// Remote PC Controller — self-hosted relay server.
//
// Responsibilities:
//   - Account auth (register/login, scrypt + HS256 JWT)
//   - Device registry with heartbeat-based online status
//   - 6-digit one-time PIN pairing (mobile user <-> Windows agent)
//   - WebRTC signaling relay (offer/answer/ICE) between a user and their device
//   - TURN/STUN configuration endpoint
//   - Optional TLS termination (wss://) via RELAY_TLS_CERT / RELAY_TLS_KEY
//
// REST is used only for register / login / turn / health. Everything after
// auth flows over the WebSocket as JSON messages — see PROTOCOL.md.

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { JsonStore } from './store.js';
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  signJwt,
  verifyJwt,
  sha256hex,
  safeEqualHex,
  safeEqualString,
  randomTokenHex,
} from './auth.js';

const RELAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Timing / limits -------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 15_000; // agents heartbeat every 15s
const OFFLINE_AFTER_MS = 45_000;      // considered offline after 45s of silence
const PAIRING_TTL_MS = 5 * 60 * 1000; // pairing code expires after 5 minutes
const MAX_FAILED_CLAIMS_PER_CODE = 5; // a code burns after 5 failed claims
const MAX_ACTIVE_CODES_PER_USER = 3;
const JWT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;
const MAX_NAME_LEN = 64;
const MAX_SHORT_LEN = 32;
const MAX_SDP_LEN = 64 * 1024;

// ---- Config ----------------------------------------------------------------

function resolveConfig(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = path.resolve(options.dataDir ?? env.RELAY_DATA_DIR ?? path.join(RELAY_ROOT, 'data'));
  const tlsCert = env.RELAY_TLS_CERT ? path.resolve(env.RELAY_TLS_CERT) : null;
  const tlsKey = env.RELAY_TLS_KEY ? path.resolve(env.RELAY_TLS_KEY) : null;
  const stunUrls = (env.RELAY_STUN_URLS ??
    'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(options.port ?? env.PORT ?? 8080),
    host: options.host ?? env.HOST ?? '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'db.json'),
    jwtSecret: options.jwtSecret ?? env.RELAY_JWT_SECRET ?? loadOrCreateSecret(dataDir),
    tlsCert,
    tlsKey,
    stunUrls,
    turnUrl: env.RELAY_TURN_URL ?? null,
    turnUsername: env.RELAY_TURN_USERNAME ?? null,
    turnCredential: env.RELAY_TURN_CREDENTIAL ?? null,
  };
}

function loadOrCreateSecret(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

// ---- Rate limiting (in-memory, per key) -------------------------------------

function createRateLimiter(limit, windowMs) {
  const hits = new Map(); // key -> timestamps[]
  return (key) => {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) { arr = []; hits.set(key, arr); }
    while (arr.length > 0 && now - arr[0] >= windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (v.length === 0 || now - v[v.length - 1] >= windowMs) hits.delete(k);
      }
    }
    return true;
  };
}

// ---- Helpers ----------------------------------------------------------------

function nowMs() { return Date.now(); }

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  // Strip control characters, collapse whitespace, clamp length.
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LEN);
}

function sanitizeShort(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_SHORT_LEN);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// ---- Server -----------------------------------------------------------------

/**
 * Create and start the relay server.
 * @returns {{ server: import('node:http').Server, port: number, config: object,
 *             store: JsonStore, close: () => Promise<void> }}
 */
