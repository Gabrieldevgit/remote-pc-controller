import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {Appearance} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DARK,
  LIGHT,
  type Palette,
  type ThemeMode,
  type ThemePreference,
} from './tokens';

const STORAGE_KEY = 'app.themePreference';

interface ThemeContextValue {
  /** Active palette resolved from preference + OS setting. */
  palette: Palette;
  /** Resolved concrete mode ('light' | 'dark'). */
  mode: ThemeMode;
  /** User preference ('system' follows the OS). */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveMode(preference: ThemePreference, system: ThemeMode): ThemeMode {
  return preference === 'system' ? system : preference;
}

export function ThemeProvider({children}: {children: React.ReactNode}) {
  const [system, setSystem] = useState<ThemeMode>(
    () => (Appearance.getColorScheme() ?? 'light') as ThemeMode,
  );
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Follow the OS color scheme while preference is 'system'.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({colorScheme}) => {
      setSystem((colorScheme ?? 'light') as ThemeMode);
    });
    return () => subscription.remove();
  }, []);

  // Restore the persisted manual override once on mount.
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then(stored => {
        if (
          mounted &&
          (stored === 'light' || stored === 'dark' || stored === 'system')
        ) {
          setPreferenceState(stored);
        }
      })
      .catch(() => {
        // Corrupted or unavailable storage falls back to 'system'.
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Persistence is best-effort; the in-memory value is already applied.
    });
  }, []);

  const mode = resolveMode(preference, system);
  const palette = mode === 'dark' ? DARK : LIGHT;

  const value = useMemo<ThemeContextValue>(
    () => ({palette, mode, preference, setPreference}),
    [palette, mode, preference, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Force a palette for a subtree regardless of the user preference — the
 * remote-session viewer is always dark so the remote desktop stays the
 * brightest thing on screen.
 */
export function ThemeOverride({
  mode,
  children,
}: {
  mode: ThemeMode;
  children: React.ReactNode;
}) {
  const parent = useTheme();
  const value = useMemo<ThemeContextValue>(
    () => ({...parent, mode, palette: mode === 'dark' ? DARK : LIGHT}),
    [parent, mode],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function useThemeMode(): {
  mode: ThemeMode;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} {
  const {mode, preference, setPreference} = useTheme();
  return {mode, preference, setPreference};
}
