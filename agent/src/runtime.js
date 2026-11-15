// Runtime wiring shared by the CLI entry (index.js) and the protocol test:
// capability detection, WebRTC backend selection, relay client + session
// manager assembly.

import { RelayClient } from './relay-client.js';
import { SupabaseAgentClient } from './supabase-client.js';
import { SessionManager } from './session.js';
import * as webrtc from './webrtc.js';
import * as input from './input.js';
import { closeInput } from './input.js';
import * as clipboard from './clipboard.js';
import * as system from './system.js';
import { loadConfig, resolveConfigPath } from './config.js';
import { verifyPin } from './pin.js';

function makeLogger(log) {
  return (...args) => log(...args);
}

/**
 * Start the agent runtime.
 * @param {object} opts
 * @param {object} opts.config   loaded config (see config.js)
 * @param {function} [opts.log]  line logger
 * @param {object} [opts.backend] injected WebRTC backend (tests); otherwise detected
 * @param {number} [opts.heartbeatIntervalMs] override (tests)
 * @param {boolean} [opts.detectCapabilities] set false in tests to skip native probing
 */
export async function startAgent({
  config,
  log = console.log,
  backend = null,
  heartbeatIntervalMs,
  detectCapabilities = true,
  authorize = null,
  onSessionEvent = null,
  security = null,
}) {
  const capabilities = {
    webrtc: { mode: 'skipped', reason: null },
    input: { available: false, mode: 'none', reason: 'detection skipped' },
    clipboard: { available: false, mode: 'none', reason: 'detection skipped' },
  };

  if (detectCapabilities) {
    capabilities.input = await input.detect(log);
    log(capabilities.input.available
      ? `feature available: input injection (${capabilities.input.mode})`
      : capabilities.input.reason);
    capabilities.clipboard = await clipboard.detect();
    log(capabilities.clipboard.available
      ? 'feature available: clipboard sync (clipboardy)'
      : capabilities.clipboard.reason);
  }

  if (backend) {
    capabilities.webrtc = { mode: backend.mode, reason: backend.reason ?? null };
  } else {
    backend = await webrtc.createBackend({ log: makeLogger(log) });
    capabilities.webrtc = { mode: backend.mode, reason: backend.reason ?? null };
    log(backend.mode === 'native'
      ? 'feature available: WebRTC video streaming (@roamhq/wrtc)'
      : (backend.reason ?? `webrtc mode: ${backend.mode}`));
  }

  const sessions = new SessionManager({
    backend,
    input,
    clipboard,
    system,
    sendSignal: (type, payload) => client.sendEvent(type, payload),
    log,
    authorize,
    onSessionEvent,
    // The PIN is re-read for every session so a change applies immediately.
    security: security ?? {
      pinRequired: () => Boolean(readPin().pinHash),
      verifyPin: (pin) => verifyPin(pin, readPin()),
    },
  });

  function readPin() {
    try {
      const fresh = loadConfig(config.configPath ?? resolveConfigPath());
      return { pinHash: fresh.pinHash, pinSalt: fresh.pinSalt };
    } catch {
      return {};
    }
  }

  const client = config.backend === 'relay'
    ? new RelayClient({
      url: config.resolvedRelayUrl,
      deviceId: config.deviceId,
      token: config.token,
      name: config.name,
      os: 'windows',
      version: config.version,
      heartbeatIntervalMs: heartbeatIntervalMs ?? config.settings?.heartbeatIntervalMs ?? 15_000,
    })
    : new SupabaseAgentClient({
      url: config.supabaseUrl,
      key: config.supabaseKey,
      // Remote Support uses a temporary host identity instead of the device login.
      kind: config.supportHost ? 'support' : 'device',
      hostId: config.supportHost?.hostId,
      deviceId: config.deviceId,
      email: config.supportHost?.email ?? config.deviceEmail,
      password: config.supportHost?.password ?? config.devicePassword,
      name: config.name,
      version: config.version,
      capabilities: {
        video: capabilities.webrtc.mode,
        input: capabilities.input.available ? capabilities.input.mode : 'none',
        clipboard: capabilities.clipboard.available,
      },
      heartbeatIntervalMs: heartbeatIntervalMs ?? 20_000,
    });

  client.on('log', (level, ...args) => {
    const line = args.join(' ');
    log(`[${config.backend === 'relay' ? 'relay' : 'supabase'}] ${line}`);
  });
  client.on('message', (type, payload) => {
    if (type === 'device.command') return sessions.handleDeviceCommand(payload);
    sessions.handleRelayMessage(type, payload);
  });

  client.connect();

  return {
    client,
    sessions,
    capabilities,
    backend,
    stop() {
      sessions.teardownAll();
      closeInput();
      client.stop();
    },
  };
}
