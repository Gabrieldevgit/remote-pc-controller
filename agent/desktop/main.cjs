// Desktop host app: a small Electron shell around the agent CLI.
//
// The CLI (src/index.js) is run as a child process. Inside Electron,
// `process.execPath` is the Electron binary itself, so ELECTRON_RUN_AS_NODE
// is required — without it every "spawn" would open another copy of this
// window instead of running the agent.
//
// Sections: Remote Access (pair, PIN, on/off) and Remote Support (share this
// screen with a one-time code; every helper must be allowed here).

const {app, BrowserWindow, ipcMain, screen, shell} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.AGENT_CONFIG_PATH
  ? path.resolve(process.env.AGENT_CONFIG_PATH)
  : path.join(AGENT_ROOT, 'config.json');
const PIN_RE = /^\d{6,12}$/;

let windowRef;
let barRef;
let agentProcess;
let pairingProcess;
let supportProcess;
let hostState = 'stopped';

function runCli(args, onOutput, {stdin = false, env = {}} = {}) {
  const child = spawn(process.execPath, ['src/index.js', ...args], {
    cwd: AGENT_ROOT,
    windowsHide: true,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: {...process.env, ...env, ELECTRON_RUN_AS_NODE: '1'},
  });
  if (onOutput) {
    const forward = data => onOutput(data.toString());
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
  }
  return child;
}

function send(channel, payload) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send(channel, payload);
}

function setHostState(state) {
  hostState = state;
  send('agent:state', state);
}

function stop(child) {
  if (child && child.exitCode === null && !child.killed) child.kill();
}

/** Identity summary read straight from config.json — never exposes secrets. */
function readIdentity() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) ?? {};
  } catch {
    // Not paired yet.
  }
  const nonEmpty = v => typeof v === 'string' && v.length > 0;
  // Configs from before the Supabase backend hold a relay token.
  const backend = saved.backend === 'relay' || (!saved.backend && nonEmpty(saved.token)) ? 'relay' : 'supabase';
  const credential = backend === 'relay' ? nonEmpty(saved.token) : nonEmpty(saved.deviceEmail) && nonEmpty(saved.devicePassword);
  return {
    paired: nonEmpty(saved.deviceId) && credential,
    // Paired with the retired relay: the phone app can't see it until it is
    // paired again (Supabase).
    legacy: backend === 'relay',
    backend,
    pinSet: nonEmpty(saved.pinHash),
    name: typeof saved.name === 'string' ? saved.name : os.hostname(),
    deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : null,
    serverUrl: backend === 'relay'
      ? process.env.RELAY_URL || (typeof saved.relayUrl === 'string' ? saved.relayUrl : 'ws://127.0.0.1:8080/ws')
      : process.env.SUPABASE_URL || (typeof saved.supabaseUrl === 'string' ? saved.supabaseUrl : 'Supabase'),
    relayUrl: process.env.RELAY_URL || (typeof saved.relayUrl === 'string' ? saved.relayUrl : 'ws://127.0.0.1:8080/ws'),
  };
}

function startHost() {
  if (agentProcess) return {ok: true, alreadyRunning: true};
  const identity = readIdentity();
  if (!identity.paired) return {ok: false, error: 'Pair this computer with your account first.'};
  if (identity.legacy) return {ok: false, error: 'This PC uses the old relay server. Pair it again to use the Remote PC app.'};
  agentProcess = runCli(['run'], chunk => {
    send('agent:log', chunk);
    if (/authenticated as device/.test(chunk)) setHostState('online');
    else if (/reconnecting in|retrying in|socket error|heartbeat failed/.test(chunk) && hostState === 'online') setHostState('starting');
  });
  agentProcess.on('exit', () => {
    agentProcess = undefined;
    setHostState('stopped');
  });
  setHostState('starting');
  return {ok: true};
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#17191C',
    title: 'Remote PC Host',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef.loadFile(path.join(__dirname, 'renderer.html'));
  // Never navigate the app window away; open external links in the browser.
  windowRef.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  windowRef.webContents.on('will-navigate', event => event.preventDefault());
}

// ---- Remote Support -------------------------------------------------------------

