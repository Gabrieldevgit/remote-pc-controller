// Reconnecting WebSocket client for the relay — agent side of PROTOCOL.md.
//
// Responsibilities:
//   - device-token auth (`auth.agent`) on every (re)connect
//   - `pairing.claim` for interactive pairing (socket is authed on success)
//   - heartbeat every 15s (configurable for tests) with reply-timeout detection
//   - request/response correlation via envelope `id` / `payload.replyTo`
//   - strict inbound validation; unknown message types are logged and ignored
//   - reconnect with exponential backoff; close code 4001 (device deleted) is fatal

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const MAX_SDP_LEN = 64 * 1024; // mirrors the relay's SDP cap
const REQUEST_TIMEOUT_MS = 10_000;

// Message types the agent accepts from the relay (events, no replyTo).
const AGENT_EVENT_TYPES = new Set([
  'session.request',
  'session.accepted',
  'session.ended',
  'signal.offer',
  'signal.answer',
  'signal.ice',
  'device.status',
  'device.updated',
  'device.deleted',
  'device.command',
  'pong',
]);

function isValidString(value, maxLen = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

/** Payload shape validation for the message types the agent consumes. */
export function validatePayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'payload must be an object';
  switch (type) {
    case 'session.request':
    case 'session.accepted':
    case 'session.ended':
      if (!isValidString(payload.sessionId, 128)) return 'payload.sessionId must be a non-empty string';
      return null;
    case 'signal.offer':
    case 'signal.answer':
      if (!isValidString(payload.sessionId, 128)) return 'payload.sessionId must be a non-empty string';
      if (!isValidString(payload.sdp, MAX_SDP_LEN)) return 'payload.sdp must be a non-empty string';
      return null;
    case 'signal.ice':
      if (!isValidString(payload.sessionId, 128)) return 'payload.sessionId must be a non-empty string';
      if (!isValidString(payload.candidate, MAX_SDP_LEN)) return 'payload.candidate must be a non-empty string';
      return null;
    case 'device.status':
    case 'device.updated':
    case 'device.deleted':
      if (!isValidString(payload.deviceId, 128)) return 'payload.deviceId must be a non-empty string';
      return null;
    case 'device.command':
      if (!isValidString(payload.commandId, 128)) return 'payload.commandId must be a non-empty string';
      if (!isValidString(payload.command, 64)) return 'payload.command must be a non-empty string';
      if (payload.params !== undefined && (typeof payload.params !== 'object' || payload.params === null || Array.isArray(payload.params))) {
        return 'payload.params must be an object when present';
      }
      return null;
    case 'pong':
      return null;
    default:
      return null;
  }
}

