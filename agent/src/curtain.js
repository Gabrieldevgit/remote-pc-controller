// Curtain mode: while a remote session is active, cover every monitor of
// this PC with a black window so people standing at the computer can't see
// what the remote user is doing.
//
// The window is excluded from screen capture with
// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) (Windows 10 2004+), so the
// remote side still sees the real desktop. If Windows refuses the affinity,
// the curtain closes immediately — otherwise the remote user would just see
// black. Local keyboard/mouse are not blocked (that needs admin rights).

import os from 'node:os';
import { spawnScript } from './powershell.js';

const WORKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace AgentCurtain -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
"@
$script:allowClose = $false
$forms = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'None'
  $form.StartPosition = 'Manual'
  $form.Bounds = $screen.Bounds
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(23, 25, 28)
  $form.Cursor = [System.Windows.Forms.Cursors]::Default
  $label = New-Object System.Windows.Forms.Label
  $label.Text = "This computer is being used remotely"
  $label.ForeColor = [System.Drawing.Color]::FromArgb(146, 150, 154)
  $label.Font = New-Object System.Drawing.Font('Segoe UI', 18)
  $label.AutoSize = $false
  $label.TextAlign = 'MiddleCenter'
  $label.Dock = 'Fill'
  $form.Controls.Add($label)
  $form.Add_FormClosing({ param($s, $e) if (-not $script:allowClose) { $e.Cancel = $true } })
  $forms += $form
}
$first = $forms[0]
$first.Add_Shown({
  $ok = $true
  foreach ($f in $forms) {
    if ($f -ne $first) { $f.Show() }
    # 0x11 = WDA_EXCLUDEFROMCAPTURE
    if (-not [AgentCurtain.Native]::SetWindowDisplayAffinity($f.Handle, 0x11)) { $ok = $false }
  }
  if ($ok) {
    [Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
  } else {
    [Console]::Out.WriteLine('unsupported'); [Console]::Out.Flush()
    $script:allowClose = $true
    foreach ($f in $forms) { $f.Close() }
  }
})
[System.Windows.Forms.Application]::Run($first)
`;

/** Curtain needs Windows 10 build 19041 (2004) or later. */
export function curtainSupported() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2]);
  return Number.isFinite(build) && build >= 19041;
}

export class Curtain {
  constructor({ log } = {}) {
    this.log = log ?? (() => {});
    this.child = null;
    this.on = false;
  }

  /** Resolves true once the curtain is up (and capture-excluded). */
  show() {
    if (this.child) return Promise.resolve(this.on);
    if (!curtainSupported()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const child = spawnScript(WORKER, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        this.on = ok;
        if (!ok) this.hide();
        resolve(ok);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (/ready/.test(d)) done(true);
        else if (/unsupported/.test(d)) done(false);
      });
      child.stderr.on('data', (d) => this.log(`curtain: ${String(d).trim().slice(0, 200)}`));
      child.on('close', () => {
        if (this.child === child) this.child = null;
        this.on = false;
        done(false);
      });
      setTimeout(() => done(false), 15000);
    });
  }

  hide() {
    this.on = false;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* gone */ }
    }
  }
}
