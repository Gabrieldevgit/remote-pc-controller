// Desktop host app: a small Electron shell around the agent CLI.
//
// The CLI (src/index.js) is run as a child process. Inside Electron,
// `process.execPath` is the Electron binary itself, so ELECTRON_RUN_AS_NODE
// is required — without it every "spawn" would open another copy of this
// window instead of running the agent.

const {app, BrowserWindow, ipcMain, shell} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AGENT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.AGENT_CONFIG_PATH
  ? path.resolve(process.env.AGENT_CONFIG_PATH)
  : path.join(AGENT_ROOT, 'config.json');

let windowRef;
let agentProcess;
let pairingProcess;
let hostState = 'stopped';

function runCli(args, onOutput) {
  const child = spawn(process.execPath, ['src/index.js', ...args], {
    cwd: AGENT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
  });
  const forward = data => onOutput(data.toString());
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
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

/** Identity summary read straight from config.json — never exposes the token. */
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
    backend,
    name: typeof saved.name === 'string' ? saved.name : require('node:os').hostname(),
    deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : null,
    serverUrl: backend === 'relay'
      ? process.env.RELAY_URL || (typeof saved.relayUrl === 'string' ? saved.relayUrl : 'ws://127.0.0.1:8080/ws')
      : process.env.SUPABASE_URL || (typeof saved.supabaseUrl === 'string' ? saved.supabaseUrl : 'Supabase'),
    relayUrl: process.env.RELAY_URL || (typeof saved.relayUrl === 'string' ? saved.relayUrl : 'ws://127.0.0.1:8080/ws'),
  };
}

function startHost() {
  if (agentProcess) return {ok: true, alreadyRunning: true};
  if (!readIdentity().paired) return {ok: false, error: 'Pair this computer with your account first.'};
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
    height: 720,
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('agent:identity', () => ({...readIdentity(), state: hostState}));

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
  const name = String(request?.name ?? '').replace(/[\r\n]/g, '').trim().slice(0, 64);
  const wasRunning = Boolean(agentProcess);
  stop(agentProcess);

  let output = '';
  const args = ['pair', '--code', code, '--no-run'];
  if (name) args.push('--name', name);
  pairingProcess = runCli(args, chunk => {
    output += chunk;
    send('agent:log', chunk);
  });
  pairingProcess.on('exit', exitCode => {
    pairingProcess = undefined;
    if (exitCode === 0) {
      resolve({ok: true, identity: readIdentity()});
      startHost();
    } else {
      const reason = /pairing failed: (.+)/.exec(output)?.[1]?.trim();
      resolve({ok: false, error: reason || 'Pairing failed. Check the code and the relay address.'});
      if (wasRunning) startHost();
    }
  });
}));

app.on('before-quit', () => {
  stop(pairingProcess);
  stop(agentProcess);
});