export class RelayClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url                full relay WebSocket endpoint (ws://host:port/ws)
   * @param {string|null} [opts.deviceId]    device id from pairing (null until paired)
   * @param {string|null} [opts.token]       device token from pairing (null until paired)
   * @param {string} [opts.name]             device name sent with auth.agent
   * @param {string} [opts.os]               os string sent with auth.agent
   * @param {string} [opts.version]          agent version sent with auth.agent
   * @param {number} [opts.heartbeatIntervalMs]  15000 per protocol; tests may lower it
   * @param {number} [opts.heartbeatTimeoutMs]   missing heartbeat reply → reconnect
   * @param {number} [opts.maxBackoffMs]
   * @param {object} [opts.wsOptions]        extra options for `ws` (e.g. perMessageDeflate off)
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.deviceId = opts.deviceId ?? null;
    this.token = opts.token ?? null;
    this.name = opts.name ?? 'Windows PC';
    this.os = opts.os ?? 'windows';
    this.version = opts.version ?? '1.0.0';
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 10_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.wsOptions = opts.wsOptions ?? {};

    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();      // id -> { resolve, reject, timer }
    this.authed = false;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.heartbeatAwaiting = false;
    this.reconnectTimer = null;
    this.onAuthFailed = null;      // set by runtime to react to invalid_device_token
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  get authenticated() {
    return this.authed;
  }

  log(...args) {
    this.emit('log', 'info', ...args);
  }

  logWarn(...args) {
    this.emit('log', 'warn', ...args);
  }

  logError(...args) {
    this.emit('log', 'error', ...args);
  }

  // ---- outbound ----

  sendFrame(obj) {
    if (!this.connected) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a request-style message and await its ok/error reply. */
  request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('not connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (payloadOut) => { clearTimeout(timer); resolve(payloadOut); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.sendFrame({ type, payload, id });
    });
  }

  /** Fire-and-forget event message (e.g. session.accept — the relay does not reply). */
  sendEvent(type, payload = {}) {
    return this.sendFrame({ type, payload });
  }

  /**
   * Pairing: claim a 6-digit code from a pending (unauthenticated) socket.
   * On success the socket is authenticated as the new device and the caller
   * receives { deviceId, token, name, ownerUserId } — persist both immediately.
   */
  async claim(code, name) {
    const payload = await this.request('pairing.claim', {
      code: String(code ?? '').trim(),
      name: String(name ?? '').trim() || this.name,
      os: this.os,
      version: this.version,
    });
    if (!isValidString(payload.deviceId, 128) || !isValidString(payload.token, 128)) {
      throw new Error('pairing.claim reply missing deviceId/token');
    }
    this.deviceId = payload.deviceId;
    this.token = payload.token;
    this.authed = true;
    this.reconnectAttempts = 0;
    this.startHeartbeat();
    this.emit('paired', payload);
    return payload;
  }

  // ---- connection lifecycle ----

  connect() {
    if (this.stopped) return;
    this.clearReconnectTimer();
    let ws;
    try {
      ws = new WebSocket(this.url, this.wsOptions);
    } catch (err) {
      this.scheduleReconnect(err);
      return;
    }
    this.ws = ws;
    ws.on('open', () => this.onOpen());
    ws.on('message', (raw) => this.onRawMessage(raw));
    ws.on('error', (err) => this.logWarn('socket error:', err?.message ?? String(err)));
    ws.on('close', (code, reason) => this.onClose(code, reason));
  }

  async onOpen() {
    this.log(`connected to relay ${this.url}`);
    if (this.deviceId && this.token) {
      try {
        const payload = await this.request('auth.agent', {
          deviceId: this.deviceId,
          token: this.token,
          name: this.name,
          os: this.os,
          version: this.version,
        });
        this.authed = true;
        this.reconnectAttempts = 0;
        this.log(`authenticated as device ${this.deviceId} (${payload.name ?? this.name})`);
        this.emit('auth-ok', payload);
        this.startHeartbeat();
      } catch (err) {
        this.handleAuthError(err);
      }
    } else {
      // Pending (pairing) connection: wait for an explicit claim() call.
      this.emit('pending-open');
    }
  }

  handleAuthError(err) {
    const code = err?.code ?? null;
    if (code === 'invalid_device_token') {
      // The device was deleted or the token was rotated: retrying cannot help.
      this.authed = false;
      this.logError('device token rejected by relay (invalid_device_token) — re-pair required');
      this.stop();
      this.emit('auth-fatal', code);
      if (this.onAuthFailed) this.onAuthFailed(code);
    } else {
      this.logWarn(`auth.agent failed: ${err?.message ?? err}`);
      this.forceReconnect();
    }
  }

  onClose(code, reason) {
    this.stopHeartbeat();
    this.failAllPending(new Error(`connection closed (${code})`));
    this.authed = false;
    const wasConnected = this.ws !== null;
    this.ws = null;
    this.emit('disconnected', code, String(reason ?? ''));
    if (this.stopped) return;

    if (code === 4001) {
      this.logError('device was deleted on the relay (close 4001) — re-pair required');
      this.stop();
      this.emit('auth-fatal', 'device_deleted');
      if (this.onAuthFailed) this.onAuthFailed('device_deleted');
      return;
    }
    if (code === 4000) {
      // Another agent connection took over this device. Back off politely
      // instead of fighting over the socket.
      this.logWarn('replaced by a newer agent connection (close 4000); retrying in 30s');
      this.reconnectAttempts = 0;
      this.reconnectTimer = setTimeout(() => this.connect(), 30_000);
      return;
    }
    if (wasConnected) this.scheduleReconnect(new Error(`closed (${code})`));
  }

  scheduleReconnect(err) {
    if (this.stopped) return;
    const attempt = Math.min(this.reconnectAttempts, 10);
    const backoff = Math.min(this.maxBackoffMs, 1000 * 2 ** attempt);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.reconnectAttempts += 1;
    this.logWarn(`reconnecting in ${Math.round(delay)}ms (${err?.message ?? err})`);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  forceReconnect() {
    try { this.ws?.terminate(); } catch { /* already gone */ }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  stop() {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.failAllPending(new Error('client stopped'));
    if (this.ws) {
      try { this.ws.close(1000, 'agent stopping'); } catch { /* gone */ }
      try { this.ws.terminate(); } catch { /* gone */ }
      this.ws = null;
    }
  }

  // ---- heartbeat ----

  startHeartbeat() {
    this.stopHeartbeat();
    if (!Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatAwaiting = false;
  }

  async sendHeartbeat() {
    if (!this.authed || !this.connected) return;
    if (this.heartbeatAwaiting) {
      // Previous heartbeat never got a reply — the link is effectively dead.
      this.logWarn('heartbeat reply missing; forcing reconnect');
      this.forceReconnect();
      return;
    }
    this.heartbeatAwaiting = true;
    try {
      const payload = await this.request('heartbeat', {}, this.heartbeatTimeoutMs);
      if (typeof payload.serverTime !== 'number') {
        this.logWarn('heartbeat reply missing serverTime');
      }
      this.emit('heartbeat-ok', payload);
    } catch (err) {
      this.logWarn(`heartbeat failed: ${err?.message ?? err}`);
      this.forceReconnect();
    } finally {
      this.heartbeatAwaiting = false;
    }
  }

  // ---- inbound ----

  onRawMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logWarn('dropping non-JSON frame from relay');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      this.logWarn('dropping malformed envelope from relay');
      return;
    }
    const payload = msg.payload ?? {};

    if (msg.type === 'ok' || msg.type === 'error') {
      this.onReply(msg);
      return;
    }
    if (!AGENT_EVENT_TYPES.has(msg.type)) {
      // Unknown types are ignored, never acted upon.
      this.logWarn(`ignoring unknown message type: ${msg.type.slice(0, 64)}`);
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      this.logWarn(`dropping ${msg.type} with malformed payload`);
      return;
    }
    const problem = validatePayload(msg.type, payload);
    if (problem) {
      this.logWarn(`dropping ${msg.type}: ${problem}`);
      return;
    }
    this.emit('message', msg.type, payload, msg);
  }

  onReply(msg) {
    const replyTo = msg.payload?.replyTo;
    const entry = typeof replyTo === 'number' || typeof replyTo === 'string'
      ? this.pending.get(replyTo)
      : undefined;
    if (!entry) {
      if (msg.type === 'error') {
        this.logWarn(`unsolicited error from relay: ${msg.payload?.code} ${msg.payload?.message ?? ''}`);
      }
      return;
    }
    this.pending.delete(replyTo);
    if (msg.type === 'ok') {
      entry.resolve(msg.payload);
    } else {
      const err = new Error(msg.payload?.message ?? 'relay error');
      err.code = msg.payload?.code ?? 'unknown';
      entry.reject(err);
    }
  }

  failAllPending(err) {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}
