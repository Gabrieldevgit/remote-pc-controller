# Remote PC Controller

Control a Windows PC from your phone: live screen streaming, mouse/keyboard
input, clipboard sync, quick actions and screenshots. Accounts, devices,
pairing and connection setup run on **Supabase**; screen and input travel
peer-to-peer over WebRTC.

```
┌─────────────┐  WebRTC: video track + 'input' data channel     ┌───────────────┐
│  Mobile app │◄──────────── (DTLS/SRTP, direct P2P) ──────────►│ Windows agent │
│  (RN 0.81)  │                                                 │ (Node.js)     │
└──────┬──────┘                                                 └──────┬────────┘
       │ Auth · Database · Realtime · Storage                          │ device login
       │                                                               │ heartbeat RPC
       └───────────────────────►┌──────────────────┐◄──────────────────┘
                                │     Supabase     │ Postgres + RLS, Realtime
                                │  (hosted)        │ broadcast, Storage, Edge Fn
                                └──────────────────┘
```

- **`supabase/`** — schema, RLS policies, Realtime authorization, Storage
  bucket and the `pair-device` Edge Function. Already applied to project
  `hmhjlpxzuoyvxzqyfkqc`; see [`supabase/README.md`](supabase/README.md).
- **`agent/`** — Windows agent (Node.js 20+, no compiler required). Signs in
  with its own device login, heart-beats, answers session requests and runs
  quick actions: screen capture (PowerShell BGRA) fed into a native WebRTC
  video track (pure-JS JPEG fallback), input injection, clipboard sync,
  screenshots uploaded to Storage. Data-channel contract:
  [`docs/DATA_CHANNEL.md`](docs/DATA_CHANNEL.md). `npm run desktop` opens the
  Remote PC Host app.
- **`remote-pc-controller-main-src/`** — React Native 0.81 app (ivory /
  charcoal / slate / copper palette, light and dark, layout inspired by
  remote-desktop consoles): Computers (pairing, rename/delete, quick actions,
  screenshots), RemoteSession (video viewer, trackpad + direct-touch pointer
  modes, keyboard bar, clipboard sync, quality control, stats overlay),
  Settings, Account.
- **`relay/`** — the previous self-hosted WebSocket relay. No longer used by
  the app; the agent still supports it with `"backend": "relay"` in
  `config.json` (kept for tests and offline LAN setups).

## Quickstart

### 1. Mobile app

```bat
cd remote-pc-controller-main-src
npm install
npm run android               # or: npm run ios
```

Account → **Create account** → confirm the email → sign in.

### 2. Windows agent

```bat
cd agent
npm install
npm run desktop               # Remote PC Host app: pairing, on/off
```

In the app: Computers → **Get a code** → type the 6 digits into Remote PC
Host → **Pair**. The computer turns online and you can connect.

Command-line alternative:

```bat
node src\index.js pair        # enter the 6-digit code from the app
node src\index.js run         # serve sessions (Ctrl+C to stop)
node src\index.js status      # backend, device id, detected capabilities
```

Optional modules upgrade the experience: `@roamhq/wrtc` (native video) and
`@nut-tree/nut-js` (faster input); the agent degrades gracefully without
them. See [`agent/README.md`](agent/README.md).

## Features

- **Real online status** — agent heartbeat every 20 s; offline after 60 s of
  silence; Realtime pushes changes to the app instantly.
- **Secure pairing** — 6-digit one-time codes bound to the requesting user,
  5-minute TTL, single-use, 10 failed claims per IP per 10 minutes.
- **Remote desktop session** — WebRTC video (native track, or chunked JPEG
  over the data channel in degraded mode) with quality presets and adaptive
  bitrate; RTT/fps/bitrate stats overlay.
- **Input** — trackpad mode (relative move, tap-click, two-finger scroll,
  long-press drag) and direct-touch mode (letterbox-aware coordinates); keyboard
  bar with sticky modifiers and Unicode text injection.
- **Clipboard sync** — bidirectional; the agent pushes PC clipboard changes
  ~every 1.5 s while a session is open.
- **Quick actions without a session** — rows in `device_commands` (lock,
  shutdown, restart, hibernate, volume, mute, find-me beep, screenshot,
  process list/kill, sysinfo) with a strict whitelist; results come back live.
- **Screenshots** — captured on the PC, stored in a private Storage bucket,
  viewed in the app through short-lived signed links.
- **Device management** — rename, delete (revokes the PC's login at once),
  live status.

## Security notes

- Clients hold only the Supabase **publishable** key; every table has RLS and
  column-level grants. No service-role key is in the app, agent or repo.
- Each PC signs in with its own device login (issued once at pairing, kept in
  `agent/config.json`, git-ignored) and can only touch its own rows.
- Signaling runs on private Realtime channels that only the session's two
  participants can join.
- All data-channel messages are shape-validated; unknown types are ignored;
  no dynamic code execution anywhere. Input, power actions and process kills
  happen only on explicit requests from the owning account.
- The legacy Blink keys were removed earlier — see [`SECURITY.md`](SECURITY.md).

## Testing

```bat
node relay\test\smoke.js                 # legacy relay protocol, 31 steps
node agent\test\protocol-test.js         # agent ⇄ legacy relay, 14 steps
cd remote-pc-controller-main-src && npm run tsc
```

Manual end-to-end script (relay → pairing → stream → input → clipboard →
commands): [`docs/E2E_CHECKLIST.md`](docs/E2E_CHECKLIST.md).

## Roadmap

- File transfer over the data channel.
- Multi-display selection and per-display capture.
- Audio streaming.
- Session recording / screenshot gallery in the app.
- TURN credentials from an Edge Function for strict NAT networks.
- Packaging the agent as a signed single-file executable with a tray UI.

## Layout

```
supabase/      migrations, pair-device Edge Function, README
relay/         legacy self-hosted relay (src/, test/, PROTOCOL.md)
agent/         Windows agent (src/, test/, README.md)
docs/          DATA_CHANNEL.md, E2E_CHECKLIST.md
remote-pc-controller-main-src/   React Native app (src/screens, src/lib, src/components, src/theme, src/store)
```

> `remote-pc-controller-main-src/README.md` is the original Expo template
> readme and is outdated; this file is the project readme.
