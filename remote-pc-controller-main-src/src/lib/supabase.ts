/**
 * Supabase client shared by the whole app (Auth, Database, Realtime,
 * Storage). The publishable key is public by design: every table is
 * protected by row level security (see ../../../supabase/migrations).
 */
import 'react-native-url-polyfill/auto';
import {AppState} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {createClient} from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://hmhjlpxzuoyvxzqyfkqc.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xLslj52HKvSS2Xi9XyKstQ__37FllPS';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  realtime: {params: {eventsPerSecond: 50}},
});

// Refresh tokens only while the app is in the foreground (Supabase's
// recommendation for React Native).
AppState.addEventListener('change', state => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

/** Short project label for the UI ("hmhjlpxz…"). */
export const SUPABASE_PROJECT_LABEL = SUPABASE_URL.replace(/^https:\/\//, '').replace(
  /\.supabase\.co$/,
  '',
);
