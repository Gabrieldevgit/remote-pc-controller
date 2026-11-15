import {create} from 'zustand';

import type {VideoQuality} from './settings';
import type {InputMessage} from '../lib/inputProtocol';

export type SessionPhase =
  | 'idle'
  | 'starting'
  | 'waiting' // session.start acked, waiting for the device to accept
  | 'signaling' // accepted, exchanging SDP/ICE
  | 'connected'
  | 'ended'
  | 'failed';

export type PointerMode = 'trackpad' | 'direct';

export interface SessionStats {
  rttMs: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  packetsLost: number | null;
}

interface SessionState {
  sessionId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  phase: SessionPhase;
  error: string | null;
  endReason: string | null;
  quality: VideoQuality;
  pointerMode: PointerMode;
  keyboardOpen: boolean;
  statsVisible: boolean;
  stats: SessionStats;
  /** Latest clipboard text pulled from the remote machine. */
  remoteClipboard: string | null;

  begin: (deviceId: string, deviceName: string) => void;
  setSessionId: (sessionId: string) => void;
  setPhase: (phase: SessionPhase, error?: string) => void;
  setEndReason: (reason: string) => void;
  setQuality: (quality: VideoQuality) => void;
  setPointerMode: (mode: PointerMode) => void;
  setKeyboardOpen: (open: boolean) => void;
  setStatsVisible: (visible: boolean) => void;
  setStats: (stats: SessionStats) => void;
  setRemoteClipboard: (text: string | null) => void;
  reset: () => void;
}

const EMPTY_STATS: SessionStats = {
  rttMs: null,
  fps: null,
  bitrateKbps: null,
  width: null,
  height: null,
  packetsLost: null,
};

export const useSessionStore = create<SessionState>(set => ({
  sessionId: null,
  deviceId: null,
  deviceName: null,
  phase: 'idle',
  error: null,
  endReason: null,
  quality: 'adaptive',
  pointerMode: 'trackpad',
  keyboardOpen: false,
  statsVisible: false,
  stats: EMPTY_STATS,
  remoteClipboard: null,

  begin: (deviceId, deviceName) =>
    set({
      sessionId: null,
      deviceId,
      deviceName,
      phase: 'starting',
      error: null,
      endReason: null,
      stats: EMPTY_STATS,
      remoteClipboard: null,
      keyboardOpen: false,
    }),

  setSessionId: sessionId => set({sessionId}),

  setPhase: (phase, error) =>
    set(state => ({phase, error: error ?? (phase === 'failed' ? state.error : null)})),

  setEndReason: reason => set({endReason: reason}),

  setQuality: quality => set({quality}),

  setPointerMode: mode => set({pointerMode: mode}),

  setKeyboardOpen: open => set({keyboardOpen: open}),

  setStatsVisible: visible => set({statsVisible: visible}),

  setStats: stats => set({stats}),

  setRemoteClipboard: text => set({remoteClipboard: text}),

  reset: () =>
    set({
      sessionId: null,
      deviceId: null,
      deviceName: null,
      phase: 'idle',
      error: null,
      endReason: null,
      stats: EMPTY_STATS,
      remoteClipboard: null,
      keyboardOpen: false,
    }),
}));

/** Helper kept here so screens never import inputProtocol types directly. */
export type SessionInputSender = (message: InputMessage) => void;
