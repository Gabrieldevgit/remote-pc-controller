# Remote PC Controller — Windows Agent

The agent turns a Windows PC into a controllable device for the Remote PC
Controller system. It connects to the relay over WebSocket, appears in the
phone/desktop app's device list, and serves remote-desktop sessions: live
screen streaming, mouse/keyboard injection, clipboard sync, and system
actions (lock, shutdown, volume, screenshots, process management).

The relay protocol this agent implements is defined in `../relay/PROTOCOL.md`
— that file is the binding contract.

```
┌──────────┐  WebSocket (device token)  ┌─────────┐  WebSocket   ┌──────────────┐
│  Agent   │◄──────────────────────────►│  Relay  │◄────────────►│  App client  │
│ (this)   │  heartbeat / pairing /     │         │  signaling   │ (React Native)│
└────┬─────┘  session signaling          └─────────┘              └──────┬───────┘
     │                                                            │
     │  WebRTC (video track + data channel) — direct, via STUN    │
     └────────────────────────────────────────────────────────────┘
```

Signaling (offer/answer/ICE) is relayed through the relay server; the actual
screen video and control traffic flow peer-to-peer over WebRTC.

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

It mirrors the mobile app's look (ivory / charcoal / copper, light and dark):
**This device** shows whether remote access is on and turns it on/off,
**Set up remote access** takes the 6-digit access code from the app, and
**Relay server** saves the relay address. It runs the agent CLI as a child
process (`ELECTRON_RUN_AS_NODE`) and never displays or exports the device
token.

### Relay address

```bat
node src\index.js relay ws://192.168.1.20:8080   :: save it in config.json
node src\index.js relay                          :: print the current one
```

The `RELAY_URL` environment variable still overrides the saved value.

## Pairing (first run)

1. Start the relay and open the app (or use the relay's API directly).
2. In the app, choose **Add device** — a **6-digit pairing code** appears and
   is valid for a short time.
3. On the PC, run:

   ```bat
   cd agent
   node src\index.js pair
   ```

4. Answer the prompts:

   ```
   Enter the 6-digit pairing code shown in the app: 482913
   Device name [DESKTOP-ABC123]: Living Room PC
   ```

   Pressing Enter accepts the default device name (the machine's hostname).

   Scripted form (no prompts): `node src\index.js pair --code 482913 --name "Living Room PC"`.
   Add `--no-run` to exit after pairing instead of serving sessions.

5. On success the agent prints:

   ```
   paired successfully as "Living Room PC" (device <id>)
   device token saved to agent/config.json — keep it secret, never commit it
   connected and serving sessions — press Ctrl+C to stop
   ```

The device token is written to `agent/config.json`. That file **is** the
machine's identity — anyone holding it can control this PC. It is excluded
from git via `agent/.gitignore`. To move the agent to a different account,
delete `config.json` and pair again. Re-pairing also invalidates the old
token on the relay.

## Running

```bat
node src\index.js run      # foreground (default command)
node src\index.js status   # identity, relay URL, detected capabilities
```

`status` output looks like:

```
Remote PC Controller agent — status
  relay URL:   ws://127.0.0.1:8080/ws
  device name: Living Room PC
  device id:   dev_...
  token:       9f2a…c1 (48 chars, kept in config.json)
  video:       native
  input:       powershell-sendinput
  clipboard:   clipboardy
```

Once running, the agent:

- authenticates with its device token (`auth.agent`),
- sends a heartbeat every 15 s so the relay marks it **online**,
- accepts `session.request` and answers WebRTC offers,
- serves the data-channel control protocol until the session ends,
- reconnects automatically if the relay connection drops.

### Run in the background / at login

Three helpers live in this folder:

- **`start.bat`** — double-click to start the agent in a visible console.
- **`agent.vbs`** — starts the agent completely hidden (no console window).
  Use this for autostart.
- **Task Scheduler** (recommended for auto-start at logon):

  ```bat
  schtasks /create /tn "RemotePCAgent" /tr "wscript.exe \"C:\path\to\agent\agent.vbs\"" /sc onlogon /rl limited
  ```

  Or via the GUI: Task Scheduler → Create Task → Trigger "At log on" →
  Action: start `wscript.exe` with argument `C:\path\to\agent\agent.vbs`.
  "Run only when user is logged on" is correct — the agent injects input into
  the interactive desktop, so it must run in the logged-in session, not as a
  headless service.

To stop a hidden agent: `taskkill /F /IM node.exe` (kills all Node processes)
or find the specific PID with `tasklist /FI "IMAGENAME eq node.exe"`.

## Configuration

`agent/config.json` (created by `pair`):

```json
{
  "relayUrl": "ws://127.0.0.1:8080/ws",
  "deviceId": "dev_…",
  "token": "…secret…",
  "name": "Living Room PC",
  "version": "1.0.0",
  "settings": {
    "quality": "high",
    "heartbeatIntervalMs": 15000,
    "clipboardSync": true
  }
}
```

- `relayUrl` — relay WebSocket endpoint. The path defaults to `/ws` if
  omitted. The `RELAY_URL` environment variable overrides it (useful for
  testing: `set RELAY_URL=ws://127.0.0.1:41234/ws`).
- `settings.quality` — default streaming quality: `high`, `medium`, `low` or
  `adaptive`. The client can change this per session at runtime.
- `AGENT_CONFIG_PATH` env var overrides the config file location (used by the
  test suite so it never touches your real credentials).

## Capability tiers

Every platform feature is behind a capability check. When the best
implementation is unavailable the agent falls back and logs
`feature unavailable: <reason>`; it never crashes.

| Feature | Preferred | Fallback | Last resort |
|---|---|---|---|
| Video | `@roamhq/wrtc` video track fed by software capture (`native` mode) | JPEG frames over the data channel via `werift` (`jpeg` mode) | Sessions rejected with `capture_unavailable` (`none` mode) |
| Input | `@nut-tree/nut-js` | PowerShell `SendInput` worker (`powershell-sendinput`) | Calls reject with a clear error |
| Clipboard | `clipboardy` | `win-clipboard` | Clipboard sync disabled |

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

- The device token in `config.json` is the full credential for this machine.
  `agent/.gitignore` excludes `config.json`, `screenshots/` and `data/`.
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
    index.js        CLI entry (pair / run / status)
    runtime.js      wires config + backends + session manager together
    relay-client.js reconnecting WebSocket client, auth, heartbeat, pairing
    session.js      session orchestration + data-channel control protocol
    webrtc.js       backend detection & adapters (native / jpeg / none)
    capture.js      PowerShell screen-capture worker (BGRA frames, PNG shots)
    input.js        mouse/keyboard injection (nut-js or SendInput worker)
    clipboard.js    clipboard read/write behind a capability check
    system.js       power actions, volume, beep, screenshots, processes
    config.js       config.json load/save, relay URL normalization
    powershell.js   shared "write temp .ps1 + run with -File" helper
  test/
    protocol-test.js  end-to-end test against a spawned relay
  start.bat / agent.vbs   launchers (visible / hidden)
  config.json             created by `pair` — contains the device token
  screenshots/            PNG screenshots requested during sessions
```

## Testing

With the relay one directory up:

```bat
node test\protocol-test.js
```

The test spawns its own relay instance (`node ../relay/src/server.js`) on a
random port with a temporary data directory, then drives the full flow:
register + login → pairing request → agent claim → heartbeat → device list →
session start/accept → offer/answer/ICE both directions → session end →
malformed-message handling. It prints PASS/FAIL per step and exits non-zero
on failure. It never touches your real `config.json`.
