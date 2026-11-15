/** Relay URL helpers shared by the WS client and the REST auth calls. */

export const DEFAULT_RELAY_URL = 'ws://10.0.2.2:8080';

/**
 * Normalize user input into a bare ws(s)://host[:port] origin (no path).
 * Accepts ws://, wss://, http:// and https:// inputs; bare host:port is
 * treated as ws://.
 */
export function normalizeRelayUrl(raw: string): string {
  // Users often paste the full endpoint ("…:8080/ws") — the client appends
  // /ws itself, so strip it (and any trailing slashes) to avoid "/ws/ws".
  const trimmed = raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/ws$/i, '')
    .replace(/\/+$/, '');
  if (!trimmed) {
    return DEFAULT_RELAY_URL;
  }
  if (/^wss:\/\//i.test(trimmed)) {
    return `wss://${trimmed.replace(/^wss:\/\//i, '')}`;
  }
  if (/^ws:\/\//i.test(trimmed)) {
    return `ws://${trimmed.replace(/^ws:\/\//i, '')}`;
  }
  if (/^https:\/\//i.test(trimmed)) {
    return `wss://${trimmed.replace(/^https:\/\//i, '')}`;
  }
  if (/^http:\/\//i.test(trimmed)) {
    return `ws://${trimmed.replace(/^http:\/\//i, '')}`;
  }
  return `ws://${trimmed}`;
}

/** Map a ws:// origin to its http:// equivalent for the REST endpoints. */
export function relayHttpBase(wsUrl: string): string {
  if (/^wss:\/\//i.test(wsUrl)) {
    return `https://${wsUrl.replace(/^wss:\/\//i, '')}`;
  }
  return `http://${wsUrl.replace(/^ws:\/\//i, '')}`;
}
