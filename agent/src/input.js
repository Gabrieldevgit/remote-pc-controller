// Input injection behind one interface. Two backends:
//   1. @nut-tree/nut-js (preferred — fast, in-process; native module, may not
//      build on machines without VS build tools)
//   2. PowerShell SendInput bridge (pure fallback: a persistent powershell.exe
//      worker doing P/Invoke SendInput — works on any stock Windows box)
// If neither is available the backend reports unavailable and every call
// rejects with a clear reason — the agent must never crash over a missing
// capability.
//
// Coordinate convention: the session layer sends normalized coordinates
// (0..1, relative to the streamed frame); this module converts them to pixels
// using the primary screen size, or to SendInput's 0..65535 absolute space.

import { spawnScript } from './powershell.js';

// ---- Virtual-key map ---------------------------------------------------------

const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11,
  control: 0x11, alt: 0x12, menu: 0x12, pause: 0x13, capslock: 0x14, escape: 0x1b,
  esc: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d,
  delete: 0x2e, del: 0x2e, win: 0x5b, meta: 0x5b, super: 0x5b, apps: 0x5d,
  numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xba, equal: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe,
  slash: 0xbf, backquote: 0xc0, grave: 0xc0, bracketleft: 0xdb, backslash: 0xdc,
  bracketright: 0xdd, quote: 0xde,
  // media
  volume_up: 0xaf, volume_down: 0xae, volume_mute: 0xad, play_pause: 0xb3,
  next_track: 0xb0, prev_track: 0xb1, stop_media: 0xb2, mail: 0xb4,
  calculator: 0xb5, browser_back: 0xa6, browser_forward: 0xa7, browser_refresh: 0xa8,
};

for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i < 10; i++) VK[`numpad${i}`] = 0x60 + i;

const MODIFIER_VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b, win: 0x5b };

function vkFor(name) {
  const key = String(name ?? '').toLowerCase().trim();
  if (key in VK) return VK[key];
  if (/^0x[0-9a-f]+$/i.test(key)) {
    const n = Number.parseInt(key, 16);
    if (Number.isInteger(n) && n >= 1 && n <= 0xfe) return n;
  }
  return null;
}

// ---- PowerShell SendInput worker ----------------------------------------------

