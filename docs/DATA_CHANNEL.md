# Data-Channel Protocol

This document is the binding contract for the WebRTC data channel used during
a remote session. It is peer-to-peer between the **mobile client** and the
**Windows agent** — the relay is never in the path. The relay WebSocket
protocol (pairing, registry, signaling, `device.command`) is defined in
[`relay/PROTOCOL.md`](../relay/PROTOCOL.md).

Client-side reference implementation: `remote-pc-controller-main-src/src/lib/inputProtocol.ts`.
Agent-side reference implementation: `agent/src/session.js`.

## Envelope

- Transport: one WebRTC data channel labeled **`input`**, negotiated by the
  client inside its offer (`createDataChannel('input', {ordered: true})`),
  carrying ordered, reliable **text** frames.
- Encoding: every frame is one JSON object: `{ "t": "<kind>", ...fields }`.
  The kind discriminator field is **`t`**. (The agent also tolerates `type` as
  an alias from legacy clients, but `t` is canonical.)
- Direction: messages flow client → agent unless noted. Agent → client
  messages are replies or server-initiated pushes.
- Errors: a failed request is answered with
  `{ "t": "error", "request": "<kind>", "message": "…" }` (message ≤ 300 chars).
- Unknown kinds are logged and ignored by the agent; nothing is ever `eval`'d
  and all inbound fields are validated. Malformed JSON is dropped.
- Binary frames from the client are ignored. The only agent → client binary
  frames are JPEG frame chunks in degraded mode (see framing below).

## 1. Input — client → agent

### 1.1 Pointer

| Message | Fields | Effect |
|---|---|---|
| `pointer.move` | `dx`, `dy` (numbers) | Relative pointer movement in on-screen pixels |
| `pointer.abs` | `x`, `y` (0..1) | Absolute pointer position, normalized against the remote screen |
| `click` | `button`: `left`\|`right`\|`middle`; optional `x`, `y` (0..1) | Click; when `x`/`y` are present the pointer moves there first |
| `button` | `button`: `left`\|`right`\|`middle`; `down`: boolean | Press or release a mouse button (used for drag) |
| `wheel` | `dx`, `dy` (numbers) | Scroll in wheel notches; positive `dy` scrolls up, positive `dx` scrolls right |

Coordinates are normalized to the streamed frame (0..1 on both axes).

### 1.2 Keyboard

| Message | Fields | Effect |
|---|---|---|
| `key` | `code` (see below), `down`: boolean, optional `modifiers`: array | Press (`down: true`) or release (`down: false`) a key, with optional modifiers held |
| `text` | `text` (string) | Inject Unicode text (keyboard bar text field) |

A "tap" is expressed as a `key` pair: `{down: true}` followed by `{down: false}`.

**Key codes.** `key.code` is a Web [KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code)
value. Both sides map from this single list — the agent resolves each code to
a Windows virtual-key code. The supported set:

- Letters / digits: `KeyA`–`KeyZ`, `Digit0`–`Digit9`
- Function keys: `F1`–`F24`
- Navigation: `Escape`, `Enter`, `NumpadEnter`, `Tab`, `Backspace`, `Delete`,
  `Insert`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, `ArrowLeft`,
  `ArrowUp`, `ArrowRight`, `ArrowDown`
- Modifiers (usable as `code` and as `modifiers` entries): `ControlLeft`,
  `ControlRight`, `AltLeft`, `AltRight`, `ShiftLeft`, `ShiftRight`,
  `MetaLeft`, `MetaRight`
- Locks / misc: `CapsLock`, `NumLock`, `ScrollLock`, `PrintScreen`, `Pause`,
  `ContextMenu`
- Punctuation: `Backquote`, `Minus`, `Equal`, `BracketLeft`, `BracketRight`,
  `Backslash`, `Semicolon`, `Quote`, `Comma`, `Period`, `Slash`
