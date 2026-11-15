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
  node src/index.js run     connect to the relay and serve sessions (default)
  node src/index.js status  show identity, relay URL and capabilities
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

async function commandPair() {
  const config = loadConfig(resolveConfigPath());
  const url = resolveRelayUrl(config);
  if (config.backend === 'relay') log(`pairing against relay ${url}`);

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

  if (config.backend !== 'relay') {
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
    config.deviceId = result.deviceId;
    config.deviceEmail = result.email;
    config.devicePassword = result.password;
    config.token = null;
    config.name = result.name || name;
    saveConfig(config);
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
  if (!hasDeviceIdentity(config)) {
    die('This agent is not paired yet. Run:  node src/index.js pair');
  }
  log(`agent v${AGENT_VERSION} starting — ${config.backend === 'relay' ? `relay ${url}` : `supabase ${config.supabaseUrl}`}, device ${config.deviceId}`);
  const runtime = await startAgent({ config: { ...config, resolvedRelayUrl: url }, log });
  runtime.client.on('auth-fatal', () => {
    log('stopping: the relay rejected this device (deleted or re-paired)');
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
const handlers = { pair: commandPair, run: commandRun, status: commandStatus, relay: commandRelay, '--help': usage, '-h': usage };
if (typeof handlers[command] === 'function') {
  handlers[command]().catch((err) => die(`fatal: ${err?.stack ?? err}`));
} else if (typeof handlers[command] === 'string') {
  console.log(handlers[command]);
} else {
  die(`unknown command: ${command}\n\n${usage()}`);
}
