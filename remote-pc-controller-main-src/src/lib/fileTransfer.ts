/**
 * Peer-to-peer file transfer over the session's WebRTC connection — files
 * never pass through Supabase (docs/DATA_CHANNEL.md, "File transfer").
 *
 * Each transfer gets its own reliable data channel labelled `file:<id>`:
 *   1. JSON  {t:'file.header', id, name, size, mime}
 *   2. binary chunks (≤ 48 KiB)
 *   3. JSON  {t:'file.end', id}
 * The receiver answers on the same channel with {t:'file.saved', name} or
 * {t:'file.error', message}. Either side may send {t:'file.cancel'}.
 *
 * Phone → PC: the user picks a document, it is streamed to the PC's
 *   Downloads\Remote PC folder.
 * PC → phone: the phone sends {t:'file.request'} on the input channel, the
 *   agent opens the Windows "Open" dialog on the PC (picked with the remote
 *   pointer) and streams the file back; it is saved to Downloads/Remote PC.
 */
import {Platform} from 'react-native';
import {keepLocalCopy, pick} from '@react-native-documents/picker';
import ReactNativeBlobUtil from 'react-native-blob-util';

import {base64ToBytes, bytesToBase64} from './base64';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const CHUNK_BYTES = 48 * 1024; // multiple of 3 → clean base64 boundaries
const READ_TICK_MS = 4;

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'waiting' | 'sending' | 'receiving' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  id: string;
  name: string;
  size: number;
  done: number;
  direction: TransferDirection;
  status: TransferStatus;
  message?: string;
}

interface Channel {
  label: string;
  readyState: string;
  binaryType?: string;
  bufferedAmount?: number;
  send: (data: string | ArrayBuffer) => void;
  close: () => void;
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: {data: string | ArrayBuffer}) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
}

export class TransferManager {
  private listeners = new Set<(list: Transfer[]) => void>();
  private transfers = new Map<string, Transfer>();
  private channels = new Map<string, Channel>();

  constructor(
    private openChannel: (label: string) => Channel | null,
    private onSaved?: (transfer: Transfer, location: string) => void,
  ) {}

  subscribe(listener: (list: Transfer[]) => void) {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): Transfer[] {
    return [...this.transfers.values()].reverse();
  }

  private update(id: string, patch: Partial<Transfer>) {
    const current = this.transfers.get(id);
    if (!current) {
      return;
    }
    this.transfers.set(id, {...current, ...patch});
    const list = this.list();
    this.listeners.forEach(l => l(list));
  }

  cancel(id: string) {
    const channel = this.channels.get(id);
    try {
      channel?.send(JSON.stringify({t: 'file.cancel', id}));
      channel?.close();
    } catch {
      // Already closed.
    }
    this.channels.delete(id);
    this.update(id, {status: 'cancelled'});
  }

  closeAll() {
    for (const id of [...this.channels.keys()]) {
      this.cancel(id);
    }
  }

  // ---- phone → PC ----------------------------------------------------------

