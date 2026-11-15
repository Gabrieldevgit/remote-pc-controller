// Screen capture via PowerShell + .NET (System.Drawing). No native modules —
// works on any stock Windows install.
//
//   - captureToFile(): one-shot PNG screenshot
//   - ScreenFramePump: persistent worker emitting raw BGRA frames; the agent
//     converts them (I420 for the WebRTC video track, JPEG via jpeg-js for the
//     degraded data-channel mode). JPEG encoding is deliberately done in Node,
//     not PowerShell — GDI+ JPEG encoding trips Windows antivirus heuristics.
//
// Inline `-Command` scripts are frequently blocked by antivirus software
// ("ScriptContainedMaliciousContent"); scripts run from .ps1 files via
// powershell.js are allowed.

import fs from 'node:fs';
import path from 'node:path';

import { spawnScript, runScript } from './powershell.js';

// Persistent worker: captures frames in a loop and writes length-prefixed
// [uint64 length][uint32 width][uint32 height][BGRA bytes] payloads to stdout.
// Command loop (one JSON per stdin line):
//   {"op":"raw","maxWidth":N,"intervalMs":N}  → continuous BGRA frames
//   {"op":"stop"}                             → exit
// Reconfigure commands sent between frames take effect immediately.
const RAW_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
public static class AgentLineReader {
  private static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
  public static void Start() {
    var t = new System.Threading.Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) { Queue.Enqueue(line); }
      Queue.Enqueue("__EOF__");
    });
    t.IsBackground = true;
    t.Start();
  }
  public static bool TryRead(ref string line) { return Queue.TryDequeue(out line); }
}
"@
$out = [Console]::OpenStandardOutput()
[AgentLineReader]::Start()

# Reused capture targets — reallocated only when the frame size changes.
$script:buf = $null
$script:bufW = 0
$script:bufH = 0
$script:bmp = $null
$script:g = $null

function Get-Targets([int]$w, [int]$h) {
  if ($script:bufW -ne $w -or $script:bufH -ne $h) {
    if ($script:bmp) { $script:g.Dispose(); $script:bmp.Dispose() }
    $script:bmp = New-Object System.Drawing.Bitmap $w, $h
    $script:g = [System.Drawing.Graphics]::FromImage($script:bmp)
    $script:buf = New-Object byte[] ($w * $h * 4)
    $script:bufW = $w
    $script:bufH = $h
  }
}

function Send-Raw([int]$w, [int]$h) {
  # Frame: [uint64 length][uint32 width][uint32 height][BGRA bytes]
  $header = New-Object byte[] 16
  [BitConverter]::GetBytes([uint64](8 + $script:buf.Length)).CopyTo($header, 0)
  [BitConverter]::GetBytes([uint32]$w).CopyTo($header, 8)
  [BitConverter]::GetBytes([uint32]$h).CopyTo($header, 12)
  $out.Write($header, 0, 16)
  $out.Write($script:buf, 0, $script:buf.Length)
  $out.Flush()
}

function Capture-Raw([int]$maxWidth, [int]$maxHeight) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  # Fit the screen inside maxWidth x maxHeight, keeping its aspect ratio and
  # never upscaling.
  $scale = 1.0
  if ($maxWidth -gt 0 -and $bounds.Width -gt $maxWidth) { $scale = $maxWidth / $bounds.Width }
  if ($maxHeight -gt 0 -and ($bounds.Height * $scale) -gt $maxHeight) { $scale = $maxHeight / $bounds.Height }
  # Even dimensions keep I420 conversion simple.
  $w = [int][Math]::Max(2, [Math]::Floor($bounds.Width * $scale / 2) * 2)
  $h = [int][Math]::Max(2, [Math]::Floor($bounds.Height * $scale / 2) * 2)
  Get-Targets $w $h
  if ($scale -eq 1.0) {
    $script:g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  } else {
    $src = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $gsrc = [System.Drawing.Graphics]::FromImage($src)
    $gsrc.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $gsrc.Dispose()
    $script:g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $script:g.DrawImage($src, 0, 0, $w, $h)
    $src.Dispose()
  }
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $script:bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $script:buf, 0, $script:buf.Length)
  $script:bmp.UnlockBits($data)
  Send-Raw $w $h
}

# Main loop: commands are drained non-blocking via the background reader
# thread (Console.In.Peek would block on an idle pipe).
$script:stop = $false
$script:maxWidth = 1280
$script:maxHeight = 0
$script:intervalMs = 100
while (-not $script:stop) {
  $line = $null
  while ([AgentLineReader]::TryRead([ref]$line)) {
    if ($line -eq '__EOF__') { exit 0 }
    try { $cmd = $line | ConvertFrom-Json } catch { continue }
    if ($cmd.op -eq 'stop') { exit 0 }
    if ($cmd.op -eq 'raw') {
      if ($cmd.maxWidth) { $script:maxWidth = [int]$cmd.maxWidth }
      if ($null -ne $cmd.maxHeight) { $script:maxHeight = [int]$cmd.maxHeight }
      if ($null -ne $cmd.intervalMs) { $script:intervalMs = [int]$cmd.intervalMs }
    }
  }
  try {
    Capture-Raw $script:maxWidth $script:maxHeight
  } catch {
    $err = @{ op = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    [Console]::Error.WriteLine($err)
    Start-Sleep -Milliseconds 500
  }
  if ($script:intervalMs -gt 0) { Start-Sleep -Milliseconds $script:intervalMs }
}
`;

/**
 * One-shot capture: primary screen → PNG file.
 * @returns {Promise<{path: string}>}
 */
export async function captureToFile(filePath, { maxWidth = 0 } = {}) {
  const outPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outNs = outPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$scale = 1.0
$maxWidth = MAXWIDTH
if ($maxWidth -gt 0 -and $bounds.Width -gt $maxWidth) { $scale = $maxWidth / $bounds.Width }
$w = [int][Math]::Max(1, [Math]::Round($bounds.Width * $scale))
$h = [int][Math]::Max(1, [Math]::Round($bounds.Height * $scale))
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($scale -eq 1.0) {
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
} else {
  $src = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $gsrc = [System.Drawing.Graphics]::FromImage($src)
  $gsrc.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $gsrc.Dispose()
  $g.DrawImage($src, 0, 0, $w, $h)
  $src.Dispose()
}
$g.Dispose()
$bmp.Save('OUTPATH', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`.replace('MAXWIDTH', String(Math.max(0, Math.floor(maxWidth))))
    .replace('OUTPATH', outNs);

  await runScript(script, { timeoutMs: 20_000 });
  return { path: outPath };
}

