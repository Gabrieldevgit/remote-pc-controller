// Supabase transport for the agent — drop-in replacement for RelayClient.
//
// It exposes the same surface runtime.js / session.js rely on:
//   connect(), stop(), sendEvent(type, payload)
//   events: 'log', 'message' (type, payload), 'auth-ok', 'auth-fatal'
// and maps it onto the Supabase backend (supabase/migrations):
//
//   auth          signInWithPassword with the device login from pairing
//   heartbeat     rpc device_heartbeat() every 20 s; device_offline() on stop
//   sessions      postgres_changes on remote_sessions (INSERT → session.request
//                 once the signaling channel is joined; UPDATE ended → ended)
//   signaling     private broadcast channel "session:<id>"
//                 (events: offer, answer, ice)
//   commands      postgres_changes INSERT on device_commands → device.command;
//                 results are written back to the row
//   screenshots   uploaded to Storage by uploadScreenshot()

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const SDP_MAX = 64 * 1024;

function str(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export class SupabaseAgentClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url              Supabase project URL
   * @param {string} opts.key              publishable (anon) key
   * @param {string} opts.deviceId
   * @param {string} opts.email            device login (from pairing)
   * @param {string} opts.password
   * @param {string} [opts.name]
   * @param {string} [opts.version]
   * @param {object} [opts.capabilities]
   * @param {number} [opts.heartbeatIntervalMs]
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.deviceId = opts.deviceId;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_MS;
    this.supabase = createClient(opts.url, opts.key, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { transport: WebSocket, params: { eventsPerSecond: 50 } },
    });
    this.stopped = false;
    this.authed = false;
    this.attempts = 0;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.deviceChannel = null;
    this.sessionChannels = new Map(); // sessionId -> RealtimeChannel
  }

  log(...args) { this.emit('log', 'info', ...args); }
  warn(...args) { this.emit('log', 'warn', ...args); }

  get connected() { return this.authed; }

  // ---- lifecycle -------------------------------------------------------------

  async connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const { email, password } = this.opts;
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (/invalid login credentials/i.test(error.message) || error.status === 400) {
        this.warn('device login rejected — this PC was removed from the account; pair it again');
        this.fatal('invalid_device_credentials');
      } else {
        this.retry(`sign-in failed: ${error.message}`);
      }
      return;
    }
    await this.supabase.realtime.setAuth();
    try {
      await this.heartbeat();
    } catch (err) {
      if (err?.message?.includes('device_not_found')) {
        this.fatal('device_deleted');
      } else {
        this.retry(`heartbeat failed: ${err?.message ?? err}`);
      }
      return;
    }
    this.authed = true;
    this.attempts = 0;
    this.log(`authenticated as device ${this.deviceId} (${this.opts.name ?? 'PC'}) via Supabase`);
    this.emit('auth-ok', { deviceId: this.deviceId });
    this.subscribeDevice();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => {
        if (err?.message?.includes('device_not_found')) this.fatal('device_deleted');
        else this.warn(`heartbeat failed: ${err?.message ?? err}`);
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    await this.pickUpPendingCommands();
  }

  retry(reason) {
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempts, 6));
    this.attempts += 1;
    this.warn(`${reason}; retrying in ${Math.round(delay / 1000)} s`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  fatal(code) {
    this.authed = false;
    this.stopInternal(false);
    this.emit('auth-fatal', code);
  }

  async heartbeat() {
    const { error } = await this.supabase.rpc('device_heartbeat', {
      p_name: null,
      p_version: this.opts.version ?? null,
      p_capabilities: this.opts.capabilities ?? null,
    });
    if (error) throw new Error(error.message);
  }

  stop() {
    this.stopInternal(true);
  }

  stopInternal(markOffline) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    const done = () => {
      this.supabase.removeAllChannels().catch(() => {});
      this.sessionChannels.clear();
      this.deviceChannel = null;
    };
    if (markOffline && this.authed) {
      // Best effort: tell the backend we are going away.
      Promise.race([
        this.supabase.rpc('device_offline'),
        new Promise((r) => setTimeout(r, 2000)),
      ]).finally(done);
    } else {
      done();
    }
    this.authed = false;
  }

  // ---- inbound ---------------------------------------------------------------

  subscribeDevice() {
    const filter = `device_id=eq.${this.deviceId}`;
    this.deviceChannel = this.supabase
      .channel(`device:${this.deviceId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'remote_sessions', filter },
        (change) => this.onSessionInsert(change.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'remote_sessions', filter },
        (change) => this.onSessionUpdate(change.new))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'device_commands', filter },
        (change) => this.onCommand(change.new))
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') this.log('listening for sessions and commands');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.warn(`device channel ${status.toLowerCase()}${err ? `: ${err.message}` : ''}`);
        }
      });
  }

  onSessionInsert(row) {
    const sessionId = str(row?.id, 64);
    if (!sessionId || row.state !== 'requested' || this.sessionChannels.has(sessionId)) return;
    const channel = this.supabase.channel(`session:${sessionId}`, {
      config: { private: true, broadcast: { self: false, ack: true } },
    });
    channel
      .on('broadcast', { event: 'offer' }, ({ payload }) => {
        const sdp = str(payload?.sdp, SDP_MAX);
        if (sdp) this.emit('message', 'signal.offer', { sessionId, sdp });
      })
      .on('broadcast', { event: 'ice' }, ({ payload }) => {
        const candidate = str(payload?.candidate, SDP_MAX);
        if (!candidate) return;
        this.emit('message', 'signal.ice', {
          sessionId,
          candidate,
          sdpMid: str(payload.sdpMid, 64) ?? undefined,
          sdpMLineIndex: Number.isInteger(payload.sdpMLineIndex) ? payload.sdpMLineIndex : undefined,
          usernameFragment: str(payload.usernameFragment, 256) ?? undefined,
        });
      })
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          // Joined the signaling channel: let the session manager accept.
          this.emit('message', 'session.request', { sessionId, deviceId: this.deviceId });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.warn(`session ${sessionId} channel ${status.toLowerCase()}${err ? `: ${err.message}` : ''}`);
          this.endSession(sessionId, 'signaling_failed');
        }
      });
    this.sessionChannels.set(sessionId, channel);
  }

  onSessionUpdate(row) {
    const sessionId = str(row?.id, 64);
    if (!sessionId) return;
    if (row.state === 'ended' || row.state === 'rejected') {
      this.closeSessionChannel(sessionId);
      this.emit('message', 'session.ended', { sessionId, reason: row.end_reason ?? row.state });
    }
  }

  onCommand(row) {
    const commandId = str(row?.id, 64);
    const command = str(row?.command, 64);
    if (!commandId || !command || row.status !== 'pending') return;
    const params = row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? row.params : {};
    this.supabase.from('device_commands').update({ status: 'running' }).eq('id', commandId)
      .then(({ error }) => { if (error) this.warn(`command ${commandId}: ${error.message}`); });
    this.emit('message', 'device.command', { commandId, command, params });
  }

  /** Commands queued during a reconnect gap (younger than 60 s). */
  async pickUpPendingCommands() {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { data, error } = await this.supabase
      .from('device_commands')
      .select('id, command, params, status')
      .eq('device_id', this.deviceId)
      .eq('status', 'pending')
      .gte('created_at', since)
      .order('created_at');
    if (error) {
      this.warn(`could not read pending commands: ${error.message}`);
      return;
    }
    for (const row of data ?? []) this.onCommand(row);
  }

  closeSessionChannel(sessionId) {
    const channel = this.sessionChannels.get(sessionId);
    if (!channel) return;
    this.sessionChannels.delete(sessionId);
    this.supabase.removeChannel(channel).catch(() => {});
  }

  async endSession(sessionId, reason) {
    this.closeSessionChannel(sessionId);
    const { data } = await this.supabase.from('remote_sessions')
      .update({ state: 'ended', end_reason: reason })
      .eq('id', sessionId)
      .in('state', ['requested', 'accepted']) // never overwrite a finished session
      .select('id');
    if (data?.length) this.emit('message', 'session.ended', { sessionId, reason });
  }

  // ---- outbound (same names the relay protocol used) -------------------------

  sendEvent(type, payload = {}) {
    if (!this.authed) return false;
    const sessionId = str(payload.sessionId, 64);
    switch (type) {
      case 'session.accept':
        this.supabase.from('remote_sessions').update({ state: 'accepted' }).eq('id', sessionId)
          .then(({ error }) => { if (error) this.warn(`accept ${sessionId}: ${error.message}`); });
        return true;
      case 'session.reject':
        this.closeSessionChannel(sessionId);
        this.supabase.from('remote_sessions')
          .update({ state: 'rejected', end_reason: str(payload.reason, 64) ?? 'rejected' })
          .eq('id', sessionId)
          .then(({ error }) => { if (error) this.warn(`reject ${sessionId}: ${error.message}`); });
        return true;
      case 'session.end':
        this.endSession(sessionId, str(payload.reason, 64) ?? 'ended_by_device');
        return true;
      case 'signal.answer':
      case 'signal.ice': {
        const channel = this.sessionChannels.get(sessionId);
        if (!channel) return false;
        const { sessionId: _omit, ...rest } = payload;
        channel.send({ type: 'broadcast', event: type === 'signal.answer' ? 'answer' : 'ice', payload: rest })
          .then((res) => { if (res !== 'ok') this.warn(`${type} for ${sessionId}: ${res}`); });
        return true;
      }
      case 'device.command.result':
        this.completeCommand(payload);
        return true;
      default:
        this.warn(`unsupported outbound event ${type}`);
        return false;
    }
  }

  async completeCommand({ commandId, ok, command, result, error }) {
    let finalResult = result ?? null;
    // Screenshots go to Storage; the row only carries the object path.
    if (ok && command === 'screenshot' && result?.path) {
      try {
        finalResult = { storagePath: await this.uploadScreenshot(result.path) };
      } catch (err) {
        ok = false;
        error = `upload failed: ${err?.message ?? err}`;
        finalResult = null;
      }
    }
    const { error: updateError } = await this.supabase.from('device_commands').update({
      status: ok ? 'succeeded' : 'failed',
      result: finalResult,
      error: ok ? null : String(error ?? 'failed').slice(0, 300),
      completed_at: new Date().toISOString(),
    }).eq('id', commandId);
    if (updateError) this.warn(`command ${commandId} result: ${updateError.message}`);
  }

  async uploadScreenshot(filePath) {
    const bytes = fs.readFileSync(filePath);
    const objectPath = `${this.deviceId}/${path.basename(filePath)}`;
    const { error } = await this.supabase.storage.from('screenshots')
      .upload(objectPath, bytes, { contentType: 'image/png', upsert: false });
    if (error) throw new Error(error.message);
    try { fs.unlinkSync(filePath); } catch { /* keep local copy if locked */ }
    return objectPath;
  }
}

/**
 * Pair this PC: exchange a one-time code for a device login via the
 * pair-device Edge Function. Returns { deviceId, ownerId, name, email, password }.
 */
export async function pairWithSupabase({ url, key, code, name, os, version }) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/pair-device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key },
    body: JSON.stringify({ code, name, os, version }),
  });
  let body = {};
  try { body = await response.json(); } catch { /* non-JSON */ }
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  }
  if (!str(body.deviceId, 64) || !str(body.email, 320) || !str(body.password, 256)) {
    throw new Error('pairing reply is missing the device login');
  }
  return body;
}
