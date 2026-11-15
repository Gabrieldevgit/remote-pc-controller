/**
 * SessionClient — drives one remote session end-to-end over Supabase:
 *
 *   INSERT remote_sessions            -> row id is the session id
 *   Realtime UPDATE state=accepted    -> the PC joined the signaling channel
 *   private broadcast "session:<id>"  -> offer / answer / ice
 *   RTCPeerConnection + 'input' data channel (peer-to-peer, DTLS/SRTP)
 *   getStats polling -> stats overlay + RTT reports for adaptive quality
 *   UPDATE state=ended                -> either side hangs up
 *
 * The phone creates the offer and the PC answers. Media and input never
 * pass through Supabase.
 *
 * Quality is controlled on the agent (it owns capture width / fps / JPEG
 * quality): the client sends `quality.set` over the data channel, and in
 * adaptive mode reports its measured RTT with `stats.ping` so the agent can
 * step between presets (docs/DATA_CHANNEL.md).
 */

import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
  mediaDevices,
} from 'react-native-webrtc';

import type {RealtimeChannel} from '@supabase/supabase-js';

import {supabase} from './supabase';
import {clientName} from './clientName';
import {AUTO_RESOLUTION, resolutionPayload, type StreamResolution} from './resolution';
import {BackendError, toBackendError} from './backend';
import {
  DATA_CHANNEL_LABEL,
  sendInput,
  type InputMessage,
} from './inputProtocol';
import type {VideoQuality} from '../store/settings';

interface SignalIcePayload {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export {RTCView};

export interface SessionStatsSnapshot {
  /** 'direct' when peers talk P2P, 'relayed' through TURN. */
  route?: 'direct' | 'relayed' | null;
  rttMs: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  packetsLost: number | null;
}

export const ICE_SERVERS = [
  {urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']},
];

const STATS_INTERVAL_MS = 2000;
const ACCEPT_TIMEOUT_MS = 30000;
const SUPPORT_APPROVAL_TIMEOUT_MS = 120000;

type SessionPhaseUpdate = 'waiting' | 'signaling' | 'connected' | 'failed' | 'ended';

interface SessionClientCallbacks {
  onPhase: (phase: SessionPhaseUpdate, error?: string) => void;
  onStream: (streamUrl: string | null) => void;
  onStats: (stats: SessionStatsSnapshot) => void;
  onDataChannelOpen: () => void;
  onRemoteClipboard: (text: string) => void;
  /** Degraded (JPEG) mode: latest frame as a displayable data URL. */
  onJpegFrame?: (dataUrl: string) => void;
  /** Real pointer position/shape reported by the agent (normalized). */
  onCursor?: (cursor: {x: number; y: number; visible: boolean; shape: string}) => void;
  /** Any other agent control message (auth, files, curtain, …). */
  onControl?: (message: Record<string, unknown>) => void;
  /** Data channels the agent opens (file downloads). */
  onPeerChannel?: (channel: any) => void;
}

/** Personal remote access (owned PC) or a Remote Support session. */
export type SessionKind = 'access' | 'support';

interface LastStats {
  bytes: number;
  timestamp: number;
}

/** Binary data-channel framing used by the agent in degraded (JPEG) mode. */
const JPEG_FRAME_TYPE = 0x01;

/** Read the pixel size from a JPEG's SOFn header (null if not found). */
function jpegSize(bytes: Uint8Array): {width: number; height: number} | null {
  let i = 2; // skip SOI
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return null;
    }
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    }
    i += 2 + length;
  }
  return null;
}

export class SessionClient {
  private sessionId: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private kind: SessionKind = 'access';
  /** Realtime: row updates for this session + the signaling channel. */
  private rowChannel: RealtimeChannel | null = null;
  private signal: RealtimeChannel | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private acceptTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStats: LastStats | null = null;
  private quality: VideoQuality = 'adaptive';
  private resolution: StreamResolution = AUTO_RESOLUTION;
  private ended = false;
  private statsSeq = 0;
  private callbacks: SessionClientCallbacks;
  /** Remote ICE that arrives before the peer connection exists. */
  private pendingRemoteIce: SignalIcePayload[] = [];
  /** Partial JPEG frames keyed by sequence number (degraded mode). */
  private jpegBuffers = new Map<number, {chunks: ArrayBuffer[]; seen: number}>();
  private lastJpegSeq = -1;
  private jpegUrlTimer: ReturnType<typeof setTimeout> | null = null;
  /** Degraded-mode counters, folded into the stats snapshot. */
  private jpegFrames = 0;
  private jpegBytes = 0;
  private jpegDims: {width: number; height: number} | null = null;
  private jpegWindowStart = 0;