/**
 * Continuous BGRA frame pump backed by a persistent PowerShell worker.
 * onFrame receives { width, height, data: Buffer } per frame (BGRA order).
 * Reconfigurable at runtime (fps / maxWidth); restarts itself if the worker
 * dies.
 */
export class ScreenFramePump {
  constructor({ onFrame, onError, log } = {}) {
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {});
    this.log = log ?? (() => {});
    this.child = null;
    this.settings = { fps: 15, maxWidth: 1280, maxHeight: 0 };
    this.buffer = Buffer.alloc(0);
    this.restarting = false;
    this.stopped = false;
    this.failures = 0;
  }

  /** Apply new settings; (re)starts the worker if needed. */
  configure({ fps, maxWidth, width, maxHeight, height } = {}) {
    // Session quality presets describe the target as `width`; accept both.
    if (maxWidth === undefined) maxWidth = width;
    if (maxHeight === undefined) maxHeight = height;
    if (Number.isFinite(fps) && fps > 0 && fps <= 60) this.settings.fps = Math.round(fps);
    if (Number.isFinite(maxWidth) && maxWidth >= 160 && maxWidth <= 3840) this.settings.maxWidth = Math.round(maxWidth);
    // 0 / null = no height limit (width only).
    if (maxHeight === 0 || maxHeight === null) this.settings.maxHeight = 0;
    else if (Number.isFinite(maxHeight) && maxHeight >= 120 && maxHeight <= 2160) this.settings.maxHeight = Math.round(maxHeight);
    if (!this.child) this.start();
    else this.sendConfig();
  }

  start() {
    if (this.stopped) return;
    this.child = spawnScript(RAW_WORKER_SCRIPT, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) this.log(`capture worker: ${line.slice(0, 200)}`);
    });
    this.child.on('close', (code) => {
      this.child = null;
      if (this.stopped || this.restarting) return;
      // Give up after several consecutive failed starts (e.g. AV blocking).
      this.failures += 1;
      if (this.failures >= 5) {
        this.log('capture worker keeps failing; giving up');
        this.stopped = true;
        this.onError(new Error('capture worker failed to start 5 times'));
        return;
      }
      this.log(`capture worker exited (code ${code}); restarting in 1s`);
      this.restarting = true;
      setTimeout(() => {
        this.restarting = false;
        if (!this.stopped) this.start();
      }, 1000);
    });
    this.child.on('error', (err) => this.onError(err));
    this.sendConfig();
  }

  sendConfig() {
    const { fps, maxWidth, maxHeight } = this.settings;
    const intervalMs = Math.max(0, Math.round(1000 / fps));
    try {
      this.child?.stdin.write(`${JSON.stringify({ op: 'raw', maxWidth, maxHeight, intervalMs })}\n`);
    } catch { /* worker gone; it restarts itself */ }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const length = Number(this.buffer.readBigUInt64LE(0));
      if (!Number.isFinite(length) || length < 8 || length > 48 * 1024 * 1024) {
        // Lost framing sync — drop the worker and start clean.
        this.log('capture stream lost framing; restarting worker');
        this.restart();
        return;
      }
      if (this.buffer.length < 8 + length) return; // wait for the full frame
      const payload = Buffer.from(this.buffer.subarray(8, 8 + length));
      this.buffer = this.buffer.subarray(8 + length);
      this.failures = 0; // a good frame proves the worker is healthy
      try {
        const width = payload.readUInt32LE(0);
        const height = payload.readUInt32LE(4);
        this.onFrame({ width, height, data: payload.subarray(8) });
      } catch { /* consumer error is its own problem */ }
    }
  }

  restart() {
    if (this.child) {
      try { this.child.kill(); } catch { /* gone */ }
      this.child = null;
    }
    if (!this.stopped) this.start();
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.stdin?.write('{"op":"stop"}\n'); } catch { /* gone */ }
      try { this.child.kill(); } catch { /* gone */ }
      this.child = null;
    }
  }
}

let screenSizePromise = null;
/** The primary screen's real size in pixels (DPI-aware), cached. */
export function primaryScreenSize() {
  screenSizePromise ??= runScript(
    "Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ('' + $b.Width + 'x' + $b.Height)",
    { timeoutMs: 15_000 },
  ).then((out) => {
    const m = /(\d+)x(\d+)/.exec(out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }).catch(() => {
    screenSizePromise = null;
    return null;
  });
  return screenSizePromise;
}
