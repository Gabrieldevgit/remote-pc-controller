/**
 * "PC controls this phone" — the phone side.
 *
 *   1. The user turns on "Available to my PCs": the phone gets a `phones`
 *      row, heart-beats every 20 s and listens for `phone_sessions` inserts
 *      (a foreground service keeps this running in the background).
 *   2. Remote PC Host (same account) inserts a session → notification +
 *      in-app prompt. Allow → Android's screen-sharing prompt
 *      (getDisplayMedia) → state 'accepted'.
 *   3. The PC joins `phone:<session id>` and sends an offer; we answer with
 *      the screen track. Data channels from the PC: `input` (control
 *      messages, docs/DATA_CHANNEL.md "Phone host"), `audio` (phone sound,
 *      PCM) and `file:<id>` (files, same protocol as PC ↔ phone).
 *
 * Input is performed by the RemoteControlService accessibility service
 * (android/…/phonehost). Without it the session is view-only.
 */
import {AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, type MediaStream} from 'react-native-webrtc';
import type {RealtimeChannel} from '@supabase/supabase-js';
import {create} from 'zustand';

import {supabase} from './supabase';
import {clientName} from './clientName';
import {getIceServers} from './iceServers';
import {TransferManager, type Transfer} from './fileTransfer';
import {base64ToBytes} from './base64';

interface PhoneHostNative {
  isAccessibilityEnabled(): Promise<boolean>;
  openAccessibilitySettings(): void;
  openAppDetails(): void;
  getDisplayInfo(): Promise<DisplayInfo>;
  touch(phase: 'down' | 'move' | 'up', x: number, y: number): void;
  tap(x: number, y: number): void;
  volume(dir: 'up' | 'down'): Promise<boolean>;
  power(long: boolean): Promise<boolean>;
  canRotate(): Promise<boolean>;
  openRotationSettings(): void;
  rotate(dir: 'left' | 'right'): Promise<number>;
  restoreRotation(): void;
  scroll(x: number, y: number, dx: number, dy: number): void;
  nav(action: string): Promise<boolean>;
  typeText(text: string): Promise<boolean>;
  key(code: string): Promise<boolean>;
  setCaptureSize(width: number, height: number, fps: number): Promise<boolean>;
  startAudio(): Promise<number>;
  stopAudio(): void;
  startAvailability(title: string, text: string): void;
  stopAvailability(): void;
  showRequest(sessionId: string, pcName: string): void;
  clearRequest(): void;
  keepConnection(on: boolean): void;
}

export interface DisplayInfo {
  width: number;
  height: number;
  rotation: number;
  density: number;
}

const Native: PhoneHostNative | undefined = NativeModules.PhoneHost;
export const phoneHostSupported = Platform.OS === 'android' && Native != null;

const KEY_AVAILABLE = 'phoneHost.available';
const KEY_PHONE = (userId: string) => `phoneHost.phoneId.${userId}`;
const HEARTBEAT_MS = 20_000;
const REQUEST_MAX_AGE_MS = 2 * 60_000;
/** Auto stream size: long side at most this many pixels. */
const AUTO_LONG_SIDE = 1600;
const NAV_ACTIONS = new Set(['back', 'home', 'recents', 'notifications', 'quick_settings', 'power', 'lock', 'screenshot']);

export type HostPhase = 'idle' | 'starting' | 'connecting' | 'connected';

export interface PhoneRequest {
  sessionId: string;
  pcName: string;
}

interface PhoneHostState {
  available: boolean;
  busy: boolean;
  phoneId: string | null;
  accessibility: boolean;
  /** "Modify system settings" granted (Rotate from the PC). */
  rotate: boolean;
  request: PhoneRequest | null;
  phase: HostPhase;
  pcName: string | null;
  audioOn: boolean;
  transfers: Transfer[];
  error: string | null;
}

export const usePhoneHostStore = create<PhoneHostState>(() => ({
  available: false,
  busy: false,
  phoneId: null,
  accessibility: false,
  rotate: false,
  request: null,
  phase: 'idle',
  pcName: null,
  audioOn: false,
  transfers: [],
  error: null,
}));

const set = (patch: Partial<PhoneHostState>) => usePhoneHostStore.setState(patch);

// ---- module state ---------------------------------------------------------------------

let userId: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let requestsChannel: RealtimeChannel | null = null;
let session: HostSession | null = null;