export function startServer(options = {}) {
  const config = resolveConfig(options);
  const store = new JsonStore(config.dbPath, {
    version: 1,
    users: [],        // { id, email, emailLower, passHash, createdAt }
    devices: [],      // { id, name, os, ownerUserId, tokenHash, createdAt, lastSeen, version }
    pairingCodes: [], // { code, userId, expiresAt, used, failedAttempts, createdAt }
    claimFailures: [],// { code, count, updatedAt } — persisted anti-brute-force counters
  });

  const log = (...args) => console.log(`[relay ${new Date().toISOString()}]`, ...args);

  // In-memory runtime state (never persisted)
  const userSockets = new Map();   // userId -> Set<ws>
  const deviceSockets = new Map(); // deviceId -> ws
  const sessions = new Map();      // sessionId -> { id, deviceId, userId, clientWs, deviceWs, state, createdAt }
  const lastOnlineStatus = new Map(); // deviceId -> boolean (for change broadcast)
  const pendingCommands = new Map();  // commandId -> { clientWs, msgId, deviceId, command, timer }

  const authLimiter = createRateLimiter(30, 60_000);   // register/login per IP
  const claimLimiter = createRateLimiter(10, 60_000);  // pairing.claim per IP

  // ---- Small utilities ----

  function send(ws, type, payload = {}) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ type, payload })); } catch { /* socket gone */ }
  }

  function sendError(ws, msg, code, message) {
    send(ws, 'error', { replyTo: msg && msg.id !== undefined ? msg.id : null, code, message });
  }

  function sendOk(ws, msg, extra = {}) {
    send(ws, 'ok', { replyTo: msg && msg.id !== undefined ? msg.id : null, ...extra });
  }

  function isDeviceOnline(device) {
    const ws = deviceSockets.get(device.id);
    return Boolean(ws && ws.readyState === 1 && nowMs() - device.lastSeen <= OFFLINE_AFTER_MS);
  }

  function publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      os: device.os,
      online: isDeviceOnline(device),
      lastSeen: device.lastSeen,
      version: device.version,
      createdAt: device.createdAt,
    };
  }

  function findDevice(id) {
    return store.data.devices.find((d) => d.id === id) ?? null;
  }

  function ownedDevice(userId, deviceId) {
    if (typeof deviceId !== 'string') return null;
    const device = findDevice(deviceId);
    return device && device.ownerUserId === userId ? device : null;
  }

  function broadcastToUser(userId, type, payload) {
    const set = userSockets.get(userId);
    if (!set) return;
    for (const ws of set) send(ws, type, payload);
  }

  function setDeviceOnline(deviceId, online, reason) {
    if (lastOnlineStatus.get(deviceId) === online) return;
    lastOnlineStatus.set(deviceId, online);
    const device = findDevice(deviceId);
    if (device) {
      broadcastToUser(device.ownerUserId, 'device.status', {
        deviceId, online, lastSeen: device.lastSeen, reason: reason ?? null,
      });
    }
  }

  function endSession(sessionId, reason, notifyExceptWs = null) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    for (const ws of [session.clientWs, session.deviceWs]) {
      if (ws && ws !== notifyExceptWs && ws.readyState === 1) {
        send(ws, 'session.ended', { sessionId, reason: reason ?? null });
      }
    }
  }

  function endSessionsForDevice(deviceId, reason) {
    for (const session of [...sessions.values()]) {
      if (session.deviceId === deviceId) endSession(session.id, reason);
    }
  }

  // ---- WebSocket message handlers ----

  function handleAuthUser(ws, msg) {
    const token = msg.payload?.token;
    if (typeof token !== 'string') {
      return sendError(ws, msg, 'invalid_token', 'payload.token must be a string');
    }
    const claims = verifyJwt(token, config.jwtSecret);
    if (!claims) return sendError(ws, msg, 'invalid_token', 'token is invalid or expired');

    ws.state.kind = 'user';
    ws.state.userId = claims.sub;
    if (!userSockets.has(claims.sub)) userSockets.set(claims.sub, new Set());
    userSockets.get(claims.sub).add(ws);

    sendOk(ws, msg, { userId: claims.sub });
    log(`user ${claims.sub} authenticated`);
  }

  function handleAuthAgent(ws, msg) {
    const p = msg.payload ?? {};
    const deviceId = typeof p.deviceId === 'string' ? p.deviceId : '';
    const token = typeof p.token === 'string' ? p.token : '';
    const device = findDevice(deviceId);
    // Always run the comparison to keep timing uniform for unknown devices.
    const storedHash = device ? device.tokenHash : sha256hex(randomTokenHex(32));
    const ok = device && safeEqualHex(sha256hex(token), storedHash);
    if (!ok) return sendError(ws, msg, 'invalid_device_token', 'unknown deviceId or bad token');

    // Replace any existing connection for this device.
    const old = deviceSockets.get(deviceId);
    if (old && old !== ws && old.readyState === 1) {
      old.state.kind = 'pending'; // stop it from touching state on its way out
      endSessionsForDevice(deviceId, 'device_reconnected');
      old.close(4000, 'replaced by a new agent connection');
    }

    ws.state.kind = 'agent';
    ws.state.deviceId = deviceId;
    deviceSockets.set(deviceId, ws);

    device.lastSeen = nowMs();
    if (p.name !== undefined) {
      const name = sanitizeName(p.name);
      if (name) device.name = name;
    }
    if (p.os !== undefined) {
      const os = sanitizeShort(p.os);
      if (os) device.os = os;
    }
    if (p.version !== undefined) {
      const version = sanitizeShort(p.version);
      device.version = version || null;
    }
    store.save();

    setDeviceOnline(deviceId, true, 'agent_connected');
    sendOk(ws, msg, { deviceId, name: device.name });
    log(`device ${deviceId} (${device.name}) online`);
  }

  function handlePairingRequest(ws, msg) {
    const userId = ws.state.userId;
    // Drop the requester's oldest codes when they hoard them.
    const mine = store.data.pairingCodes
      .filter((c) => c.userId === userId && !c.used)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_ACTIVE_CODES_PER_USER) {
      const oldest = mine.shift();
      oldest.used = true; // superseded
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const entry = {
      code,
      userId,
      expiresAt: nowMs() + PAIRING_TTL_MS,
      used: false,
      failedAttempts: 0,
      createdAt: nowMs(),
    };
    store.data.pairingCodes.push(entry);
    // Keep the persisted list bounded.
    if (store.data.pairingCodes.length > 500) {
      store.data.pairingCodes = store.data.pairingCodes.filter(
        (c) => (!c.used && c.expiresAt > nowMs()) || c === entry,
      );
    }
    store.save();
    sendOk(ws, msg, { code, expiresAt: entry.expiresAt, ttlMs: PAIRING_TTL_MS });
    log(`pairing code issued for user ${userId}`);
  }

  function recordClaimFailure(codeStr) {
    // Failed claims are counted per attempted code string and persisted in the
    // JSON store so brute-force counting survives a restart (PROTOCOL.md 2.1).
    // The count is mirrored onto any stored pairing code with that value; at
    // the documented limit any live code with that value is burned.
    const key = String(codeStr ?? '').slice(0, 16);
    let record = store.data.claimFailures.find((f) => f.code === key);
    if (!record) {
      record = { code: key, count: 0, updatedAt: nowMs() };
      store.data.claimFailures.push(record);
    }
    record.count += 1;
    record.updatedAt = nowMs();
    // Keep the persisted list bounded.
    if (store.data.claimFailures.length > 5000) {
      const cutoff = nowMs() - 10 * 60_000;
      store.data.claimFailures = store.data.claimFailures.filter(
        (f) => f.updatedAt >= cutoff || f === record,
      );
    }
    for (const c of store.data.pairingCodes) {
      if (c.code === key) c.failedAttempts = record.count;
    }
    if (record.count >= MAX_FAILED_CLAIMS_PER_CODE) {
      // Burn any live code with this value; forget the counter.
      for (const c of store.data.pairingCodes) {
        if (c.code === key && !c.used) c.used = true;
      }
      store.data.claimFailures = store.data.claimFailures.filter((f) => f !== record);
    }
    store.save();
  }

  function handlePairingClaim(ws, msg) {
    const p = msg.payload ?? {};
    if (!claimLimiter(ws.state.ip)) {
      return sendError(ws, msg, 'rate_limited', 'too many pairing attempts, slow down');
    }
    const code = typeof p.code === 'string' ? p.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      recordClaimFailure(code.slice(0, 16));
      return sendError(ws, msg, 'invalid_code', 'pairing code must be 6 digits');
    }
    const entry = store.data.pairingCodes.find(
      (c) => safeEqualString(c.code, code) && !c.used,
    );
    if (!entry) {
      recordClaimFailure(code);
      return sendError(ws, msg, 'invalid_or_expired_code', 'pairing code is invalid, expired, or burned');
    }
    if (entry.expiresAt <= nowMs()) {
      recordClaimFailure(code);
      entry.used = true;
      store.save();
      return sendError(ws, msg, 'invalid_or_expired_code', 'pairing code has expired');
    }
    if (entry.failedAttempts >= MAX_FAILED_CLAIMS_PER_CODE) {
      entry.used = true;
      store.save();
      return sendError(ws, msg, 'invalid_or_expired_code', 'pairing code burned after too many failed claims');
    }

    // Claim succeeds: create the device and issue its persistent token once.
    const token = randomTokenHex(32);
    const device = {
      id: crypto.randomUUID(),
      name: sanitizeName(p.name) || 'New device',
      os: sanitizeShort(p.os) || 'unknown',
      ownerUserId: entry.userId,
      tokenHash: sha256hex(token),
      createdAt: nowMs(),
      lastSeen: nowMs(),
      version: sanitizeShort(p.version) || null,
    };
    store.data.devices.push(device);
    entry.used = true;
    store.save();

    // The agent just proved possession of the freshly issued token, so the
    // claiming socket is authenticated as this device immediately.
    ws.state.kind = 'agent';
    ws.state.deviceId = device.id;
    deviceSockets.set(device.id, ws);
    setDeviceOnline(device.id, true, 'paired');

    sendOk(ws, msg, {
      deviceId: device.id,
      token, // sent exactly once; never stored in plaintext, never logged
      name: device.name,
      ownerUserId: device.ownerUserId,
    });
    log(`device ${device.id} (${device.name}) paired for user ${device.ownerUserId}`);
  }

  function handleDeviceList(ws, msg) {
    const userId = ws.state.userId;
    const devices = store.data.devices
      .filter((d) => d.ownerUserId === userId)
      .map(publicDevice);
    sendOk(ws, msg, { devices });
  }

  function handleDeviceUpdate(ws, msg) {
    const p = msg.payload ?? {};
    const device = ownedDevice(ws.state.userId, p.deviceId);
    if (!device) return sendError(ws, msg, 'not_found', 'device not found or not owned by you');
    const name = sanitizeName(p.name);
    if (!name) return sendError(ws, msg, 'bad_request', 'payload.name must be a non-empty string');
    device.name = name;
    store.save();
    sendOk(ws, msg, { deviceId: device.id, name: device.name });
    broadcastToUser(device.ownerUserId, 'device.updated', { deviceId: device.id, name: device.name });
  }

  function handleDeviceDelete(ws, msg) {
    const p = msg.payload ?? {};
    const device = ownedDevice(ws.state.userId, p.deviceId);
    if (!device) return sendError(ws, msg, 'not_found', 'device not found or not owned by you');
    store.data.devices = store.data.devices.filter((d) => d.id !== device.id);
    store.save();
    endSessionsForDevice(device.id, 'device_deleted');
    const agentWs = deviceSockets.get(device.id);
    deviceSockets.delete(device.id);
    lastOnlineStatus.delete(device.id);
    if (agentWs && agentWs.readyState === 1) agentWs.close(4001, 'device deleted');
    sendOk(ws, msg, { deviceId: device.id });
    broadcastToUser(device.ownerUserId, 'device.deleted', { deviceId: device.id });
    log(`device ${device.id} deleted by user ${device.ownerUserId}`);
  }

  function handleSessionStart(ws, msg) {
    const p = msg.payload ?? {};
    const device = ownedDevice(ws.state.userId, p.deviceId);
    if (!device) return sendError(ws, msg, 'not_found', 'device not found or not owned by you');
    const deviceWs = deviceSockets.get(device.id);
    if (!isDeviceOnline(device) || !deviceWs || deviceWs.readyState !== 1) {
      return sendError(ws, msg, 'device_offline', 'device is not online');
    }
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      deviceId: device.id,
      userId: ws.state.userId,
      clientWs: ws,
      deviceWs,
      state: 'requested',
      createdAt: nowMs(),
    };
    sessions.set(sessionId, session);
    sendOk(ws, msg, { sessionId, deviceId: device.id });
    // The device is pre-authorized by its token: no local confirmation needed.
    // The reference agent answers session.accept immediately.
    send(deviceWs, 'session.request', { sessionId, deviceId: device.id });
    log(`session ${sessionId} requested for device ${device.id}`);
  }

  function handleSessionAccept(ws, msg) {
    const p = msg.payload ?? {};
    const session = sessions.get(p.sessionId);
    if (!session || session.deviceWs !== ws) {
      return sendError(ws, msg, 'not_found', 'no such session for this device');
    }
    session.state = 'accepted';
    send(session.clientWs, 'session.accepted', { sessionId: session.id });
  }

  function handleSessionReject(ws, msg) {
    const p = msg.payload ?? {};
    const session = sessions.get(p.sessionId);
    if (!session || session.deviceWs !== ws) {
      return sendError(ws, msg, 'not_found', 'no such session for this device');
    }
    endSession(session.id, typeof p.reason === 'string' ? p.reason : 'rejected');
  }

  function handleSessionEnd(ws, msg) {
    const p = msg.payload ?? {};
    const session = sessions.get(p.sessionId);
    if (!session || (ws !== session.clientWs && ws !== session.deviceWs)) {
      return sendError(ws, msg, 'not_found', 'no such session');
    }
    endSession(session.id, 'ended_by_peer', ws);
  }

  // Signal relay: offer/answer/ICE between the two participants of a session.
  const SIGNAL_FIELDS = {
    'signal.offer': ['sdp'],
    'signal.answer': ['sdp'],
    'signal.ice': ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'],
  };

  function handleSignal(ws, msg) {
    const p = msg.payload ?? {};
    const session = sessions.get(p.sessionId);
    if (!session) return sendError(ws, msg, 'not_found', 'no such session');
    const fromClient = ws === session.clientWs;
    const fromDevice = ws === session.deviceWs;
    if (!fromClient && !fromDevice) {
      return sendError(ws, msg, 'forbidden', 'you are not a participant in this session');
    }
    const target = fromClient ? session.deviceWs : session.clientWs;
    if (!target || target.readyState !== 1) {
      return sendError(ws, msg, 'peer_offline', 'the other peer is not connected');
    }
    // Whitelist + validate fields; never echo arbitrary payload keys.
    const out = { sessionId: session.id };
    for (const field of SIGNAL_FIELDS[msg.type]) {
      if (p[field] === undefined) continue;
      if (typeof p[field] === 'string' && p[field].length <= MAX_SDP_LEN) {
        out[field] = p[field];
      }
    }
    if (msg.type === 'signal.offer' || msg.type === 'signal.answer') {
      if (typeof out.sdp !== 'string' || out.sdp.length === 0) {
        return sendError(ws, msg, 'bad_request', `payload.sdp is required for ${msg.type}`);
      }
    } else if (typeof out.candidate !== 'string' || out.candidate.length === 0) {
      return sendError(ws, msg, 'bad_request', 'payload.candidate is required for signal.ice');
    }
    send(target, msg.type, out);
  }

  function handleHeartbeat(ws, msg) {
    const device = findDevice(ws.state.deviceId);
    if (device) {
      device.lastSeen = nowMs();
      store.save();
    }
    sendOk(ws, msg, { serverTime: nowMs() });
  }

  // ---- device commands (quick actions without a session) ----

  // Whitelist: only these command names are ever forwarded to a device.
  const DEVICE_COMMANDS = new Set([
    'lock', 'shutdown', 'hibernate', 'restart', 'logoff',
    'volume_up', 'volume_down', 'mute', 'beep',
    'screenshot', 'process_list', 'process_kill', 'sysinfo',
  ]);
  const COMMAND_TIMEOUT_MS = 30_000;
  const MAX_COMMAND_PARAMS_JSON = 4 * 1024;

  function handleDeviceCommand(ws, msg) {
    const p = msg.payload ?? {};
    const device = ownedDevice(ws.state.userId, p.deviceId);
    if (!device) return sendError(ws, msg, 'not_found', 'device not found or not owned by you');
    const deviceWs = deviceSockets.get(device.id);
    if (!isDeviceOnline(device) || !deviceWs || deviceWs.readyState !== 1) {
      return sendError(ws, msg, 'device_offline', 'device is not online');
    }
    const command = typeof p.command === 'string' ? p.command : '';
    if (!DEVICE_COMMANDS.has(command)) {
      return sendError(ws, msg, 'unknown_command', `unknown command: ${command.slice(0, 64) || '(missing)'}`);
    }
    let params = {};
    if (p.params !== undefined) {
      if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) {
        return sendError(ws, msg, 'bad_request', 'payload.params must be an object when present');
      }
      if (JSON.stringify(p.params).length > MAX_COMMAND_PARAMS_JSON) {
        return sendError(ws, msg, 'bad_request', 'payload.params is too large');
      }
      params = p.params;
    }
    // No immediate reply: the ok/error reply is correlated to the user's `id`
    // once the device reports device.command.result (or the request times out).
    const commandId = crypto.randomUUID();
    const pending = {
      clientWs: ws,
      msgId: msg.id,
      deviceId: device.id,
      command,
      timer: setTimeout(() => {
        pendingCommands.delete(commandId);
        sendError(ws, msg, 'command_timeout', 'device did not report a command result in time');
      }, COMMAND_TIMEOUT_MS),
    };
    if (pending.timer.unref) pending.timer.unref();
    pendingCommands.set(commandId, pending);
    send(deviceWs, 'device.command', { commandId, command, params });
    log(`device.command ${command} queued for device ${device.id}`);
  }

  function handleDeviceCommandResult(ws, msg) {
    const p = msg.payload ?? {};
    const commandId = typeof p.commandId === 'string' ? p.commandId : '';
    const pending = pendingCommands.get(commandId);
    if (!pending || pending.deviceId !== ws.state.deviceId) {
      // Unknown or stale result (e.g. after a timeout) — drop it silently.
      return;
    }
    clearTimeout(pending.timer);
    pendingCommands.delete(commandId);
    const ok = p.ok === true;
    if (ok) {
      send(pending.clientWs, 'ok', {
        replyTo: pending.msgId,
        command: pending.command,
        result: p.result && typeof p.result === 'object' && !Array.isArray(p.result) ? p.result : {},
      });
    } else {
      send(pending.clientWs, 'error', {
        replyTo: pending.msgId,
        code: 'command_failed',
        message: typeof p.error === 'string' && p.error ? p.error.slice(0, 300) : 'device reported command failure',
      });
    }
  }

  /** Fail any pending commands belonging to a disconnecting client socket. */
  function failPendingCommandsFor(ws) {
    for (const [commandId, pending] of [...pendingCommands.entries()]) {
      if (pending.clientWs === ws) {
        clearTimeout(pending.timer);
        pendingCommands.delete(commandId);
      }
    }
  }

  // ---- WebSocket wiring ----

  // Before authentication a socket may only authenticate or ping.
  const PENDING_TYPES = new Set(['auth.user', 'auth.agent', 'pairing.claim', 'ping']);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  function routeMessage(ws, msg) {
    const state = ws.state;
    switch (msg.type) {
      case 'ping':
        send(ws, 'pong', { serverTime: nowMs() });
        return;
      case 'auth.user':
        return handleAuthUser(ws, msg);
      case 'auth.agent':
        return handleAuthAgent(ws, msg);
      case 'pairing.claim':
        return handlePairingClaim(ws, msg);
      case 'pairing.request':
        if (state.kind !== 'user') break;
        return handlePairingRequest(ws, msg);
      case 'device.list':
        if (state.kind !== 'user') break;
        return handleDeviceList(ws, msg);
      case 'device.update':
        if (state.kind !== 'user') break;
        return handleDeviceUpdate(ws, msg);
      case 'device.delete':
        if (state.kind !== 'user') break;
        return handleDeviceDelete(ws, msg);
      case 'session.start':
        if (state.kind !== 'user') break;
        return handleSessionStart(ws, msg);
      case 'session.accept':
        if (state.kind !== 'agent') break;
        return handleSessionAccept(ws, msg);
      case 'session.reject':
        if (state.kind !== 'agent') break;
        return handleSessionReject(ws, msg);
      case 'session.end':
        if (state.kind !== 'user' && state.kind !== 'agent') break;
        return handleSessionEnd(ws, msg);
      case 'signal.offer':
      case 'signal.answer':
      case 'signal.ice':
        if (state.kind !== 'user' && state.kind !== 'agent') break;
        return handleSignal(ws, msg);
      case 'heartbeat':
        if (state.kind !== 'agent') break;
        return handleHeartbeat(ws, msg);
      case 'device.command':
        if (state.kind !== 'user') break;
        return handleDeviceCommand(ws, msg);
      case 'device.command.result':
        if (state.kind !== 'agent') break;
        return handleDeviceCommandResult(ws, msg);
      default:
        return sendError(ws, msg, 'unknown_type', `unknown message type: ${String(msg.type).slice(0, 64)}`);
    }
    sendError(ws, msg, 'not_allowed', `message type ${msg.type} not allowed in state "${state.kind}"`);
  }

  wss.on('connection', (ws, req) => {
    ws.state = {
      kind: 'pending',
      userId: null,
      deviceId: null,
      ip: req.socket.remoteAddress ?? 'unknown',
    };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendError(ws, null, 'bad_json', 'message must be valid JSON');
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)
        || typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > 64) {
        return sendError(ws, null, 'bad_message', 'expected an object with a string "type"');
      }
      if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null || Array.isArray(msg.payload))) {
        return sendError(ws, msg, 'bad_message', 'payload must be an object when present');
      }
      if (ws.state.kind === 'pending' && !PENDING_TYPES.has(msg.type)) {
        return sendError(ws, msg, 'not_authenticated', 'authenticate first (auth.user / auth.agent / pairing.claim)');
      }
      try {
        routeMessage(ws, msg);
      } catch (err) {
        log(`handler error for ${msg.type}: ${err && err.message}`);
        sendError(ws, msg, 'internal_error', 'internal server error');
      }
    });

    ws.on('close', () => {
      const state = ws.state ?? {};
      if (state.kind === 'user' && state.userId) {
        const set = userSockets.get(state.userId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) userSockets.delete(state.userId);
        }
        failPendingCommandsFor(ws);
        for (const session of [...sessions.values()]) {
          if (session.clientWs === ws) endSession(session.id, 'client_disconnected');
        }
      }
      if (state.kind === 'agent' && state.deviceId) {
        if (deviceSockets.get(state.deviceId) === ws) {
          deviceSockets.delete(state.deviceId);
          setDeviceOnline(state.deviceId, false, 'agent_disconnected');
          endSessionsForDevice(state.deviceId, 'device_disconnected');
          // Commands in flight can never complete now — fail them right away
          // instead of leaving the client waiting for the 30 s timeout.
          for (const [commandId, pending] of [...pendingCommands.entries()]) {
            if (pending.deviceId !== state.deviceId) continue;
            clearTimeout(pending.timer);
            pendingCommands.delete(commandId);
            send(pending.clientWs, 'error', {
              replyTo: pending.msgId,
              code: 'device_offline',
              message: 'device disconnected before reporting a result',
            });
          }
          log(`device ${state.deviceId} offline`);
        }
      }
    });

    ws.on('error', () => { /* logged via close; avoid crashing on socket errors */ });
  });

  // Periodic liveness sweep for sockets + staleness sweep for online status.
  const sweepTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /* gone */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* gone */ }
    }
    for (const device of store.data.devices) {
      const ws = deviceSockets.get(device.id);
      const online = Boolean(ws && ws.readyState === 1 && nowMs() - device.lastSeen <= OFFLINE_AFTER_MS);
      setDeviceOnline(device.id, online, online ? 'heartbeat' : 'stale');
    }
    // Expire pairing codes.
    let dirty = false;
    for (const c of store.data.pairingCodes) {
      if (!c.used && c.expiresAt <= nowMs()) { c.used = true; dirty = true; }
    }
    if (dirty) store.save();
  }, HEARTBEAT_INTERVAL_MS);
  sweepTimer.unref?.();

  // ---- REST API ----

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body_too_large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function bearerUserId(req) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    const claims = verifyJwt(match[1].trim(), config.jwtSecret);
    return claims ? claims.sub : null;
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://internal');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    try {
      if (route === 'GET /api/health') {
        return json(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), time: nowMs() });
      }

      if (route === 'POST /api/register') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!authLimiter(`reg:${ip}`)) return json(res, 429, { error: 'rate_limited' });
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!isValidEmail(email)) return json(res, 400, { error: 'invalid_email' });
        if (password.length < 8 || password.length > 256) return json(res, 400, { error: 'invalid_password', message: 'password must be 8-256 characters' });
        const emailLower = email.toLowerCase();
        if (store.data.users.some((u) => u.emailLower === emailLower)) {
          return json(res, 409, { error: 'email_taken' });
        }
        const user = {
          id: crypto.randomUUID(),
          email,
          emailLower,
          passHash: hashPassword(password),
          createdAt: nowMs(),
        };
        store.data.users.push(user);
        store.save();
        log(`user registered: ${user.id}`);
        return json(res, 201, { userId: user.id, email: user.email });
      }

      if (route === 'POST /api/login') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!authLimiter(`login:${ip}`)) return json(res, 429, { error: 'rate_limited' });
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad_json' }); }
        const emailLower = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const user = store.data.users.find((u) => u.emailLower === emailLower);
        // Verify against a dummy hash when the user is missing to equalize timing.
        const ok = verifyPassword(password, user ? user.passHash : DUMMY_HASH);
        if (!user || !ok) return json(res, 401, { error: 'invalid_credentials' });
        const token = signJwt({ sub: user.id }, config.jwtSecret, JWT_TTL_SEC);
        return json(res, 200, { token, tokenType: 'Bearer', expiresIn: JWT_TTL_SEC, userId: user.id });
      }

      if (route === 'GET /api/turn') {
        const userId = bearerUserId(req);
        if (!userId) return json(res, 401, { error: 'unauthorized' });
        const iceServers = [{ urls: config.stunUrls }];
        if (config.turnUrl) {
          iceServers.push({
            urls: config.turnUrl,
            username: config.turnUsername ?? undefined,
            credential: config.turnCredential ?? undefined,
          });
        }
        return json(res, 200, { iceServers, iceTransportPolicy: 'all' });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err && err.message === 'body_too_large') return json(res, 413, { error: 'body_too_large' });
      log(`http error on ${route}: ${err && err.message}`);
      return json(res, 500, { error: 'internal_error' });
    }
  }

  // ---- HTTP(S) server ----

  let httpServer;
  if (config.tlsCert && config.tlsKey) {
    const tlsOpts = {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
    };
    httpServer = https.createServer(tlsOpts, handleRequest);
  } else {
    httpServer = http.createServer(handleRequest);
  }
  // Attach the WebSocket endpoint: only /ws may upgrade; anything else is dropped.
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    } catch { /* malformed url */ }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      const port = httpServer.address().port;
      log(`listening on ${config.tlsCert ? 'wss' : 'ws'}://${config.host}:${port} (data: ${config.dbPath})`);
      const close = async () => {
        clearInterval(sweepTimer);
        for (const ws of wss.clients) {
          try { ws.close(1001, 'server shutting down'); } catch { /* gone */ }
        }
        await new Promise((r) => httpServer.close(r));
        store.saveNow();
      };
      resolve({ server: httpServer, port, config, store, close });
    });
  });
}

// ---- CLI entry point ----

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error('failed to start relay server:', err);
    process.exitCode = 1;
  });
  const shutdown = (signal) => {
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
