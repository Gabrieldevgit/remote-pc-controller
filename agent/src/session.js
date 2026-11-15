// Session orchestration: accepts session.request, answers signal.offer via the
// WebRTC backend, wires the data channel (input, clipboard sync, quality,
// stats, system actions), and tears everything down on session end.
//
// Data-channel control protocol (JSON text messages, client → agent unless
// noted) is documented in docs/DATA_CHANNEL.md — that file is the binding
// contract; agent/README.md summarizes it. Unknown message types are logged
// and ignored; nothing is ever eval'd.

import jpegJs from 'jpeg-js';

import { ScreenFramePump } from './capture.js';

const QUALITY_PRESETS = {
  high: { width: 1920, fps: 30, jpegQuality: 65 },
  medium: { width: 1280, fps: 24, jpegQuality: 55 },
  low: { width: 854, fps: 15, jpegQuality: 45 },
};
const ADAPTIVE_DEFAULT = 'medium';
const ADAPTIVE_STEP_DOWN_RTT_MS = 150; // degrade when round-trip is high
const ADAPTIVE_STEP_UP_RTT_MS = 60;    // upgrade when round-trip is low
const ADAPTIVE_MIN_INTERVAL_MS = 5000;
const CLIPBOARD_POLL_MS = 1500;
const JPEG_CHUNK_SIZE = 16 * 1024;
const BINARY_TYPE_JPEG = 0x01;

const ADAPTIVE_ORDER = ['low', 'medium', 'high'];

/** Swap B/R channels: PowerShell gives BGRA, encoders want RGBA. */
function bgraToRgba(bgra, pixelCount) {
  const rgba = Buffer.from(bgra); // copy — the pump reuses its buffer
  for (let i = 0; i < pixelCount * 4; i += 4) {
    const b = rgba[i];
    rgba[i] = rgba[i + 2];
    rgba[i + 2] = b;
  }
  return rgba;
}

function isNonEmptyString(value, maxLen = 64 * 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen;
}

// Canonical key codes are Web KeyboardEvent.code values (docs/DATA_CHANNEL.md).
// This table maps them onto the agent's internal key names (see input.js —
// lowercase names resolved to virtual-key codes there). Codes with a natural
// name mapping are listed; KeyX/DigitX/F1-F24/Numpad0-9 are handled by pattern.
const KEY_CODES = {
  Escape: 'escape',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Space: 'space',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',
  PrintScreen: 'printscreen',
  ScrollLock: 'scrolllock',
  Pause: 'pause',
  NumLock: 'numlock',
  CapsLock: 'capslock',
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  AltLeft: 'alt',
  AltRight: 'alt',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  MetaLeft: 'win',
  MetaRight: 'win',
  ContextMenu: 'apps',
  Backquote: 'backquote',
  Minus: 'minus',
  Equal: 'equal',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  NumpadAdd: '0x6b',
  NumpadSubtract: '0x6d',
  NumpadMultiply: '0x6a',
  NumpadDivide: '0x6f',
  NumpadDecimal: '0x6e',
};

/** Map a canonical KeyboardEvent.code to the agent's internal key name. */
function keyNameForCode(code) {
  if (typeof code !== 'string') return null;
  if (KEY_CODES[code]) return KEY_CODES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F(1[0-9]|2[0-4]|[1-9])$/.exec(code);
  if (m) return `f${m[1]}`;
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `numpad${m[1]}`;
  return null;
}

export class SessionManager {
  /**
   * @param {object} opts
   * @param {object} opts.backend    WebRTC backend from webrtc.js (createPeer, mode)
   * @param {object} opts.input      input module (capability-checked)
   * @param {object} opts.clipboard  clipboard module
   * @param {object} opts.system     system API
   * @param {(type: string, payload: object) => void} opts.sendSignal
   *        sends a relay event (session.accept / signal.answer / signal.ice)
   * @param {function} [opts.log]
   */
  constructor({ backend, input, clipboard, system, sendSignal, log = console.log }) {
    this.backend = backend;
    this.input = input;
    this.clipboard = clipboard;
    this.system = system;
    this.sendSignal = sendSignal;
    this.log = log;
    this.sessions = new Map(); // sessionId -> record
  }

  get count() {
    return this.sessions.size;
  }

  logWarn(...args) {
    this.log(`[warn] ${args.join(' ')}`);
  }

