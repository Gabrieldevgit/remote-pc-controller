// Remote Access PIN — stored only on this PC as an scrypt hash in
// config.json, checked locally before a session is unlocked. The PIN never
// reaches Supabase.

import crypto from 'node:crypto';

export const PIN_MIN = 6;
export const PIN_MAX = 12;
export const PIN_MAX_ATTEMPTS = 5;

export function isValidPin(pin) {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

/** Returns { pinHash, pinSalt } for config.json. */
export function hashPin(pin) {
  if (!isValidPin(pin)) throw new Error(`the PIN must be ${PIN_MIN}–${PIN_MAX} digits`);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { pinHash: hash, pinSalt: salt };
}

export function verifyPin(pin, { pinHash, pinSalt } = {}) {
  if (!isValidPin(pin) || typeof pinHash !== 'string' || typeof pinSalt !== 'string') return false;
  const expected = Buffer.from(pinHash, 'hex');
  const actual = crypto.scryptSync(pin, pinSalt, expected.length, { N: 16384, r: 8, p: 1 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
