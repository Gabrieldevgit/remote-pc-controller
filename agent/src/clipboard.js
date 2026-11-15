// System clipboard text access. Preferred: clipboardy (pure JS on Windows —
// shells out to `clip` / PowerShell). Fallback: PowerShell Get-/Set-Clipboard.

import { runScript, spawnScript } from './powershell.js';

let clipboardyModule = null;
let loadError = null;
let capabilityInfo = { available: false, mode: 'none', reason: 'not initialized' };

async function loadClipboardy() {
  if (clipboardyModule || loadError) return clipboardyModule;
  try {
    clipboardyModule = await import('clipboardy');
  } catch (err) {
    loadError = err;
  }
  return clipboardyModule;
}

function runPowerShell(script, timeoutMs = 5000) {
  return runScript(script, { timeoutMs });
}

/** Detect clipboard capability. Call once at startup for the feature log. */
export async function detect() {
  const mod = await loadClipboardy();
  if (mod) {
    capabilityInfo = { available: true, mode: 'clipboardy', reason: null };
  } else {
    capabilityInfo = {
      available: false,
      mode: 'none',
      reason: `feature unavailable: clipboardy could not be imported (${loadError?.message ?? 'unknown'})`,
    };
  }
  return capabilityInfo;
}

/** Current capability info (populated by detect()). */
export function clipboardInfo() {
  return capabilityInfo;
}

/** Read text from the system clipboard. Returns '' when empty/non-text. */
export async function readText() {
  const mod = await loadClipboardy();
  if (mod) {
    try {
      return await mod.readText();
    } catch (err) {
      try {
        // Fallback: PowerShell (trailing newline added by the console is trimmed).
        const out = await runPowerShell('Get-Clipboard -Raw');
        return out.replace(/\r?\n$/, '');
      } catch {
        throw err;
      }
    }
  }
  const out = await runPowerShell('Get-Clipboard -Raw');
  return out.replace(/\r?\n$/, '');
}

/** Write text to the system clipboard. Text is passed via stdin — no quoting. */
export async function writeText(text) {
  const value = String(text ?? '');
  const mod = await loadClipboardy();
  if (mod) {
    try {
      await mod.writeText(value);
      return;
    } catch (err) {
      try {
        await writeViaPowerShell(value);
        return;
      } catch {
        throw err;
      }
    }
  }
  await writeViaPowerShell(value);
}

function writeViaPowerShell(value) {
  return new Promise((resolve, reject) => {
    const child = spawnScript('$input | Set-Clipboard', { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error('Set-Clipboard timed out'));
    }, 5000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Set-Clipboard exited with ${code}`));
    });
    child.stdin?.end(value, 'utf8');
  });
}
