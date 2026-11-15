import {create} from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {AUTO_RESOLUTION, sanitizeResolution, type StreamResolution} from '../lib/resolution';

export type VideoQuality = 'high' | 'medium' | 'low' | 'adaptive';
export type PointerColor = 'classic' | 'black' | 'copper';
/** mouse = big draggable cursor (default), touch = tap where you touch, trackpad = laptop pad. */
export type PointerModeSetting = 'mouse' | 'touch' | 'trackpad';

export const POINTER_SIZE_MIN = 32;
export const POINTER_SIZE_MAX = 160;

const STORAGE_KEY = 'app.settings';

interface PersistedSettings {
  defaultQuality: VideoQuality;
  haptics: boolean;
  /** On-screen pointer height in dp. */
  pointerSize: number;
  pointerColor: PointerColor;
  /** Multiplier for relative finger movement. */
  pointerSpeed: number;
  pointerMode: PointerModeSetting;
  /** Play the computer's sound during sessions. */
  computerSound: boolean;
  /** Size of the PC picture streamed to this phone (default Auto). */
  resolution: StreamResolution;
}

interface SettingsState extends PersistedSettings {
  /** True once persisted values have been read back. */
  loaded: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<PersistedSettings>) => void;
  setDefaultQuality: (quality: VideoQuality) => Promise<void>;
  setHaptics: (enabled: boolean) => Promise<void>;
}

const QUALITIES: VideoQuality[] = ['high', 'medium', 'low', 'adaptive'];
const COLORS: PointerColor[] = ['classic', 'black', 'copper'];
const MODES: PointerModeSetting[] = ['mouse', 'touch', 'trackpad'];

const DEFAULTS: PersistedSettings = {
  defaultQuality: 'adaptive',
  haptics: true,
  pointerSize: 72,
  pointerColor: 'classic',
  pointerSpeed: 1.5,
  pointerMode: 'mouse',
  computerSound: true,
  resolution: AUTO_RESOLUTION,
};

function clampSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULTS.pointerSize;
  }
  return Math.round(Math.min(POINTER_SIZE_MAX, Math.max(POINTER_SIZE_MIN, n)));
}

function clampSpeed(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(3, Math.max(0.5, n)) : DEFAULTS.pointerSpeed;
}

function sanitize(raw: Partial<PersistedSettings>): PersistedSettings {
  return {
    defaultQuality: QUALITIES.includes(raw.defaultQuality as VideoQuality)
      ? (raw.defaultQuality as VideoQuality)
      : DEFAULTS.defaultQuality,
    haptics: typeof raw.haptics === 'boolean' ? raw.haptics : DEFAULTS.haptics,
    pointerSize: clampSize(raw.pointerSize ?? DEFAULTS.pointerSize),
    pointerColor: COLORS.includes(raw.pointerColor as PointerColor)
      ? (raw.pointerColor as PointerColor)
      : DEFAULTS.pointerColor,
    pointerSpeed: clampSpeed(raw.pointerSpeed ?? DEFAULTS.pointerSpeed),
    pointerMode: MODES.includes(raw.pointerMode as PointerModeSetting)
      ? (raw.pointerMode as PointerModeSetting)
      : DEFAULTS.pointerMode,
    computerSound:
      typeof raw.computerSound === 'boolean' ? raw.computerSound : DEFAULTS.computerSound,
    resolution: sanitizeResolution(raw.resolution),
  };
}

function snapshot(state: SettingsState): PersistedSettings {
  return {
    defaultQuality: state.defaultQuality,
    haptics: state.haptics,
    pointerSize: state.pointerSize,
    pointerColor: state.pointerColor,
    pointerSpeed: state.pointerSpeed,
    pointerMode: state.pointerMode,
    computerSound: state.computerSound,
    resolution: state.resolution,
  };
}

function persist(state: PersistedSettings) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
    // Persistence is best-effort; the in-memory value is already applied.
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  ...DEFAULTS,

  hydrate: async () => {
    if (get().loaded) {
      return;
    }
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        set({...sanitize(JSON.parse(raw) as Partial<PersistedSettings>), loaded: true});
        return;
      }
    } catch {
      // Corrupted storage falls back to defaults.
    }
    set({loaded: true});
  },

  update: patch => {
    const next = sanitize({...snapshot(get()), ...patch});
    set(next);
    persist(next);
  },

  setDefaultQuality: async quality => get().update({defaultQuality: quality}),
  setHaptics: async enabled => get().update({haptics: enabled}),
}));
