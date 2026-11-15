// CLI entry point for the Windows agent.
//
//   node src/index.js pair   — interactive pairing: prompts for the 6-digit
//                              code + device name, claims it, saves the token
//   node src/index.js run    — connect and serve sessions (default command)
//   node src/index.js status — print identity, relay URL and capabilities
//
// See agent/README.md for background/auto-start options (start.bat, agent.vbs,
// Task Scheduler).

import readline from 'node:readline/promises';
import {
  resolveConfigPath,
  AGENT_VERSION,
  hasDeviceIdentity,
  loadConfig,
  normalizeRelayUrl,
  resolveRelayUrl,
  saveConfig,
} from './config.js';
import { startAgent } from './runtime.js';
import { hashPin, isValidPin, PIN_MAX, PIN_MIN } from './pin.js';

function log(...args) {
  console.log(`[agent ${new Date().toISOString()}]`, ...args);
}

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// A rejected promise from a fire-and-forget input call must never crash the agent.
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection (ignored): ${reason?.message ?? reason}`);
});

function usage() {
  return `
Remote PC Controller — Windows agent

Usage:
  node src/index.js pair    interactively pair with your account (6-digit code)
                            scripted: pair --code 123456 [--name "PC"] [--no-run]
                            (pairs with Supabase; --backend relay for the legacy relay)
  node src/index.js run     connect to the relay and serve sessions (default)
  node src/index.js status  show identity, relay URL and capabilities
  node src/index.js pin     set or change the Remote Access PIN (pin --clear removes it)
  node src/index.js support Remote Support: show a one-time code so someone can help (no account needed)
  node src/index.js relay [url]  show or save the relay URL (e.g. ws://192.168.1.20:8080)

Environment:
  RELAY_URL   overrides the relay endpoint from config.json (e.g. wss://host/ws)
`.trim();
}

// ---- pair ------------------------------------------------------------------

/**
 * Prompt helper that queues lines: sequential `question()` calls lose input
 * when multiple lines arrive before the next question is asked (e.g. scripted
 * stdin), and an ended stdin would leave the promise hanging forever.
 */
function makePrompter() {
  const queue = [];
  let pending = null;
  let eof = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    eof = true;
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve('');
    }
  });
  return async function prompt(text) {
    process.stdout.write(text);
    if (queue.length > 0) return queue.shift();
    if (eof) return '';
    return new Promise((resolve) => {
      pending = { resolve };
    });
  };
}

/** Parse `--flag value` / `--flag=value` / `--switch` style options. */
function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      options[arg.slice(2)] = argv[++i];
    } else {
      options[arg.slice(2)] = true;
    }
  }
  return options;
}

const OPTIONS = parseOptions(process.argv.slice(3));

/**
 * Resolve the Remote Access PIN for `pair` / `pin`:
 *   AGENT_NEW_PIN env (host app — keeps it off the command line), --pin,
 *   --no-pin, or an interactive prompt (asked twice).
 */
async function choosePin(prompt, { allowSkip }) {
  if (OPTIONS['no-pin'] && allowSkip) return null;
  const preset = process.env.AGENT_NEW_PIN ?? (typeof OPTIONS.pin === 'string' ? OPTIONS.pin : null);
  if (preset != null) {
    if (!isValidPin(preset)) die(`the PIN must be ${PIN_MIN}–${PIN_MAX} digits`);
    return preset;
  }
  if (!prompt) return null;
  for (;;) {
    const first = (await prompt(`Choose a PIN for remote access (${PIN_MIN}–${PIN_MAX} digits${allowSkip ? ', Enter to skip' : ''}): `)).trim();
    if (!first && allowSkip) return null;
    if (!isValidPin(first)) { console.log(`  The PIN must be ${PIN_MIN}–${PIN_MAX} digits.`); continue; }
    const again = (await prompt('Type the PIN again: ')).trim();
    if (again === first) return first;
    console.log('  The PINs did not match.');
  }
}

async function commandPair() {
  const config = loadConfig(resolveConfigPath());
  const url = resolveRelayUrl(config);
  // New pairings always go to Supabase. A config left over from the retired
  // relay (token, no backend) must not keep re-pairing against the relay —
  // that is what stranded PCs on the old backend. `--backend relay` is the
  // explicit opt-in for the legacy LAN setup.
  const pairBackend = OPTIONS.backend === 'relay' ? 'relay' : 'supabase';
  if (pairBackend === 'relay') log(`pairing against relay ${url}`);

  // Non-interactive form (used by the desktop host app):
  //   pair --code 123456 [--name "My PC"] [--no-run]
  const scripted = typeof OPTIONS.code === 'string';
  const prompt = scripted ? null : makePrompter();
  const code = (scripted ? OPTIONS.code : await prompt('Enter the 6-digit pairing code shown in the app: ')).trim();
  if (!/^\d{6}$/.test(code)) {
    die('pairing code must be exactly 6 digits');
  }
  const nameInput = scripted
    ? (typeof OPTIONS.name === 'string' ? OPTIONS.name : '')
    : await prompt(`Device name [${config.name}]: `);
  const name = nameInput.trim() || config.name;

  if (pairBackend === 'supabase') {
    const { pairWithSupabase } = await import('./supabase-client.js');
    log(`pairing with ${config.supabaseUrl}`);
    let result;
    try {
      result = await pairWithSupabase({
        url: config.supabaseUrl,
        key: config.supabaseKey,
        code,
        name,
        os: 'windows',
        version: AGENT_VERSION,
      });
    } catch (err) {
      die(`pairing failed: ${err.message}`);
    }
    config.backend = 'supabase';
    config.deviceId = result.deviceId;
    config.deviceEmail = result.email;
    config.devicePassword = result.password;
    config.token = null;
    config.name = result.name || name;
    const pin = await choosePin(prompt, { allowSkip: true });
    if (pin) Object.assign(config, hashPin(pin));
    saveConfig(config);
    if (!config.pinHash) log('tip: protect this PC with a PIN —  node src/index.js pin');
    log(`paired successfully as "${config.name}" (device ${config.deviceId})`);
    log('device login saved to agent/config.json — keep it secret, never commit it');
    if (OPTIONS['no-run']) {
      log('pairing complete — start the host with:  node src/index.js run');
      // Let the event loop drain: process.exit() while fetch's keep-alive
      // socket is closing trips a libuv assertion on Windows.
      process.exitCode = 0;
      return;
    }
    log('connected and serving sessions — press Ctrl+C to stop');
    const runtime = await startAgent({ config, log });
    runtime.client.on('auth-fatal', () => { process.exitCode = 1; runtime.stop(); });
    await runForever(runtime);
    return;
  }

  const { RelayClient } = await import('./relay-client.js');
  const client = new RelayClient({ url, name, version: AGENT_VERSION });
  client.on('log', (level, ...args) => log(...args));

  const paired = new Promise((resolve, reject) => {
    client.once('pending-open', () => {
      client.claim(code, name).then(resolve, reject);
    });
    client.once('auth-fatal', (reason) => reject(new Error(`pairing failed: ${reason}`)));
  });

  client.connect();

  try {
    const result = await paired;
    config.backend = 'relay';
    config.deviceId = result.deviceId;
    config.token = result.token;
    if (name) config.name = name;
    saveConfig(config);
    log(`paired successfully as "${result.name}" (device ${result.deviceId})`);
    log('device token saved to agent/config.json — keep it secret, never commit it');
  } catch (err) {
    client.stop();
    die(`pairing failed: ${err.message}`);
  }

  // The claiming socket must not outlive pairing: it is authenticated as the
  // device, so if it stayed open next to the runtime's own connection the
  // relay would keep replacing one with the other (close 4000) every 30 s.
  client.stop();

  if (OPTIONS['no-run']) {
    log('pairing complete — start the host with:  node src/index.js run');
    process.exit(0);
  }

  log('connected and serving sessions — press Ctrl+C to stop');
  const runtime = await startAgent({ config: { ...config, resolvedRelayUrl: url }, log });
  await runForever(runtime);
}

// ---- run -------------------------------------------------------------------

async function commandRun() {
  const config = loadConfig(resolveConfigPath());
  const url = resolveRelayUrl(config);
  if (config.backend === 'relay' && OPTIONS.backend !== 'relay') {
    die('This PC is paired with the retired relay server, so the Remote PC app cannot see it.\n'
      + 'Pair it again: in the app tap "Get a code", then run  node src/index.js pair\n'
      + '(or use Pair in Remote PC Host). To keep using a self-hosted relay, add  --backend relay', 2);
  }
  if (!hasDeviceIdentity(config)) {
    die('This agent is not paired yet. Run:  node src/index.js pair');
  }
  log(`agent v${AGENT_VERSION} starting — ${config.backend === 'relay' ? `relay ${url}` : `supabase ${config.supabaseUrl}`}, device ${config.deviceId}`);
  const runtime = await startAgent({ config: { ...config, resolvedRelayUrl: url }, log });
  runtime.client.on('auth-fatal', () => {
    log('stopping: this PC was removed from the account or re-paired — pair it again');
    process.exitCode = 1;
    runtime.stop();
  });
  await runForever(runtime);
}

function runForever(runtime) {
  return new Promise((resolve) => {
    const shutdown = () => {
      log('shutting down');
      runtime.stop();
      // Give the backend a moment to record "offline" before exiting.
      setTimeout(() => { resolve(); process.exit(process.exitCode ?? 0); }, 1500).unref?.();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ---- status ------------------------------------------------------------------

async function commandStatus() {
  const config = loadConfig(resolveConfigPath());
  const url = resolveRelayUrl(config);
  console.log('Remote PC Controller agent — status');
  console.log(`  backend:     ${config.backend === 'relay' ? `relay ${url}` : `supabase ${config.supabaseUrl}`}`);
  console.log(`  device name: ${config.name}`);
  console.log(`  device id:   ${config.deviceId ?? '(not paired)'}`);
  console.log(`  PIN:         ${config.pinHash ? 'set' : 'not set'}`);
  if (config.backend !== 'relay' && config.deviceEmail) {
    console.log('  credential:  device login (kept in config.json)');
  } else if (config.token) {
    console.log(`  token:       ${config.token.slice(0, 4)}…${config.token.slice(-2)} (${config.token.length} chars, kept in config.json)`);
  } else {
    console.log('  token:       (not paired)');
  }
  const webrtc = await import('./webrtc.js');
  const webrtcInfo = await webrtc.detect();
  console.log(`  video:       ${webrtcInfo.mode}${webrtcInfo.reason ? ` — ${webrtcInfo.reason}` : ''}`);
  const inputMod = await import('./input.js');
  const inputInfo = await inputMod.detect();
  console.log(`  input:       ${inputInfo.available ? inputInfo.mode : inputInfo.reason}`);
  const clipboard = await import('./clipboard.js');
  const clipInfo = await clipboard.detect();
  console.log(`  clipboard:   ${clipInfo.available ? clipInfo.mode : clipInfo.reason}`);
  // Detection spawns helper processes; close them and exit explicitly.
  inputMod.closeInput();
  process.exit(0);
}

// ---- support -----------------------------------------------------------------

/**
 * `support` — Remote Support ("Share this screen"). No account needed: a
 * temporary identity is created, a 12-digit code is shown, and every helper
 * request must be allowed here. Sharing stops when the session ends.
 *   --json   machine-readable events on stdout, consent answers on stdin as
 *            {"sessionId":"…","allow":true} (used by Remote PC Host)
 */
async function commandSupport() {
  const config = loadConfig(resolveConfigPath());
  const json = Boolean(OPTIONS.json);
  const emit = (event) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (event.event === 'code') {
      const c = event.code;
      console.log(`\n  Access code:  ${c.slice(0, 4)} ${c.slice(4, 8)} ${c.slice(8)}   (valid 5 minutes)\n`);
      console.log('  Give this code to the person helping you. They enter it in the Remote PC app → Support.');
    } else if (event.event === 'started') {
      console.log(`\n  Sharing your screen with ${event.helperEmail} (${event.mode === 'view' ? 'view only' : 'full control'}). Press Ctrl+C to stop.`);
    } else if (event.event === 'ended') {
      console.log('\n  Sharing stopped.');
    } else if (event.event === 'error') {
      console.error(`  ${event.message}`);
    }
  };
  const logLine = (...args) => {
    const line = `[agent ${new Date().toISOString()}] ${args.join(' ')}`;
    if (json) process.stderr.write(`${line}\n`);
    else if (OPTIONS.verbose) console.log(line);
  };
  const name = typeof OPTIONS.name === 'string' && OPTIONS.name.trim() ? OPTIONS.name.trim() : config.name;

  const { createSupportHost } = await import('./supabase-client.js');
  let host;
  try {
    host = await createSupportHost({ url: config.supabaseUrl, key: config.supabaseKey, name });
  } catch (err) {
    emit({ event: 'error', message: `Could not start Remote Support: ${err.message}` });
    process.exit(1);
  }

  // Consent: answers arrive on stdin (JSON lines in --json mode, y/n otherwise).
  const pending = new Map();
  const rl = readline.createInterface({ input: process.stdin, output: json ? undefined : process.stdout, terminal: false });
  rl.on('line', (line) => {
    const text = line.trim();
    if (json) {
      try {
        const answer = JSON.parse(text);
        if (answer.stop) { shutdown(); return; }
        const resolve = pending.get(answer.sessionId);
        if (resolve) { pending.delete(answer.sessionId); resolve(answer.allow === true); }
      } catch { /* ignore */ }
    } else {
      const [sessionId, resolve] = [...pending.entries()][0] ?? [];
      if (resolve) { pending.delete(sessionId); resolve(/^y(es)?$/i.test(text)); }
    }
  });
  const authorize = ({ sessionId, helperEmail, clientName, mode }) => new Promise((resolve) => {
    pending.set(sessionId, resolve);
    emit({ event: 'request', sessionId, helperEmail, clientName: clientName ?? null, mode });
    if (!json) process.stdout.write(`\n  ${helperEmail} wants to ${mode === 'view' ? 'see' : 'see and control'} your screen. Allow? [y/N] `);
    // No answer within 2 minutes = declined.
    setTimeout(() => { if (pending.delete(sessionId)) resolve(false); }, 120_000);
  });

  let active = false;
  let runtime = null;
  let refreshTimer = null;
  const shutdown = () => {
    clearTimeout(refreshTimer);
    runtime?.stop();
    setTimeout(() => process.exit(0), 1500);
  };
  const onSessionEvent = (event) => {
    if (event.type === 'support-started') {
      active = true;
      clearTimeout(refreshTimer);
      emit({ event: 'started', sessionId: event.sessionId, helperEmail: event.helperEmail, clientName: event.clientName ?? null, mode: event.mode });
    } else if (event.type === 'support-ended' && active) {
      emit({ event: 'ended', sessionId: event.sessionId });
      shutdown();
    }
  };

  runtime = await startAgent({
    config: { ...config, backend: 'supabase', name, supportHost: host },
    log: logLine,
    authorize,
    onSessionEvent,
  });
  const issue = async () => {
    if (active) return;
    try {
      const { code, expiresAt } = await runtime.client.issueSupportCode();
      emit({ event: 'code', code, expiresAt });
      // Codes last 5 minutes; refresh a little before while nobody is connected.
      refreshTimer = setTimeout(issue, Math.max(30_000, expiresAt - Date.now() - 20_000));
    } catch (err) {
      emit({ event: 'error', message: `Could not create an access code: ${err.message}` });
    }
  };
  runtime.client.once('auth-ok', issue);
  runtime.client.on('auth-fatal', () => {
    emit({ event: 'error', message: 'The support session expired.' });
    shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---- pin ---------------------------------------------------------------------

/** `pin` — set or change the Remote Access PIN; `pin --clear` removes it. */
async function commandPin() {
  const config = loadConfig(resolveConfigPath());
  if (OPTIONS.clear) {
    config.pinHash = null;
    config.pinSalt = null;
    saveConfig(config);
    console.log('PIN removed — sessions from your account no longer ask for one.');
    process.exit(0);
  }
  const scripted = process.env.AGENT_NEW_PIN != null || typeof OPTIONS.pin === 'string';
  const pin = await choosePin(scripted ? null : makePrompter(), { allowSkip: false });
  if (!pin) die('no PIN given');
  Object.assign(config, hashPin(pin));
  saveConfig(config);
  console.log('PIN saved. The phone will ask for it at the start of every session.');
  process.exit(0);
}

// ---- relay -------------------------------------------------------------------

/** `relay <url>` — persist the relay endpoint in config.json. */
async function commandRelay() {
  const raw = process.argv[3];
  const config = loadConfig(resolveConfigPath());
  if (!raw) {
    console.log(resolveRelayUrl(config));
    process.exit(0);
  }
  const normalized = normalizeRelayUrl(raw);
  if (!normalized) die(`not a valid relay URL: ${raw}`);
  config.relayUrl = normalized;
  saveConfig(config);
  console.log(`relay URL saved: ${normalized}`);
  process.exit(0);
}

// ---- main ---------------------------------------------------------------------

const command = (process.argv[2] ?? 'run').toLowerCase();
const handlers = { pair: commandPair, run: commandRun, status: commandStatus, relay: commandRelay, pin: commandPin, support: commandSupport, '--help': usage, '-h': usage };
if (typeof handlers[command] === 'function') {
  handlers[command]().catch((err) => die(`fatal: ${err?.stack ?? err}`));
} else if (typeof handlers[command] === 'string') {
  console.log(handlers[command]);
} else {
  die(`unknown command: ${command}\n\n${usage()}`);
}
