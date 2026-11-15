import {create} from 'zustand';
import {AuthError, type Session} from '@supabase/supabase-js';

import {supabase} from '../lib/supabase';
import {BackendError} from '../lib/backend';

interface AuthState {
  /** Access token of the current session (null when signed out). */
  token: string | null;
  userId: string | null;
  email: string | null;
  hydrated: boolean;
  busy: boolean;
  hydrate: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  /** Resolves `true` when the account still needs email confirmation. */
  register: (email: string, password: string) => Promise<boolean>;
  resendConfirmation: (email: string) => Promise<void>;
  signOut: () => void;
}

function describeError(error: unknown): string {
  if (error instanceof AuthError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Wrong email or password.';
      case 'email_not_confirmed':
        return 'Confirm your email first — check your inbox for the link.';
      case 'user_already_exists':
      case 'email_exists':
        return 'An account with this email already exists. Sign in instead.';
      case 'weak_password':
        return 'Choose a stronger password (at least 8 characters).';
      case 'email_address_invalid':
        return 'That email address does not look valid.';
      case 'over_request_rate_limit':
      case 'over_email_send_rate_limit':
        return 'Too many attempts. Wait a minute and try again.';
      default:
        if (/network request failed|failed to fetch/i.test(error.message)) {
          return 'Can’t reach the server. Check your internet connection.';
        }
        return error.message;
    }
  }
  if (error instanceof BackendError) {
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export {describeError as describeAuthError};

function fromSession(session: Session | null) {
  return {
    token: session?.access_token ?? null,
    userId: session?.user.id ?? null,
    email: session?.user.email ?? null,
  };
}

let listening = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  userId: null,
  email: null,
  hydrated: false,
  busy: false,

  hydrate: async () => {
    if (!listening) {
      listening = true;
      // Keep the store in sync with sign-in, refresh and sign-out events.
      supabase.auth.onAuthStateChange((_event, session) => {
        const next = fromSession(session);
        const current = get();
        if (current.token !== next.token || current.userId !== next.userId) {
          set({...next, hydrated: true});
        }
      });
    }
    if (get().hydrated) {
      return;
    }
    try {
      const {data} = await supabase.auth.getSession();
      set({...fromSession(data.session), hydrated: true});
    } catch {
      set({hydrated: true});
    }
  },

  login: async (email, password) => {
    set({busy: true});
    try {
      const {data, error} = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        throw error;
      }
      set({...fromSession(data.session), busy: false});
    } catch (error) {
      set({busy: false});
      throw error;
    }
  },

  register: async (email, password) => {
    set({busy: true});
    try {
      const {data, error} = await supabase.auth.signUp({email: email.trim(), password});
      if (error) {
        throw error;
      }
      if (data.session) {
        set({...fromSession(data.session), busy: false});
        return false;
      }
      // Supabase sends a confirmation email when that setting is on.
      set({busy: false});
      return true;
    } catch (error) {
      set({busy: false});
      throw error;
    }
  },

  resendConfirmation: async email => {
    const {error} = await supabase.auth.resend({type: 'signup', email: email.trim()});
    if (error) {
      throw error;
    }
  },

  signOut: () => {
    set({token: null, userId: null, email: null});
    supabase.auth.signOut().catch(() => {
      // Local session is already cleared.
    });
  },
}));
