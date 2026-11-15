/**
 * Thin data layer over Supabase for the screens and stores: device rows,
 * pairing codes, quick-action commands and screenshots.
 *
 * Data model (supabase/migrations):
 *   devices          one row per paired PC; presence via device_heartbeat()
 *   remote_sessions  session requests, accepted/ended by the agent
 *   device_commands  quick actions; the agent writes status/result back
 *   screenshots      private Storage bucket, "<device_id>/<file>.png"
 */
import {supabase} from './supabase';

/** A device is online when its agent heart-beat within this window. */
export const ONLINE_WINDOW_MS = 60_000;

export interface DeviceRow {
  id: string;
  name: string;
  os: string;
  agent_version: string | null;
  online: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  os: string;
  online: boolean;
  /** Epoch ms of the last heartbeat (0 when never seen). */
  lastSeen: number;
  version?: string;
  createdAt?: number;
}

export const DEVICE_COLUMNS = 'id,name,os,agent_version,online,last_seen_at,created_at';

export function toDeviceInfo(row: DeviceRow, now = Date.now()): DeviceInfo {
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    online: Boolean(row.online) && now - lastSeen < ONLINE_WINDOW_MS,
    lastSeen,
    version: row.agent_version ?? undefined,
    createdAt: row.created_at ? Date.parse(row.created_at) : undefined,
  };
}

/** Backend failure with a stable code the UI can switch on. */
export class BackendError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BackendError';
  }
}

/** Normalize PostgREST / RPC errors (custom exceptions carry the code). */
export function toBackendError(error: {message?: string; code?: string} | null | undefined): BackendError {
  const message = error?.message ?? 'Something went wrong.';
  for (const code of ['device_offline', 'session_finished', 'not_authenticated', 'device_not_found']) {
    if (message.includes(code)) {
      return new BackendError(code, friendlyMessage(code, message));
    }
  }
  if (/network request failed|failed to fetch/i.test(message)) {
    return new BackendError('network', 'Can’t reach the server. Check your internet connection.');
  }
  return new BackendError(error?.code ?? 'unknown', message);
}

function friendlyMessage(code: string, fallback: string): string {
  switch (code) {
    case 'device_offline':
      return 'That computer is offline.';
    case 'session_finished':
      return 'This session has already ended.';
    case 'not_authenticated':
      return 'Please sign in again.';
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function fetchDevices(): Promise<DeviceRow[]> {
  const {data, error} = await supabase
    .from('devices')
    .select(DEVICE_COLUMNS)
    .order('created_at', {ascending: true});
  if (error) {
    throw toBackendError(error);
  }
  return (data ?? []) as DeviceRow[];
}

export async function renameDevice(deviceId: string, name: string) {
  const {error} = await supabase.from('devices').update({name}).eq('id', deviceId);
  if (error) {
    throw toBackendError(error);
  }
}

export async function deleteDevice(deviceId: string) {
  const {error} = await supabase.from('devices').delete().eq('id', deviceId);
  if (error) {
    throw toBackendError(error);
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function createPairingCode(): Promise<{code: string; expiresAt: number}> {
  const {data, error} = await supabase.rpc('create_pairing_code');
  if (error) {
    throw toBackendError(error);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.code) {
    throw new BackendError('unknown', 'The server did not return a code.');
  }
  return {code: String(row.code), expiresAt: Date.parse(row.expires_at)};
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

export type DeviceCommandName =
  | 'lock'
  | 'shutdown'
  | 'hibernate'
  | 'restart'
  | 'logoff'
  | 'volume_up'
  | 'volume_down'
  | 'mute'
  | 'beep'
  | 'screenshot'
  | 'process_list'
  | 'process_kill'
  | 'sysinfo';

interface CommandRow {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'expired';
  result: Record<string, unknown> | null;
  error: string | null;
}

const COMMAND_TIMEOUT_MS = 35_000;

/**
 * Queue a quick action and resolve with its result once the agent reports
 * back (Realtime UPDATE on the row, with a polling fallback).
 */
export async function runDeviceCommand(
  deviceId: string,
  command: DeviceCommandName,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const {data, error} = await supabase
    .from('device_commands')
    .insert({device_id: deviceId, command, params})
    .select('id')
    .single();
  if (error || !data) {
    throw toBackendError(error);
  }
  const id = data.id as string;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (row: CommandRow | null, timeout = false) => {
      if (settled) {
        return;
      }
      if (!timeout && (!row || row.status === 'pending' || row.status === 'running')) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      void supabase.removeChannel(channel);
      if (timeout) {
        reject(new BackendError('timeout', 'The computer did not answer in time.'));
      } else if (row!.status === 'succeeded') {
        resolve(row!.result ?? {});
      } else if (row!.status === 'expired') {
        reject(new BackendError('timeout', 'The computer did not pick up the command.'));
      } else {
        reject(new BackendError('command_failed', row!.error ?? 'The command failed.'));
      }
    };
    const channel = supabase
      .channel(`command:${id}`)
      .on(
        'postgres_changes',
        {event: 'UPDATE', schema: 'public', table: 'device_commands', filter: `id=eq.${id}`},
        change => finish(change.new as CommandRow),
      )
      .subscribe();
    // Fallback in case the Realtime event is missed.
    const poll = setInterval(async () => {
      const {data: row} = await supabase
        .from('device_commands')
        .select('id,status,result,error')
        .eq('id', id)
        .single();
      finish(row as CommandRow | null);
    }, 3000);
    const timer = setTimeout(() => finish(null, true), COMMAND_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// Screenshots (Storage)
// ---------------------------------------------------------------------------

export async function screenshotUrl(storagePath: string): Promise<string> {
  const {data, error} = await supabase.storage
    .from('screenshots')
    .createSignedUrl(storagePath, 10 * 60);
  if (error || !data) {
    throw toBackendError(error);
  }
  return data.signedUrl;
}

export async function deleteScreenshot(storagePath: string) {
  const {error} = await supabase.storage.from('screenshots').remove([storagePath]);
  if (error) {
    throw toBackendError(error);
  }
}
