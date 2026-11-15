/**
 * One-time wiring between Supabase and the Zustand stores. Called from
 * App.tsx on mount; idempotent.
 *
 *  - restores the auth session and follows sign-in / sign-out
 *  - loads the user's computers and keeps them live through Realtime
 *    (postgres_changes on public.devices — RLS limits it to own rows)
 *  - re-derives online/offline every 15 s, since a PC that vanishes stops
 *    sending heartbeats rather than sending an "offline" event
 */
import type {RealtimeChannel} from '@supabase/supabase-js';

import {supabase} from './supabase';
import type {DeviceRow} from './backend';
import {useAuthStore} from '../store/auth';
import {useDevicesStore} from '../store/devices';
import {useSettingsStore} from '../store/settings';

let bound = false;
let channel: RealtimeChannel | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let currentUser: string | null | undefined;

function stopLive() {
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function startLive(userId: string) {
  stopLive();
  const devices = useDevicesStore.getState();
  devices.setLink('connecting');
  void devices.refresh();

  channel = supabase
    .channel(`devices:${userId}`)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'devices'}, change => {
      const store = useDevicesStore.getState();
      if (change.eventType === 'DELETE') {
        const id = (change.old as {id?: string}).id;
        if (id) {
          store.removeDevice(id);
        }
      } else {
        store.upsertRow(change.new as DeviceRow);
      }
    })
    .subscribe(status => {
      const store = useDevicesStore.getState();
      if (status === 'SUBSCRIBED') {
        store.setLink('online');
        // Catch up on anything that changed while we were disconnected.
        void store.refresh();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        store.setLink('connecting');
      } else if (status === 'CLOSED' && channel) {
        store.setLink('offline');
      }
    });

  ticker = setInterval(() => useDevicesStore.getState().tick(), 15_000);
}

export function bindRelay() {
  if (bound) {
    return;
  }
  bound = true;

  const apply = () => {
    const {userId, hydrated} = useAuthStore.getState();
    if (!hydrated || userId === currentUser) {
      return;
    }
    currentUser = userId;
    // Account changed (sign-in, sign-out, switch): drop the old list.
    useDevicesStore.getState().reset();
    if (userId) {
      startLive(userId);
    } else {
      stopLive();
    }
  };

  useAuthStore.subscribe(apply);
  void useSettingsStore.getState().hydrate();
  void useAuthStore.getState().hydrate().then(apply);
}