  // ---- relay message entry points -------------------------------------------

  handleRelayMessage(type, payload) {
    switch (type) {
      case 'session.request':
        return this.onSessionRequest(payload);
      case 'signal.offer':
        return this.onSignalOffer(payload);
      case 'signal.ice':
        return this.onSignalIce(payload);
      case 'session.ended':
        return this.onSessionEnded(payload);
      case 'session.accepted':
        // The client receives this, not the agent — ignore defensively.
        return;
      case 'signal.answer':
        // The agent answers, it never receives answers — ignore defensively.
        return;
      default:
        this.logWarn(`ignoring unexpected relay message type ${type}`);
    }
  }

  onSessionRequest(payload) {
    const { sessionId } = payload;
    if (this.sessions.has(sessionId)) {
      this.logWarn(`duplicate session.request for ${sessionId}; ignoring`);
      return;
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      peer: null,
      channel: null,
      pump: null,
      clipboardTimer: null,
      lastClipboardSent: null,
      lastClipboardReceived: null,
      quality: null, // resolved lazily from defaults
      adaptive: true, // until the client picks a fixed level
      channelReady: false,
      lastAdaptiveChange: 0,
      pendingIce: [], // ICE that arrives before the answer is ready
      createdAt: Date.now(),
    });
    this.log(`session ${sessionId} requested — accepting (device pre-authorized by token)`);
    // The device is pre-authorized by its token: accept immediately.
    this.sendSignal('session.accept', { sessionId });
  }

  async onSignalOffer(payload) {
    const { sessionId, sdp } = payload;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logWarn(`signal.offer for unknown session ${sessionId}; ignoring`);
      return;
    }
    if (session.peer) {
      this.logWarn(`duplicate offer for session ${sessionId}; ignoring`);
      return;
    }
    if (!this.backend || this.backend.mode === 'none') {
      // No WebRTC capability at all: reject the session with a clear reason.
      this.logWarn(`feature unavailable: WebRTC backend (${this.backend?.reason ?? 'none'}) — rejecting session`);
      this.sendSignal('session.reject', { sessionId, reason: 'capture_unavailable' });
      this.sessions.delete(sessionId);
      return;
    }
    try {
      session.peer = await this.backend.createPeer({
        offerSdp: sdp,
        sendSignal: (type, fields) => this.sendSignal(type, { sessionId, ...fields }),
        onDataChannel: (channel) => this.wireDataChannel(session, channel),
        session,
      });
      // Native mode: feed the video track right away (no datachannel needed).
      if (this.backend.mode === 'native') {
        this.startFramePump(session);
      }
      // Flush any ICE candidates that arrived while the answer was being made.
      const pending = session.pendingIce.splice(0);
      for (const candidate of pending) {
        try {
          session.peer.addIceCandidate(candidate);
        } catch (err) {
          this.logWarn(`addIceCandidate (queued) failed for ${sessionId}: ${err?.message ?? err}`);
        }
      }
      this.log(`session ${sessionId}: answered offer (${this.backend.mode} mode)`);
    } catch (err) {
      this.logWarn(`failed to answer offer for ${sessionId}: ${err?.message ?? err}`);
      this.sendSignal('session.reject', { sessionId, reason: 'capture_unavailable' });
      this.teardown(sessionId);
    }
  }

  onSignalIce(payload) {
    const { sessionId } = payload;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logWarn(`signal.ice for unknown session ${sessionId}; ignoring`);
      return;
    }
    if (!session.peer) {
      // The answer is still being prepared — queue and flush once it exists.
      session.pendingIce.push(payload);
      return;
    }
    try {
      session.peer.addIceCandidate(payload);
    } catch (err) {
      this.logWarn(`addIceCandidate failed for ${sessionId}: ${err?.message ?? err}`);
    }
  }

  onSessionEnded(payload) {
    const { sessionId, reason } = payload;
    this.log(`session ${sessionId} ended (${reason ?? 'unknown'})`);
    this.teardown(sessionId);
  }

  teardown(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.clipboardTimer) clearInterval(session.clipboardTimer);
    session.clipboardTimer = null;
    try { session.pump?.stop(); } catch { /* already gone */ }
    session.pump = null;
    try { session.peer?.close(); } catch { /* already gone */ }
    session.peer = null;
    session.channel = null;
  }

  teardownAll() {
    for (const id of [...this.sessions.keys()]) this.teardown(id);
  }

  // ---- data channel -----------------------------------------------------------

  wireDataChannel(session, channel) {
    session.channel = channel;
    this.log(`session ${session.id}: data channel open (${channel.label ?? 'default'})`);

    channel.onopen = () => this.onChannelReady(session);
    channel.onmessage = (event) => {
      const { data } = event;
      if (typeof data === 'string') {
        this.onControlMessage(session, data);
      } else {
        // Binary from the client is not expected; ignore.
        this.logWarn(`session ${session.id}: ignoring binary data-channel message (${data?.byteLength ?? '?'} bytes)`);
      }
    };
    channel.onclose = () => {
      this.log(`session ${session.id}: data channel closed`);
      // The phone went away without hanging up (app killed, network lost):
      // record the end so the session does not stay "accepted" forever.
      if (this.sessions.has(session.id)) {
        this.sendSignal('session.end', { sessionId: session.id, reason: 'peer_closed' });
      }
      this.teardown(session.id);
    };
    channel.onerror = (err) => {
      this.logWarn(`session ${session.id}: data channel error: ${err?.message ?? 'unknown'}`);
    };
    // Some stacks report the channel as already open when the event fires.
    if (channel.readyState === undefined || channel.readyState === 'open') {
      this.onChannelReady(session);
    }
  }

  onChannelReady(session) {
    // Both `onopen` and the "already open" check can fire for the same
    // channel; run the setup once or the clipboard poller leaks a timer.
    if (session.channelReady) return;
    session.channelReady = true;
    // Push the current clipboard once so the client starts in sync.
    if (this.clipboard?.clipboardInfo?.().available !== false) {
      this.pushClipboard(session).catch(() => {});
      session.clipboardTimer = setInterval(() => {
        this.pushClipboard(session).catch(() => {});
      }, CLIPBOARD_POLL_MS);
      session.clipboardTimer.unref?.();
    }
    // Degraded mode: stream JPEG frames over the data channel. In native mode
    // the video track is fed directly (pump started with the peer).
    if (this.backend.mode === 'jpeg') {
      this.startFramePump(session);
    }
  }

  async pushClipboard(session) {
    if (!session.channel) return;
    const text = await this.clipboard.readText();
    if (text === session.lastClipboardSent || text === session.lastClipboardReceived) return;
    session.lastClipboardSent = text;
    this.sendChannel(session, { t: 'clipboard.set', text });
  }

  startFramePump(session) {
    if (session.pump) return;
    const settings = this.resolveQuality(session);
    session.pump = new ScreenFramePump({
      onFrame: (frame) => {
        if (this.backend.mode === 'native') {
          // Native mode: the peer converts BGRA → I420 into the video track.
          session.peer?.pushFrame(frame);
        } else {
          // Degraded mode: BGRA → RGBA → JPEG (pure-JS encoder) → data channel.
          this.sendJpegFrame(session, frame);
        }
      },
      onError: (err) => this.logWarn(`session ${session.id}: capture error: ${err?.message ?? err}`),
      log: (...args) => this.log(`[capture] ${args.join(' ')}`),
    });
    session.pump.configure(settings);
    const how = this.backend.mode === 'native' ? 'video track feed' : 'JPEG stream over data channel';
    this.log(`session ${session.id}: ${how} started (${settings.width}w @${settings.fps}fps)`);
  }

  /** Encode a raw BGRA frame to JPEG and chunk it onto the data channel. */
  sendJpegFrame(session, { width, height, data }) {
    const channel = session.channel;
    if (!channel || channel.readyState === 'closing' || channel.readyState === 'closed') return;
    let jpeg;
    try {
      const rgba = bgraToRgba(data, width * height);
      jpeg = jpegJs.encode({ data: rgba, width, height }, session.quality?.jpegQuality ?? 55).data;
    } catch (err) {
      this.logWarn(`session ${session.id}: JPEG encode failed: ${err?.message ?? err}`);
      return;
    }
    // Binary framing: [type:1][flags:1][seq:2 LE] + payload chunks (≤16 KiB).
    // flags bit0 = final chunk. Sequence increments per frame.
    if (!Number.isInteger(session.frameSeq)) session.frameSeq = 0;
    const seq = session.frameSeq++ & 0xffff;
    for (let offset = 0; offset < jpeg.length; offset += JPEG_CHUNK_SIZE) {
      const end = Math.min(offset + JPEG_CHUNK_SIZE, jpeg.length);
      const head = Buffer.alloc(4);
      head.writeUInt8(BINARY_TYPE_JPEG, 0);
      head.writeUInt8(end >= jpeg.length ? 1 : 0, 1);
      head.writeUInt16LE(seq, 2);
      const chunk = Buffer.concat([head, jpeg.subarray(offset, end)]);
      try {
        channel.send(chunk);
      } catch {
        return; // channel died; teardown happens via onclose
      }
    }
  }

  sendChannel(session, obj) {
    if (!session.channel) return;
    try {
      session.channel.send(JSON.stringify(obj));
    } catch { /* channel gone */ }
  }

  sendChannelError(session, requestType, message) {
    this.sendChannel(session, { t: 'error', request: requestType, message: String(message).slice(0, 300) });
  }

  // ---- control messages ---------------------------------------------------------

  onControlMessage(session, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logWarn(`session ${session.id}: dropping non-JSON control message`);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.logWarn(`session ${session.id}: dropping malformed control message`);
      return;
    }
    // `t` is the canonical discriminator (docs/DATA_CHANNEL.md); `type` is
    // tolerated as a legacy alias from older clients.
    const kind = typeof msg.t === 'string' ? msg.t : (typeof msg.type === 'string' ? msg.type : '');
    if (!kind) {
      this.logWarn(`session ${session.id}: dropping control message without a "t" kind`);
      return;
    }
    try {
      this.dispatchControl(session, kind, msg);
    } catch (err) {
      this.logWarn(`session ${session.id}: ${kind} failed: ${err?.message ?? err}`);
      this.sendChannelError(session, kind, err?.message ?? String(err));
    }
  }

  dispatchControl(session, type, msg) {
    switch (type) {
      // -- input (canonical shapes, docs/DATA_CHANNEL.md) --
      case 'pointer.move': {
        const dx = Number.isFinite(Number(msg.dx)) ? Number(msg.dx) : 0;
        const dy = Number.isFinite(Number(msg.dy)) ? Number(msg.dy) : 0;
        this.input.moveRel(dx, dy)
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'pointer.abs': {
        const inRange = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
        if (!inRange(msg.x) || !inRange(msg.y)) throw new Error('pointer.abs needs x,y in 0..1');
        this.input.moveAbs(Number(msg.x), Number(msg.y), { normalized: true })
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'click': {
        const button = typeof msg.button === 'string' ? msg.button : 'left';
        const inRange = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
        const seq = [];
        if (inRange(msg.x) && inRange(msg.y)) {
          seq.push(() => this.input.moveAbs(Number(msg.x), Number(msg.y), { normalized: true }));
        }
        seq.push(() => this.input.click(button));
        seq.reduce((p, fn) => p.then(fn), Promise.resolve())
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'button': {
        const button = typeof msg.button === 'string' ? msg.button : 'left';
        if (typeof msg.down !== 'boolean') throw new Error('button.down must be a boolean');
        this.input.button(button, msg.down)
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'wheel': {
        const dx = Number.isFinite(Number(msg.dx)) ? Number(msg.dx) : 0;
        const dy = Number.isFinite(Number(msg.dy)) ? Number(msg.dy) : 0;
        this.input.scroll(dx, dy)
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'key':
        return this.handleKey(session, msg);
      case 'text': {
        if (typeof msg.text !== 'string') throw new Error('text must be a string');
        this.input.typeText(msg.text).catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }

      // -- agent-only extensions (documented in docs/DATA_CHANNEL.md) --
      case 'input.media': {
        if (typeof msg.key !== 'string') throw new Error('key must be a string');
        this.input.mediaKey(msg.key).catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'input.ctrlaltdel':
        this.input.ctrlAltDel().catch((err) => this.sendChannelError(session, type, err.message));
        return;

      // -- clipboard --
      case 'clipboard.set': {
        if (typeof msg.text !== 'string') throw new Error('text must be a string');
        session.lastClipboardReceived = msg.text;
        this.clipboard.writeText(msg.text).catch((err) => this.sendChannelError(session, type, err.message));
        return;
      }
      case 'clipboard.get':
        this.clipboard.readText()
          .then((text) => {
            session.lastClipboardSent = text;
            // The reply reuses the clipboard.set shape (docs/DATA_CHANNEL.md).
            this.sendChannel(session, { t: 'clipboard.set', text });
          })
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;

      // -- quality / stats --
      case 'quality.set':
        return this.handleQualitySet(session, msg);
      case 'stats.ping':
        return this.handleStatsPing(session, msg);

      // -- system --
      case 'screenshot.request':
        this.system.screenshot({ maxWidth: Number(msg.maxWidth) || 0 })
          .then((result) => this.sendChannel(session, { t: 'screenshot.result', ok: true, path: result.path }))
          .catch((err) => this.sendChannel(session, { t: 'screenshot.result', ok: false, error: String(err.message).slice(0, 300) }));
        return;
      case 'system.info':
        this.system.systemInfo()
          .then((info) => this.sendChannel(session, { t: 'system.info.result', info }))
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      case 'system.displays':
        this.system.displayList()
          .then((result) => this.sendChannel(session, { t: 'system.displays.result', ...result }))
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      case 'system.processes':
        this.system.processList()
          .then((result) => this.sendChannel(session, { t: 'system.processes.result', ...result }))
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;
      case 'system.kill': {
        const pid = Number(msg.pid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
        this.system.killProcess(pid)
          .then(() => this.sendChannel(session, { t: 'system.kill.result', ok: true, pid }))
          .catch((err) => this.sendChannel(session, { t: 'system.kill.result', ok: false, pid, error: String(err.message).slice(0, 300) }));
        return;
      }
      case 'system.power': {
        if (typeof msg.action !== 'string') throw new Error('action must be a string');
        this.system.powerAction(msg.action)
          .then(() => this.sendChannel(session, { t: 'system.power.result', ok: true, action: msg.action }))
          .catch((err) => this.sendChannel(session, { t: 'system.power.result', ok: false, action: msg.action, error: String(err.message).slice(0, 300) }));
        return;
      }
      case 'system.beep':
        this.system.findMeBeep()
          .then(() => this.sendChannel(session, { t: 'system.beep.result', ok: true }))
          .catch((err) => this.sendChannelError(session, type, err.message));
        return;

      default:
        // Unknown control types are logged and ignored.
        this.logWarn(`session ${session.id}: ignoring unknown control message type ${type.slice(0, 64)}`);
    }
  }

  handleKey(session, msg) {
    if (typeof msg.code !== 'string') throw new Error('code must be a string');
    if (typeof msg.down !== 'boolean') throw new Error('down must be a boolean');
    const keyName = keyNameForCode(msg.code);
    if (!keyName) throw new Error(`unknown key code: ${msg.code.slice(0, 32)}`);
    const modifiers = Array.isArray(msg.modifiers) ? msg.modifiers : [];
    this.input.keyToggle(keyName, msg.down, modifiers)
      .catch((err) => this.sendChannelError(session, 'key', err.message));
  }

  resolveQuality(session) {
    if (session.quality) return session.quality;
    const level = this.backend.defaultQuality ?? 'high';
    session.quality = { level, ...QUALITY_PRESETS[level] };
    return session.quality;
  }

  handleQualitySet(session, msg) {
    let level = typeof msg.level === 'string' ? msg.level.toLowerCase() : '';
    // Internal adaptive steps pass `fromAdaptive`; an explicit client choice
    // switches adaptive mode on ('adaptive') or off (fixed level / custom).
    if (!msg.fromAdaptive) session.adaptive = level === 'adaptive';
    if (level === 'adaptive') {
      const current = session.quality?.level;
      level = current && QUALITY_PRESETS[current] ? current : ADAPTIVE_DEFAULT;
    }
    if (!QUALITY_PRESETS[level]) {
      // Allow explicit overrides: { level: 'custom', width, fps, jpegQuality }
      if (level === 'custom' && (Number.isFinite(Number(msg.width)) || Number.isFinite(Number(msg.fps)))) {
        const current = this.resolveQuality(session);
        session.quality = {
          ...current,
          level: 'custom',
          width: Number.isFinite(Number(msg.width)) ? Math.max(160, Math.min(3840, Number(msg.width))) : current.width,
          fps: Number.isFinite(Number(msg.fps)) ? Math.max(1, Math.min(60, Number(msg.fps))) : current.fps,
          jpegQuality: Number.isFinite(Number(msg.jpegQuality)) ? Math.max(10, Math.min(95, Number(msg.jpegQuality))) : current.jpegQuality,
        };
      } else {
        throw new Error(`unknown quality level: ${msg.level}`);
      }
    } else {
      session.quality = { level, ...QUALITY_PRESETS[level] };
    }
    session.lastAdaptiveChange = Date.now();
    if (session.pump) session.pump.configure(session.quality);
    this.log(`session ${session.id}: quality set to ${session.quality.level} (${session.quality.width}w @${session.quality.fps}fps)`);
    this.sendChannel(session, { t: 'quality.ack', quality: session.quality, adaptive: session.adaptive });
  }

  handleStatsPing(session, msg) {
    // Adaptive quality: the client may report its measured round-trip time.
    if (msg.rttMs !== undefined && session.adaptive && session.quality?.level !== 'custom') {
      const rtt = Number(msg.rttMs);
      if (Number.isFinite(rtt) && Date.now() - session.lastAdaptiveChange > ADAPTIVE_MIN_INTERVAL_MS) {
        const idx = ADAPTIVE_ORDER.indexOf(session.quality?.level ?? ADAPTIVE_DEFAULT);
        if (rtt > ADAPTIVE_STEP_DOWN_RTT_MS && idx > 0) {
          this.handleQualitySet(session, { level: ADAPTIVE_ORDER[idx - 1], fromAdaptive: true });
        } else if (rtt < ADAPTIVE_STEP_UP_RTT_MS && idx >= 0 && idx < ADAPTIVE_ORDER.length - 1) {
          this.handleQualitySet(session, { level: ADAPTIVE_ORDER[idx + 1], fromAdaptive: true });
        }
      }
    }
    this.sendChannel(session, {
      t: 'stats.pong',
      seq: msg.seq ?? null,
      now: Date.now(),
      mode: this.backend.mode,
      quality: session.quality ?? null,
      sessions: this.count,
    });
  }

  // ---- device commands (relay-level, session-independent) ----------------------
  //
  // device.command (PROTOCOL.md 5) reaches the agent outside any session so
  // quick actions work without a live remote-desktop stream. Results go back
  // as device.command.result events correlated by commandId.

  handleDeviceCommand(payload) {
    const commandId = typeof payload.commandId === 'string' ? payload.commandId : '';
    const command = typeof payload.command === 'string' ? payload.command : '';
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? payload.params
      : {};
    if (!commandId || !command) {
      this.logWarn('dropping device.command without commandId/command');
      return;
    }
    this.executeDeviceCommand(command, params)
      .then((result) => this.sendSignal('device.command.result', { commandId, ok: true, command, result }))
      .catch((err) => this.sendSignal('device.command.result', {
        commandId,
        ok: false,
        command,
        error: String(err?.message ?? err).slice(0, 300),
      }));
  }

  async executeDeviceCommand(command, params) {
    switch (command) {
      case 'lock':
      case 'shutdown':
      case 'restart':
      case 'hibernate':
        await this.system.powerAction(command);
        return {};
      case 'logoff':
        // The agent's power action is called "signout"; the protocol name is logoff.
        await this.system.powerAction('signout');
        return {};
      case 'volume_up':
      case 'volume_down': {
        const steps = Math.max(1, Math.min(50, Math.floor(Number(params.steps)) || 1));
        await this.system.volume(command === 'volume_up' ? 'up' : 'down', steps);
        return { steps };
      }
      case 'mute':
        await this.system.volume('mute');
        return {};
      case 'beep':
        await this.system.findMeBeep();
        return {};
      case 'screenshot': {
        const maxWidth = Number(params.maxWidth) || 0;
        const shot = await this.system.screenshot({ maxWidth });
        return { path: shot.path };
      }
      case 'process_list':
        return this.system.processList();
      case 'process_kill': {
        const pid = Number(params.pid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('params.pid must be a positive integer');
        await this.system.killProcess(pid);
        return { pid };
      }
      case 'sysinfo': {
        const info = await this.system.systemInfo();
        return { info };
      }
      default:
        throw new Error(`unknown command: ${String(command).slice(0, 64)}`);
    }
  }
}
