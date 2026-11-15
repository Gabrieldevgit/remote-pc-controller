import {create} from 'zustand';

import {
  fetchDevices,
  toDeviceInfo,
  type DeviceInfo,
  type DeviceRow,
} from '../lib/backend';

export type {DeviceInfo} from '../lib/backend';

/** State of the Realtime link used for banners and empty states. */
export type RelayLinkState = 'connecting' | 'online' | 'offline' | 'signed-out';

interface DevicesState {
  /** Raw rows as stored in Postgres (presence is derived from them). */
  rows: DeviceRow[];
  devices: DeviceInfo[];
  /** True once the first fetch has been applied. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  link: RelayLinkState;
  refresh: () => Promise<void>;
  upsertRow: (row: DeviceRow) => void;
  removeDevice: (deviceId: string) => void;
  applyRename: (deviceId: string, name: string) => void;
  /** Re-derive online flags (heartbeats go stale without an event). */
  tick: () => void;
  setLink: (link: RelayLinkState) => void;
  reset: () => void;
}

function derive(rows: DeviceRow[]): DeviceInfo[] {
  const now = Date.now();
  return rows
    .map(row => toDeviceInfo(row, now))
    .sort((a, b) => {
      if (a.online !== b.online) {
        return a.online ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

export const useDevicesStore = create<DevicesState>((set, get) => ({
  rows: [],
  devices: [],
  loaded: false,
  loading: false,
  error: null,
  link: 'signed-out',

  refresh: async () => {
    if (get().loading) {
      return;
    }
    set({loading: true});
    try {
      const rows = await fetchDevices();
      set({rows, devices: derive(rows), loaded: true, error: null});
    } catch (error) {
      set({error: error instanceof Error ? error.message : 'Could not load your computers.'});
    } finally {
      set({loading: false});
    }
  },

  upsertRow: row =>
    set(state => {
      const rows = state.rows.some(r => r.id === row.id)
        ? state.rows.map(r => (r.id === row.id ? {...r, ...row} : r))
        : [...state.rows, row];
      return {rows, devices: derive(rows)};
    }),

  removeDevice: deviceId =>
    set(state => {
      const rows = state.rows.filter(r => r.id !== deviceId);
      return {rows, devices: derive(rows)};
    }),

  applyRename: (deviceId, name) =>
    set(state => {
      const rows = state.rows.map(r => (r.id === deviceId ? {...r, name} : r));
      return {rows, devices: derive(rows)};
    }),

  tick: () => {
    const {rows, devices} = get();
    const next = derive(rows);
    if (next.some((d, i) => d.online !== devices[i]?.online || d.id !== devices[i]?.id)) {
      set({devices: next});
    }
  },

  setLink: link => set({link}),

  reset: () =>
    set({rows: [], devices: [], loaded: false, loading: false, error: null, link: 'signed-out'}),
}));