export async function refreshAccessibility(): Promise<boolean> {
  const on = phoneHostSupported ? await Native!.isAccessibilityEnabled().catch(() => false) : false;
  set({accessibility: on});
  return on;
}

export const openAccessibilitySettings = () => Native?.openAccessibilitySettings();
export const openAppDetails = () => Native?.openAppDetails();
export const openRotationSettings = () => Native?.openRotationSettings();

/** "Modify system settings" granted → the PC's Rotate buttons work. */
export async function refreshRotation(): Promise<boolean> {
  const on = phoneHostSupported ? await Native!.canRotate().catch(() => false) : false;
  set({rotate: on});
  return on;
}

/** Debug input test screen (src/screens/InputTestScreen.tsx). */
export const debugInput = {
  tap: (x: number, y: number) => Native?.tap(x, y),
  touch: (phase: 'down' | 'move' | 'up', x: number, y: number) => Native?.touch(phase, x, y),
  scroll: (x: number, y: number, dx: number, dy: number) => Native?.scroll(x, y, dx, dy),
};

AppState.addEventListener('change', state => {
  if (state === 'active') {
    void refreshAccessibility();
    void refreshRotation();
  }
});

async function ensurePhoneRow(uid: string): Promise<string> {
  const saved = await AsyncStorage.getItem(KEY_PHONE(uid));
  if (saved) {
    const {data} = await supabase.from('phones').select('id').eq('id', saved).maybeSingle();
    if (data?.id) {
      await supabase.from('phones').update({name: clientName().split(' · ')[0], model: clientName()}).eq('id', saved);
      return saved;
    }
  }
  const constants = (Platform.constants ?? {}) as Record<string, unknown>;
  const {data, error} = await supabase
    .from('phones')
    .insert({
      name: clientName().split(' · ')[0].slice(0, 64) || 'Android phone',
      model: clientName(),
      android_version: String(constants.Release ?? Platform.Version).slice(0, 16),
      capabilities: {gestures: true, audio: Number(Platform.Version) >= 29, files: true},
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? 'Could not register this phone.');
  }
  await AsyncStorage.setItem(KEY_PHONE(uid), data.id);
  return data.id as string;
}

async function beat(phoneId: string, online = true) {
  await supabase.rpc('phone_heartbeat', {p_phone: phoneId, p_online: online});
}

function listenForRequests(phoneId: string) {
  requestsChannel?.unsubscribe();
  requestsChannel = supabase
    .channel(`phone-requests:${phoneId}`)
    .on(
      'postgres_changes',
      {event: 'INSERT', schema: 'public', table: 'phone_sessions', filter: `phone_id=eq.${phoneId}`},
      change => onRequest(change.new as {id: string; client_name: string | null; state: string; created_at: string}),
    )
    .on(
      'postgres_changes',
      {event: 'UPDATE', schema: 'public', table: 'phone_sessions', filter: `phone_id=eq.${phoneId}`},
      change => {
        const row = change.new as {id: string; state: string; end_reason?: string | null};
        const req = usePhoneHostStore.getState().request;
        if (req?.sessionId === row.id && row.state !== 'requested') {
          Native?.clearRequest();
          set({request: null});
        }
        if (session?.id === row.id && (row.state === 'ended' || row.state === 'rejected')) {
          void session.close(false);
        }
      },
    )
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        // Catch up on a request made while we were not listening.
        const since = new Date(Date.now() - REQUEST_MAX_AGE_MS).toISOString();
        const {data} = await supabase
          .from('phone_sessions')
          .select('id,client_name,state,created_at')
          .eq('phone_id', phoneId)
          .eq('state', 'requested')
          .gte('created_at', since)
          .order('created_at', {ascending: false})
          .limit(1);
        if (data?.[0]) {
          onRequest(data[0]);
        }
      }
    });
}

function onRequest(row: {id: string; client_name: string | null; state: string; created_at: string}) {
  if (row.state !== 'requested' || Date.now() - Date.parse(row.created_at) > REQUEST_MAX_AGE_MS) {
    return;
  }
  if (session) {
    // Already controlled by a PC: decline the second one.
    void supabase.from('phone_sessions').update({state: 'rejected', end_reason: 'busy'}).eq('id', row.id).then(undefined, () => {});
    return;
  }
  const pcName = row.client_name || 'Your PC';
  set({request: {sessionId: row.id, pcName}});
  Native?.showRequest(row.id, pcName);
}

