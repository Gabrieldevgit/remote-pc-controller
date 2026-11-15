# Remote PC Controller — Windows Agent

The agent turns a Windows PC into a controllable device for the Remote PC
Controller app. It signs in to **Supabase** with its own device login, shows
up online in the app, and serves remote-desktop sessions: live screen and
sound, a reported pointer for the phone's big cursor, mouse/keyboard
injection, clipboard sync, file transfer, curtain mode and quick actions
(lock, shutdown, volume, screenshots, processes). It can also run as a
temporary **Remote Support** host with a one-time code.

```
┌──────────┐  device login · heartbeat RPC ┌──────────┐  Auth · Realtime   ┌──────────────┐
│  Agent   │◄─────────────────────────────►│ Supabase │◄──────────────────►│  App client  │
│ (this)   │  session rows · signaling     │          │  signaling         │(React Native)│
└────┬─────┘                               └──────────┘                    └──────┬───────┘
     │                                                                           │
     │  WebRTC (video + audio tracks, data channels) — peer-to-peer, DTLS/SRTP   │
     └───────────────────────────────────────────────────────────────────────────┘
```

Supabase only carries signaling and metadata; screen, sound, input and files
flow peer-to-peer. The legacy relay (`../relay/PROTOCOL.md`) is still
supported with `"backend": "relay"` for tests and offline LAN setups.

---

## Requirements

- **Windows 10 or 11** (x64). The agent uses PowerShell 5.1 (built into
  Windows) for screen capture, input injection and system actions — no extra
  PowerShell install is needed.
- **Node.js 20 or newer** — https://nodejs.org (LTS recommended).
- Network access to the relay (WebSocket, default `ws://127.0.0.1:8080/ws`).
  Outbound UDP for WebRTC/ICE; STUN servers are used for NAT traversal.

## Install

```bat
cd agent
npm install
```

