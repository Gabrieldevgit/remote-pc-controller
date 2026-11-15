# Remote PC Controller — Remaster Plan

> Goal: transform the current command-polling app into a full remote-desktop product
> functionally equivalent to Chrome Remote Desktop, with an original Material You
> (light/dark) design. No Google code, assets, logos, or UI copied — feature parity
> and original implementation only.

## 1. Current state (audited)

- React Native 0.81 (bare CLI, android/ + ios/ folders), 3 screens: Controls, Setup, Profile.
- Backend: Blink SDK (BaaS). Tables: `computers`, `commands`. PC agent is a Python
  script that polls pending commands. The script body was stripped from the repo —
  Setup screen shows a truncated stub.
- Features today: lock / shutdown / hibernate / restart / "find me" beep / volume up-down-mute.
- Weaknesses:
  - No screen viewing, no remote mouse/keyboard, no clipboard — not a "remote desktop".
  - Online status is hardcoded `● Online` (fake).
  - Publishable + secret keys committed in `src/lib/blink.ts`.
  - Purple/indigo gradient theme, no dark mode, no design system usage consistency.
  - No session security (any device that can reach the DB can send commands).

## 2. Target architecture

```
┌─────────────┐  WebRTC (video/input/clipboard, DTLS/SRTP)   ┌──────────────┐
│  Mobile app │◄────────────────────────────────────────────►│ Windows agent│
│  (RN 0.81)  │                                              │ (Node.js)    │
└──────┬──────┘                                              └──────┬───────┘
       │ WSS: signaling, registry, pairing, auth                    │ WSS
       └────────────────────►┌──────────────────┐◄──────────────────┘
                             │  Relay server    │  Node.js + ws
                             │  (self-hosted)   │  + optional coturn
                             └──────────────────┘
```

- **relay/** — Node.js + WebSocket server:
  - Device registry (register, heartbeat, online status — real this time).
  - Account auth (JWT), per-device 6-digit one-time PIN pairing (CRD-style).
  - WebRTC signaling relay (offer/answer/ICE), TURN config endpoint.
  - E2E: DTLS-SRTP is transport encryption; control channel over WSS/TLS.
- **agent/** — Windows agent in Node.js (single .exe-able runtime, no Python dep):
  - Screen capture → WebRTC video track (desktopCapturer + native encoder path).
  - Input injection: mouse move/click/drag/scroll, keyboard, Unicode text, Ctrl+Alt+Del via SAS.
  - Clipboard sync (read/write), system info, power actions, volume/media keys,
    process list/kill, screenshot capture, display management.
  - Runs as background service / tray app; auto-start config.
- **Mobile app (upgrade in place)** — add `react-native-webrtc`; new navigation:
  - **Devices** — real online status, add-device pairing flow (enter PIN), rename/delete.
  - **Remote** — live screen viewer: trackpad mode (relative pointer, tap-click,
    two-finger scroll, long-press drag), direct-touch mouse mode, keyboard bar,
    Ctrl+Alt+Del, clipboard sync, fullscreen/rotation lock, quality/resolution/fps
    settings, connection stats overlay (latency/fps/bitrate).
  - **Settings** — theme, quality defaults, haptics, relay server URL, TURN.
  - **Profile** — account, paired devices, security (change PIN), sign out.

## 3. Feature parity matrix (CRD public feature set → our app)

| Chrome Remote Desktop feature | Ours |
|---|---|
| Device list w/ online status | ✅ real heartbeat |
| 1-time PIN pairing | ✅ 6-digit PIN, 5-min expiry |
| Remote screen viewing | ✅ WebRTC video, adaptive bitrate |
| Trackpad remote input | ✅ relative pointer + gestures |
| Direct mouse mode | ✅ tap-to-position |
| Keyboard input + special keys | ✅ + Ctrl+Alt+Del |
| Clipboard sync | ✅ bidirectional |
| Fullscreen / resize to fit | ✅ + rotation lock |
| Quality: bandwidth/fps/resolution | ✅ + stats overlay |
| Multiple hosts, rename/delete | ✅ |
| Power: lock/shutdown/restart | ✅ + hibernate, sign-out |
| Extra (beyond CRD): volume/media, screenshots, process manager, find-my-PC beep | ✅ |

## 4. Design system (original, warm-neutral)

- `src/theme/tokens.ts` — five-color brand palette: Ivory #F4F2ED, Charcoal
  #17191C, Slate #292E34, Copper #C87545 (single restrained accent; deepened to
  #AE5F33 for filled buttons in light mode to keep AA contrast), Grey #92969A.
  Light = ivory surfaces / charcoal text; dark = charcoal surfaces / ivory text.
- Principles: no gradient backgrounds, no glow/neon, clean 1px borders with
  subtle shadows, large confident type, consistent spacing, restrained motion.
  The session viewer is always dark (`ThemeOverride`).
- `src/theme/` — Typography (Roboto/system), shape scale (12/16/28), spacing, dark-mode
  via Appearance listener + manual toggle persisted to AsyncStorage.
- Replace every hardcoded hex in screens with tokens. Remove purple gradient entirely.

## 5. Execution phases & subagent split

- **Phase 0 — Foundation** (Agent A: "design-core"): theme tokens, ThemeProvider,
  navigation restructure, reusable components (Card, Button, ListItem, StatusDot,
  PinPad, Toolbar), app icon/name cleanup.
- **Phase 1 — Relay server** (Agent B: "relay"): Node/WS server, auth, registry,
  pairing, signaling, TURN docs; tests via ws client scripts.
- **Phase 2 — Windows agent** (Agent C: "agent"): capture, input injection,
  clipboard, power/media/process commands, tray service, pairing flow, heartbeat.
- **Phase 3 — Mobile session experience** (Agent D: "session-ui"): react-native-webrtc
  integration, viewer screen, trackpad gesture engine, keyboard bar, stats overlay.
- **Phase 4 — Integration & polish** (Agent E: "integration"): end-to-end wiring,
  onboarding/setup flow rewrite (download-and-run agent, QR/PIN entry), README,
  security hardening (remove committed keys → env), build configs.

Agents A+B run in parallel first (no deps), then C+D, then E.

## 6. Risks / notes

- NAT traversal: STUN included; TURN (coturn) needed for strict networks — documented, optional.
- react-native-webrtc on RN 0.81: pin compatible version; Android permissions added.
- Input injection on Windows from a service session requires UIAccess considerations —
  agent runs in user session (tray app), which is the standard approach.
- Repo has committed Blink secret key — must be revoked/rotated and moved to env.
- Naming: original product name/branding; no Google marks.
