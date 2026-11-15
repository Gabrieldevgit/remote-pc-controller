/** Tiny base64 helpers for binary data-channel payloads (Hermes-safe). */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < CHARS.length; i++) {
  LOOKUP[CHARS.charCodeAt(i)] = i;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out +=
      CHARS[b0 >> 2] +
      CHARS[((b0 & 3) << 4) | (b1 >> 4)] +
      (has1 ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
      (has2 ? CHARS[b2 & 63] : '=');
    if (out.length >= 8192) {
      parts.push(out);
      out = '';
    }
  }
  parts.push(out);
  return parts.join('');
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)];
    const c1 = LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0;
    if (o < len) {
      out[o++] = (c0 << 2) | (c1 >> 4);
    }
    if (o < len && i + 2 < clean.length) {
      out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    }
    if (o < len && i + 3 < clean.length) {
      out[o++] = ((c2 & 3) << 6) | c3;
    }
  }
  return o === len ? out : out.subarray(0, o);
}
