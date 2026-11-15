// Auth primitives for the relay: scrypt password hashing, a minimal hand-rolled
// HS256 JWT, and constant-time comparison helpers. No third-party crypto deps.

import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;

/**
 * Hash a password with scrypt (random 16-byte salt).
 * Format: scrypt$N$r$p$<salt hex>$<hash hex>
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-ish-time password verification against a stored hash. */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const params = {
      N: parseInt(parts[1], 10),
      r: parseInt(parts[2], 10),
      p: parseInt(parts[3], 10),
    };
    if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) return false;
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, params);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Precomputed hash used to equalize timing when a user does not exist at login.
export const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalization');

/**
 * Sign a JWT (HS256). Claims `iat` and `exp` are set here.
 * Returns the compact serialization: header.payload.signature (base64url).
 */
export function signJwt(payload, secret, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

/** Verify a JWT signature (timing-safe) and expiry. Returns the payload or null. */
export function verifyJwt(token, secret) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null; // refuse algorithm confusion
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison of two hex strings (device tokens). */
export function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** Constant-time comparison of two equal-role strings (e.g. pairing codes). */
export function safeEqualString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Burn comparable time so length is not a cheap oracle.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function randomTokenHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