  async pickAndSend(): Promise<void> {
    const [file] = await pick({mode: 'import'});
    const name = safeName(file.name ?? 'file');
    const size = file.size ?? 0;
    if (size > MAX_FILE_BYTES) {
      throw new Error('Files up to 1 GB can be sent.');
    }
    const [copy] = await keepLocalCopy({
      files: [{uri: file.uri, fileName: name}],
      destination: 'cachesDirectory',
    });
    if (copy.status !== 'success') {
      throw new Error('Could not read that file.');
    }
    const path = decodeURIComponent(copy.localUri.replace(/^file:\/\//, ''));
    const stat = await ReactNativeBlobUtil.fs.stat(path);
    const id = newId();
    const channel = this.openChannel(`file:${id}`);
    if (!channel) {
      throw new Error('Not connected to the computer.');
    }
    channel.binaryType = 'arraybuffer';
    this.channels.set(id, channel);
    this.transfers.set(id, {
      id,
      name,
      size: Number(stat.size),
      done: 0,
      direction: 'upload',
      status: 'waiting',
    });
    this.update(id, {});

    channel.onmessage = ({data}) => {
      if (typeof data !== 'string') {
        return;
      }
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'file.saved') {
          this.update(id, {status: 'done', done: Number(stat.size), message: msg.path});
          channel.close();
          ReactNativeBlobUtil.fs.unlink(path).catch(() => {});
        } else if (msg.t === 'file.error' || msg.t === 'file.cancel') {
          this.update(id, {status: msg.t === 'file.cancel' ? 'cancelled' : 'failed', message: msg.message});
          channel.close();
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    channel.onclose = () => this.channels.delete(id);
    // A channel opened on an established connection can already be open
    // before `onopen` is attached — start on whichever comes first.
    let started = false;
    const start = async () => {
      if (started) {
        return;
      }
      started = true;
      channel.send(JSON.stringify({t: 'file.header', id, name, size: Number(stat.size), mime: file.type}));
      this.update(id, {status: 'sending'});
      let sent = 0;
      const stream = await ReactNativeBlobUtil.fs.readStream(path, 'base64', CHUNK_BYTES, READ_TICK_MS);
      stream.open();
      stream.onData(chunk => {
        if (channel.readyState !== 'open') {
          return;
        }
        const bytes = base64ToBytes(String(chunk));
        channel.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        sent += bytes.byteLength;
        this.update(id, {done: sent});
      });
      stream.onError(() => {
        this.update(id, {status: 'failed', message: 'Could not read the file.'});
        channel.close();
      });
      stream.onEnd(() => {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify({t: 'file.end', id}));
        }
      });
    };
    channel.onopen = () => void start();
    if (channel.readyState === 'open') {
      void start();
    }
  }

  // ---- PC → phone ----------------------------------------------------------

  /** Called for data channels the agent opens (labels `file:<id>`). */
  acceptIncoming(channel: Channel) {
    if (!channel.label?.startsWith('file:')) {
      return;
    }
    channel.binaryType = 'arraybuffer';
    const id = channel.label.slice(5);
    let target: string | null = null;
    let writing: Promise<unknown> = Promise.resolve();
    let received = 0;
    let header: {name: string; size: number; mime?: string} | null = null;
    this.channels.set(id, channel);

    const fail = (message: string) => {
      this.update(id, {status: 'failed', message});
      try {
        channel.send(JSON.stringify({t: 'file.error', id, message}));
        channel.close();
      } catch {
        // Closed already.
      }
    };

    channel.onmessage = ({data}) => {
      if (typeof data === 'string') {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.t === 'file.header') {
          const size = Number(msg.size);
          const name = safeName(String(msg.name ?? 'file'));
          if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
            fail('File too large.');
            return;
          }
          header = {name, size, mime: typeof msg.mime === 'string' ? msg.mime : undefined};
          target = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/rpc-${id}-${name}`;
          this.transfers.set(id, {id, name, size, done: 0, direction: 'download', status: 'receiving'});
          this.update(id, {});
          const path = target;
          writing = ReactNativeBlobUtil.fs.createFile(path, '', 'base64');
        } else if (msg.t === 'file.end' && header && target) {
          const path = target;
          const h = header;
          writing = writing
            .then(async () => {
              if (received !== h.size) {
                throw new Error('The file arrived incomplete.');
              }
              const location = await saveToDownloads(path, h.name, h.mime);
              this.update(id, {status: 'done', done: received, message: location});
              channel.send(JSON.stringify({t: 'file.saved', id}));
              channel.close();
              this.onSaved?.(this.transfers.get(id)!, location);
            })
            .catch(err => fail(err instanceof Error ? err.message : 'Could not save the file.'));
        } else if (msg.t === 'file.cancel') {
          this.update(id, {status: 'cancelled'});
          channel.close();
        }
        return;
      }
      if (!target) {
        return;
      }
      const bytes = new Uint8Array(data as ArrayBuffer);
      received += bytes.byteLength;
      const path = target;
      const b64 = bytesToBase64(bytes);
      writing = writing.then(() => ReactNativeBlobUtil.fs.appendFile(path, b64, 'base64'));
      this.update(id, {done: received});
    };
    channel.onclose = () => this.channels.delete(id);
  }
}

/** Copy a finished download into the public Downloads/Remote PC folder. */
async function saveToDownloads(path: string, name: string, mime?: string): Promise<string> {
  if (Platform.OS === 'android') {
    await ReactNativeBlobUtil.MediaCollection.copyToMediaStore(
      {name, parentFolder: 'Remote PC', mimeType: mime || 'application/octet-stream'},
      'Download',
      path,
    );
    ReactNativeBlobUtil.fs.unlink(path).catch(() => {});
    return `Downloads/Remote PC/${name}`;
  }
  // iOS: keep it in the app's Documents folder (visible in the Files app).
  const dest = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${name}`;
  await ReactNativeBlobUtil.fs.mv(path, dest);
  return `Files › Remote PC › ${name}`;
}
