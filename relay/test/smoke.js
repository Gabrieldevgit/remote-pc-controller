// End-to-end smoke test for the relay server.
// Run from the repo root:  node relay/test/smoke.js
// (or: npm test inside relay/)
//
// Spins up the real server on a random port with a throwaway data directory,
// then walks the full happy path plus key negative cases, printing PASS/FAIL
// per step. Exits 0 only if every step passes.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../src/server.js';

const results = [];
let failed = false;

function report(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    report(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    report(name, false, err && err.message ? err.message : String(err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---- Tiny HTTP helpers (global fetch is available on Node 20+) ----

async function http(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// ---- Tiny WebSocket test client built on the global WebSocket (Node >= 22) ----

class TestClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.waiters = []; // { pred, resolve, timer }
    this.inbox = [];   // messages not immediately matched to a waiter
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('websocket error'));
      this.ws.onclose = (e) => this._resolveClosed(e.code);
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const idx = this.waiters.findIndex((w) => w.pred(msg));
        if (idx >= 0) {
          const w = this.waiters.splice(idx, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
        } else {
          this.inbox.push(msg);
        }
      };
    });
  }

  send(type, payload = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ type, payload, id }));
    return id;
  }

  /** Wait for a message matching {type} and optionally payload.replyTo. */
  waitFor(match, timeoutMs = 5000) {
    const pred = typeof match === 'function'
      ? match
      : (m) => m.type === (typeof match === 'string' ? match : match.type)
        && (typeof match === 'object' && match.replyTo !== undefined
          ? m.payload?.replyTo === match.replyTo
          : true);
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${typeof match === 'function' ? 'predicate' : match}`));
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  /** Send a message and resolve with the correlated ok/error reply. */
  async request(type, payload = {}, timeoutMs = 5000) {
    const id = this.send(type, payload);
    const msg = await this.waitFor((m) => m.payload?.replyTo === id, timeoutMs);
    return { ok: msg.type === 'ok', msg };
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
    return this.closed;
  }
}

// ---- Test run ----

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));
let port = 0;
let server;

try {
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir, jwtSecret: 'a'.repeat(64) });
  port = server.port;

  const EMAIL = 'alice@example.com';
  const PASSWORD = 'correct-horse-battery';
  let jwt = null;
  let pairingCode = null;
  let deviceId = null;
  let deviceToken = null;
  let sessionId = null;
  let liveAgent = null;

  const user = new TestClient();
  const agent = new TestClient(); // socket used for the original pairing.claim

  await step('health endpoint responds', async () => {
    const res = await http('GET', '/api/health');
    assert(res.status === 200 && res.json?.ok === true, `status ${res.status}`);
    return 'GET /api/health -> 200';
  });

  await step('register account', async () => {
    const res = await http('POST', '/api/register', { body: { email: EMAIL, password: PASSWORD } });
    assert(res.status === 201 && typeof res.json?.userId === 'string', `status ${res.status}: ${JSON.stringify(res.json)}`);
    return `userId ${res.json.userId.slice(0, 8)}…`;
  });

  await step('register rejects duplicate email (409)', async () => {
    const res = await http('POST', '/api/register', { body: { email: EMAIL, password: PASSWORD } });
    assert(res.status === 409, `expected 409, got ${res.status}`);
  });

  await step('register rejects weak password (400)', async () => {
    const res = await http('POST', '/api/register', { body: { email: 'bob@example.com', password: 'short' } });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });

  await step('login returns JWT', async () => {
    const res = await http('POST', '/api/login', { body: { email: EMAIL, password: PASSWORD } });
    assert(res.status === 200 && typeof res.json?.token === 'string', `status ${res.status}`);
    assert(res.json.token.split('.').length === 3, 'token is not a JWT');
    jwt = res.json.token;
    return `expiresIn ${res.json.expiresIn}s`;
  });

  await step('login rejects wrong password (401)', async () => {
    const res = await http('POST', '/api/login', { body: { email: EMAIL, password: 'wrong-password' } });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step('turn endpoint requires auth (401)', async () => {
    const res = await http('GET', '/api/turn');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await step('turn endpoint returns STUN/TURN config', async () => {
    const res = await http('GET', '/api/turn', { token: jwt });
    assert(res.status === 200 && Array.isArray(res.json?.iceServers), `status ${res.status}`);
    assert(
      res.json.iceServers.some((s) => Array.isArray(s.urls) && s.urls.some((u) => u.startsWith('stun:'))),
      'no STUN entry',
    );
    return `${res.json.iceServers.length} ice server group(s)`;
  });

  await step('user WS auth with JWT', async () => {
    await user.connect();
    const reply = await user.request('auth.user', { token: jwt });
    assert(reply.ok && reply.msg.payload.userId, `error: ${JSON.stringify(reply.msg?.payload)}`);
  });

  await step('user WS rejects tampered JWT', async () => {
    const evil = new TestClient();
    await evil.connect();
    const tampered = jwt.slice(0, -3) + (jwt.endsWith('aaa') ? 'bbb' : 'aaa');
    const reply = await evil.request('auth.user', { token: tampered });
    assert(!reply.ok && reply.msg.payload.code === 'invalid_token',
      `expected invalid_token, got ${JSON.stringify(reply.msg?.payload)}`);
    await evil.close();
  });

  await step('unauthenticated socket cannot list devices', async () => {
    const anon = new TestClient();
    await anon.connect();
    const reply = await anon.request('device.list');
    assert(!reply.ok && reply.msg.payload.code === 'not_authenticated',
      `expected not_authenticated, got ${JSON.stringify(reply.msg?.payload)}`);
    await anon.close();
  });

  await step('pairing.request issues 6-digit code with ~5-min expiry', async () => {
    const reply = await user.request('pairing.request');
    assert(reply.ok, `error: ${JSON.stringify(reply.msg?.payload)}`);
    pairingCode = reply.msg.payload.code;
    assert(/^\d{6}$/.test(pairingCode), `bad code format: ${pairingCode}`);
    assert(reply.msg.payload.expiresAt > Date.now() + 4 * 60_000, 'expiry should be ~5 minutes out');
    return `code ${pairingCode}`;
  });

  await step('agent pairing.claim returns device id + one-time token', async () => {
    await agent.connect();
    const reply = await agent.request('pairing.claim', {
      code: pairingCode, name: 'Living Room PC', os: 'windows', version: '1.0.0',
    });
    assert(reply.ok, `error: ${JSON.stringify(reply.msg?.payload)}`);
    deviceId = reply.msg.payload.deviceId;
    deviceToken = reply.msg.payload.token;
    assert(/^[0-9a-f]{64}$/.test(deviceToken), 'device token should be 32-byte hex');
    return `deviceId ${deviceId.slice(0, 8)}…`;
  });

  await step('pairing code is single-use (second claim fails)', async () => {
    const second = new TestClient();
    await second.connect();
    const reply = await second.request('pairing.claim', { code: pairingCode, name: 'Evil PC', os: 'windows' });
    assert(!reply.ok, 'second claim should fail');
    assert(reply.msg.payload.code === 'invalid_or_expired_code',
      `unexpected code: ${reply.msg.payload.code}`);
    await second.close();
  });

  await step('malformed pairing codes are rejected', async () => {
    const probe = new TestClient();
    await probe.connect();
    const reply = await probe.request('pairing.claim', { code: '12ab' });
    assert(!reply.ok && reply.msg.payload.code === 'invalid_code',
      `expected invalid_code, got ${JSON.stringify(reply.msg?.payload)}`);
    await probe.close();
  });

  await step('wrong-code claims fail consistently (5-strike burn path)', async () => {
    const burner = new TestClient();
    await burner.connect();
    const wrongCode = pairingCode === '000000' ? '999999' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await burner.request('pairing.claim', { code: wrongCode });
      assert(!r.ok, 'wrong code must fail');
    }
    await burner.close();
    return '5 failed claims on one code recorded';
  });

  await step('agent re-auth with persistent device token (fresh socket)', async () => {
    const fresh = new TestClient();
    await fresh.connect();
    const reply = await fresh.request('auth.agent', { deviceId, token: deviceToken, version: '1.0.1' });
    assert(reply.ok && reply.msg.payload.deviceId === deviceId,
      `error: ${JSON.stringify(reply.msg?.payload)}`);
    await fresh.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  await step('heartbeat accepted from authenticated agent', async () => {
    liveAgent = new TestClient();
    await liveAgent.connect();
    const auth = await liveAgent.request('auth.agent', { deviceId, token: deviceToken });
    assert(auth.ok, 'agent auth failed');
    const reply = await liveAgent.request('heartbeat');
    assert(reply.ok && typeof reply.msg.payload.serverTime === 'number',
      `error: ${JSON.stringify(reply.msg?.payload)}`);
    await agent.close(); // retire the original claiming socket
    return 'heartbeat ack received';
  });

  await step('device.list shows device online with metadata', async () => {
    const reply = await user.request('device.list');
    assert(reply.ok, 'device.list failed');
    const devices = reply.msg.payload.devices;
    const dev = devices.find((d) => d.id === deviceId);
    assert(dev, `device ${deviceId} not in list: ${JSON.stringify(devices)}`);
    assert(dev.online === true, 'device should be online after heartbeat');
    assert(dev.name === 'Living Room PC', `unexpected name: ${dev.name}`);
    assert(dev.version === '1.0.1', `unexpected version: ${dev.version}`);
    assert(dev.os === 'windows', `unexpected os: ${dev.os}`);
  });

  await step('device.update renames device', async () => {
    const reply = await user.request('device.update', { deviceId, name: 'Media PC' });
    assert(reply.ok && reply.msg.payload.name === 'Media PC',
      `error: ${JSON.stringify(reply.msg?.payload)}`);
    const listed = await user.request('device.list');
    assert(listed.msg.payload.devices.find((d) => d.id === deviceId)?.name === 'Media PC',
      'rename not reflected in list');
  });

  await step('user cannot touch another user’s device', async () => {
    await http('POST', '/api/register', { body: { email: 'mallory@example.com', password: 'another-password-1' } });
    const res = await http('POST', '/api/login', { body: { email: 'mallory@example.com', password: 'another-password-1' } });
    const mallory = new TestClient();
    await mallory.connect();
    await mallory.request('auth.user', { token: res.json.token });
    const del = await mallory.request('device.delete', { deviceId });
    assert(!del.ok && del.msg.payload.code === 'not_found',
      `expected not_found, got ${JSON.stringify(del.msg?.payload)}`);
    const start = await mallory.request('session.start', { deviceId });
    assert(!start.ok && start.msg.payload.code === 'not_found',
      `expected not_found, got ${JSON.stringify(start.msg?.payload)}`);
    await mallory.close();
  });

  await step('session.start notifies the device (session.request)', async () => {
    const reply = await user.request('session.start', { deviceId });
    assert(reply.ok && reply.msg.payload.sessionId, `error: ${JSON.stringify(reply.msg?.payload)}`);
    sessionId = reply.msg.payload.sessionId;
    const req = await liveAgent.waitFor('session.request');
    assert(req.payload.sessionId === sessionId, 'device got wrong session id');
    return `sessionId ${sessionId.slice(0, 8)}…`;
  });

  await step('agent session.accept reaches the client (session.accepted)', async () => {
    liveAgent.send('session.accept', { sessionId });
    const accepted = await user.waitFor('session.accepted');
    assert(accepted.payload.sessionId === sessionId, 'client got wrong session id');
  });

  await step('signal.offer relays client -> device', async () => {
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=offer\r\n';
    user.send('signal.offer', { sessionId, sdp });
    const offered = await liveAgent.waitFor('signal.offer');
    assert(offered.payload.sdp === sdp, 'sdp mangled in transit');
    assert(offered.payload.sessionId === sessionId, 'session id mismatch');
  });

  await step('signal.answer relays device -> client', async () => {
    const sdp = 'v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\ns=answer\r\n';
    liveAgent.send('signal.answer', { sessionId, sdp });
    const answered = await user.waitFor('signal.answer');
    assert(answered.payload.sdp === sdp, 'sdp mangled in transit');
  });

  await step('signal.ice relays both directions', async () => {
    user.send('signal.ice', {
      sessionId,
      candidate: 'candidate:1 1 udp 1 1.1.1.1 5000 typ host',
      sdpMid: '0',
    });
    const atDevice = await liveAgent.waitFor('signal.ice');
    assert(atDevice.payload.candidate.startsWith('candidate:'), 'candidate mangled');

    liveAgent.send('signal.ice', {
      sessionId,
      candidate: 'candidate:2 1 udp 1 2.2.2.2 5001 typ host',
      sdpMid: '0',
    });
    const atClient = await user.waitFor('signal.ice');
    assert(atClient.payload.candidate.startsWith('candidate:'), 'candidate mangled');
  });

  await step('signal from a non-participant is rejected', async () => {
    const res = await http('POST', '/api/login', { body: { email: 'mallory@example.com', password: 'another-password-1' } });
    const outsider = new TestClient();
    await outsider.connect();
    await outsider.request('auth.user', { token: res.json.token });
    const reply = await outsider.request('signal.offer', { sessionId, sdp: 'v=0' });
    assert(!reply.ok && (reply.msg.payload.code === 'forbidden' || reply.msg.payload.code === 'not_found'),
      `expected forbidden/not_found, got ${JSON.stringify(reply.msg?.payload)}`);
    await outsider.close();
  });

  await step('session.end tears down and notifies the peer', async () => {
    user.send('session.end', { sessionId });
    const ended = await liveAgent.waitFor('session.ended');
    assert(ended.payload.sessionId === sessionId, 'device got wrong session id');
  });

  await step('device.command rejects unknown command names', async () => {
    const reply = await user.request('device.command', { deviceId, command: 'format_c' });
    assert(!reply.ok && reply.msg.payload.code === 'unknown_command',
      `expected unknown_command, got ${JSON.stringify(reply.msg?.payload)}`);
  });

  await step('device.delete closes the agent socket and clears the list', async () => {
    const reply = await user.request('device.delete', { deviceId });
    assert(reply.ok, `error: ${JSON.stringify(reply.msg?.payload)}`);
    const closedCode = await Promise.race([
      liveAgent.closed,
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    assert(closedCode === 4001, `agent socket should close with 4001, got ${closedCode}`);
    const listed = await user.request('device.list');
    assert(!listed.msg.payload.devices.some((d) => d.id === deviceId), 'deleted device still listed');
  });

  await step('pairing.claim rate limit trips after repeated attempts', async () => {
    const hammer = new TestClient();
    await hammer.connect();
    let sawRateLimited = false;
    for (let i = 0; i < 12 && !sawRateLimited; i++) {
      const r = await hammer.request('pairing.claim', { code: '123456' });
      if (!r.ok && r.msg.payload.code === 'rate_limited') sawRateLimited = true;
    }
    assert(sawRateLimited, 'expected a rate_limited error within 12 attempts');
    await hammer.close();
  });

  await user.close();

  // Summary
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps passed`);
  if (failed) {
    console.log('FAILED steps:');
    for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.name}`);
    process.exitCode = 1;
  } else {
    console.log('ALL PASS');
  }
} finally {
  if (server) await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
