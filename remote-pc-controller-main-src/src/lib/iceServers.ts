/**
 * ICE servers for every peer connection: STUN plus short-lived TURN
 * credentials from the `turn-credentials` Edge Function (Cloudflare TURN).
 * TURN relays the traffic when the two devices cannot reach each other
 * directly — different networks, mobile data / CGNAT, strict routers.
 * Falls back to STUN only (same-network connections) if the call fails.
 */
import {supabase} from './supabase';

export type IceServer = {urls: string | string[]; username?: string; credential?: string};

export const STUN_SERVERS: IceServer[] = [
  {urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']},
];

let cache: {servers: IceServer[]; until: number} | null = null;

export async function getIceServers(): Promise<IceServer[]> {
  if (cache && cache.until > Date.now()) {
    return cache.servers;
  }
  try {
    const {data, error} = await Promise.race([
      supabase.functions.invoke('turn-credentials', {body: {}}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    if (error || !Array.isArray(data?.iceServers) || !data.iceServers.length) {
      throw new Error(error?.message ?? 'bad reply');
    }
    const ttl = Number(data.ttl) > 0 ? Number(data.ttl) : 3600;
    cache = {servers: data.iceServers as IceServer[], until: Date.now() + (ttl * 1000) / 2};
    return cache.servers;
  } catch {
    return STUN_SERVERS;
  }
}

type RestartablePc = {
  connectionState: string;
  signalingState?: string;
  createOffer: (opts?: Record<string, unknown>) => Promise<{sdp?: string; type?: string}>;
  setLocalDescription: (desc: any) => Promise<void>;
  localDescription?: {sdp?: string} | null;
};

/**
 * Keeps a connection alive across network drops (Wi-Fi ↔ mobile data, a
 * short outage, the phone's Wi-Fi power saving): when the link goes
 * `disconnected` / `failed`, the offering side sends a fresh offer with
 * `iceRestart` so both ends find a new path. Gives up after `giveUpMs`
 * without recovering.
 */
export class IceRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private giveUp: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private lastOffer = 0;

  constructor(
    private pc: RestartablePc,
    private opts: {
      sendOffer: (sdp: string) => void;
      onLost: () => void;
      onState?: (state: 'reconnecting' | 'connected') => void;
      giveUpMs?: number;
    },
  ) {}

  /** Call from onconnectionstatechange. */
  update() {
    if (this.stopped) {
      return;
    }
    const state = this.pc.connectionState;
    if (state === 'connected') {
      this.attempts = 0;
      this.clear();
      this.opts.onState?.('connected');
    } else if (state === 'disconnected') {
      // Often recovers by itself within a second or two; restart if not.
      this.startGiveUp();
      this.opts.onState?.('reconnecting');
      this.schedule(2500);
    } else if (state === 'failed') {
      this.startGiveUp();
      this.opts.onState?.('reconnecting');
      this.schedule(0);
    }
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  private clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.giveUp) {
      clearTimeout(this.giveUp);
      this.giveUp = null;
    }
  }

  private startGiveUp() {
    if (!this.giveUp) {
      this.giveUp = setTimeout(() => {
        if (!this.stopped && this.pc.connectionState !== 'connected') {
          this.stop();
          this.opts.onLost();
        }
      }, this.opts.giveUpMs ?? 45_000);
    }
  }

  private schedule(ms: number) {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.restart();
    }, ms);
  }

  private async restart() {
    const state = this.pc.connectionState;
    if (this.stopped || state === 'connected' || state === 'closed') {
      return;
    }
    this.attempts += 1;
    // Still waiting for the answer to the previous restart: give it time.
    if (this.pc.signalingState === 'have-local-offer' && Date.now() - this.lastOffer < 5000) {
      this.schedule(2000);
      return;
    }
    try {
      this.lastOffer = Date.now();
      const offer = await this.pc.createOffer({iceRestart: true});
      await this.pc.setLocalDescription(offer);
      this.opts.sendOffer(this.pc.localDescription?.sdp ?? offer.sdp ?? '');
    } catch {
      // try again below
    }
    // No luck yet: try again (2 s, 4 s, 8 s … capped at 10 s) until giveUpMs.
    this.schedule(Math.min(10_000, 1000 * 2 ** this.attempts));
  }
}