const PS_INPUT_WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int nIndex);
  const uint MOVE = 0x1, LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10,
             MIDDLEDOWN = 0x20, MIDDLEUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000,
             ABSOLUTE = 0x8000, KEYDOWN = 0, KEYUP = 2, UNICODE = 4;
  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  public static void Mouse(uint flags, int dx, int dy, uint data) {
    var i = new INPUT[1];
    i[0].type = 0;
    i[0].u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    Send(i);
  }
  public static void Key(ushort vk, uint flags) {
    var i = new INPUT[1];
    i[0].type = 1;
    i[0].u.ki = new KEYBDINPUT {
      wVk = (flags & UNICODE) != 0 ? (ushort)0 : vk,
      wScan = (flags & UNICODE) != 0 ? vk : (ushort)0,
      dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero
    };
    Send(i);
  }
  public static void MouseAbs(int x, int y) { Mouse(ABSOLUTE | MOVE, x, y, 0); }
  public static void MouseRel(int dx, int dy) { Mouse(MOVE, dx, dy, 0); }
  public static void Button(string button, bool down) {
    uint f;
    if (button == "left") f = down ? LEFTDOWN : LEFTUP;
    else if (button == "right") f = down ? RIGHTDOWN : RIGHTUP;
    else f = down ? MIDDLEDOWN : MIDDLEUP;
    Mouse(f, 0, 0, 0);
  }
  public static void Wheel(int delta) { Mouse(WHEEL, 0, 0, unchecked((uint)delta)); }
  public static void WheelH(int delta) { Mouse(HWHEEL, 0, 0, unchecked((uint)delta)); }
  public static void KeyDown(ushort vk) { Key(vk, KEYDOWN); }
  public static void KeyUp(ushort vk) { Key(vk, KEYUP); }
  public static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\n') { KeyDown(0x0D); KeyUp(0x0D); continue; }
      Key((ushort)c, UNICODE | KEYDOWN);
      Key((ushort)c, UNICODE | KEYUP);
    }
  }
}
"@
$w = [AgentInput]::GetSystemMetrics(0)
$h = [AgentInput]::GetSystemMetrics(1)
[Console]::Out.WriteLine("READY $w $h")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { continue }
  try {
    switch ($cmd.op) {
      'move' { [AgentInput]::MouseAbs([int]$cmd.x, [int]$cmd.y) }
      'rel'  { [AgentInput]::MouseRel([int]$cmd.dx, [int]$cmd.dy) }
      'btn'  { [AgentInput]::Button([string]$cmd.button, [bool]$cmd.down) }
      'wheel'  { [AgentInput]::Wheel([int]$cmd.delta) }
      'wheelH' { [AgentInput]::WheelH([int]$cmd.delta) }
      'key'  { if ([bool]$cmd.down) { [AgentInput]::KeyDown([uint16]$cmd.vk) } else { [AgentInput]::KeyUp([uint16]$cmd.vk) } }
      'text' { [AgentInput]::TypeText([string]$cmd.text) }
      default { }
    }
  } catch {
    [Console]::Error.WriteLine(("ERR " + $_.Exception.Message))
  }
}
`;

class PowerShellInputBackend {
  constructor(log) {
    this.log = log ?? (() => {});
    this.child = null;
    this.screen = { width: 0, height: 0 };
    this.ready = null; // promise
  }

  ensureWorker() {
    if (this.stopped) throw new Error('input backend stopped');
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnScript(PS_INPUT_WORKER, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.on('data', (d) => {
        const line = d.toString().trim();
        const m = /^READY (\d+) (\d+)$/.exec(line);
        if (m && !settled) {
          settled = true;
          this.screen = { width: Number(m[1]), height: Number(m[2]) };
          resolve(this);
        }
      });
      child.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (text) this.log(`input worker: ${text.slice(0, 200)}`);
      });
      child.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
        this.child = null;
        this.ready = null;
      });
      child.on('close', () => {
        this.child = null;
        this.ready = null;
      });
      // Compile + start can take a couple of seconds the first time.
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('input worker did not become ready in 15s')); }
      }, 15_000).unref?.();
    });
    return this.ready;
  }

  send(cmd) {
    try {
      this.child?.stdin.write(`${JSON.stringify(cmd)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  async cmd(cmd) {
    await this.ensureWorker();
    if (!this.send(cmd)) throw new Error('input worker is not running');
  }

  toAbsolute(x, y) {
    const w = Math.max(1, this.screen.width || 1920);
    const h = Math.max(1, this.screen.height || 1080);
    return {
      x: Math.max(0, Math.min(65535, Math.round((x / (w - 1)) * 65535))),
      y: Math.max(0, Math.min(65535, Math.round((y / (h - 1)) * 65535))),
    };
  }

  async moveAbs(x, y) {
    await this.ensureWorker();
    const a = this.toAbsolute(x, y);
    this.send({ op: 'move', x: a.x, y: a.y });
  }

  async moveRel(dx, dy) {
    await this.cmd({ op: 'rel', dx: Math.round(dx), dy: Math.round(dy) });
  }

  async button(button, down) {
    const map = { left: 'left', right: 'right', middle: 'middle' };
    await this.cmd({ op: 'btn', button: map[button] ?? 'left', down: Boolean(down) });
  }

  async scroll(deltaV, deltaH = 0) {
    await this.ensureWorker();
    // WHEEL delta: +120 per notch away from the user (up).
    if (deltaV) this.send({ op: 'wheel', delta: Math.round(deltaV * 120) });
    if (deltaH) this.send({ op: 'wheelH', delta: Math.round(deltaH * 120) });
  }

  async key(vk, down) {
    await this.cmd({ op: 'key', vk, down });
  }

  async typeText(text) {
    await this.cmd({ op: 'text', text: String(text ?? '') });
  }

  close() {
    this.stopped = true;
    try { this.child?.kill(); } catch { /* gone */ }
    this.child = null;
  }
}

// ---- nut-js backend --------------------------------------------------------------

const NUT_KEY_NAMES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: 'Space',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  left: 'Left', up: 'Up', right: 'Right', down: 'Down',
  insert: 'Insert', printscreen: 'PrintScreen', capslock: 'CapsLock',
  numlock: 'NumLock', scrolllock: 'ScrollLock',
  ctrl: 'LeftControl', control: 'LeftControl', alt: 'LeftAlt', shift: 'LeftShift',
  meta: 'LeftWin', win: 'LeftWin',
  volume_up: 'AudioVolUp', volume_down: 'AudioVolDown', volume_mute: 'AudioMute',
  play_pause: 'MediaPlayPause', next_track: 'MediaNext', prev_track: 'MediaPrev',
};

