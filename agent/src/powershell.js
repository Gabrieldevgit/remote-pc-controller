// PowerShell runner used by every agent module that needs shell helpers.
//
// Inline `-Command` scripts are frequently blocked by Windows antivirus
// ("This script contains malicious content ..."); the identical script run
// from a .ps1 file on disk is allowed. So all payloads are written to a
// per-process temp directory and launched with -File. Scripts receive no
// untrusted input on their command line — callers pass data via stdin or
// placeholder substitution of validated values.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_DIR = path.join(os.tmpdir(), 'remote-pc-agent');
let counter = 0;

function writeScript(script) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `agent-${process.pid}-${Date.now()}-${counter++}.ps1`);
  fs.writeFileSync(file, script, { encoding: 'utf8' });
  return file;
}

const BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/**
 * Run a script to completion; resolves with stdout, rejects on non-zero exit.
 */
export function runScript(script, { timeoutMs = 15_000, maxBuffer } = {}) {
  const file = writeScript(script);
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...BASE_ARGS, '-File', file],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: maxBuffer ?? 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(String(stdout ?? ''));
        }
      },
    );
  });
}

/**
 * Spawn a long-lived worker script. `stdio` is passed through; the caller
 * owns the process. The temp file is removed when the process exits.
 */
export function spawnScript(script, { stdio }) {
  const file = writeScript(script);
  const child = spawn(
    'powershell.exe',
    [...BASE_ARGS, '-File', file],
    { stdio, windowsHide: true },
  );
  child.on('close', () => {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  });
  return child;
}
