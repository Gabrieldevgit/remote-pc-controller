// Unit test for SessionManager security gates (no network, no WebRTC):
//   - a PIN-locked access session ignores input until the right PIN arrives
//   - 5 wrong PINs end the session
//   - a view-only support session never reaches input / clipboard / system
//   - support sessions need consent (declined → session.reject)
//
//   node test/session-gates-test.js

import { SessionManager } from '../src/session.js';
import { hashPin, verifyPin } from '../src/pin.js';

const results = [];
const step = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeManager({ pinHash = null, authorize = null } = {}) {
  const calls = [];
  const signals = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  const input = {
    moveRel: record('moveRel'), moveAbs: record('moveAbs'), click: record('click'),
    button: record('button'), scroll: record('scroll'), keyToggle: record('keyToggle'),
    typeText: record('typeText'), mediaKey: record('mediaKey'), ctrlAltDel: record('ctrlAltDel'),
  };
  const clipboard = {
    clipboardInfo: () => ({ available: false }),
    readText: async () => '', writeText: record('clipboard.write'),
  };
  const system = new Proxy({}, { get: (_t, name) => record(`system.${String(name)}`) });
  const backend = { mode: 'native', audio: false, createPeer: null };
  const manager = new SessionManager({
    backend, input, clipboard, system,
    sendSignal: (type, payload) => signals.push([type, payload]),
    log: () => {},
    authorize,
    security: {
      pinRequired: () => Boolean(pinHash),
      verifyPin: (pin) => verifyPin(pin, pinHash ?? {}),
    },
  });
  // Stand-in for the cursor tracker so no PowerShell worker is spawned.
  manager.cursor = { subscribe: () => () => {} };
  return { manager, calls, signals };
}

/** Attach a fake open data channel and capture what the agent sends on it. */
function attachChannel(manager, sessionId) {
  const sent = [];
  const session = manager.sessions.get(sessionId);
  session.peer = { pushFrame() {}, close() {}, addIceCandidate() {} };
  session.pump = { stop() {}, configure() {} }; // pretend video is already running
  const channel = { label: 'input', readyState: 'open', send: (d) => sent.push(JSON.parse(d)), close() {} };
  manager.wireDataChannel(session, channel);
  const control = (msg) => channel.onmessage({ data: JSON.stringify(msg) });
  return { session, sent, control };
}

const INPUTS = [
  { t: 'pointer.abs', x: 0.5, y: 0.5 },
  { t: 'click', button: 'left' },
  { t: 'button', button: 'left', down: true },
  { t: 'wheel', dx: 0, dy: 40 },
  { t: 'key', code: 'KeyA', down: true },
  { t: 'text', text: 'hello' },
  { t: 'clipboard.set', text: 'secret' },
  { t: 'system.power', action: 'shutdown' },
  { t: 'input.ctrlaltdel' },
];

// ---- PIN gate ---------------------------------------------------------------
{
  const { manager, calls, signals } = makeManager({ pinHash: hashPin('482913') });
  manager.onSessionRequest({ sessionId: 's1' });
  step('access session is accepted', signals.some(([t]) => t === 'session.accept'));
  const { session, sent, control } = attachChannel(manager, 's1');
  step('locked session asks for the PIN', sent.some((m) => m.t === 'auth.required'));
  INPUTS.forEach(control);
  await sleep(20);
  step('locked session ignores all input', calls.length === 0, `${calls.length} calls`);
  control({ t: 'auth.pin', pin: '000000' });
  await sleep(900);
  const failed = sent.find((m) => m.t === 'auth.failed');
  step('wrong PIN is refused with attempts left', failed?.attemptsLeft === 4, JSON.stringify(failed));
  control({ t: 'auth.pin', pin: '482913' });
  await sleep(20);
  step('right PIN unlocks', sent.some((m) => m.t === 'auth.ok') && session.locked === false);
  control({ t: 'click', button: 'left' });
  await sleep(20);
  step('input works after unlock', calls.some(([n]) => n === 'click'));
  manager.teardownAll();
}

// ---- PIN lockout --------------------------------------------------------------
{
  const { manager, signals } = makeManager({ pinHash: hashPin('482913') });
  manager.onSessionRequest({ sessionId: 's2' });
  const { control } = attachChannel(manager, 's2');
  for (let i = 0; i < 5; i++) control({ t: 'auth.pin', pin: '111111' });
  await sleep(500);
  step('5 wrong PINs end the session',
    signals.some(([t, p]) => t === 'session.end' && p.reason === 'pin_failed') && !manager.sessions.has('s2'));
}

// ---- view-only support ---------------------------------------------------------
{
  const { manager, calls, signals } = makeManager({ authorize: async () => true });
  manager.onSessionRequest({ sessionId: 's3', kind: 'support', mode: 'view', helperEmail: 'helper@example.test' });
  await sleep(20);
  step('support session accepted after consent', signals.some(([t, p]) => t === 'session.accept' && p.sessionId === 's3'));
  const { session, sent, control } = attachChannel(manager, 's3');
  step('support sessions never ask for the PIN', !sent.some((m) => m.t === 'auth.required') && session.locked === false);
  INPUTS.forEach(control);
  control({ t: 'file.request' });
  control({ t: 'curtain.set', on: true });
  await sleep(20);
  step('view-only session cannot send input, clipboard or system actions', calls.length === 0, `${calls.length} calls`);
  manager.teardownAll();
}

// ---- consent declined -----------------------------------------------------------
{
  const { manager, signals } = makeManager({ authorize: async () => false });
  manager.onSessionRequest({ sessionId: 's4', kind: 'support', mode: 'control', helperEmail: 'x@example.test' });
  await sleep(20);
  step('declined support request is rejected',
    signals.some(([t, p]) => t === 'session.reject' && p.sessionId === 's4') && !manager.sessions.has('s4'));
}

// ---- no consent handler = declined ------------------------------------------------
{
  const { manager, signals } = makeManager();
  manager.onSessionRequest({ sessionId: 's5', kind: 'support', mode: 'control' });
  await sleep(20);
  step('support without a consent handler is declined', signals.some(([t]) => t === 'session.reject'));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