  /** Data channel for input events; null until negotiated and open. */
  private dataChannel: {
    readyState: string;
    send: (data: string) => void;
  } | null = null;

  constructor(callbacks: SessionClientCallbacks, kind: SessionKind = 'access') {
    this.callbacks = callbacks;
    this.kind = kind;
  }

  private get table() {
    return this.kind === 'support' ? 'support_sessions' : 'remote_sessions';
  }

  private get acceptedState() {
    return this.kind === 'support' ? 'approved' : 'accepted';
  }

  /** Open an extra reliable data channel (file transfers). */
  createChannel(label: string): any {
    return this.pc ? this.pc.createDataChannel(label, {ordered: true}) : null;
  }

  get active(): boolean {
    return !this.ended && this.sessionId != null;
  }

  sendInput(message: InputMessage) {
    sendInput(this.dataChannel, message);
  }

  /** Apply a quality preset live; the agent acknowledges with quality.ack. */
  setQuality(quality: VideoQuality) {
    this.quality = quality;
    this.sendInput({t: 'quality.set', level: quality});
  }

  /** Stream resolution (Auto / preset / custom), applied live. */
  setResolution(resolution: StreamResolution) {
    this.resolution = resolution;
    this.sendInput({t: 'quality.set', ...resolutionPayload(resolution)});
  }

  private emitPhase(phase: SessionPhaseUpdate, error?: string) {
    if (this.ended && phase !== 'ended') {
      return;
    }
    this.callbacks.onPhase(phase, error);
  }

  /** Run the full lifecycle. Resolves once the session row exists. */
  async start(deviceId: string, quality: VideoQuality): Promise<void> {
    this.quality = quality;
    this.ended = false;

    const {data, error} = await supabase
      .from('remote_sessions')
      .insert({device_id: deviceId, client_name: clientName()})
      .select('id,state')
      .single();
    if (error || !data) {
      throw toBackendError(error);
    }
    const sessionId = data.id as string;
    if (this.ended) {
      // The screen closed while the request was in flight.
      // Query builders are lazy: .then() is what sends the request.
      supabase
        .from('remote_sessions')
        .update({state: 'ended', end_reason: 'cancelled'})
        .eq('id', sessionId)
        .then(undefined, () => {});
      return;
    }
    this.watch(sessionId);
  }

  /**
   * Join a Remote Support session created by redeem_support_code(); the
   * host approves it on the PC, then signaling starts as usual.
   */
  async attach(sessionId: string, quality: VideoQuality): Promise<void> {
    this.quality = quality;
    this.ended = false;
    this.watch(sessionId);
  }

