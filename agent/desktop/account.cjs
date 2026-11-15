// Remote PC Host — optional account sign-in.
//
// Signing in on the PC (the same Supabase account as the phone app) lets the
// host:
//   * set up remote access without typing a code (it asks Supabase for a
//     pairing code itself), and
//   * show the connection history saved in the account: which account and
//     which phone connected to this PC, when and for how long.
// The PC's own device login (config.json) is separate and unchanged; signing
// out never unpairs the PC.
//
// The account session lives in the main process only (never the renderer)
// and is stored in %APPDATA%\Remote PC Host\account.json, encrypted with
// Windows DPAPI through Electron's safeStorage when available.

const fs = require('node:fs');
const path = require('node:path');
const {createClient} = require('@supabase/supabase-js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class SecureFileStorage {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    this.items = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const text = raw.startsWith('enc:') && this.safe
        ? this.safe.decryptString(Buffer.from(raw.slice(4), 'base64'))
        : raw;
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const text = JSON.stringify(this.items);
    const body = this.safe ? `enc:${this.safe.encryptString(text).toString('base64')}` : text;
    fs.writeFileSync(this.file, body, {encoding: 'utf8', mode: 0o600});
  }

  getItem(key) { return Object.prototype.hasOwnProperty.call(this.items, key) ? this.items[key] : null; }
  setItem(key, value) { this.items[key] = value; this.save(); }
  removeItem(key) { delete this.items[key]; this.save(); }
}

function friendlyAuthError(error) {
  const message = String(error?.message ?? error ?? '');
  if (/invalid login credentials/i.test(message)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(message)) return 'Confirm your email first — open the link we sent you, then sign in.';
  if (/already registered|already exists/i.test(message)) return 'An account with this email already exists. Sign in instead.';
  if (/password should be|weak password/i.test(message)) return 'Choose a stronger password (at least 8 characters).';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Wait a minute and try again.';
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(message)) return 'Could not reach the server. Check the internet connection.';
  return message.slice(0, 200) || 'Something went wrong.';
}

function createAccount({file, url, key, safeStorage}) {
  const storage = new SecureFileStorage(file, safeStorage);
  const supabase = createClient(url, key, {
    auth: {storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false},
  });

  async function currentUser() {
    const {data} = await supabase.auth.getSession();
    return data?.session?.user ?? null;
  }

  return {
    async state() {
      const user = await currentUser();
      return user ? {signedIn: true, email: user.email ?? ''} : {signedIn: false};
    },

    async signIn(email, password) {
      email = String(email ?? '').trim();
      if (!EMAIL_RE.test(email)) return {ok: false, error: 'Enter a valid email address.'};
      if (!password) return {ok: false, error: 'Enter your password.'};
      const {data, error} = await supabase.auth.signInWithPassword({email, password: String(password)});
      if (error) return {ok: false, error: friendlyAuthError(error)};
      return {ok: true, email: data.user?.email ?? email};
    },

    async signUp(email, password) {
      email = String(email ?? '').trim();
      password = String(password ?? '');
      if (!EMAIL_RE.test(email)) return {ok: false, error: 'Enter a valid email address.'};
      if (password.length < 8) return {ok: false, error: 'Use at least 8 characters for the password.'};
      const {data, error} = await supabase.auth.signUp({email, password});
      if (error) return {ok: false, error: friendlyAuthError(error)};
      // With email confirmation on, there is no session until the link is opened.
      if (!data.session) return {ok: true, confirm: true, email};
      return {ok: true, email: data.user?.email ?? email};
    },

    async signOut() {
      await supabase.auth.signOut({scope: 'local'}).catch(() => {});
      return {ok: true};
    },

    /** A fresh 6-digit pairing code for the signed-in account. */
    async pairingCode() {
      if (!(await currentUser())) throw new Error('Sign in first.');
      const {data, error} = await supabase.rpc('create_pairing_code');
      if (error) throw new Error(friendlyAuthError(error));
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.code) throw new Error('The server did not return a code.');
      return String(row.code);
    },

    /**
     * Sessions on this PC, newest first. `owned: false` when this PC is not
     * paired, or belongs to another account.
     */
    async history(deviceId) {
      if (!(await currentUser())) return {ok: false, error: 'Sign in first.'};
      if (!deviceId) return {ok: true, owned: false, reason: 'not_paired', sessions: []};
      const {data: device, error: deviceError} = await supabase
        .from('devices').select('id,name').eq('id', deviceId).maybeSingle();
      if (deviceError) return {ok: false, error: friendlyAuthError(deviceError)};
      if (!device) return {ok: true, owned: false, reason: 'other_account', sessions: []};
      const {data, error} = await supabase.rpc('device_connection_history', {p_device: deviceId, p_limit: 50});
      if (error) return {ok: false, error: friendlyAuthError(error)};
      const sessions = (data ?? []).map(row => ({
        id: row.id,
        kind: 'access',
        who: row.requester_email ?? null,
        client: row.client_name ?? null,
        state: row.state,
        endReason: row.end_reason ?? null,
        startedAt: row.created_at,
        endedAt: row.ended_at ?? null,
      }));
      return {ok: true, owned: true, sessions};
    },
  };
}

// ---- Remote Support history (kept on this PC) ---------------------------------
// Support sessions use a temporary host identity that is not tied to any
// account, so they are recorded locally.

function createSupportLog(file) {
  const MAX = 100;
  const read = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const write = list => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX)), 'utf8');
  };
  return {
    list: read,
    started({sessionId, helperEmail, clientName, mode}) {
      const list = read().filter(item => item.id !== sessionId);
      list.unshift({
        id: String(sessionId ?? Date.now()),
        kind: 'support',
        who: helperEmail ? String(helperEmail).slice(0, 320) : null,
        client: clientName ? String(clientName).slice(0, 80) : null,
        mode: mode === 'view' ? 'view' : 'control',
        state: 'accepted',
        startedAt: new Date().toISOString(),
        endedAt: null,
      });
      write(list);
    },
    ended(sessionId) {
      const list = read();
      const item = list.find(entry => entry.endedAt == null && (!sessionId || entry.id === sessionId));
      if (!item) return;
      item.endedAt = new Date().toISOString();
      item.state = 'ended';
      write(list);
    },
  };
}

module.exports = {createAccount, createSupportLog};
