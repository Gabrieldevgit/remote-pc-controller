// End-to-end protocol test for the agent.
//
// Spawns a real relay server (node ../relay/src/server.js) on a random port
// with a throwaway data directory, then drives the full PROTOCOL.md flow:
//
//   register/login → pairing.request → agent pairing.claim → heartbeat
//   → device.list shows online → session.start/accept → signal.offer/answer
//   → ICE both directions → session.end
//
// The WebRTC backend is replaced by a deterministic mock so the test never
// touches screen capture or native modules. Prints PASS/FAIL per step and
// exits non-zero on any failure.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_DIR = path.resolve(AGENT_ROOT, '..', 'relay');

// ---- tiny test harness --------------------------------------------------------

const results = [];
let failed = false;

async function step(name, fn) {
  const label = name.padEnd(24);
  try {
    await fn();
    results.push(`PASS  ${label}`);
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed = true;
    results.push(`FAIL  ${label} ${err?.message ?? err}`);
    console.log(`FAIL  ${name}: ${err?.message ?? err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

// ---- helpers --------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Minimal user-side (mobile) WebSocket client for the relay protocol. */
class UserClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString('utf8'))));
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  onMessage(msg) {
    if ((msg.type === 'ok' || msg.type === 'error') && msg.payload?.replyTo !== undefined) {
      const entry = this.pending.get(msg.payload.replyTo);
      if (entry) {
        this.pending.delete(msg.payload.replyTo);
        if (msg.type === 'ok') entry.resolve(msg.payload);
        else {
          const err = new Error(`${msg.payload.code}: ${msg.payload.message}`);
          err.code = msg.payload.code;
          entry.reject(err);
        }
      }
      return;
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.type === msg.type && (!w.predicate || w.predicate(msg.payload))) {
        this.waiters.splice(i, 1);
        w.resolve(msg.payload);
        return;
      }
    }
  }

  async open() {
    await this.opened;
  }

  request(type, payload = {}, timeoutMs = 5000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${type} timed out`));
        }
      }, timeoutMs);
    });
    this.ws.send(JSON.stringify({ type, payload, id }));
    return p;
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  waitFor(type, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        predicate,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });
    });
  }

  close() {
    try { this.ws.close(); } catch { /* gone */ }
  }
}

// ---- mock WebRTC backend ---------------------------------------------------------

/** Deterministic backend used instead of real WebRTC in this test. */
function createMockBackend() {
  const state = { answers: 0, remoteCandidates: [], closed: 0 };
  return {
    mode: 'mock',
    reason: null,
    state,
    async createPeer({ offerSdp, sendSignal }) {
      assert(typeof offerSdp === 'string' && offerSdp.startsWith('v=0'), 'offer sdp must look like SDP');
      state.answers += 1;
      // Answer asynchronously so the offer handler has fully returned first.
      await sleep(20);
      sendSignal('signal.answer', { sdp: `v=0\r\no=agent-answer ${state.answers}\r\n` });
      await sleep(20);
      sendSignal('signal.ice', { candidate: 'candidate:99 1 udp 2130706431 10.0.0.1 40000 typ host' });
      return {
        addIceCandidate(candidate) {
          state.remoteCandidates.push(candidate);
        },
        close() {
          state.closed += 1;
        },
      };
    },
  };
}

// ---- main -------------------------------------------------------------------------

