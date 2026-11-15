// Agent configuration: agent/config.json holds the relay URL and the device
// credentials issued at pairing. The device token is a secret — config.json is
// gitignored (see agent/.gitignore) and must never be committed or logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG_PATH = path.join(AGENT_ROOT, 'config.json');
// The installed host app points this at %APPDATA%\Remote PC Host\screenshots.
export const SCREENSHOT_DIR = process.env.AGENT_SCREENSHOT_DIR
  ? path.resolve(process.env.AGENT_SCREENSHOT_DIR)
  : path.join(AGENT_ROOT, 'screenshots');
export const AGENT_VERSION = '1.1.0';
export const AGENT_OS = 'windows';

// Hosted backend (supabase/). The publishable key is designed to be public:
// every table is protected by RLS and the PC acts through its own device
// login issued at pairing. Override with SUPABASE_URL / SUPABASE_KEY.
export const SUPABASE_URL = 'https://hmhjlpxzuoyvxzqyfkqc.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xLslj52HKvSS2Xi9XyKstQ__37FllPS';

/** Config path resolution: AGENT_CONFIG_PATH env var overrides the default. */
export function resolveConfigPath(env = process.env) {
  return env.AGENT_CONFIG_PATH ? path.resolve(env.AGENT_CONFIG_PATH) : DEFAULT_CONFIG_PATH;
}

export function defaultConfig() {
  return {
    // 'supabase' (default, hosted) or 'relay' (legacy self-hosted relay/).
    backend: 'supabase',
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_PUBLISHABLE_KEY,
    // Legacy relay WebSocket endpoint (path /ws). Overridable with RELAY_URL.
    relayUrl: 'ws://127.0.0.1:8080/ws',
    // Set by `pair`: device id plus its credential — a device login
    // (Supabase) or a device token (legacy relay).
    deviceId: null,
    deviceEmail: null,
    devicePassword: null,
    token: null,
    // Remote Access PIN (scrypt), set with `node src/index.js pin`.
    pinHash: null,
    pinSalt: null,
    name: defaultDeviceName(),
    version: AGENT_VERSION,
    settings: {
      // Default streaming quality: high | medium | low | adaptive
      quality: 'high',
      heartbeatIntervalMs: 15_000,
      clipboardSync: true,
    },
  };
}

function defaultDeviceName() {
  try {
    return os.hostname() || 'Windows PC';
  } catch {
    return 'Windows PC';
  }
}

/**
 * Normalize a relay URL: ensure a ws(s):// scheme and the /ws path.
 * Accepts "host:port", "ws://host:port" or a full endpoint URL.
 */
export function normalizeRelayUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return null;
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
  url.hash = '';
  url.search = '';
  return url.toString();
}

/** Resolve the relay URL: RELAY_URL env var wins over the config file. */
export function resolveRelayUrl(config, env = process.env) {
  return normalizeRelayUrl(env.RELAY_URL) ?? normalizeRelayUrl(config.relayUrl) ?? defaultConfig().relayUrl;
}

function mergeSettings(saved) {
  const base = defaultConfig();
  const settings = { ...base.settings };
  if (saved && typeof saved.settings === 'object' && saved.settings !== null) {
    for (const key of Object.keys(settings)) {
      if (saved.settings[key] !== undefined) settings[key] = saved.settings[key];
    }
  }
  return settings;
}

/** Load agent/config.json, merging over defaults. Missing file → defaults. */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  } catch {
    // First run or unreadable file: start from defaults.
  }
  const config = defaultConfig();
  for (const key of ['backend', 'supabaseUrl', 'supabaseKey', 'relayUrl', 'deviceId', 'deviceEmail', 'devicePassword', 'token', 'pinHash', 'pinSalt', 'name', 'version']) {
    if (typeof saved[key] === 'string' && saved[key]) config[key] = saved[key];
  }
  if (saved.deviceId === null) config.deviceId = null;
  if (saved.token === null) config.token = null;
  // Configs written before the Supabase backend existed are relay pairings.
  if (typeof saved.backend !== 'string' && typeof saved.token === 'string' && saved.token) {
    config.backend = 'relay';
  }
  if (process.env.SUPABASE_URL) config.supabaseUrl = process.env.SUPABASE_URL;
  if (process.env.SUPABASE_KEY) config.supabaseKey = process.env.SUPABASE_KEY;
  if (config.backend !== 'relay') config.backend = 'supabase';
  config.settings = mergeSettings(saved);
  config.configPath = configPath;
  return config;
}

/** Persist the config atomically (tmp file + rename). */
export function saveConfig(config, configPath = config.configPath ?? DEFAULT_CONFIG_PATH) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    backend: config.backend ?? 'supabase',
    supabaseUrl: config.supabaseUrl,
    supabaseKey: config.supabaseKey,
    relayUrl: config.relayUrl,
    deviceId: config.deviceId ?? null,
    deviceEmail: config.deviceEmail ?? null,
    devicePassword: config.devicePassword ?? null,
    token: config.token ?? null,
    pinHash: config.pinHash ?? null,
    pinSalt: config.pinSalt ?? null,
    name: config.name,
    version: config.version,
    settings: config.settings,
    // Restrictive note: this file contains the device token secret.
    _note: 'Contains the device token secret. Never commit this file (see .gitignore).',
  };
  const tmp = path.join(dir, `.config-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows ACLs differ; the restrictive note + .gitignore cover the rest.
  }
}

/** True when the config holds a usable device identity for its backend. */
export function hasDeviceIdentity(config) {
  const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
  if (!nonEmpty(config.deviceId)) return false;
  return config.backend === 'relay'
    ? nonEmpty(config.token)
    : nonEmpty(config.deviceEmail) && nonEmpty(config.devicePassword);
}