const NUT_BUTTONS = { left: 0, middle: 1, right: 2 };

class NutInputBackend {
  constructor(nut, log) {
    this.nut = nut;
    this.log = log ?? (() => {});
    this.screen = { width: 0, height: 0 };
  }

  async init() {
    const { mouse, keyboard, screen } = this.nut;
    mouse.config.autoDelayMs = 0;
    keyboard.config.autoDelayMs = 0;
    this.screen = { width: await screen.width(), height: await screen.height() };
  }

  nutKey(name) {
    const key = String(name ?? '').toLowerCase().trim();
    if (NUT_KEY_NAMES[key]) return this.nut.Key[NUT_KEY_NAMES[key]];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return this.nut.Key[`F${key.slice(1)}`];
    if (key in this.nut.Key) {
      const single = key.length === 1 ? key.toUpperCase() : key;
      if (single in this.nut.Key) return this.nut.Key[single];
    }
    return null;
  }

  async moveAbs(x, y) {
    const { mouse, Point } = this.nut;
    await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
  }

  async moveRel(dx, dy) {
    const { mouse, Point } = this.nut;
    const pos = await mouse.getPosition();
    await mouse.setPosition(new Point(pos.x + Math.round(dx), pos.y + Math.round(dy)));
  }

  async button(button, down) {
    const btn = NUT_BUTTONS[button] ?? 0;
    if (down) await this.nut.mouse.pressButton(btn);
    else await this.nut.mouse.releaseButton(btn);
  }

  async scroll(deltaV, deltaH = 0) {
    const { mouse } = this.nut;
    const amount = Math.abs(Math.round(deltaV || deltaH)) || 1;
    if (deltaV > 0) await mouse.scrollUp(amount);
    else if (deltaV < 0) await mouse.scrollDown(amount);
    else if (deltaH > 0) await mouse.scrollRight(amount);
    else if (deltaH < 0) await mouse.scrollLeft(amount);
  }

  async key(vk, down) {
    // nut-js works with Key enums, not raw VKs — find the matching enum entry.
    const entry = Object.entries(this.nut.Key).find(([, value]) => value === vk);
    if (!entry) throw new Error(`no nut-js Key for vk ${vk}`);
    if (down) await this.nut.keyboard.pressKey(entry[1]);
    else await this.nut.keyboard.releaseKey(entry[1]);
  }

  async typeText(text) {
    await this.nut.keyboard.type(String(text ?? ''));
  }

  close() { /* nothing persistent */ }
}

// ---- Public interface (module-level exports) --------------------------------------

let backend = null;
let backendInfo = { available: false, mode: 'none', reason: 'not initialized' };

/** Detect and initialize the best available input backend. */
export async function detect(log = console.log) {
  try {
    const nut = await import('@nut-tree/nut-js');
    const candidate = new NutInputBackend(nut, log);
    await candidate.init();
    backend = candidate;
    backendInfo = { available: true, mode: 'nut-js', reason: null };
    return backendInfo;
  } catch (nutErr) {
    try {
      const candidate = new PowerShellInputBackend(log);
      await candidate.ensureWorker();
      backend = candidate;
      backendInfo = { available: true, mode: 'powershell-sendinput', reason: null };
      return backendInfo;
    } catch (psErr) {
      backend = null;
      backendInfo = {
        available: false,
        mode: 'none',
        reason: `feature unavailable: no input backend (@nut-tree/nut-js: ${nutErr.message}; powershell SendInput: ${psErr.message})`,
      };
      return backendInfo;
    }
  }
}

/** Current capability info (populated by detect()). */
export function inputInfo() {
  return backendInfo;
}

function requireBackend() {
  if (!backend || !backendInfo.available) {
    throw new Error(backendInfo.reason ?? 'input injection unavailable');
  }
  return backend;
}