/** Turn "Available to my PCs" on. */
export async function enableAvailability(uid: string): Promise<void> {
  if (!phoneHostSupported) {
    throw new Error('Only Android phones can be controlled from a PC.');
  }
  set({busy: true, error: null});
  try {
    userId = uid;
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never).catch(() => null);
    }
    const phoneId = await ensurePhoneRow(uid);
    await beat(phoneId, true);
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    heartbeat = setInterval(() => void beat(phoneId, true).catch(() => {}), HEARTBEAT_MS);
    listenForRequests(phoneId);
    Native!.startAvailability(
      'Available to your PCs',
      'Your PCs can ask to control this phone. You’ll be asked to allow each time.',
    );
    await AsyncStorage.setItem(KEY_AVAILABLE, '1');
    set({available: true, phoneId, busy: false});
    void refreshAccessibility();
  } catch (err) {
    set({busy: false, error: err instanceof Error ? err.message : 'Could not turn it on.'});
    throw err;
  }
}

/** Turn it off (also on sign-out). */
export async function disableAvailability(): Promise<void> {
  const {phoneId} = usePhoneHostStore.getState();
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  requestsChannel?.unsubscribe();
  requestsChannel = null;
  Native?.stopAvailability();
  await AsyncStorage.setItem(KEY_AVAILABLE, '0').catch(() => {});
  set({available: false, request: null});
  if (phoneId) {
    await beat(phoneId, false).catch(() => {});
  }
}

/** On app start / sign-in: restore the user's choice. */
export async function resumeAvailability(uid: string | null): Promise<void> {
  if (!uid) {
    if (usePhoneHostStore.getState().available) {
      await disableAvailability();
    }
    userId = null;
    return;
  }
  void refreshAccessibility();
  const want = (await AsyncStorage.getItem(KEY_AVAILABLE)) === '1';
  if (want && phoneHostSupported && !usePhoneHostStore.getState().available) {
    await enableAvailability(uid).catch(() => {});
  }
}

export async function declineRequest() {
  const req = usePhoneHostStore.getState().request;
  Native?.clearRequest();
  set({request: null});
  if (req) {
    await supabase.from('phone_sessions').update({state: 'rejected', end_reason: 'declined'}).eq('id', req.sessionId);
  }
}

/** Allow → Android screen-sharing prompt → accept the session. */
export async function acceptRequest(): Promise<void> {
  const req = usePhoneHostStore.getState().request;
  if (!req || session) {
    return;
  }
  Native?.clearRequest();
  set({request: null, phase: 'starting', pcName: req.pcName, error: null});
  const s = new HostSession(req.sessionId, req.pcName);
  session = s;
  try {
    await s.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not start sharing.';
    set({error: /denied|cancel|permission/i.test(message) ? 'Screen sharing was not allowed on the phone.' : message});
    await s.close(true, 'capture_denied');
  }
}

export function stopSharing() {
  void session?.close(true, 'phone_stopped');
}

export function cancelTransfer(id: string) {
  session?.transfers.cancel(id);
}

// ---- one session ----------------------------------------------------------------------

type Channel = {
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
};

class HostSession {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private signal: RealtimeChannel | null = null;
  private input: Channel | null = null;
  private audio: Channel | null = null;
  private pendingIce: RTCIceCandidate[] = [];
  private closed = false;
  private answering = false;
  private lostTimer: ReturnType<typeof setTimeout> | null = null;
  private display: DisplayInfo | null = null;
  private box: {width: number; height: number} | null = null; // requested stream size
  private subs: {remove: () => void}[] = [];
  readonly transfers: TransferManager;

  constructor(readonly id: string, readonly pcName: string) {
    this.transfers = new TransferManager(label => (this.pc ? (this.pc.createDataChannel(label, {ordered: true}) as unknown as Channel) : null));
    this.transfers.subscribe(list => set({transfers: list}));
  }