- Numpad: `Numpad0`–`Numpad9`, `NumpadAdd`, `NumpadSubtract`,
  `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal`, `NumpadEnter`

`modifiers` entries are `ctrl` | `alt` | `shift` | `meta` (canonical
`ModifierName` values; `win` is tolerated as an alias of `meta`).

### 1.3 Clipboard

| Message | Fields | Effect |
|---|---|---|
| `clipboard.get` | — | Ask for the remote clipboard; the agent replies with `clipboard.set` |
| `clipboard.set` | `text` (string) | Write text to the PC clipboard |

The agent also pushes `{ "t": "clipboard.set", "text": "…" }` unsolicited
(~every 1.5 s) while the channel is open whenever the PC clipboard changes,
and once immediately after the channel opens. Both directions use the same
message name; direction is implied by who sent the frame.

## 2. Agent → client

| Message | When | Fields |
|---|---|---|
| `clipboard.set` | Reply to `clipboard.get`, and on PC clipboard changes | `text` |
| `error` | A request failed | `request`, `message` |
| `quality.ack` | After a `quality.set` | `quality` `{level, width, fps, jpegQuality}`, `adaptive` (true while the agent steps presets from `stats.ping` RTT) |
| `stats.pong` | Reply to `stats.ping` | `seq` (echo), `now`, `mode`, `quality`, `sessions` |
| `screenshot.result` | Reply to `screenshot.request` | `ok`, `path` or `error` |
| `system.info.result` | Reply to `system.info` | `info` |
| `system.displays.result` | Reply to `system.displays` | `displays` |
| `system.processes.result` | Reply to `system.processes` | `processes`, `count` |
| `system.kill.result` | Reply to `system.kill` | `ok`, `pid`, `error?` |
| `system.power.result` | Reply to `system.power` | `ok`, `action`, `error?` |
| `system.beep.result` | Reply to `system.beep` | `ok` or `error` |

## 3. Agent-only extensions (client → agent)

These are implemented by the agent and available to any client; the current
mobile UI does not send all of them yet.

| Message | Fields | Effect |
|---|---|---|
| `quality.set` | `level`: `high`\|`medium`\|`low`\|`adaptive`, or `{level:"custom", width, fps, jpegQuality}` (width 160–3840, fps 1–60, quality 10–95) | Change streaming quality; replies `quality.ack` |
| `stats.ping` | optional `seq` (echoed back), optional `rttMs` (drives adaptive quality) | Reply `stats.pong` |
| `input.media` | `key`: `volume_up`, `volume_down`, `volume_mute`, `play_pause`, `next_track`, `prev_track`, `stop_media`, … | Media key |
| `input.ctrlaltdel` | — | Best-effort Ctrl+Alt+Del (Windows blocks SAS injection from user mode, so this usually reports an error) |
| `screenshot.request` | optional `maxWidth` | Save a PNG to `agent/screenshots/` |
| `system.info` / `system.displays` / `system.processes` | — | See replies above |
| `system.kill` | `pid` (positive integer) | Kill a process |
| `system.power` | `action`: `lock`\|`shutdown`\|`restart`\|`hibernate`\|`signout` | Power action |
| `system.beep` | — | Play the "find me" beep |

## 4. Binary JPEG framing (degraded mode only)

When the agent runs without a native WebRTC video track (`jpeg` mode), each
screen frame is sent as one or more binary data-channel messages:

```
offset 0  : uint8  type      = 0x01 (JPEG frame)
offset 1  : uint8  flags     ; bit0 = final chunk of this frame
offset 2  : uint16 sequence  ; little-endian, increments per frame
offset 4  : payload          ; ≤ 16 KiB of JPEG bytes
```

Concatenate the payloads of all chunks sharing a `sequence` until the final
flag is set; the result is one complete JPEG image at the frame's configured
width. In `native` mode this framing is unused — video arrives on the normal
WebRTC video track instead.