function checkCoord(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Primary screen size in pixels (0 when unknown). */
export function screenSize() {
  return backend?.screen ?? { width: 0, height: 0 };
}

/** Absolute move in primary-screen pixels (or normalized 0..1 when normalized=true). */
export async function moveAbs(x, y, { normalized = false } = {}) {
  const b = requireBackend();
  if (normalized) {
    const w = Math.max(1, (b.screen.width || 1920) - 1);
    const h = Math.max(1, (b.screen.height || 1080) - 1);
    return b.moveAbs(checkCoord(x) * w, checkCoord(y) * h);
  }
  return b.moveAbs(checkCoord(x), checkCoord(y));
}

export async function moveRel(dx, dy) {
  return requireBackend().moveRel(checkCoord(dx), checkCoord(dy));
}

export async function button(buttonName, down) {
  const name = String(buttonName ?? 'left').toLowerCase();
  if (!(name in { left: 1, right: 1, middle: 1 })) throw new Error(`unknown button: ${name}`);
  return requireBackend().button(name, Boolean(down));
}

export async function click(buttonName = 'left', { double = false } = {}) {
  const b = requireBackend();
  const name = String(buttonName ?? 'left').toLowerCase();
  if (!(name in { left: 1, right: 1, middle: 1 })) throw new Error(`unknown button: ${name}`);
  await b.button(name, true);
  await b.button(name, false);
  if (double) {
    await b.button(name, true);
    await b.button(name, false);
  }
}

/** Scroll in notches; positive = up / right. */
export async function scroll(dx = 0, dy = 0) {
  return requireBackend().scroll(checkCoord(dy), checkCoord(dx));
}

/** Tap a key with optional modifiers, e.g. keyTap('r', ['ctrl']). */
export async function keyTap(keyName, modifiers = []) {
  const b = requireBackend();
  const mods = Array.isArray(modifiers) ? modifiers : [];
  if (b instanceof NutInputBackend) {
    const key = b.nutKey(keyName);
    if (!key) {
      if (mods.length === 0 && String(keyName ?? '').length === 1) return b.typeText(String(keyName));
      throw new Error(`unknown key: ${keyName}`);
    }
    const modKeys = mods.map((m) => b.nutKey(m)).filter(Boolean);
    await b.nut.keyboard.pressKey(...modKeys, key);
    await b.nut.keyboard.releaseKey(...modKeys.reverse(), key);
    return;
  }
  // PowerShell backend: hold modifiers, tap key, release modifiers.
  const vk = vkFor(keyName);
  if (vk === null) throw new Error(`unknown key: ${keyName}`);
  const modVks = mods.map((m) => MODIFIER_VK[String(m ?? '').toLowerCase()]).filter(Boolean);
  for (const m of modVks) await b.key(m, true);
  await b.key(vk, true);
  await b.key(vk, false);
  for (const m of modVks.reverse()) await b.key(m, false);
}

/** Hold or release a key (optionally with modifiers held). */
export async function keyToggle(keyName, down, modifiers = []) {
  const b = requireBackend();
  const vk = vkFor(keyName);
  if (vk === null) throw new Error(`unknown key: ${keyName}`);
  if (b instanceof NutInputBackend) {
    const key = b.nutKey(keyName);
    if (!key) throw new Error(`unknown key: ${keyName}`);
    if (down) await b.nut.keyboard.pressKey(key);
    else await b.nut.keyboard.releaseKey(key);
    return;
  }
  const mods = Array.isArray(modifiers) ? modifiers : [];
  if (down) {
    for (const m of mods) {
      const mvk = MODIFIER_VK[String(m ?? '').toLowerCase()];
      if (mvk) await b.key(mvk, true);
    }
    await b.key(vk, true);
  } else {
    await b.key(vk, false);
    for (const m of mods.reverse()) {
      const mvk = MODIFIER_VK[String(m ?? '').toLowerCase()];
      if (mvk) await b.key(mvk, false);
    }
  }
}

/** Type Unicode text (KEYEVENTF_UNICODE / nut-js type). */
export async function typeText(text) {
  return requireBackend().typeText(text);
}

/** Media keys by name. */
export async function mediaKey(name) {
  const key = String(name ?? '').toLowerCase().trim();
  const allowed = new Set([
    'volume_up', 'volume_down', 'volume_mute', 'play_pause',
    'next_track', 'prev_track', 'stop_media', 'mail', 'calculator',
    'browser_back', 'browser_forward', 'browser_refresh',
  ]);
  if (!allowed.has(key)) throw new Error(`unknown media key: ${key}`);
  return keyTap(key);
}

/**
 * Ctrl+Alt+Del: best-effort. The Secure Attention Sequence cannot be injected
 * from user mode on Windows (it requires a SAS service/driver), so this always
 * rejects with a clear reason. The session layer reports it to the client.
 */
export async function ctrlAltDel() {
  throw new Error('ctrl+alt+del cannot be injected from user mode (Secure Attention Sequence requires a service driver)');
}

/** Module-level shutdown: release whichever input backend is active. */
export function closeInput() {
  backend?.close?.();
  backend = null;
  backendInfo = { available: false, mode: 'none', reason: 'closed' };
}