/** Small always-on-top bar while someone is looking at this screen. */
function showSharingBar(helperEmail, mode) {
  closeSharingBar();
  const {workArea} = screen.getPrimaryDisplay();
  const width = 520;
  barRef = new BrowserWindow({
    width,
    height: 56,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 12,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: '#17191C',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  barRef.setAlwaysOnTop(true, 'screen-saver');
  const query = new URLSearchParams({who: helperEmail || 'someone', mode: mode || 'control'});
  barRef.loadFile(path.join(__dirname, 'sharing-bar.html'), {search: query.toString()});
  barRef.on('closed', () => { barRef = undefined; });
}

function closeSharingBar() {
  if (barRef && !barRef.isDestroyed()) barRef.close();
  barRef = undefined;
}

function stopSupport() {
  if (!supportProcess) return;
  try { supportProcess.stdin.write(`${JSON.stringify({stop: true})}\n`); } catch { /* gone */ }
  const child = supportProcess;
  setTimeout(() => stop(child), 3000);
}

function startSupport() {
  if (supportProcess) return {ok: true, alreadyRunning: true};
  const name = readIdentity().name;
  let buffer = '';
  supportProcess = runCli(['support', '--json', '--name', name], null, {stdin: true});
  supportProcess.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      send('support:event', event);
      if (event.event === 'request' && windowRef && !windowRef.isDestroyed()) {
        // Someone is asking to connect: bring the consent prompt forward.
        if (windowRef.isMinimized()) windowRef.restore();
        windowRef.show();
        windowRef.focus();
        windowRef.flashFrame(true);
      } else if (event.event === 'started') {
        windowRef?.flashFrame(false);
        showSharingBar(event.helperEmail, event.mode);
      } else if (event.event === 'ended') {
        closeSharingBar();
      }
    }
  });
  supportProcess.stderr.on('data', chunk => send('agent:log', chunk.toString()));
  supportProcess.on('exit', () => {
    supportProcess = undefined;
    closeSharingBar();
    send('support:event', {event: 'stopped'});
  });
  return {ok: true};
}

// ---- app lifecycle + IPC --------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('agent:identity', () => ({...readIdentity(), state: hostState, supporting: Boolean(supportProcess)}));

ipcMain.handle('agent:status', () => new Promise(resolve => {
  let output = '';
  const child = runCli(['status'], chunk => { output += chunk; });
  child.on('exit', () => resolve(output.trim()));
  child.on('error', err => resolve(`Could not run the agent: ${err.message}`));
}));

ipcMain.handle('agent:start', () => startHost());

ipcMain.handle('agent:stop', () => {
  stop(agentProcess);
  return {ok: true};
});

ipcMain.handle('agent:relay', (_event, value) => new Promise(resolve => {
  const url = String(value ?? '').trim();
  if (!url || url.length > 512) {
    resolve({ok: false, error: 'Enter a relay address such as ws://192.168.1.20:8080'});
    return;
  }
  let output = '';
  const child = runCli(['relay', url], chunk => { output += chunk; });
  child.on('exit', code => resolve(code === 0
    ? {ok: true, relayUrl: readIdentity().relayUrl}
    : {ok: false, error: output.trim() || 'Could not save the relay address.'}));
}));

ipcMain.handle('agent:pair', (_event, request) => new Promise(resolve => {
  if (pairingProcess) {
    resolve({ok: false, error: 'Pairing is already in progress.'});
    return;
  }
  const code = String(request?.code ?? '').replace(/\D/g, '');
  if (code.length !== 6) {
    resolve({ok: false, error: 'The access code has 6 digits.'});
    return;
  }
  const pin = String(request?.pin ?? '');
  if (!PIN_RE.test(pin)) {
    resolve({ok: false, error: 'Choose a PIN of 6 to 12 digits.'});
    return;
  }
  const name = String(request?.name ?? '').replace(/[\r\n]/g, '').trim().slice(0, 64);
  const wasRunning = Boolean(agentProcess);
  stop(agentProcess);

  let output = '';
  const args = ['pair', '--code', code, '--no-run'];
  if (name) args.push('--name', name);
  // The PIN goes through the environment, never the command line.
  pairingProcess = runCli(args, chunk => {
    output += chunk;
    send('agent:log', chunk);
  }, {env: {AGENT_NEW_PIN: pin}});
  pairingProcess.on('exit', exitCode => {
    pairingProcess = undefined;
    if (exitCode === 0) {
      resolve({ok: true, identity: readIdentity()});
      startHost();
    } else {
      const reason = /pairing failed: (.+)/.exec(output)?.[1]?.trim();
      resolve({ok: false, error: reason || 'Pairing failed. Check the code and try again.'});
      if (wasRunning) startHost();
    }
  });
}));

ipcMain.handle('agent:set-pin', (_event, value) => new Promise(resolve => {
  const pin = String(value ?? '');
  if (!PIN_RE.test(pin)) {
    resolve({ok: false, error: 'The PIN must be 6 to 12 digits.'});
    return;
  }
  let output = '';
  const child = runCli(['pin'], chunk => { output += chunk; }, {env: {AGENT_NEW_PIN: pin}});
  child.on('exit', code => resolve(code === 0
    ? {ok: true, identity: readIdentity()}
    : {ok: false, error: output.trim() || 'Could not save the PIN.'}));
}));

ipcMain.handle('support:start', () => startSupport());
ipcMain.handle('support:stop', () => {
  stopSupport();
  return {ok: true};
});
ipcMain.handle('support:answer', (_event, answer) => {
  if (!supportProcess) return {ok: false};
  const sessionId = String(answer?.sessionId ?? '');
  supportProcess.stdin.write(`${JSON.stringify({sessionId, allow: answer?.allow === true})}\n`);
  return {ok: true};
});

app.on('before-quit', () => {
  stop(pairingProcess);
  stop(agentProcess);
  stopSupport();
  if (supportProcess) stop(supportProcess);
});