async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-protocol-test-'));
  const relayUrl = `ws://127.0.0.1:${port}/ws`;
  const base = `http://127.0.0.1:${port}`;

  let relay = null;
  let user = null;
  let runtime = null;

  try {
    await step('start relay', async () => {
      relay = spawn(process.execPath, [path.join(RELAY_DIR, 'src', 'server.js')], {
        env: { ...process.env, PORT: String(port), RELAY_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      relay.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));
      // Wait for /api/health to answer.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) return;
        } catch { /* not up yet */ }
        await sleep(200);
      }
      throw new Error('relay did not become healthy');
    });

    let jwt = null;
    let deviceId = null;

    await step('register + login', async () => {
      const email = `agent-test-${Date.now()}@example.com`;
      const password = 'correct-horse-battery';
      const reg = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert(reg.status === 201 || reg.status === 409, `register returned ${reg.status}`);
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert(login.status === 200, `login returned ${login.status}`);
      jwt = (await login.json()).token;
      assert(typeof jwt === 'string' && jwt.length > 20, 'no JWT returned');
    });

    await step('user auth.user', async () => {
      user = new UserClient(relayUrl);
      await user.open();
      const payload = await user.request('auth.user', { token: jwt });
      assert(typeof payload.userId === 'string' && payload.userId.length > 0, 'no userId in ok reply');
    });

    let pairingCode = null;
    await step('pairing.request', async () => {
      const payload = await user.request('pairing.request');
      pairingCode = payload.code;
      assert(/^\d{6}$/.test(pairingCode), `code not 6 digits: ${pairingCode}`);
      assert(typeof payload.expiresAt === 'number' && payload.ttlMs === 300_000, 'bad expiry payload');
    });

    await step('agent pairing.claim', async () => {
      const { startAgent } = await import('../src/runtime.js');
      const mockBackend = createMockBackend();
      const config = {
        backend: 'relay', // this suite exercises the legacy self-hosted relay
        relayUrl,
        deviceId: null,
        token: null,
        name: 'Test PC',
        version: '1.0.0-test',
        settings: { heartbeatIntervalMs: 300, quality: 'high', clipboardSync: true },
        resolvedRelayUrl: relayUrl,
      };
      runtime = await startAgent({ config, backend: mockBackend, heartbeatIntervalMs: 300, detectCapabilities: false });
      const claimed = withTimeout(
        new Promise((resolve, reject) => {
          runtime.client.once('pending-open', () => {
            runtime.client.claim(pairingCode, 'Test PC').then(resolve, reject);
          });
        }),
        8000,
        'pairing.claim',
      );
      const result = await claimed;
      deviceId = result.deviceId;
      assert(/^[0-9a-f-]{36}$/.test(deviceId), `deviceId not a uuid: ${deviceId}`);
      assert(/^[0-9a-f]{64}$/.test(result.token), 'device token is not 64 hex chars');
      assert(result.name === 'Test PC', `device name mismatch: ${result.name}`);
      runtime._mockBackend = mockBackend;
    });

    await step('heartbeat', async () => {
      const payload = await withTimeout(runtime.client.request('heartbeat'), 5000, 'heartbeat');
      assert(typeof payload.serverTime === 'number', 'heartbeat reply missing serverTime');
    });

    await step('device.list shows online', async () => {
      const payload = await user.request('device.list');
      const device = payload.devices.find((d) => d.id === deviceId);
      assert(device, 'paired device missing from device.list');
      assert(device.online === true, `device reports online=${device.online}`);
      assert(device.name === 'Test PC', `device name mismatch: ${device.name}`);
      assert(device.os === 'windows', `device os mismatch: ${device.os}`);
    });

    await step('device.command round-trip (process_list)', async () => {
      const payload = await user.request(
        'device.command',
        { deviceId, command: 'process_list' },
        15000,
      );
      assert(payload.command === 'process_list', `reply missing command echo: ${payload.command}`);
      assert(payload.result && typeof payload.result === 'object', 'reply missing result object');
      assert(Array.isArray(payload.result.processes), 'process_list result missing processes array');
      assert(
        payload.result.processes.length > 0
          && Number.isInteger(payload.result.processes[0].pid)
          && typeof payload.result.processes[0].name === 'string',
        `process rows malformed: ${JSON.stringify(payload.result.processes[0])}`,
      );
      assert(Number.isInteger(payload.result.count), 'process_list result missing count');
    });

    await step('device.command whitelist rejects unknown names', async () => {
      try {
        await user.request('device.command', { deviceId, command: 'format_c_drive' }, 5000);
        throw new Error('unknown command was accepted');
      } catch (err) {
        assert(err?.code === 'unknown_command', `expected unknown_command, got ${err?.code ?? err?.message}`);
      }
    });

    let sessionId = null;
    await step('session.start → accepted', async () => {
      const payload = await user.request('session.start', { deviceId });
      sessionId = payload.sessionId;
      assert(typeof sessionId === 'string' && sessionId.length > 0, 'no sessionId in ok reply');
      const accepted = await user.waitFor(
        'session.accepted',
        (p) => p.sessionId === sessionId,
        5000,
      );
      assert(accepted.sessionId === sessionId, 'session.accepted for wrong session');
    });

    await step('signal.offer → signal.answer', async () => {
      user.send('signal.offer', { sessionId, sdp: 'v=0\r\no=client-offer\r\n' });
      const answer = await user.waitFor(
        'signal.answer',
        (p) => p.sessionId === sessionId,
        5000,
      );
      assert(answer.sdp.includes('agent-answer'), `unexpected answer sdp: ${answer.sdp}`);
    });

    await step('signal.ice both directions', async () => {
      // client → agent
      user.send('signal.ice', {
        sessionId,
        candidate: 'candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
      // agent → client (the mock backend emits one after answering)
      const ice = await user.waitFor(
        'signal.ice',
        (p) => p.sessionId === sessionId,
        5000,
      );
      assert(ice.candidate.includes('10.0.0.1'), `unexpected agent candidate: ${ice.candidate}`);
      // give the inbound candidate a moment to be recorded
      await sleep(200);
      const received = runtime._mockBackend.state.remoteCandidates;
      assert(
        received.some((c) => c.candidate?.includes('192.168.1.10')),
        `agent never received the client ICE candidate (got ${JSON.stringify(received)})`,
      );
    });

    await step('session.end → session.ended', async () => {
      const endedPromise = withTimeout(
        new Promise((resolve, reject) => {
          runtime.client.once('message', (type, payload) => {
            if (type === 'session.ended' && payload.sessionId === sessionId) resolve(payload);
          });
        }),
        5000,
        'session.ended',
      );
      user.send('session.end', { sessionId });
      const payload = await endedPromise;
      assert(payload.reason === 'ended_by_peer', `unexpected reason: ${payload.reason}`);
      await sleep(100);
      assert(runtime.sessions.count === 0, 'session was not torn down');
      assert(runtime._mockBackend.state.closed >= 1, 'mock peer was not closed');
    });

    await step('invalid messages handled gracefully', async () => {
      // A garbage frame must not crash the relay or the agent; ping must still
      // answer with a pong event afterwards.
      user.ws.send('this is not json');
      user.send('ping', {});
      const pong = await user.waitFor('pong', null, 5000);
      assert(typeof pong.serverTime === 'number', 'pong missing serverTime');
    });
  } finally {
    // cleanup
    try { runtime?.stop(); } catch { /* ignore */ }
    try { user?.close(); } catch { /* ignore */ }
    if (relay) {
      try { relay.kill(); } catch { /* ignore */ }
    }
    await sleep(200);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n=== summary ===');
  for (const line of results) console.log(line);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
