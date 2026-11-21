// Desktop host app: a small Electron shell around the agent CLI.
//
// The CLI (src/index.js) is run as a child process. Inside Electron,
// `process.execPath` is the Electron binary itself, so ELECTRON_RUN_AS_NODE
// is required — without it every "spawn" would open another copy of this
// window instead of running the agent.
//
// Sections: Remote Access (pair, PIN, on/off) and Remote Support (share this
// screen with a one-time code; every helper must be allowed here).

const {app, BrowserWindow, clipboard, ipcMain, safeStorage, screen, session: electronSession, shell} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createAccount, createSupportLog} = require('./account.cjs');

const AGENT_ROOT = path.resolve(__dirname, '..');
// From source the identity lives in agent/config.json. In the installed app
// the program folder is not writable, so it lives in
// %APPDATA%\Remote PC Host\ (Electron's userData folder) instead.
// REMOTE_PC_HOST_DATA gives a test copy its own folder (and its own
// single-instance lock) next to an installed host.
app.setPath('userData', process.env.REMOTE_PC_HOST_DATA
  ? path.resolve(process.env.REMOTE_PC_HOST_DATA)
  : path.join(app.getPath('appData'), 'Remote PC Host'));
const DATA_DIR = app.isPackaged ? app.getPath('userData') : AGENT_ROOT;
const CONFIG_PATH = process.env.AGENT_CONFIG_PATH
  ? path.resolve(process.env.AGENT_CONFIG_PATH)
  : path.join(DATA_DIR, 'config.json');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
// The account session and Remote Support history always live in the
// per-user app data folder (also when running from source).
const ACCOUNT_DIR = app.getPath('userData');
const supportLog = createSupportLog(path.join(ACCOUNT_DIR, 'support-history.json'));
let accountPromise;

/** Lazily create the account client (Supabase settings come from src/config.js). */
function account() {
  accountPromise ??= import(pathToFileURL(path.join(AGENT_ROOT, 'src', 'config.js')).href).then(cfg => createAccount({
    file: path.join(ACCOUNT_DIR, 'account.json'),
    url: process.env.SUPABASE_URL || cfg.SUPABASE_URL,
    key: process.env.SUPABASE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY,
    safeStorage,
  }));
  return accountPromise;
}
const PIN_RE = /^\d{6,12}$/;
const APP_ICON = path.join(__dirname, 'icon.ico');

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
    env: {
      ...process.env,
      AGENT_CONFIG_PATH: CONFIG_PATH,
      AGENT_SCREENSHOT_DIR: SCREENSHOT_DIR,
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    },
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
    icon: APP_ICON,
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
        try { supportLog.started(event); } catch { /* history is best effort */ }
      } else if (event.event === 'ended') {
        closeSharingBar();
        try { supportLog.ended(event.sessionId); } catch { /* best effort */ }
      }
    }
  });
  supportProcess.stderr.on('data', chunk => send('agent:log', chunk.toString()));
  supportProcess.on('exit', () => {
    supportProcess = undefined;
    try { supportLog.ended(null); } catch { /* best effort */ }
    closeSharingBar();
    send('support:event', {event: 'stopped'});
  });
  return {ok: true};
}

// ---- app lifecycle + IPC --------------------------------------------------------

// One host per PC: a second launch focuses the existing window instead of
// starting a second agent.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!windowRef || windowRef.isDestroyed()) return;
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
  });
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
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

ipcMain.handle('agent:pair', async (_event, request) => {
  // Signed in on this PC: no code to type — ask Supabase for one.
  if (request?.useAccount) {
    try {
      const code = await (await account()).pairingCode();
      return pairWithCode({...request, code});
    } catch (err) {
      return {ok: false, error: err?.message ?? 'Could not get a pairing code.'};
    }
  }
  return pairWithCode(request);
});

const pairWithCode = request => new Promise(resolve => {
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
});

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

// ---- account (optional sign-in on this PC) --------------------------------------

ipcMain.handle('account:state', async () => {
  try { return await (await account()).state(); } catch { return {signedIn: false}; }
});
ipcMain.handle('account:sign-in', async (_event, request) =>
  (await account()).signIn(request?.email, request?.password));