This installs the pure-JS dependencies (`ws`, `clipboardy`, `jpeg-js`) and
tries to install the optional native/feature modules. The agent works with
whatever installs successfully — see [Capability tiers](#capability-tiers).

### Optional native modules and their prerequisites

| Module | What it enables | Prerequisites |
|---|---|---|
| `@roamhq/wrtc` | **Native WebRTC**: real H.264/VP8 video track at capture speed (best experience) | None — ships prebuilt Windows binaries |
| `werift` | Pure-JS WebRTC fallback: data channel only, JPEG frames at reduced fps | None (pure JS) |
| `@nut-tree/nut-js` | Fast in-process input injection | Visual Studio Build Tools (C++ workload), Python — often fails to build; the agent falls back automatically |

Install them explicitly if you want to force a tier:

```bat
npm install @roamhq/wrtc        # native video
npm install werift              # pure-JS fallback
npm install @nut-tree/nut-js    # optional faster input
```

Nothing here is mandatory: if a module is missing the agent logs
`feature unavailable: <reason>` and keeps running with the remaining
features. It never crashes over a missing capability.

### Remote PC Host (desktop app)

For a guided Windows experience instead of the command line, start the
desktop host app (Electron):

```bat
npm run desktop
```

It mirrors the mobile app's look (ivory / charcoal / copper, light and dark)
and has two parts, like Chrome Remote Desktop:

- **Remote Access** — pair this PC with your account (6-digit code from the
  app + a PIN), turn access on/off, change the PIN. A PC still paired with
  the retired relay shows **Update needed**: pair it again.
- **Remote Support** — *Generate code* shows a 12-digit one-time code
  (5 minutes, refreshed automatically). When a helper enters it, a dialog asks
  **Allow / Decline**; while they are connected an always-on-top bar shows
  *"Your screen is shared — Stop sharing"*. No account is needed on this PC.

- **Account & history** (optional) — sign in or create an account (the same
  one as the phone app). While signed in, *Set up remote access* needs no
  code, and **Connection history** lists who connected — account email and
  phone model ("Google Pixel 7 · Android 16"), when and for how long — read
  from the account; Remote Support sessions are recorded on this PC. The
  account session is kept in `%APPDATA%\Remote PC Host\account.json`,
  encrypted with Windows DPAPI; signing out never unpairs the PC.

It runs the agent CLI as a child process (`ELECTRON_RUN_AS_NODE`) and never
displays or exports the device login.

### Building the `.exe`

```bat
npm install
npm run dist
```

This produces, in `agent\dist\`:

- `Remote-PC-Host-Setup-<version>.exe` — installer (per user, no admin
  rights; choose the folder; Start-menu and desktop shortcuts).
- `Remote-PC-Host-<version>-portable.exe` — single file, nothing installed.

`npm run dist:dir` only builds the unpacked app in `dist\win-unpacked\`
(faster, for testing). The build bundles Node, the agent and whichever
optional modules are installed (`@roamhq/wrtc` for native video), so the
target PC needs nothing else.

Installed or portable, the app keeps its identity (`config.json`) and
screenshots in `%APPDATA%\Remote PC Host\`, not next to the program. A PC
paired from source (`agent\config.json`) must pair again in the `.exe`, or
copy that file into `%APPDATA%\Remote PC Host\`. Only one copy of the host
runs at a time; launching it again brings the window forward.

The `.exe` is not code-signed, so Windows SmartScreen shows *"Windows
protected your PC"* on first launch (**More info → Run anyway**). Signing
needs a code-signing certificate (`win.signtoolOptions` / `CSC_LINK` in
electron-builder).

## Pairing (first run)

1. In the app: Computers → **Get a code** — a 6-digit code appears (valid
   5 minutes).
2. On the PC, in Remote PC Host or on the command line:

   ```bat
   cd agent
   node src\index.js pair
   ```

3. Answer the prompts (code, device name, PIN). The PIN (6–12 digits) is
   asked every time someone connects; it is stored as a scrypt hash in
   `config.json` and checked on this PC only.

   Scripted form: `node src\index.js pair --code 482913 --name "Living Room PC" --pin 246810`
   (`--no-pin` skips the PIN, `--no-run` exits after pairing).

`pair` always pairs with Supabase and rewrites `config.json`
(`backend: "supabase"`, the device login, the PIN hash). A config left from
the old relay (it has a `token` and no `backend`) is refused by `run` with
*"This PC is paired with the retired relay server… Pair it again"*.
`--backend relay` still pairs against a self-hosted relay for tests.

`agent/config.json` **is** the machine's identity — anyone holding it can
sign in as this PC. It is git-ignored. Removing the PC in the app revokes its
login immediately.

## Running

```bat
node src\index.js run           :: serve sessions (default command)
node src\index.js status        :: backend, device id, capabilities
node src\index.js pin           :: set or change the PIN
node src\index.js pin --clear   :: remove the PIN (not recommended)
node src\index.js support       :: one-off Remote Support code in the terminal
node src\index.js support --json   :: JSON-lines protocol used by Remote PC Host
```

Once running, the agent:

- signs in with its device login and heart-beats every 20 s (online status),
- answers session requests and WebRTC offers on private Realtime channels,
- keeps each Remote Access session **locked** until the right PIN arrives
  (5 tries),
- serves the data-channel protocol: video, sound, pointer reports, input,
  clipboard, files, curtain (see [`../docs/DATA_CHANNEL.md`](../docs/DATA_CHANNEL.md)),
- runs quick actions and uploads screenshots to Storage,
- reconnects automatically.

### Session features

| Feature | How it works | Notes |
|---|---|---|
| Pointer reports | `src/cursor.js` — PowerShell `GetCursorInfo` worker, ≤ 30 reports/s | The phone draws a big pointer from these; the capture has no cursor |
| PIN | `src/pin.js` — scrypt hash + salt in `config.json` | Never sent to Supabase |
| Sound | `src/audio.js` — WASAPI loopback (C# in a PowerShell worker), 48 kHz stereo | Native video mode only; off until the phone turns it on |
| Curtain | `src/curtain.js` — black top-most window per monitor with `WDA_EXCLUDEFROMCAPTURE` | Windows 10 2004+; local keyboard/mouse are **not** blocked |
| Files | `src/files.js` — one `file:<id>` data channel per transfer, 1 GiB cap | Received files go to `%USERPROFILE%\Downloads\Remote PC\` (`AGENT_DOWNLOADS_DIR` overrides); "Get a file" opens the Windows Open dialog on this PC |
| Remote Support | temporary host login from the `support-host` Edge Function, `support_sessions` rows | Needs the person at the PC to click Allow; *View only* drops all input |
| Camera | `src/camera.js` — `Windows.Media.Capture` from PowerShell: JPEG photo or 720p MP4 clip (1–30 s, no sound) | Quick actions `camera_photo` / `camera_record`, owner only; uploaded to Storage. Windows must allow *Let desktop apps access your camera*; the camera light is on while it runs |

### Run in the background / at login

Three helpers live in this folder:

- **`start.bat`** — double-click to start the agent in a visible console.
- **`agent.vbs`** — starts the agent completely hidden (no console window).
  Use this for autostart.
- **Task Scheduler** (recommended for auto-start at logon):

  ```bat
  schtasks /create /tn "RemotePCAgent" /tr "wscript.exe \"C:\path\to\agent\agent.vbs\"" /sc onlogon /rl limited
  ```

  "Run only when user is logged on" is correct — the agent injects input into
  the interactive desktop, so it must run in the logged-in session, not as a
  headless service.

## Configuration

`agent/config.json` (created by `pair`):

```json
{
  "backend": "supabase",
  "deviceId": "…",
  "name": "Living Room PC",
  "deviceEmail": "device-…@devices.remote-pc.invalid",
  "devicePassword": "…secret…",
  "pinHash": "…", "pinSalt": "…",
  "settings": { "quality": "high", "clipboardSync": true }
}
```

- `settings.quality` — default streaming quality: `high`, `medium`, `low` or
  `adaptive`. The client can change this per session.
- `AGENT_CONFIG_PATH` overrides the config file location (the tests use it so
  they never touch your real identity).
- Legacy relay mode: `"backend": "relay"` with `relayUrl` / `token`;
  `node src\index.js relay ws://host:8080` saves the address and `RELAY_URL`
  overrides it.

## Capability tiers

Every platform feature is behind a capability check. When the best
implementation is unavailable the agent falls back and logs
`feature unavailable: <reason>`; it never crashes.

| Feature | Preferred | Fallback | Last resort |
|---|---|---|---|
| Video | `@roamhq/wrtc` video track fed by software capture (`native` mode) | JPEG frames over the data channel via `werift` (`jpeg` mode) | Sessions rejected with `capture_unavailable` (`none` mode) |
| Input | `@nut-tree/nut-js` | PowerShell `SendInput` worker (`powershell-sendinput`) | Calls reject with a clear error |
| Clipboard | `clipboardy` | `win-clipboard` | Clipboard sync disabled |
| Sound | WASAPI loopback on a WebRTC audio track (native mode) | — | `audio.state.available: false` |
| Curtain | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` | — | `curtain.state.available: false` (older Windows) |

### Degraded (JPEG) mode explained

`@roamhq/wrtc`'s `getDisplayMedia` is a fake-device stub on Windows, so even
in native mode the video track is fed manually: a persistent PowerShell
worker captures the screen as raw BGRA frames, Node swaps them to RGBA,
converts to I420 and pushes them into an `RTCVideoSource` — a genuine WebRTC
video track at capture speed. That is `native` mode and is what you get when
`@roamhq/wrtc` installs.

If only `werift` (pure JS) is available there is no native video track; the
agent then encodes each frame to JPEG and streams it over the WebRTC data
channel at reduced fps. The client must support the binary JPEG framing
described below. Both modes use the same control protocol.

### Quality levels

| Level | Width | FPS | JPEG quality (degraded mode) |
|---|---|---|---|
| `high` | 1920 | 30 | 65 |
| `medium` | 1280 | 24 | 55 |
| `low` | 854 | 15 | 45 |
| `adaptive` | starts at `medium`, steps up when RTT < 60 ms, down when RTT > 150 ms (checked at most every 5 s) | | |

## Data-channel protocol reference

The binding contract for the data channel is [`../docs/DATA_CHANNEL.md`](../docs/DATA_CHANNEL.md)
— that file is canonical; this section is a summary. Once the WebRTC data
channel opens, the agent speaks a small JSON control protocol (one JSON object
per message, UTF-8 text, discriminator field `t`). Unknown message types are
logged and ignored; nothing is ever `eval`'d and all inbound fields are
validated. Malformed JSON is dropped. Errors are reported back as
`{"t":"error","request":"<kind>","message":"…"}`.

### Client → agent (input, canonical)

| Message | Fields | Effect |
|---|---|---|
| `pointer.move` | `dx`, `dy` | Relative pointer movement (on-screen pixels) |
| `pointer.abs` | `x`, `y` (0..1) | Absolute pointer position, normalized to the streamed frame |
| `click` | `button`: `left`\|`right`\|`middle`; optional `x`, `y` (0..1) | Click, optionally moving to `x`/`y` first |
| `button` | `button`, `down`: boolean | Press/release a mouse button (drag) |
| `wheel` | `dx`, `dy` | Scroll in wheel notches |
| `key` | `code` (KeyboardEvent.code, see below), `down`: boolean, `modifiers`: array of `ctrl`\|`alt`\|`shift`\|`meta` | Key press/release |
| `text` | `text` (string) | Types unicode text |
| `clipboard.get` | — | Reply `clipboard.set` with current text |
| `clipboard.set` | `text` | Write to the PC clipboard |

Key codes are Web `KeyboardEvent.code` values (`KeyA`, `Digit3`, `Escape`,
`ArrowUp`, `Enter`, `ControlLeft`, …). The full supported list and the code →
virtual-key mapping are specified in `../docs/DATA_CHANNEL.md`.

### Client → agent (agent-only extensions)

| Message | Fields | Effect |
|---|---|---|
| `quality.set` | `level`: `high`\|`medium`\|`low`\|`adaptive`, or `{level:"custom", width, fps, jpegQuality}` (width 160–3840, fps 1–60, quality 10–95) | Change streaming quality; replies `quality.ack` |
| `stats.ping` | optional `seq` (echoed back), optional `rttMs` (drives adaptive quality) | Reply `stats.pong` with `{seq, now, mode, quality, sessions}` |
| `input.media` | `key`: `volume_up`, `volume_down`, `volume_mute`, `play_pause`, `next_track`, `prev_track`, `stop_media`, … | Media key |
| `input.ctrlaltdel` | — | Sends Ctrl+Alt+Del (best-effort; see troubleshooting) |
| `screenshot.request` | optional `maxWidth` | Saves a PNG to `agent/screenshots/`, replies `screenshot.result` with `{ok, path}` |
| `system.info` | — | Reply `system.info.result` (OS, CPU, RAM, uptime, hostname…) |
| `system.displays` | — | Reply `system.displays.result` with display list |
| `system.processes` | — | Reply `system.processes.result` (tasklist output parsed to `{name, pid, memMB}` rows) |
| `system.kill` | `pid` (positive integer) | `taskkill /PID <pid> /F`; replies `system.kill.result` |
| `system.power` | `action`: `lock` \| `shutdown` \| `restart` \| `hibernate` \| `signout` | Power action; replies `system.power.result` |
| `system.beep` | — | Plays the "find me" beep; replies `system.beep.result` |

### Agent → client (server-initiated)

| Message | When |
|---|---|
| `clipboard.set` `{text}` | Reply to `clipboard.get` and whenever the PC clipboard changes (~every 1.5 s while the channel is open) |
| `quality.ack` `{quality}` | After a `quality.set` |
| `stats.pong` `{seq, now, mode, quality, sessions}` | Reply to `stats.ping` |
| `screenshot.result` / `system.*.result` / `error` | Reply to the matching request |

### Binary JPEG framing (degraded mode only)

In `jpeg` mode every frame is sent as one or more binary data-channel
messages:

```
offset 0  : uint8  type      = 0x01 (JPEG frame)
offset 1  : uint8  flags     ; bit0 = final chunk of this frame
offset 2  : uint16 sequence  ; little-endian, increments per frame
offset 4  : payload          ; ≤ 16 KiB of JPEG bytes
```

Concatenate the payloads of all chunks sharing a `sequence` until the
`final` flag is set; the result is a complete JPEG image at the frame's
configured width. In `native` mode this framing is unused — video arrives on
the normal WebRTC video track instead.

## Security notes

- The device login in `config.json` is the full credential for this machine.
  `agent/.gitignore` excludes `config.json`, `screenshots/` and `data/`.
  Removing the PC in the app deletes that login.
- Remote Access sessions stay locked (no video, sound, input or files) until
  the PIN is verified on this PC; 5 wrong tries end the session.
- Remote Support needs the person at this PC to click **Allow**; *View only*
  helpers cannot send input, read the clipboard or transfer files.
- All inbound relay and data-channel messages are shape-validated before use;
  unknown types are logged and ignored; no dynamic code execution anywhere.
- Input injection, power actions and process killing only happen on explicit
  client requests inside an established session.
- Screenshots are written to `agent/screenshots/` with timestamped names.

## Troubleshooting

**`feature unavailable: …` in the log** — informational, not fatal. The
matching feature is degraded or off. Install the optional module listed in
the table above to restore it.

**Antivirus blocks PowerShell scripts** — the agent writes its PowerShell
helpers to temp `.ps1` files and runs them with `powershell -File`, which
avoids the common "ScriptContainedMaliciousContent" block on inline
`-Command` scripts. If your AV still quarantines them, whitelist the agent
folder. Note that GDI+ JPEG-encoding scripts are widely flagged; this agent
deliberately encodes JPEG in Node instead.

**No video / session rejected with `capture_unavailable`** — no WebRTC
backend installed. Run `npm install @roamhq/wrtc` (or at minimum
`npm install werift` for degraded mode) and check `node src\index.js status`.

**Video is slow / low fps** — capture runs at roughly 7–15 fps depending on
resolution and scaling. Set `quality.set` to `low` on slow links, or use
`custom` with a smaller width. Native mode always outperforms JPEG mode.

**Pairing fails with "invalid or expired code"** — codes are single-use and
short-lived; request a fresh one in the app. If the relay was restarted, its
in-memory pending pairings are gone — request a new code.

**Agent shows offline in the app** — check the relay URL (`status`), make
sure the relay is running, and check that no firewall blocks outbound
WebSocket. The agent reconnects automatically; give it a few seconds.

**Input doesn't work in elevated (admin) windows** — SendInput cannot inject
into windows running at a higher integrity level. Run the agent elevated if
you need to control admin prompts.

**Ctrl+Alt+Del does nothing** — Windows requires a local logon session and
special privileges for SAS injection; the agent sends it best-effort.

**Node keeps running after closing the console** — that's the hidden
`agent.vbs` instance; stop it via Task Scheduler or `taskkill`.

## Layout

```
agent/
  src/
    index.js        CLI entry (pair / run / status / pin / support / relay)
    runtime.js      wires config + backends + session manager together
    supabase-client.js  Supabase device / support-host client (presence,
                    sessions, signaling, commands, pairing)
    relay-client.js legacy relay WebSocket client
    session.js      session orchestration + data-channel control protocol
    webrtc.js       backend detection & adapters (native / jpeg / none)
    capture.js      PowerShell screen-capture worker (BGRA frames, PNG shots)
    input.js        mouse/keyboard injection (nut-js or SendInput worker)
    clipboard.js    clipboard read/write behind a capability check
    system.js       power actions, volume, beep, screenshots, processes
    config.js       config.json load/save, relay URL normalization
    powershell.js   shared "write temp .ps1 + run with -File" helper
    cursor.js       real pointer position / shape reports
    pin.js          PIN hashing and checks (scrypt)
    audio.js        WASAPI loopback sound capture
    curtain.js      curtain-mode window hidden from the capture
    files.js        peer-to-peer file transfer, Windows Open dialog
  desktop/          Remote PC Host (Electron): main.cjs, preload.cjs,
                    renderer.html, sharing-bar.html
  test/
    protocol-test.js     end-to-end test against a spawned relay
    session-gates-test.js  PIN lock / view-only / support gates (no network)
  start.bat / agent.vbs   launchers (visible / hidden)
  config.json             created by `pair` — the device login and PIN hash
  screenshots/            PNG screenshots requested during sessions
```

## Testing

```bat
npm run test:gates          :: session gates (PIN, view only, support)
node test\protocol-test.js  :: legacy relay flow, with the relay one directory up
```

The test spawns its own relay instance (`node ../relay/src/server.js`) on a
random port with a temporary data directory, then drives the full flow:
register + login → pairing request → agent claim → heartbeat → device list →
session start/accept → offer/answer/ICE both directions → session end →
malformed-message handling. It prints PASS/FAIL per step and exits non-zero
on failure. It never touches your real `config.json`.
