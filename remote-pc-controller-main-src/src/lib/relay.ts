/**
 * Relay client — implements the mobile side of relay/PROTOCOL.md.
 *
 * Transport: one text-frame JSON WebSocket at <relayUrl>/ws with envelope
 * `{ type, payload, id }`. Requests are correlated via `payload.replyTo` on
 * the `ok`/`error` reply. Server-initiated messages (device.status,
 * session.*, signal.*) are surfaced through a typed event emitter.
 */

import {normalizeRelayUrl, relayHttpBase} from './relayUrl';

export {normalizeRelayUrl, relayHttpBase};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen: number;
  version?: string;
  createdAt?: number;
}

export interface DeviceStatusEvent {
  deviceId: string;
  online: boolean;
  lastSeen?: number;
  reason?: string;
}

export interface SignalIcePayload {
  sessionId: string;
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export type RelayConnectionState =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'error';

export type RelayEvent =
  | 'open'
  | 'closed'
  | 'authError'
  | 'device.status'
  | 'device.updated'
  | 'device.deleted'
  | 'session.accepted'
  | 'session.ended'
  | 'signal.offer'
  | 'signal.answer'
  | 'signal.ice';

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
  }
}

export class RelayRestError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'RelayRestError';
  }
}

interface Envelope {
  type: string;
  payload: Record<string, unknown>;
  id?: number | string;
}

type Listener = (payload: Record<string, unknown>) => void;