  async start() {
    // 1. Android's own prompt ("Start recording or casting?"); the whole
    //    screen, not a single app, so the PC can control everything.
    this.stream = (await mediaDevices.getDisplayMedia({android: {createConfigForDefaultDisplay: true}})) as MediaStream;
    if (this.closed) {
      return;
    }
    this.display = await Native!.getDisplayInfo();
    // 2. Signaling channel, then accept (the PC sends its offer after that).
    await this.joinSignaling();
    const {error} = await supabase.from('phone_sessions').update({state: 'accepted'}).eq('id', this.id);
    if (error) {
      throw new Error(error.message);
    }
    set({phase: 'connecting'});
    // Keep Wi-Fi / CPU awake while the PC controls the phone (no freezes from power saving).
    Native?.keepConnection(true);
    const emitter = new NativeEventEmitter(NativeModules.PhoneHost);
    this.subs.push(
      emitter.addListener('PhoneHostDisplay', (info: DisplayInfo) => {
        this.display = info;
        void this.applyCaptureSize();
        this.sendScreen();
      }),
      emitter.addListener('PhoneHostAudio', (chunk: string) => {
        if (this.audio?.readyState === 'open') {
          const bytes = base64ToBytes(chunk);
          this.audio.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        }
      }),
    );
    // Ends by itself if the PC never connects.
    setTimeout(() => {
      if (!this.closed && usePhoneHostStore.getState().phase !== 'connected') {
        set({error: 'The PC did not connect.'});
        void this.close(true, 'timeout');
      }
    }, 45_000);
  }

