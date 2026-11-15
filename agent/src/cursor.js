// Cursor tracker: reports the real Windows pointer (position, visibility and
// shape) so the phone can draw it — screen capture via CopyFromScreen does
// not include the cursor.
//
// A persistent PowerShell worker polls GetCursorInfo ~30 times per second
// and prints one JSON line per change:
//   {"x":0.412,"y":0.733,"v":1,"s":"ibeam"}
// x / y are normalized to the primary screen (same coordinate space the
// input module uses for absolute moves), s is a coarse shape name.

import { spawnScript } from './powershell.js';

const WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr hInstance, int id);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  public static CURSORINFO Read() { var c = new CURSORINFO(); c.cbSize = Marshal.SizeOf(typeof(CURSORINFO)); GetCursorInfo(ref c); return c; }
}
"@
$shapes = @{}
foreach ($pair in @(@(32512,'arrow'),@(32513,'ibeam'),@(32514,'wait'),@(32515,'cross'),@(32642,'size-nwse'),@(32643,'size-nesw'),@(32644,'size-we'),@(32645,'size-ns'),@(32646,'size-all'),@(32648,'no'),@(32649,'hand'),@(32650,'progress'))) {
  $h = [AgentCursor]::LoadCursor([IntPtr]::Zero, $pair[0])
  if ($h -ne [IntPtr]::Zero) { $shapes[$h.ToInt64()] = $pair[1] }
}
$last = ''
while ($true) {
  $c = [AgentCursor]::Read()
  $w = [Math]::Max(1, [AgentCursor]::GetSystemMetrics(0) - 1)
  $h = [Math]::Max(1, [AgentCursor]::GetSystemMetrics(1) - 1)
  $shape = $shapes[$c.hCursor.ToInt64()]
  if (-not $shape) { $shape = 'arrow' }
  $visible = [int](($c.flags -band 1) -eq 1)
  $x = [Math]::Round([Math]::Min(1, [Math]::Max(0, $c.pt.X / $w)), 4)
  $y = [Math]::Round([Math]::Min(1, [Math]::Max(0, $c.pt.Y / $h)), 4)
  $line = '{"x":' + $x.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"y":' + $y.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"v":' + $visible + ',"s":"' + $shape + '"}'
  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Milliseconds 33
}
`;

const SHAPES = new Set([
  'arrow', 'ibeam', 'wait', 'cross', 'size-nwse', 'size-nesw', 'size-we',
  'size-ns', 'size-all', 'no', 'hand', 'progress',
]);

/**
 * Shared cursor tracker: one worker for all sessions, started on the first
 * subscriber and stopped with the last.
 */
export class CursorTracker {
  constructor({ log } = {}) {
    this.log = log ?? (() => {});
    this.child = null;
    this.listeners = new Set();
    this.last = null;
    this.buffer = '';
    this.failures = 0;
  }

  /** Subscribe to cursor changes; returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    if (this.last) listener(this.last);
    if (!this.child) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  start() {
    let child;
    try {
      child = spawnScript(WORKER, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.log(`cursor tracker unavailable: ${err?.message ?? err}`);
      return;
    }
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) this.log(`cursor worker: ${line.slice(0, 200)}`);
    });
    child.on('error', (err) => this.log(`cursor worker error: ${err?.message ?? err}`));
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null;
      // Restart while someone is listening (e.g. after a desktop switch).
      if (this.listeners.size > 0 && this.failures < 5) {
        this.failures += 1;
        setTimeout(() => { if (!this.child && this.listeners.size > 0) this.start(); }, 1000);
      }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this.failures = 0;
      this.last = {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        visible: parsed.v !== 0,
        shape: SHAPES.has(parsed.s) ? parsed.s : 'arrow',
      };
      for (const listener of this.listeners) {
        try { listener(this.last); } catch { /* listener's problem */ }
      }
    }
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* gone */ }
    }
  }
}
