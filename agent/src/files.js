// Peer-to-peer file transfer over per-transfer data channels "file:<id>"
// (docs/DATA_CHANNEL.md). Files never touch Supabase.
//
//   phone → PC : receiveUpload(channel)  → %USERPROFILE%\Downloads\Remote PC\
//   PC → phone : sendViaDialog(...)      → Windows "Open" dialog on this PC,
//                                           then streamed to the phone

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runScript } from './powershell.js';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const CHUNK = 48 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;

export function downloadsDir() {
  const base = process.env.AGENT_DOWNLOADS_DIR
    ? path.resolve(process.env.AGENT_DOWNLOADS_DIR)
    : path.join(os.homedir(), 'Downloads', 'Remote PC');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function safeName(name) {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

/** "report.pdf" → "report (2).pdf" when taken. */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function sendJson(channel, obj) {
  try { channel.send(JSON.stringify(obj)); } catch { /* closed */ }
}

/** Receive a phone → PC transfer on a freshly opened `file:<id>` channel. */
export function receiveUpload(channel, { log = () => {}, onSaved } = {}) {
  let header = null;
  let target = null;
  let out = null;
  let received = 0;
  let finished = false;

  const abort = (message, notify = true) => {
    if (finished) return;
    finished = true;
    try { out?.destroy(); } catch { /* gone */ }
    if (target) fs.rm(target, { force: true }, () => {});
    if (notify) sendJson(channel, { t: 'file.error', message });
    log(`upload failed: ${message}`);
  };

  channel.onmessage = (event) => {
    const { data } = event;
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.t === 'file.header' && !header) {
        const size = Number(msg.size);
        if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
          abort('File too large (1 GB maximum).');
          return;
        }
        header = { name: safeName(msg.name), size };
        target = uniquePath(downloadsDir(), header.name);
        out = fs.createWriteStream(target, { flags: 'wx' });
        out.on('error', (err) => abort(`Could not write the file: ${err.message}`));
        log(`receiving ${header.name} (${size} bytes)`);
      } else if (msg.t === 'file.end' && header && !finished) {
        out.end(() => {
          if (received !== header.size) {
            abort('The file arrived incomplete.');
            return;
          }
          finished = true;
          sendJson(channel, { t: 'file.saved', path: target });
          log(`saved ${target}`);
          onSaved?.(target);
        });
      } else if (msg.t === 'file.cancel') {
        abort('cancelled', false);
      }
      return;
    }
    if (!out || finished) return;
    const buf = toBuffer(data);
    if (!buf) return;
    received += buf.length;
    if (received > header.size) {
      abort('Received more data than announced.');
      return;
    }
    out.write(buf);
  };
  channel.onclose = () => {
    if (!finished && header) abort('The connection closed during the transfer.', false);
  };
}

const PICK_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Show()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Remote PC — choose a file to send to the phone'
$dialog.Multiselect = $false
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.FileName)
}
$owner.Close()
`;

/** Open the Windows "Open" dialog on this PC; resolves the chosen path or null. */
export async function pickFileOnPc() {
  const out = await runScript(PICK_SCRIPT, { timeoutMs: 10 * 60_000 });
  const chosen = out.trim().split(/\r?\n/).pop();
  return chosen ? chosen : null;
}

/** Stream a PC file to the phone on a new channel created by `openChannel`. */
export function sendFile(filePath, openChannel, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      reject(new Error(`Can't read ${path.basename(filePath)}: ${err.message}`));
      return;
    }
    if (!stat.isFile()) {
      reject(new Error('Only single files can be sent.'));
      return;
    }
    if (stat.size > MAX_FILE_BYTES) {
      reject(new Error('Files up to 1 GB can be sent.'));
      return;
    }
    const id = crypto.randomUUID();
    const channel = openChannel(`file:${id}`);
    if (!channel) {
      reject(new Error('File transfer is not available in this session.'));
      return;
    }
    let cancelled = false;
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'file.saved') {
        resolve({ name: path.basename(filePath), size: stat.size });
        try { channel.close(); } catch { /* closed */ }
      } else if (msg.t === 'file.error' || msg.t === 'file.cancel') {
        cancelled = true;
        reject(new Error(msg.message ?? 'The phone cancelled the transfer.'));
      }
    };
    const start = async () => {
      sendJson(channel, {
        t: 'file.header',
        id,
        name: path.basename(filePath),
        size: stat.size,
        mime: 'application/octet-stream',
      });
      log(`sending ${filePath} (${stat.size} bytes)`);
      const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK });
      try {
        for await (const chunk of stream) {
          if (cancelled || channel.readyState === 'closed') {
            stream.destroy();
            return;
          }
          while ((channel.bufferedAmount ?? 0) > HIGH_WATER) {
            await new Promise((r) => setTimeout(r, 15));
            if (channel.readyState === 'closed') return;
          }
          channel.send(chunk);
        }
        sendJson(channel, { t: 'file.end', id });
      } catch (err) {
        reject(err);
      }
    };
    if (channel.readyState === 'open') start();
    else channel.onopen = () => start();
  });
}
