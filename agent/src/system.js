// System-level actions: power, volume, screenshots, process list/kill,
// system info, display list. Everything shells out to built-in Windows tools
// (rundll32, shutdown, logoff, tasklist, taskkill, PowerShell) — no native
// modules, and no untrusted input is ever interpolated into a command line
// (pids are validated integers; actions are fixed strings).

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { captureToFile } from './capture.js';
import { SCREENSHOT_DIR } from './config.js';
import { runScript } from './powershell.js';

const EXEC_OPTS = { timeout: 15_000, windowsHide: true };

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...EXEC_OPTS, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(String(stdout ?? ''));
      }
    });
  });
}

// ---- Power actions ----------------------------------------------------------

export const POWER_ACTIONS = {
  lock: () => run('rundll32.exe', ['user32.dll,LockWorkStation']),
  shutdown: () => run('shutdown.exe', ['/s', '/t', '0']),
  restart: () => run('shutdown.exe', ['/r', '/t', '0']),
  hibernate: () => run('shutdown.exe', ['/h']),
  signout: () => run('logoff.exe', []),
};

export async function powerAction(action) {
  const fn = POWER_ACTIONS[action];
  if (!fn) throw new Error(`unknown power action: ${action}`);
  await fn();
}

// ---- Volume -----------------------------------------------------------------
// Uses keybd_event with the VK_VOLUME_* keys (no pycaw, no nircmd needed).

const VOLUME_SCRIPT = String.raw`
$VK_VOLUME_MUTE = 0xAD; $VK_VOLUME_DOWN = 0xAE; $VK_VOLUME_UP = 0xAF
Add-Type -Namespace Win32 -Name Keys -MemberDefinition @"
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
"@
$vk = @{ up = $VK_VOLUME_UP; down = $VK_VOLUME_DOWN; mute = $VK_VOLUME_MUTE }[ARGS]
if (-not $vk) { throw 'unknown volume action' }
$press = 0x0 # KEYBDINPUT-less legacy keybd_event flags: 0=down, 2=up
for ($i = 0; $i -lt STEPS; $i++) {
  [Win32.Keys]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 10
  [Win32.Keys]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
}
`;

export async function volume(action, steps = 1) {
  const valid = { up: 'up', down: 'down', mute: 'mute' };
  const key = valid[action];
  if (!key) throw new Error(`unknown volume action: ${action}`);
  const count = Math.max(1, Math.min(50, Math.floor(steps) || 1));
  await runScript(VOLUME_SCRIPT.replace('ARGS', `'${key}'`).replace('STEPS', String(count)), { timeoutMs: 20_000 });
}

/** Play a distinctive beep so the user can find a misplaced machine. */
export async function findMeBeep() {
  await runScript(String.raw`
for ($i = 0; $i -lt 3; $i++) {
  [Console]::Beep(880, 250)
  [Console]::Beep(1175, 350)
}
`, { timeoutMs: 20_000 });
}

// ---- Screenshot --------------------------------------------------------------

/** Capture the primary display to agent/screenshots/ and return the path. */
export async function screenshot({ maxWidth = 0 } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SCREENSHOT_DIR, `screenshot-${stamp}.png`);
  const result = await captureToFile(file, { maxWidth });
  return { path: result.path };
}
// ---- Processes ----------------------------------------------------------------

/** Parse `tasklist /fo csv /nh` into a compact process list. */
export async function processList() {
  const out = await run('tasklist.exe', ['/fo', 'csv', '/nh'], { maxBuffer: 16 * 1024 * 1024 });
  const processes = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // "name","pid","session name","session#","mem"
    const m = /^"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"/.exec(line);
    if (!m) continue;
    const memKb = Number(String(m[5]).replace(/[^\d]/g, '')) || 0;
    processes.push({
      name: m[1],
      pid: Number(m[2]),
      memMB: Math.round(memKb / 1024),
    });
  }
  return { processes, count: processes.length };
}

export async function killProcess(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0 || id > 4294967295) {
    throw new Error('pid must be a positive integer');
  }
  await run('taskkill.exe', ['/PID', String(id), '/T', '/F']);
  return { pid: id };
}

// ---- Info ---------------------------------------------------------------------

export async function systemInfo() {
  const cpus = os.cpus();
  const info = {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
    },
    memory: {
      totalMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMB: Math.round(os.freemem() / (1024 * 1024)),
    },
    uptimeSec: Math.round(os.uptime()),
    agentVersion: '1.0.0',
    nodeVersion: process.version,
  };
  // Windows edition is a nice-to-have; never fail the whole call for it.
  try {
    const out = await runScript('(Get-CimInstance Win32_OperatingSystem).Caption');
    if (out.trim()) info.osEdition = out.trim();
  } catch { /* optional */ }
  return info;
}

export async function displayList() {
  const out = await runScript(String.raw`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [PSCustomObject]@{
    name = $_.DeviceName
    primary = $_.Primary
    x = $_.Bounds.X; y = $_.Bounds.Y
    width = $_.Bounds.Width; height = $_.Bounds.Height
    bitsPerPixel = $_.BitsPerPixel
  }
} | ConvertTo-Json -Compress
`);
  const text = out.trim();
  if (!text) return { displays: [] };
  const parsed = JSON.parse(text);
  return { displays: Array.isArray(parsed) ? parsed : [parsed] };
}

export const systemApi = {
  powerAction,
  volume,
  findMeBeep,
  screenshot,
  processList,
  killProcess,
  systemInfo,
  displayList,
};
