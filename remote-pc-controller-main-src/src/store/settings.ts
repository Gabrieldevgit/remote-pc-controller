import {create} from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type VideoQuality = 'high' | 'medium' | 'low' | 'adaptive';

const STORAGE_KEY = 'app.settings';

interface PersistedSettings {
  defaultQuality: VideoQuality;
  haptics: boolean;
}

interface SettingsState extends PersistedSettings {
  /** True once persisted values have been read back. */
  loaded: boolean;
  hydrate: () => Promise<void>;
  setDefaultQuality: (quality: VideoQuality) => Promise<void>;
  setHaptics: (enabled: boolean) => Promise<void>;
}

const QUALITIES: VideoQuality[] = ['high', 'medium', 'low', 'adaptive'];

function persist(state: PersistedSettings) {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
    // Persistence is best-effort; the in-memory value is already applied.
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  defaultQuality: 'adaptive',
  haptics: true,

  hydrate: async () => {
    if (get().loaded) {
      return;
    }
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
        set({
          defaultQuality: QUALITIES.includes(parsed.defaultQuality as VideoQuality)
            ? (parsed.defaultQuality as VideoQuality)
            : 'adaptive',
          haptics: parsed.haptics ?? true,
          loaded: true,
        });
        return;
      }
    } catch {
      // Corrupted storage falls back to defaults.
    }
    set({loaded: true});
  },

  setDefaultQuality: async quality => {
    set({defaultQuality: quality});
    persist({defaultQuality: quality, haptics: get().haptics});
  },

  setHaptics: async enabled => {
    set({haptics: enabled});
    persist({defaultQuality: get().defaultQuality, haptics: enabled});
  },
}));