  private joinSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      void supabase.realtime.setAuth().then(() => {
        this.signal = supabase
          .channel(`phone:${this.id}`, {config: {private: true, broadcast: {self: false, ack: true}}})
          .on('broadcast', {event: 'offer'}, ({payload}) => {
            if (typeof payload?.sdp === 'string') {
              void this.answer(payload.sdp);
            }
          })
          .on('broadcast', {event: 'ice'}, ({payload}) => {
            if (typeof payload?.candidate === 'string') {
              const c = new RTCIceCandidate({
                candidate: payload.candidate,
                sdpMid: payload.sdpMid ?? null,
                sdpMLineIndex: payload.sdpMLineIndex ?? null,
              });
              if (this.pc?.remoteDescription) {
                void this.pc.addIceCandidate(c).catch(() => {});
              } else {
                this.pendingIce.push(c);
              }
            }
          })
          .on('broadcast', {event: 'end'}, () => void this.close(false))
          .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
              resolve();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              reject(new Error(err?.message ?? 'Could not open the signaling channel.'));
            }
          });
      }, reject);
    });
  }

  private send(event: string, payload: Record<string, unknown>) {
    void this.signal?.send({type: 'broadcast', event, payload});
  }

  private async answer(sdp: string) {
    if (this.closed || !this.stream) {
      return;
    }
    if (this.pc) {
      // A new offer on the same session: the PC restarts ICE after a network drop.
      const live = this.pc;
      try {
        await live.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp}));
        const again = await live.createAnswer();
        await live.setLocalDescription(again);
        this.send('answer', {sdp: again.sdp});
      } catch {
        // The next attempt from the PC will try again.
      }
      return;
    }
    if (this.answering) {
      return;
    }
    this.answering = true;
    // STUN + TURN: TURN relays the stream when the PC is on another network.
    const iceServers = await getIceServers();
    if (this.closed || this.pc) {
      return;
    }
    const pc = new RTCPeerConnection({iceServers: iceServers as never[]});
    this.pc = pc;
    for (const track of this.stream.getTracks()) {
      pc.addTrack(track, this.stream);
    }
    const anyPc = pc as unknown as {
      onicecandidate: ((e: {candidate: RTCIceCandidate | null}) => void) | null;
      ondatachannel: ((e: {channel: Channel}) => void) | null;
      onconnectionstatechange: (() => void) | null;
    };
    anyPc.onicecandidate = e => {
      if (e.candidate) {
        this.send('ice', {candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex});
      }
    };
    anyPc.ondatachannel = ({channel}) => this.onChannel(channel);
    anyPc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        if (this.lostTimer) {
          clearTimeout(this.lostTimer);
          this.lostTimer = null;
        }
        set({phase: 'connected'});
      } else if ((state === 'disconnected' || state === 'failed') && !this.lostTimer) {
        // The PC restarts ICE to recover; only hang up if that never works.
        this.lostTimer = setTimeout(() => {
          this.lostTimer = null;
          if (!this.closed && pc.connectionState !== 'connected') {
            set({error: 'The connection to the PC was lost.'});
            void this.close(true, 'connection_failed');
          }
        }, 55_000);
      }
    };
    await pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp}));
    for (const c of this.pendingIce.splice(0)) {
      await pc.addIceCandidate(c).catch(() => {});
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send('answer', {sdp: answer.sdp});
  }

  private onChannel(channel: Channel) {
    if (channel.label === 'input') {
      this.input = channel;
      const ready = () => {
        this.sendScreen();
        void Promise.all([refreshAccessibility(), refreshRotation()]).then(([input, rotate]) =>
          this.sendJson({t: 'access', input, rotate}),
        );
        this.sendJson({t: 'audio.state', available: Number(Platform.Version) >= 29, on: false});
        void this.applyCaptureSize();
      };
      channel.onopen = ready;
      if (channel.readyState === 'open') {
        ready();
      }
      channel.onmessage = ({data}) => {
        if (typeof data === 'string') {
          void this.onInput(data);
        }
      };
      channel.onclose = () => void this.close(false);
    } else if (channel.label === 'audio') {
      this.audio = channel;
    } else if (channel.label.startsWith('file:')) {
      this.transfers.acceptIncoming(channel);
    }
  }

  private sendJson(msg: Record<string, unknown>) {
    if (this.input?.readyState === 'open') {
      try {
        this.input.send(JSON.stringify(msg));
      } catch {
        // closing
      }
    }
  }

  private sendScreen() {
    if (this.display) {
      this.sendJson({t: 'screen', width: this.display.width, height: this.display.height, rotation: this.display.rotation});
    }
  }

  /** Stream size: requested box (or Auto), keeping the phone's shape. */
  private async applyCaptureSize() {
    const d = this.display;
    if (!d) {
      return;
    }
    let scale = Math.min(1, AUTO_LONG_SIDE / Math.max(d.width, d.height));
    if (this.box) {
      // The box is given landscape-first; match it to the phone's orientation.
      const portrait = d.height >= d.width;
      const bw = portrait ? Math.min(this.box.width, this.box.height) : Math.max(this.box.width, this.box.height);
      const bh = portrait ? Math.max(this.box.width, this.box.height) : Math.min(this.box.width, this.box.height);
      scale = Math.min(1, bw / d.width, bh / d.height);
    }
    const w = Math.max(2, Math.floor((d.width * scale) / 2) * 2);
    const h = Math.max(2, Math.floor((d.height * scale) / 2) * 2);
    const ok = await Native!.setCaptureSize(w, h, 30).catch(() => false);
    this.sendJson({t: 'quality.ack', size: {width: w, height: h}, screen: {width: d.width, height: d.height}, applied: ok});
  }

  private async onInput(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    try {
      switch (msg.t) {
        case 'tap': {
          const x = num(msg.x);
          const y = num(msg.y);
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            Native!.tap(x, y);
          }
          return;
        }
        case 'volume':
          if (msg.dir === 'up' || msg.dir === 'down') {
            await Native!.volume(msg.dir);
          }
          return;
        case 'power':
          await Native!.power(msg.long === true);
          return;
        case 'rotate':
          if (msg.dir === 'left' || msg.dir === 'right') {
            await Native!.rotate(msg.dir);
          }
          return;
        case 'touch': {
          const phase = msg.phase;
          const x = num(msg.x);
          const y = num(msg.y);
          if ((phase === 'down' || phase === 'move' || phase === 'up') && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            Native!.touch(phase, x, y);
          }
          return;
        }
        case 'scroll': {
          const [x, y, dx, dy] = [num(msg.x), num(msg.y), num(msg.dx), num(msg.dy)];
          if ([x, y, dx, dy].every(Number.isFinite)) {
            Native!.scroll(x, y, Math.max(-0.9, Math.min(0.9, dx)), Math.max(-0.9, Math.min(0.9, dy)));
          }
          return;
        }
        case 'nav':
          if (typeof msg.action === 'string' && NAV_ACTIONS.has(msg.action)) {
            await Native!.nav(msg.action);
          }
          return;
        case 'text':
          if (typeof msg.text === 'string' && msg.text.length > 0) {
            await Native!.typeText(msg.text.slice(0, 4000));
          }
          return;
        case 'key':
          if (typeof msg.code === 'string') {
            await Native!.key(msg.code.slice(0, 32));
          }
          return;
        case 'clipboard.set':
          if (typeof msg.text === 'string') {
            Clipboard.setString(msg.text.slice(0, 100_000));
          }
          return;
        case 'clipboard.get': {
          const text = await Clipboard.getString();
          this.sendJson({t: 'clipboard.set', text: text.slice(0, 100_000)});
          return;
        }
        case 'audio.set':
          await this.setAudio(msg.on === true);
          return;
        case 'file.request':
          this.sendJson({t: 'file.picking'});
          await this.transfers.pickAndSend().catch(err => {
            const text = err instanceof Error ? err.message : '';
            this.sendJson(/cancel/i.test(text) ? {t: 'file.none'} : {t: 'error', request: 'file.request', message: text.slice(0, 300)});
          });
          return;
        case 'quality.set': {
          const res = msg.resolution as {mode?: string; width?: number; height?: number} | undefined;
          if (res?.mode === 'auto') {
            this.box = null;
          } else if (res && Number.isFinite(Number(res.width)) && Number.isFinite(Number(res.height))) {
            this.box = {width: Math.max(160, Math.min(4096, Number(res.width))), height: Math.max(160, Math.min(4096, Number(res.height)))};
          }
          await this.applyCaptureSize();
          return;
        }
        case 'stats.ping':
          this.sendJson({t: 'stats.pong', seq: msg.seq ?? null, now: Date.now()});
          return;
      }
    } catch (err) {
      const code = (err as {code?: string})?.code;
      if (code === 'no_accessibility') {
        this.sendJson({t: 'access', input: false, rotate: usePhoneHostStore.getState().rotate});
      } else if (code === 'no_rotate_permission') {
        this.sendJson({t: 'access', input: usePhoneHostStore.getState().accessibility, rotate: false});
      }
      this.sendJson({t: 'error', request: String(msg.t), message: (err instanceof Error ? err.message : String(err)).slice(0, 300)});
    }
  }

  private async setAudio(on: boolean) {
    if (!on) {
      Native!.stopAudio();
      set({audioOn: false});
      this.sendJson({t: 'audio.state', available: true, on: false});
      return;
    }
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: 'Phone sound on your PC',
      message: 'Android calls this "record audio". Remote PC only captures what apps play, never the microphone.',
      buttonPositive: 'Continue',
    });
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      this.sendJson({t: 'audio.state', available: true, on: false, error: 'Sound was not allowed on the phone.'});
      return;
    }
    const rate = await Native!.startAudio();
    set({audioOn: true});
    this.sendJson({t: 'audio.state', available: true, on: true, sampleRate: rate, channels: 1});
  }

  async close(updateRow: boolean, reason = 'ended') {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.lostTimer) {
      clearTimeout(this.lostTimer);
      this.lostTimer = null;
    }
    Native?.keepConnection(false);
    Native?.stopAudio();
    // Put the phone's own rotation setting back.
    Native?.restoreRotation();
    this.subs.forEach(s => s.remove());
    this.transfers.closeAll();
    this.stream?.getTracks().forEach(t => t.stop());
    try {
      this.pc?.close();
    } catch {
      // closed
    }
    if (updateRow) {
      this.send('end', {reason});
      await supabase.from('phone_sessions').update({state: 'ended', end_reason: reason}).eq('id', this.id).then(undefined, () => {});
    }
    this.signal?.unsubscribe();
    if (session === this) {
      session = null;
    }
    set({phase: 'idle', pcName: null, audioOn: false});
  }
}

export interface PhoneSessionRow {
  id: string;
  client_name: string | null;
  state: string;
  end_reason: string | null;
  created_at: string;
  ended_at: string | null;
}

/** Recent sessions on this phone (owner only). */
export async function recentPhoneSessions(): Promise<PhoneSessionRow[]> {
  const {phoneId} = usePhoneHostStore.getState();
  const uid = userId;
  const id = phoneId ?? (uid ? await AsyncStorage.getItem(KEY_PHONE(uid)) : null);
  if (!id) {
    return [];
  }
  const {data} = await supabase
    .from('phone_sessions')
    .select('id,client_name,state,end_reason,created_at,ended_at')
    .eq('phone_id', id)
    .order('created_at', {ascending: false})
    .limit(20);
  return (data ?? []) as PhoneSessionRow[];
}