const REQUEST_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 25000;
const PONG_STALE_MS = 60000;
const MAX_BACKOFF_MS = 15000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RelayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    {resolve: (p: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}
  >();
  private listeners = new Map<RelayEvent, Set<Listener>>();
  private url = '';
  private token: string | null = null;
  private manualClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private connectPromise: Promise<void> | null = null;
  /** Bumped by close(); lets late events from old sockets be ignored. */
  private generation = 0;

  state: RelayConnectionState = 'idle';

  on(event: RelayEvent, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(event: RelayEvent, payload: Record<string, unknown> = {}) {
    this.listeners.get(event)?.forEach(listener => {
      try {
        listener(payload);
      } catch {
        // Listener errors must never break the socket loop.
      }
    });
  }

  getUrl(): string {
    return this.url;
  }

  setUrl(url: string) {
    const next = normalizeRelayUrl(url);
    if (next === this.url) {
      return;
    }
    this.url = next;
    // Re-dial against the new endpoint when credentials are present.
    if (this.token) {
      this.close();
      void this.connect();
    }
  }

  setToken(token: string | null) {
    if (token === this.token) {
      return;
    }
    this.token = token;
    if (!token) {
      this.close();
      return;
    }
    if (this.ws && (this.state === 'online' || this.state === 'connecting')) {
      // Re-authenticate in place is not supported by the protocol (a socket
      // leaves `pending` exactly once), so re-dial.
      this.close();
    }
    void this.connect();
  }

  isConnected(): boolean {
    return this.state === 'online';
  }

  /** Open the socket and authenticate as a user. Resolves once online. */
  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (!this.url) {
      return Promise.reject(new RelayError('bad_request', 'Relay URL is not configured'));
    }
    this.manualClose = false;
    this.state = 'connecting';
    const generation = this.generation;
    const attempt: Promise<void> = this.dial(generation)
      .then(() => {
        this.reconnectAttempts = 0;
      })
      .catch(error => {
        // A newer connection superseded this one (close() / re-dial): its
        // failure must not touch the state of the live connection.
        if (generation === this.generation) {
          this.state = 'error';
          if (error instanceof RelayError && error.code === 'invalid_token') {
            // A dead JWT will never authenticate; stop retrying and surface it.
            this.emit('authError', {code: error.code, message: error.message});
          } else {
            this.scheduleReconnect();
          }
        }
        throw error;
      })
      .finally(() => {
        if (this.connectPromise === attempt) {
          this.connectPromise = null;
        }
      });
    this.connectPromise = attempt;
    return attempt;
  }

  private dial(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const wsUrl = `${this.url}/ws`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.ws = ws;
      /** True while this socket is still the client's live connection. */
      const isCurrent = () => generation === this.generation && this.ws === ws;
      let authId: number | null = null;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(authTimer);
        try {
          ws.close();
        } catch {
          // Already closed.
        }
        reject(error);
      };

      // The relay must complete auth promptly; treat silence as failure.
      const authTimer = setTimeout(() => {
        fail(new RelayError('timeout', 'Relay did not answer auth.user in time'));
      }, REQUEST_TIMEOUT_MS);

      ws.onopen = () => {
        if (!isCurrent()) {
          fail(new RelayError('network', 'Superseded connection'));
          return;
        }
        if (!this.token) {
          fail(new RelayError('not_authenticated', 'No relay token available'));
          return;
        }
        authId = this.nextId++;
        try {
          this.sendRaw({type: 'auth.user', payload: {token: this.token}, id: authId});
        } catch (error) {
          fail(error instanceof Error ? error : new RelayError('network', String(error)));
        }
      };

      ws.onmessage = event => {
        if (!isCurrent()) {
          return;
        }
        let envelope: Envelope;
        try {
          envelope = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!envelope || typeof envelope.type !== 'string') {
          return;
        }
        if (envelope.type === 'ok' || envelope.type === 'error') {
          const replyTo = envelope.payload?.replyTo;
          // The auth.user reply settles the dial itself.
          if (!settled && authId !== null && replyTo === authId) {
            if (envelope.type === 'error') {
              fail(
                new RelayError(
                  String(envelope.payload?.code ?? 'internal_error'),
                  String(envelope.payload?.message ?? 'Relay error'),
                ),
              );
              return;
            }
            settled = true;
            clearTimeout(authTimer);
            this.lastPongAt = Date.now();
            this.state = 'online';
            this.startKeepalive();
            resolve();
            this.emit('open');
            return;
          }
          const pendingEntry =
            replyTo != null ? this.pending.get(replyTo as number | string) : undefined;
          if (!pendingEntry) {
            return;
          }
          this.pending.delete(replyTo as number | string);
          clearTimeout(pendingEntry.timer);
          if (envelope.type === 'error') {
            pendingEntry.reject(
              new RelayError(
                String(envelope.payload?.code ?? 'internal_error'),
                String(envelope.payload?.message ?? 'Relay error'),
              ),
            );
          } else {
            pendingEntry.resolve(envelope.payload);
          }
          return;
        }
        if (envelope.type === 'pong') {
          this.lastPongAt = Date.now();
          return;
        }
        // Server-initiated events (device.status, session.*, signal.*).
        if (this.listeners.has(envelope.type as RelayEvent) && envelope.payload) {
          this.emit(envelope.type as RelayEvent, envelope.payload);
        }
      };

      ws.onerror = () => {
        fail(new RelayError('network', 'Could not reach the relay server'));
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(authTimer);
          reject(new RelayError('network', 'Relay connection closed'));
        }
        // A stale socket closing late (after close() + re-dial) must not tear
        // down the timers or socket reference of the connection replacing it.
        if (!isCurrent()) {
          return;
        }
        // Only the keepalive belongs to this socket; a reconnect timer may
        // already have been scheduled by connect() for a failed dial.
        this.stopKeepalive();
        this.ws = null;
        this.failPending();
        const wasOnline = this.state === 'online';
        this.state = this.manualClose ? 'idle' : 'reconnecting';
        // A failed dial reschedules from connect()'s catch; only a drop of an
        // established connection needs to schedule here.
        if (!this.manualClose && wasOnline) {
          this.scheduleReconnect();
        }
        this.emit('closed', {manual: this.manualClose});
      };
    });
  }

  private scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose && this.token) {
        this.connect().catch(() => {
          // State and backoff already updated; keep retrying on next timer.
        });
      }
    }, delay);
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > PONG_STALE_MS) {
        // The socket is wedged; drop it and dial a fresh one. close() marks
        // the disconnect as manual, so explicitly resume connecting —
        // otherwise a single stall would take the app offline forever.
        this.close();
        if (this.token) {
          void this.connect().catch(() => {
            // connect() already scheduled the next retry.
          });
        }
        return;
      }
      // `pong` is an event, not an ok reply (PROTOCOL.md 1.5) — send without
      // a correlation id and rely on lastPongAt for liveness.
      this.sendRaw({type: 'ping', payload: {}});
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private teardownTimers() {
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Close the socket and stop reconnecting until the next connect(). */
  close() {
    this.manualClose = true;
    this.generation += 1;
    this.connectPromise = null;
    this.teardownTimers();
    const ws = this.ws;
    this.ws = null;
    this.state = 'idle';
    this.failPending();
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  private failPending() {
    this.pending.forEach(entry => {
      clearTimeout(entry.timer);
      entry.reject(new RelayError('network', 'Relay connection closed'));
    });
    this.pending.clear();
  }

  private sendRaw(envelope: Envelope) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new RelayError('not_connected', 'Relay socket is not open');
    }
    ws.send(JSON.stringify(envelope));
  }

  /**
   * Fire-and-forget message for types that get no reply (e.g. `session.end`,
   * PROTOCOL.md 4.4). Silently ignores a closed socket.
   */
  notify(type: string, payload: Record<string, unknown> = {}) {
    try {
      this.sendRaw({type, payload});
    } catch {
      // Not connected; nothing to deliver to.
    }
  }

  /**
   * JSON-RPC-style request: sends `{type, payload, id}` and resolves with the
   * `ok` reply payload (which includes `replyTo`), or rejects with RelayError.
   */
  request(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RelayError('not_connected', 'Relay is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError('timeout', `Relay request '${type}' timed out`));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try {
        this.sendRaw({type, payload, id});
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

/** Shared singleton used across screens and stores. */
export const relay = new RelayClient();

// ---------------------------------------------------------------------------
// REST auth endpoints (PROTOCOL.md 1.1 / 1.2)
// ---------------------------------------------------------------------------

interface LoginResponse {
  token: string;
  tokenType: string;
  expiresIn: number;
  userId: string;
}

async function restRequest(
  baseUrl: string,
  path: string,
  body: {email: string; password: string},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${relayHttpBase(baseUrl)}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelayRestError(0, 'network', 'Could not reach the relay server');
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body.
  }
  if (!response.ok) {
    // The relay reports `{error: '<code>', message?}`; accept `code` too.
    const code =
      typeof json.error === 'string'
        ? json.error
        : typeof json.code === 'string'
          ? json.code
          : null;
    const message =
      typeof json.message === 'string' ? json.message : `HTTP ${response.status}`;
    throw new RelayRestError(response.status, code, message);
  }
  return json;
}

export async function registerRelayAccount(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{userId: string; email: string}> {
  const json = await restRequest(baseUrl, '/api/register', {email, password});
  return {
    userId: String(json.userId ?? ''),
    email: String(json.email ?? email),
  };
}

export async function loginRelayAccount(
  baseUrl: string,
  email: string,
  password: string,
): Promise<LoginResponse> {
  const json = await restRequest(baseUrl, '/api/login', {email, password});
  return {
    token: String(json.token ?? ''),
    tokenType: String(json.tokenType ?? 'Bearer'),
    expiresIn: Number(json.expiresIn ?? 0),
    userId: String(json.userId ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Connection test (Settings screen)
// ---------------------------------------------------------------------------

export interface RelayTestResult {
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

/**
 * Probe a relay deployment. Any HTTP response (even 401 without a token)
 * proves the server is reachable; with a token a 200 also validates auth.
 */
export async function testRelayConnection(
  url: string,
  token: string | null,
): Promise<RelayTestResult> {
  const started = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${relayHttpBase(url)}/api/turn`, {headers});
    const latencyMs = Date.now() - started;
    if (response.ok) {
      return {ok: true, latencyMs, detail: `Reachable (${latencyMs} ms)`};
    }
    if (response.status === 401) {
      return {
        ok: true,
        latencyMs,
        detail: `Reachable (${latencyMs} ms); sign in to validate your account`,
      };
    }
    return {
      ok: false,
      latencyMs,
      detail: `Server responded with HTTP ${response.status}`,
    };
  } catch {
    return {ok: false, latencyMs: null, detail: 'Could not reach the server'};
  }
}
