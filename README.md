# Remote PC Controller

Control a Windows PC from your phone — or get help on someone else's PC with
a one-time code: live screen and sound, a big on-screen mouse you drag with
your finger, keyboard, clipboard, file transfer, curtain mode, quick actions
and screenshots. Accounts, devices,
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
  bucket, the `pair-device` and `support-host` Edge Functions and the hourly
  clean-up job. Already applied to project
  `hmhjlpxzuoyvxzqyfkqc`; see [`supabase/README.md`](supabase/README.md).
- **`agent/`** — Windows agent (Node.js 20+, no compiler required). Signs in
  with its own device login, heart-beats, answers session requests and runs
  quick actions: screen capture (PowerShell BGRA) fed into a native WebRTC
  video track (pure-JS JPEG fallback), input injection, clipboard sync,
  screenshots uploaded to Storage. Data-channel contract:
  [`docs/DATA_CHANNEL.md`](docs/DATA_CHANNEL.md). `npm run desktop` opens the
  Remote PC Host app
  (Remote Access pairing + PIN, Remote Support codes and consent).
- **`remote-pc-controller-main-src/`** — React Native 0.81 app (ivory /
  charcoal / slate / copper palette, light and dark, layout inspired by
  remote-desktop consoles): Computers (pairing, rename/delete, quick actions,
  screenshots), Support (connect with a 12-digit code), RemoteSession (video +
  sound, Mouse / Touch / Trackpad pointer modes, PIN sheet, keyboard bar,
  clipboard, files, curtain, quality, stats), Settings (pointer size, colour,
  speed), Account.
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
Host, choose a **PIN** (6–12 digits) → **Pair**. The computer turns online;
connecting asks for that PIN.

> **PC paired with the old relay?** Remote PC Host shows *Update needed* and
> `node src\index.js run` refuses to start: pair it again (same steps). Pairing
> now always moves the PC to Supabase.

**Remote Support** (no account on the shared PC): on the PC open Remote PC
Host → *Share this screen* → **Generate code**. On the phone: Support tab →
type the 12 digits → Control or View only. The person at the PC is asked to
**Allow** before anything is shared, and can stop at any time.

Command-line alternative:

```bat
node src\index.js pair        # enter the 6-digit code from the app
node src\index.js run         # serve sessions (Ctrl+C to stop)
node src\index.js status      # backend, device id, detected capabilities
node src\index.js pin         # set or change the PIN (pin --clear removes it)
node src\index.js support     # one-off Remote Support code in the terminal
```

Optional modules upgrade the experience: `@roamhq/wrtc` (native video) and
`@nut-tree/nut-js` (faster input); the agent degrades gracefully without
them. See [`agent/README.md`](agent/README.md).

## Features

Compared with Chrome Remote Desktop:

| Feature | Status | Notes |
|---|---|---|
| Full desktop control | ✅ | WebRTC video, adaptive quality, stats overlay |
| Remote Support (one-time code) | ✅ | 12-digit code, 5 min, single use; temporary host identity, no account on the shared PC; explicit Allow / Decline; always-on-top *Stop sharing* bar |
| Screen sharing (view only) | ✅ | Support sessions in *View only* mode drop all input |
| Persistent access with a PIN | ✅ | 6–12 digits, scrypt hash kept on the PC, checked on the PC, 5 tries; optional "remember on this phone" |
| Encrypted sessions | ✅ | DTLS-SRTP peer-to-peer; the session menu shows direct vs relayed route |
| Keyboard & mouse | ✅ | Big draggable pointer (32–160 px, 3 colours, speed 0.5–3×), tap / double-tap / long-press drag / right click / scroll / pinch-zoom; Touch and Trackpad modes; keyboard bar with modifiers |
| Clipboard | ✅ | Both directions (not pushed to view-only helpers) |
| Audio sharing | ✅ | PC sound (WASAPI loopback) on a WebRTC audio track, toggle in the session menu |
| File transfer | ✅ | Peer-to-peer, both directions, up to 1 GB |
| Curtain mode | ✅ | Black screen on the PC that the capture ignores (Windows 10 2004+); local keyboard/mouse are not blocked |
| Multiple connection modes | ✅ | Remote Access (own PCs) and Remote Support (code) |
| Quick actions without a session | ✅ | lock, shutdown, restart, volume, find-me, screenshot, processes, sysinfo |
| Cross-platform client | 🟡 | Android tested; iOS builds need a Mac; web client is planned |
| Organisations, admin support, unattended access, policies | ⏳ | Roadmap |

Other details:

- **Real online status** — agent heartbeat every 20 s; offline after 60 s of
  silence; Realtime pushes changes to the app instantly.
- **Secure pairing** — 6-digit one-time codes bound to the requesting user,
  5-minute TTL, single-use, 10 failed claims per IP per 10 minutes.
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
node agent\test\session-gates-test.js    # PIN lock / view-only / support gates
cd remote-pc-controller-main-src && npm run tsc
```

Manual end-to-end script (relay → pairing → stream → input → clipboard →
commands): [`docs/E2E_CHECKLIST.md`](docs/E2E_CHECKLIST.md).

## Roadmap

- **Control the phone from the PC** — Android host (MediaProjection screen
  capture + AccessibilityService input) reusing the same Supabase signaling
  and data-channel protocol, with the same features as the PC host.
- **Web client** — connect from any browser.
- **Organisations** — shared device lists, admin-initiated support,
  unattended access and policies (clipboard / files / curtain on or off).
- Curtain mode that also blocks local input (needs an elevated service).
- Multi-display selection and per-display capture.
- TURN credentials from an Edge Function for strict NAT networks.
- iOS build and TestFlight (requires macOS / Xcode).
- Packaging the agent as a signed single-file executable.

## Layout

```
supabase/      migrations, pair-device + support-host Edge Functions, README
relay/         legacy self-hosted relay (src/, test/, PROTOCOL.md)
agent/         Windows agent (src/, test/, README.md)
docs/          DATA_CHANNEL.md, E2E_CHECKLIST.md
remote-pc-controller-main-src/   React Native app (src/screens, src/lib, src/components, src/theme, src/store)
```

> `remote-pc-controller-main-src/README.md` is the original Expo template
> readme and is outdated; this file is the project readme.