ipcMain.handle('account:sign-up', async (_event, request) =>
  (await account()).signUp(request?.email, request?.password));
ipcMain.handle('account:sign-out', async () => (await account()).signOut());
ipcMain.handle('account:history', async () => {
  const support = supportLog.list();
  const state = await (await account()).state().catch(() => ({signedIn: false}));
  if (!state.signedIn) return {ok: true, signedIn: false, owned: false, sessions: support};
  const remote = await (await account()).history(readIdentity().deviceId);
  if (!remote.ok) return {...remote, signedIn: true, sessions: support};
  const sessions = [...remote.sessions, ...support]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return {ok: true, signedIn: true, owned: remote.owned, reason: remote.reason, sessions};
});

// ---- your phones (PC controls the phone) ----------------------------------------------

const phoneViewers = new Map(); // webContents id → {win, session}

function openPhoneViewer(phone) {
  for (const v of phoneViewers.values()) {
    if (v.phoneId === phone.id && !v.win.isDestroyed()) {
      v.win.focus();
      return;
    }
  }
  // Emulator-style: a frameless, transparent window that the page draws as
  // a phone with a toolbar beside it. The page asks for its exact size
  // (phone:fit) and drives minimize / maximize / fullscreen (phone:window).
  const work = screen.getPrimaryDisplay().workArea;
  const height = Math.min(880, Math.round(work.height * 0.86));
  const width = Math.round(height * 0.52) + 76;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: true,
    title: `${phone.name} — Remote PC`,
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'phone-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A live remote view: input timing, sound and layout must not be
      // throttled when the window is behind others.
      backgroundThrottling: false,
    },
  });
  const id = win.webContents.id;
  phoneViewers.set(id, {win, phoneId: phone.id, session: null, mode: 'normal', restore: null});
  const sendState = () => {
    const v = phoneViewers.get(id);
    if (v && !win.isDestroyed()) win.webContents.send('phone:window-state', {mode: v.mode, top: win.isAlwaysOnTop()});
  };
  win.on('enter-full-screen', () => { const v = phoneViewers.get(id); if (v) v.mode = 'full'; sendState(); });
  win.on('leave-full-screen', () => {
    const v = phoneViewers.get(id);
    if (!v || v.mode !== 'full') return;
    v.mode = 'normal';
    if (v.restore) win.setBounds(v.restore);
    v.restore = null;
    sendState();
  });
  win.loadFile(path.join(__dirname, 'phone-viewer.html'), {
    search: new URLSearchParams({id: phone.id, name: String(phone.name || 'Phone')}).toString(),
  });
  win.on('closed', () => {
    const v = phoneViewers.get(id);
    phoneViewers.delete(id);
    v?.session?.end('pc_closed').catch(() => {});
  });
}

ipcMain.handle('phones:list', async () => {
  try {
    return await (await account()).phones();
  } catch (err) {
    return {ok: false, error: err?.message ?? 'Could not load your phones.', phones: []};
  }
});
ipcMain.handle('phones:open', (_event, phone) => {
  if (!phone || typeof phone.id !== 'string') return {ok: false};
  openPhoneViewer({id: phone.id, name: String(phone.name ?? 'Phone').slice(0, 64)});
  return {ok: true};
});