  private watch(sessionId: string) {
    const table = this.table;
    this.sessionId = sessionId;
    this.emitPhase('waiting');

    const onRow = (row: {state?: string; end_reason?: string | null}) => {
      if (row.state === this.acceptedState) {
        this.clearAcceptTimer();
        void this.negotiate();
      } else if (row.state === 'ended' || row.state === 'rejected') {
        this.handleEnded(row.end_reason ?? row.state);
      }
    };
    this.rowChannel = supabase
      .channel(`session-row:${sessionId}`)
      .on(
        'postgres_changes',
        {event: 'UPDATE', schema: 'public', table, filter: `id=eq.${sessionId}`},
        change => onRow(change.new as {state?: string; end_reason?: string | null}),
      )
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          // The PC may have answered before we were listening: catch up.
          const {data: row} = await supabase
            .from(table)
            .select('state,end_reason')
            .eq('id', sessionId)
            .single();
          if (row) {
            onRow(row);
          }
        }
      });

    // Support sessions wait for a person to click Allow on the PC.
    this.acceptTimer = setTimeout(() => {
      this.emitPhase(
        'failed',
        this.kind === 'support'
          ? 'Nobody accepted the request on the other computer.'
          : 'The computer did not respond in time. Is remote access turned on?',
      );
    }, this.kind === 'support' ? SUPPORT_APPROVAL_TIMEOUT_MS : ACCEPT_TIMEOUT_MS);
  }

  private clearAcceptTimer() {
    if (this.acceptTimer) {
      clearTimeout(this.acceptTimer);
      this.acceptTimer = null;
    }
  }

  /** Join the private signaling channel; resolves once subscribed. */
  private joinSignaling(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      void supabase.realtime.setAuth().then(() => {
        this.signal = supabase
          .channel(`${this.kind === 'support' ? 'support' : 'session'}:${sessionId}`, {
            config: {private: true, broadcast: {self: false, ack: true}},
          })
          .on('broadcast', {event: 'answer'}, ({payload}) => {
            if (typeof payload?.sdp === 'string') {
              void this.applyAnswer(payload.sdp);
            }
          })
          .on('broadcast', {event: 'ice'}, ({payload}) => {
            if (typeof payload?.candidate === 'string') {
              void this.addRemoteIce(payload as SignalIcePayload);
            }
          })
          .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
              resolve();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              reject(new BackendError('signaling', err?.message ?? 'Could not open the signaling channel.'));
            }
          });
      }, reject);
    });
  }

  private sendSignal(event: 'offer' | 'ice', payload: Record<string, unknown>) {
    void this.signal?.send({type: 'broadcast', event, payload});
  }

  private async negotiate() {
    if (this.pc || this.ended) {
      return;
    }
    this.emitPhase('signaling');
    try {
      await this.joinSignaling(this.sessionId!);
      if (this.ended) {
        return;
      }
      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS as never[],
      });
      this.pc = pc;

      // CRITICAL: the offer must contain a video m-section, otherwise the
      // device (which answers with its capture track attached) cannot include
      // video in the answer — Unified Plan answers can never add m-sections.
      // Without this the session connects but shows a black screen forever.
      pc.addTransceiver('video', {direction: 'recvonly'});
      // Computer sound (WASAPI loopback on the PC); played automatically.
      pc.addTransceiver('audio', {direction: 'recvonly'});

      // Input channel is negotiated inside our offer (PROTOCOL.md 4.3).
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {ordered: true});
      this.dataChannel = channel;
      channel.onopen = () => {
        this.callbacks.onDataChannelOpen();
        this.emitPhase('connected');
        // Tell the agent which quality the user picked (adaptive by default).
        this.sendInput({t: 'quality.set', level: this.quality, ...resolutionPayload(this.resolution)});
        // Candidates may have queued while the pc/channel were coming up.
        this.flushPendingIce();
      };
      channel.onclose = () => {
        this.dataChannel = null;
      };
      // The lib's onX setter typings are loose (Event<string>); the runtime
      // payloads carry the real fields, hence the explicit any annotations.
      channel.onmessage = (event: any) => {
        // Binary frames (degraded JPEG mode) arrive as ArrayBuffer; JSON
        // control messages arrive as strings.
        this.handleDataMessage(event?.data);
      };

      pc.ontrack = (event: any) => {
        const stream = event?.streams?.[0];
        // Audio plays on its own; only the video stream feeds the RTCView.
        if (stream && event?.track?.kind !== 'audio') {
          this.callbacks.onStream(stream.toURL());
        }
      };
      pc.ondatachannel = (event: any) => {
        if (event?.channel) {
          this.callbacks.onPeerChannel?.(event.channel);
        }
      };

      pc.onicecandidate = (event: any) => {
        const candidate = event?.candidate;
        if (!candidate || !this.sessionId) {
          return;
        }
        this.sendSignal('ice', {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? undefined,
          sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        });
      };

      pc.onconnectionstatechange = () => {
        if (this.ended || this.pc !== pc) {
          return;
        }
        if (pc.connectionState === 'failed') {
          this.emitPhase('failed', 'The connection to the computer was lost.');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal('offer', {sdp: pc.localDescription?.sdp ?? offer.sdp});
      // The answer can race ahead of this function returning; flush any ICE
      // that already queued up while we were negotiating.
      this.flushPendingIce();
    } catch (error) {
      this.emitPhase(
        'failed',
        error instanceof Error ? error.message : 'Signaling failed',
      );
    }
  }

  private async applyAnswer(sdp: string) {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({type: 'answer', sdp}),
      );
      this.flushPendingIce();
    } catch {
      this.emitPhase('failed', 'Could not apply the computer’s answer');
    }
  }

  private async addRemoteIce(payload: SignalIcePayload) {
    const pc = this.pc;
    // Candidates can only be applied once the remote description is set.
    if (!pc || !pc.remoteDescription) {
      if (payload.candidate) {
        this.pendingRemoteIce.push(payload);
      }
      return;
    }
    try {
      await pc.addIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex,
        usernameFragment: payload.usernameFragment,
      });
    } catch {
      // A single bad candidate must not kill the session.
    }
  }

  /** Flush ICE candidates that were queued before the pc was ready. */
  private flushPendingIce() {
    if (!this.pc?.remoteDescription) {
      return;
    }
    const queued = this.pendingRemoteIce.splice(0);
    for (const candidate of queued) {
      void this.addRemoteIce(candidate);
    }
  }

  /**
   * Degraded (werift) mode: the agent streams JPEG frames as binary chunks
   * framed as [type:1][flags:1][seq:2 LE] + payload (docs/DATA_CHANNEL.md).
   * flags bit0 marks the final chunk of a frame.
   */
  private handleJpegChunk(data: ArrayBuffer) {
    if (!data || data.byteLength < 4) {
      return;
    }
    const view = new DataView(data);
    const type = view.getUint8(0);
    if (type !== JPEG_FRAME_TYPE) {
      return;
    }
    const flags = view.getUint8(1);
    const seq = view.getUint16(2, true);
    const final = (flags & 0x01) !== 0;
    const payload = data.slice(4);
    this.jpegBytes += data.byteLength;

    // Drop everything from an older, unfinished frame — keep only the newest.
    if (seq !== this.lastJpegSeq) {
      this.jpegBuffers.clear();
      this.jpegBuffers.set(seq, {chunks: [payload], seen: 1});
      this.lastJpegSeq = seq;
    } else {
      const entry = this.jpegBuffers.get(seq);
      if (!entry) {
        this.jpegBuffers.set(seq, {chunks: [payload], seen: 1});
      } else {
        entry.chunks.push(payload);
        entry.seen += 1;
      }
    }
    if (!final) {
      return;
    }
    const entry = this.jpegBuffers.get(seq);
    this.jpegBuffers.delete(seq);
    if (!entry || entry.chunks.length === 0) {
      return;
    }
    let size = 0;
    for (const chunk of entry.chunks) {
      size += chunk.byteLength;
    }
    if (size === 0) {
      return;
    }
    const jpeg = new Uint8Array(size);
    let offset = 0;
    for (const chunk of entry.chunks) {
      jpeg.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    this.jpegFrames += 1;
    const dims = jpegSize(jpeg);
    if (dims) {
      this.jpegDims = dims;
    }
    // Rate-limit data-URL churn: at most one render per animation-ish tick.
    if (this.jpegUrlTimer) {
      clearTimeout(this.jpegUrlTimer);
    }
    const base64 = this.bytesToBase64(jpeg);
    this.jpegUrlTimer = setTimeout(() => {
      this.jpegUrlTimer = null;
      this.callbacks.onJpegFrame?.(`data:image/jpeg;base64,${base64}`);
    }, 16);
  }

  /** Hermes ships without btoa; encode straight from the byte array. */
  private bytesToBase64(bytes: Uint8Array): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const parts: string[] = [];
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const has1 = i + 1 < bytes.length;
      const has2 = i + 2 < bytes.length;
      const b1 = has1 ? bytes[i + 1] : 0;
      const b2 = has2 ? bytes[i + 2] : 0;
      out +=
        chars[b0 >> 2] +
        chars[((b0 & 3) << 4) | (b1 >> 4)] +
        (has1 ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
        (has2 ? chars[b2 & 63] : '=');
      if (out.length >= 8192) {
        parts.push(out);
        out = '';
      }
    }
    parts.push(out);
    return parts.join('');
  }

  private handleDataMessage(raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') {
      this.handleJpegChunk(raw as ArrayBuffer);
      return;
    }
    try {
      const message = JSON.parse(raw) as Record<string, unknown> & {t?: string; text?: string};
      if (message.t === 'clipboard.set' && typeof message.text === 'string') {
        this.callbacks.onRemoteClipboard(message.text);
      } else if (message.t === 'cursor') {
        const x = Number(message.x);
        const y = Number(message.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.callbacks.onCursor?.({
            x,
            y,
            visible: message.visible !== false,
            shape: typeof message.shape === 'string' ? message.shape : 'arrow',
          });
        }
      } else if (typeof message.t === 'string') {
        this.callbacks.onControl?.(message);
      }
    } catch {
      // Non-JSON frame on the data channel; ignore.
    }
  }

  pullRemoteClipboard() {
    this.sendInput({t: 'clipboard.get'});
  }

  pushLocalClipboard(text: string) {
    this.sendInput({t: 'clipboard.set', text});
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  startStatsPolling() {
    if (this.statsTimer) {
      return;
    }
    this.jpegWindowStart = Date.now();
    this.statsTimer = setInterval(() => {
      void this.pollStats();
    }, STATS_INTERVAL_MS);
  }

  stopStatsPolling() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async pollStats() {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    try {
      const report = await pc.getStats();
      let rttMs: number | null = null;
      let fps: number | null = null;
      let width: number | null = null;
      let height: number | null = null;
      let packetsLost: number | null = null;
      let bytes = 0;
      let timestamp = 0;
      let sawVideo = false;
      let route: 'direct' | 'relayed' | null = null;
      let localCandidateId: string | null = null;
      const candidateTypes = new Map<string, string>();

      report.forEach((entry: Record<string, unknown>) => {
        const type = entry.type as string | undefined;
        if (
          type === 'candidate-pair' &&
          (entry.nominated === true || entry.selected === true) &&
          entry.state === 'succeeded'
        ) {
          const rtt = entry.currentRoundTripTime;
          if (typeof rtt === 'number') {
            rttMs = Math.round(rtt * 1000);
          }
          localCandidateId = typeof entry.localCandidateId === 'string' ? entry.localCandidateId : null;
        }
        if (type === 'local-candidate' && typeof entry.id === 'string') {
          candidateTypes.set(entry.id, String(entry.candidateType ?? ''));
        }
        if (type === 'inbound-rtp' && entry.kind === 'video') {
          sawVideo = typeof entry.bytesReceived === 'number' && entry.bytesReceived > 0;
          if (typeof entry.framesPerSecond === 'number') {
            fps = Math.round(entry.framesPerSecond);
          }
          if (typeof entry.frameWidth === 'number') {
            width = entry.frameWidth as number;
          }
          if (typeof entry.frameHeight === 'number') {
            height = entry.frameHeight as number;
          }
          if (typeof entry.packetsLost === 'number') {
            packetsLost = entry.packetsLost as number;
          }
          if (typeof entry.bytesReceived === 'number') {
            bytes = entry.bytesReceived as number;
          }
          if (typeof entry.timestamp === 'number') {
            timestamp = entry.timestamp as number;
          }
        }
      });

      let bitrateKbps: number | null = null;
      if (sawVideo) {
        if (this.lastStats && timestamp > this.lastStats.timestamp) {
          const deltaBytes = bytes - this.lastStats.bytes;
          const deltaMs = timestamp - this.lastStats.timestamp;
          if (deltaMs > 0) {
            bitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
          }
        }
        if (timestamp) {
          this.lastStats = {bytes, timestamp};
        }
      } else if (this.jpegFrames > 0 || this.jpegBytes > 0) {
        // Degraded mode: frames arrive over the data channel instead.
        const now = Date.now();
        const elapsed = Math.max(1, now - this.jpegWindowStart);
        fps = Math.round((this.jpegFrames * 1000) / elapsed);
        bitrateKbps = Math.round((this.jpegBytes * 8) / elapsed);
        width = this.jpegDims?.width ?? null;
        height = this.jpegDims?.height ?? null;
        this.jpegFrames = 0;
        this.jpegBytes = 0;
        this.jpegWindowStart = now;
      }

      if (localCandidateId) {
        route = candidateTypes.get(localCandidateId) === 'relay' ? 'relayed' : 'direct';
      }
      this.callbacks.onStats({route, rttMs, fps, bitrateKbps, width, height, packetsLost});

      // Adaptive quality lives on the agent; feed it our round-trip time.
      this.sendInput({
        t: 'stats.ping',
        seq: this.statsSeq++,
        ...(rttMs != null && this.quality === 'adaptive' ? {rttMs} : {}),
      });
    } catch {
      // getStats can fail transiently during renegotiation.
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  private handleEnded(reason: string) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.clearAcceptTimer();
    this.callbacks.onPhase('ended', reason);
    this.cleanupMedia();
  }

  private removeChannels() {
    for (const channel of [this.rowChannel, this.signal]) {
      if (channel) {
        void supabase.removeChannel(channel);
      }
    }
    this.rowChannel = null;
    this.signal = null;
  }

  private cleanupMedia() {
    this.removeChannels();
    this.stopStatsPolling();
    this.dataChannel = null;
    this.pendingRemoteIce = [];
    this.jpegBuffers.clear();
    this.lastJpegSeq = -1;
    if (this.jpegUrlTimer) {
      clearTimeout(this.jpegUrlTimer);
      this.jpegUrlTimer = null;
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    this.callbacks.onStream(null);
  }

  /** Hang up: mark the session ended so the PC tears down too. */
  end() {
    if (!this.ended && this.sessionId) {
      // Query builders are lazy: .then() is what sends the request.
      supabase
        .from(this.table)
        .update({state: 'ended', end_reason: 'ended_by_peer'})
        .eq('id', this.sessionId)
        .then(undefined, () => {});
    }
    this.ended = true;
    this.clearAcceptTimer();
    this.cleanupMedia();
    this.sessionId = null;
  }
}

// Re-exported for convenience so screens import WebRTC symbols from one place.
export {mediaDevices};