ipcMain.handle('phone:start', async (event, phoneId) => {
  const viewer = phoneViewers.get(event.sender.id);
  if (!viewer || viewer.phoneId !== phoneId) return {ok: false, error: 'Unknown phone.'};
  try {
    viewer.session = await (await account()).openPhoneSession(phoneId, readIdentity().name || os.hostname(), ev => {
      if (!event.sender.isDestroyed()) event.sender.send('phone:event', ev);
    });
    return {ok: true, sessionId: viewer.session.id};
  } catch (err) {
    return {ok: false, error: err?.message ?? 'Could not reach the phone.'};
  }
});
ipcMain.handle('phone:ice', async event => {
  if (!phoneViewers.get(event.sender.id)) return null;
  try {
    return await (await account()).iceServers();
  } catch {
    return null;
  }
});
ipcMain.on('phone:signal', (event, msg) => {
  const viewer = phoneViewers.get(event.sender.id);
  if (viewer?.session && msg && typeof msg.event === 'string') viewer.session.signal(msg.event, msg.payload ?? {});
});
ipcMain.handle('phone:end', async (event, reason) => {
  const viewer = phoneViewers.get(event.sender.id);
  await viewer?.session?.end(typeof reason === 'string' ? reason : 'pc_closed');
  return {ok: true};
});
/** The page asks for an exact window size (phone + toolbar) in normal mode. */
ipcMain.handle('phone:fit', (event, size) => {
  const viewer = phoneViewers.get(event.sender.id);
  const w = Math.round(Number(size?.width)), h = Math.round(Number(size?.height));
  if (!viewer || viewer.win.isDestroyed() || !(w > 100 && h > 100)) return null;
  if (viewer.mode !== 'normal') return null;
  const b = viewer.win.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  const width = Math.min(w, work.width), height = Math.min(h, work.height);
  // Keep the window on screen; grow from the top-left corner.
  const x = Math.min(Math.max(b.x, work.x), work.x + work.width - width);
  const y = Math.min(Math.max(b.y, work.y), work.y + work.height - height);
  viewer.win.setBounds({x, y, width, height});
  return {width, height, maxWidth: work.width, maxHeight: work.height};
});

function exitFullscreen(viewer) {
  const bounds = viewer.restore;
  viewer.mode = 'normal';
  viewer.restore = null;
  viewer.win.setFullScreen(false);
  if (!bounds) return;
  // Windows finishes leaving fullscreen asynchronously and may apply its own
  // size afterwards; set ours again once it has settled.
  viewer.win.setBounds(bounds);
  setTimeout(() => { if (!viewer.win.isDestroyed() && viewer.mode === 'normal') viewer.win.setBounds(bounds); }, 250);
}

/** Window controls drawn by the page (the window has no frame). */
ipcMain.handle('phone:window', (event, msg) => {
  const viewer = phoneViewers.get(event.sender.id);
  if (!viewer || viewer.win.isDestroyed()) return null;
  const win = viewer.win;
  switch (msg?.action) {
    case 'minimize': win.minimize(); break;
    case 'close': win.close(); return null;
    case 'maximize':
      if (viewer.mode === 'full') { exitFullscreen(viewer); break; }
      if (viewer.mode === 'max') {
        viewer.mode = 'normal';
        if (viewer.restore) win.setBounds(viewer.restore);
        viewer.restore = null;
      } else {
        viewer.restore = win.getBounds();
        viewer.mode = 'max';
        win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea);
      }
      break;
    case 'fullscreen':
      // Track the mode ourselves: a transparent frameless window does not
      // report fullscreen reliably on Windows.
      if (viewer.mode === 'full') { exitFullscreen(viewer); break; }
      if (viewer.mode === 'normal') viewer.restore = win.getBounds();
      viewer.mode = 'full';
      win.setFullScreen(true);
      break;
    case 'top': win.setAlwaysOnTop(Boolean(msg.value), 'floating'); break;
    default: break;
  }
  const state = {mode: viewer.mode, top: win.isAlwaysOnTop()};
  win.webContents.send('phone:window-state', state);
  return state;
});
ipcMain.handle('clipboard:read', () => clipboard.readText().slice(0, 100000));
ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text ?? '').slice(0, 100000));
  return true;
});

// Files received from a phone go to Downloads\Remote PC (no save dialog).
app.whenReady().then(() => {
  electronSession.defaultSession.on('will-download', (_event, item) => {
    const dir = path.join(app.getPath('downloads'), 'Remote PC');
    fs.mkdirSync(dir, {recursive: true});
    const safe = item.getFilename().replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const ext = path.extname(safe);
    const base = safe.slice(0, safe.length - ext.length);
    let target = path.join(dir, safe);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${base} (${i})${ext}`);
    item.setSavePath(target);
  });
});
