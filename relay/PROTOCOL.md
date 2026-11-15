# Relay Protocol

This document is the contract between the **relay server**, the **mobile client**, and the **Windows agent**. It is the single source of truth for all communication. Message shapes are normative; if you change one side, change this file.

- Transport: WebSocket at path `/ws` (`ws://` in dev, `wss://` when TLS is configured).
- Encoding: every WebSocket **text frame** is one JSON object. No binary frames are used on the relay (WebRTC media goes peer-to-peer, never through the relay).
- Envelope: `{ "type": string, "payload": object, "id": number|string }`
  - `type` — message type (required).
  - `payload` — parameters (required; use `{}` when empty).
  - `id` — optional client-chosen correlation id. The server echoes it as `payload.replyTo` on the corresponding `ok`/`error` reply.
- Replies: every request-style message gets exactly one reply:
  - `{ "type": "ok", "payload": { "replyTo": <id>, ...result } }`
  - `{ "type": "error", "payload": { "replyTo": <id>|null, "code": string, "message": string } }`
- Events (server-initiated, no `replyTo`): `device.status`, `device.updated`, `device.deleted`, `session.request`, `session.accepted`, `session.ended`, `signal.offer`, `signal.answer`, `signal.ice`, `device.command` (to devices), `pong`.

Message size limit: 1 MiB per frame. SDP strings are capped at 64 KiB.

## Roles and connection states

A WebSocket connection starts in state `pending`. It becomes one of:

| State | How | What it may do |
|---|---|---|
| `user` | `auth.user` with a JWT (mobile client) | pairing, device management, session start, signaling |
| `agent` | `auth.agent` with a device token (Windows agent), or immediately after a successful `pairing.claim` | heartbeat, session accept/reject, signaling |

In `pending` state only `auth.user`, `auth.agent`, `pairing.claim`, and `ping` are accepted; anything else returns error `not_authenticated`.

---

## 1. Authentication

### 1.1 Account registration — `POST /api/register` (REST)

Request:

```json
{ "email": "alice@example.com", "password": "correct-horse-battery" }
```

Response `201`:

```json
{ "userId": "0b8f2c1e-6d4a-4f2e-9a3f-7c1b2d3e4f5a", "email": "alice@example.com" }
```

Errors: `400` `invalid_email` / `invalid_password` (8–256 chars), `409` `email_taken`, `429` `rate_limited` (30 req/min/IP).

### 1.2 Login — `POST /api/login` (REST)

Request:

```json
{ "email": "alice@example.com", "password": "correct-horse-battery" }
```

Response `200`:

```json
{
  "token": "<JWT>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "userId": "0b8f2c1e-6d4a-4f2e-9a3f-7c1b2d3e4f5a"
}
```

The JWT is HS256 with claims `sub` (userId), `iat`, `exp` (7 days). Errors: `401` `invalid_credentials`, `429` `rate_limited`.

### 1.3 User socket auth — `auth.user` (WS)

```json
{ "type": "auth.user", "payload": { "token": "<JWT>" }, "id": 1 }
```

Reply:

```json
{ "type": "ok", "payload": { "replyTo": 1, "userId": "0b8f2c1e-…" } }
```

Errors: `invalid_token`.

### 1.4 Agent socket auth — `auth.agent` (WS)

Used on every agent (re)connect with the persistent device token obtained at pairing.

```json
{
  "type": "auth.agent",
  "payload": {
    "deviceId": "8fdb7ce6-d96a-4e5f-…",
    "token": "<64-char hex device token>",
    "name": "Living Room PC",
    "os": "windows",
    "version": "1.0.0"
  },
  "id": 2
}
```

`name` / `os` / `version` are optional self-updates. Reply:

```json
{ "type": "ok", "payload": { "replyTo": 2, "deviceId": "8fdb7ce6-…", "name": "Living Room PC" } }
```

Errors: `invalid_device_token`. If another socket is already connected as the same device, the old socket is closed with code `4000` and its sessions are ended.

### 1.5 Liveness ping — `ping` (WS, any state)

```json
{ "type": "ping", "payload": {}, "id": 3 }
```

Reply: `{ "type": "pong", "payload": { "serverTime": 1769347200000 } }` (note: `pong` is an event, not an `ok` reply).

---

## 2. Pairing (6-digit one-time code)

### 2.1 Request a code — `pairing.request` (WS, user)

```json
{ "type": "pairing.request", "payload": {}, "id": 4 }
```

Reply:

```json
{
  "type": "ok",
  "payload": { "replyTo": 4, "code": "482913", "expiresAt": 1769347500000, "ttlMs": 300000 }
}
```

- The code is bound to the requesting user, is 6 digits, expires after **5 minutes**, and is **single-use**.
- A user can have at most 3 active codes; requesting more silently supersedes the oldest.
- Failed claims against a code string are counted (persisted in the relay's JSON store, so the counts survive restarts); after **5 failed claims** that code is burned (a live code with that value is invalidated). Additionally, `pairing.claim` is rate-limited to 10 attempts/min/IP (`rate_limited`).

### 2.2 Claim a code — `pairing.claim` (WS, unauthenticated agent)

```json
{
  "type": "pairing.claim",
  "payload": { "code": "482913", "name": "Living Room PC", "os": "windows", "version": "1.0.0" },
  "id": 5
}
```

Reply (the device token is returned **exactly once**, over the TLS/WSS channel; the server stores only its SHA-256 hash):

```json
{
  "type": "ok",
  "payload": {
    "replyTo": 5,
    "deviceId": "8fdb7ce6-d96a-4e5f-…",
    "token": "9f1c…(64 hex chars)",
    "name": "Living Room PC",
    "ownerUserId": "0b8f2c1e-…"
  }
}
```

The claiming socket is authenticated as this device immediately (it just proved possession of the token). The agent must persist `deviceId` + `token` locally. Errors: `invalid_code` (format), `invalid_or_expired_code`, `rate_limited`.

---

## 3. Device registry

### 3.1 Heartbeat — `heartbeat` (WS, agent)

Send every **15 seconds**. A device is considered offline when it has no live socket **or** its last heartbeat is older than **45 seconds**.

```json
{ "type": "heartbeat", "payload": {}, "id": 6 }
```

Reply:

```json
{ "type": "ok", "payload": { "replyTo": 6, "serverTime": 1769347200000 } }
```

### 3.2 List devices — `device.list` (WS, user)

```json
{ "type": "device.list", "payload": {}, "id": 7 }
```

Reply:

```json
{
  "type": "ok",
  "payload": {
    "replyTo": 7,
    "devices": [
      {
        "id": "8fdb7ce6-d96a-4e5f-…",
        "name": "Living Room PC",
        "os": "windows",
        "online": true,
        "lastSeen": 1769347195000,
        "version": "1.0.1",
        "createdAt": 1769300000000
      }
    ]
  }
}
```

### 3.3 Rename — `device.update` (WS, user)

```json
{ "type": "device.update", "payload": { "deviceId": "8fdb7ce6-…", "name": "Media PC" }, "id": 8 }
```

Reply: `{ "type": "ok", "payload": { "replyTo": 8, "deviceId": "…", "name": "Media PC" } }`

Event broadcast to all of the owner's sockets:

```json
{ "type": "device.updated", "payload": { "deviceId": "8fdb7ce6-…", "name": "Media PC" } }
```

### 3.4 Delete — `device.delete` (WS, user)

```json
{ "type": "device.delete", "payload": { "deviceId": "8fdb7ce6-…" }, "id": 9 }
```

Reply: `{ "type": "ok", "payload": { "replyTo": 9, "deviceId": "8fdb7ce6-…" } }`

The device's token becomes invalid, its agent socket is closed with code `4001`, and its sessions are ended. Event to the owner's sockets:

```json
{ "type": "device.deleted", "payload": { "deviceId": "8fdb7ce6-…" } }
```

### 3.5 Online-status event — `device.status` (WS, unsolicited to owner)

Sent whenever a device's online status flips (connect, disconnect, heartbeat staleness):

```json
{ "type": "device.status", "payload": { "deviceId": "8fdb7ce6-…", "online": false, "lastSeen": 1769347195000, "reason": "agent_disconnected" } }
```

`reason` ∈ `agent_connected | agent_disconnected | paired | heartbeat | stale | device_deleted`.

---

## 4. Sessions and WebRTC signaling

### 4.1 Start a session — `session.start` (WS, user)

```json
{ "type": "session.start", "payload": { "deviceId": "8fdb7ce6-…" }, "id": 10 }
```

Reply (immediate ack; the request has been forwarded):

```json
{ "type": "ok", "payload": { "replyTo": 10, "sessionId": "476b9fee-182a-4a11-…" , "deviceId": "8fdb7ce6-…" } }
```

Event to the device:

```json
{ "type": "session.request", "payload": { "sessionId": "476b9fee-…", "deviceId": "8fdb7ce6-…" } }
```

The device is **pre-authorized by its token** — no local user confirmation is required. The reference agent must call `session.accept` immediately (it may `session.reject` with a reason, e.g. screen locked / capture unavailable).

Errors: `not_found` (unknown or not owned), `device_offline`.

### 4.2 Device accepts / rejects

```json
{ "type": "session.accept", "payload": { "sessionId": "476b9fee-…" } }
```

```json
{ "type": "session.reject", "payload": { "sessionId": "476b9fee-…", "reason": "capture_unavailable" } }
```

On accept, the client receives:

```json
{ "type": "session.accepted", "payload": { "sessionId": "476b9fee-…" } }
```

On reject, the client receives `{ "type": "session.ended", "payload": { "sessionId": "…", "reason": "capture_unavailable" } }`.

### 4.3 Signaling relay — `signal.offer` / `signal.answer` / `signal.ice`

Either participant sends; the relay forwards to the other participant of the session. Payloads are whitelisted — unknown fields are dropped.

Client → device (offer):

```json
{ "type": "signal.offer", "payload": { "sessionId": "476b9fee-…", "sdp": "v=0\r\n…" }, "id": 11 }
```

Device receives (unsolicited):

```json
{ "type": "signal.offer", "payload": { "sessionId": "476b9fee-…", "sdp": "v=0\r\n…" } }
```

Device → client (answer): identical shape with `type: "signal.answer"`.

ICE candidates (both directions):

```json
{
  "type": "signal.ice",
  "payload": {
    "sessionId": "476b9fee-…",
    "candidate": "candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host",
    "sdpMid": "0",
    "sdpMLineIndex": 0,
    "usernameFragment": "abcd"
  }
}
```

`sdpMid`, `sdpMLineIndex`, `usernameFragment` are optional for ICE. Errors: `not_found`, `forbidden` (not a participant), `peer_offline`, `bad_request` (missing `sdp`/`candidate`).

> Who sends the offer? Convention: the **mobile client** creates the offer (it is the viewer/answerer-side initiator), the device answers. Either side may send ICE candidates at any time during the session.

### 4.4 End a session — `session.end` (WS, either participant)

```json
{ "type": "session.end", "payload": { "sessionId": "476b9fee-…" } }
```

No reply is sent to the initiator; the other side receives:

```json
{ "type": "session.ended", "payload": { "sessionId": "476b9fee-…", "reason": "ended_by_peer" } }
```

Sessions are also ended automatically (with `reason` `client_disconnected`, `device_disconnected`, `device_reconnected`, or `device_deleted`) when a participant disconnects or the device is removed.

---

## 5. Device commands — `device.command` (WS, user)

Quick actions (lock, shutdown, volume, …) sent to a device **outside any
session**. The relay validates ownership and online status, whitelists the
command name, forwards the request to the device, and correlates the device's
result back to the user's original `id` — the user gets exactly one `ok` or
`error` reply, either when the device reports a result or when the relay's
30-second timeout expires.

Request (user → relay):

```json
{ "type": "device.command", "payload": { "deviceId": "8fdb7ce6-…", "command": "lock", "params": {} }, "id": 12 }
```

`params` is optional (default `{}`) and capped at 4 KiB of JSON.

Event forwarded to the device (no `replyTo` — the correlation is by `commandId`):

```json
{ "type": "device.command", "payload": { "commandId": "0d2f…", "command": "lock", "params": {} } }
```

The device executes the command and reports back (agent → relay, unsolicited):

```json
{ "type": "device.command.result", "payload": { "commandId": "0d2f…", "ok": true, "command": "lock", "result": {} } }
```

On failure: `{ "ok": false, "commandId": "…", "command": "…", "error": "human-readable reason" }`.

Reply to the user (correlated via `replyTo`):

```json
{ "type": "ok", "payload": { "replyTo": 12, "command": "lock", "result": {} } }
```

or `{ "type": "error", "payload": { "replyTo": 12, "code": "command_failed", "message": "…" } }`.

Errors: `not_found` (unknown or not owned), `device_offline`, `unknown_command` (not in the whitelist), `bad_request` (malformed `params`), `command_timeout` (no result within 30 s), `command_failed` (device reported failure).

### Command whitelist and result payloads

| Command | `params` | `result` |
|---|---|---|
| `lock`, `shutdown`, `restart`, `hibernate`, `logoff` | — | `{}` |
| `volume_up`, `volume_down` | `steps`? (integer 1–50, default 1) | `{ "steps": n }` |
| `mute` | — | `{}` |
| `beep` | — | `{}` |
| `screenshot` | `maxWidth`? (pixels, 0 = native) | `{ "path": "agent/screenshots/screenshot-….png" }` |
| `process_list` | — | `{ "processes": [{ "name", "pid", "memMB" }], "count": n }` |
| `process_kill` | `pid` (required, positive integer) | `{ "pid": n }` |
| `sysinfo` | — | `{ "info": { "hostname", "platform", "cpu", "memory", "uptimeSec", … } }` |

Power actions and process killing execute on the device immediately — clients
should confirm destructive commands (`shutdown`, `restart`, `hibernate`,
`logoff`, `process_kill`) in the UI before sending.

---

## 6. TURN / STUN configuration — `GET /api/turn` (REST, Bearer JWT)

```json
{
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "…" }
  ],
  "iceTransportPolicy": "all"
}
```

The TURN entry is present only when `RELAY_TURN_URL` is configured. Feed `iceServers` directly into `RTCPeerConnection`.

---

## 7. Error codes

| `code` | Meaning |
|---|---|
| `bad_json` | frame was not valid JSON |
| `bad_message` | envelope malformed (missing/invalid `type` or `payload`) |
| `unknown_type` | message type not recognized |
| `not_authenticated` | socket still in `pending` state |
| `not_allowed` | message type not valid for this socket's state |
| `invalid_token` | JWT missing/invalid/expired |
| `invalid_device_token` | deviceId unknown or token mismatch |
| `invalid_code` | pairing code not 6 digits |
| `invalid_or_expired_code` | code unknown, expired, used, or burned |
| `rate_limited` | too many requests (pairing claims: 10/min/IP; REST auth: 30/min/IP) |
| `not_found` | device/session unknown or not owned by you |
| `device_offline` | device has no live heartbeat |
| `forbidden` | not a participant in the session |
| `peer_offline` | signaling peer disconnected |
| `bad_request` | required payload field missing/invalid |
| `unknown_command` | `device.command` name not in the whitelist |
| `command_timeout` | device did not report a `device.command.result` within 30 s |
| `command_failed` | device reported that the command failed |
| `internal_error` | server fault |

WebSocket close codes used by the server: `4000` (replaced by a newer agent connection), `4001` (device deleted), `1001` (server shutting down).

---

## 8. Reference flows

### Pairing

```
Mobile                          Relay                          Agent
  |-- pairing.request ----------->|                               |
  |<-- ok {code, expiresAt} ------|                               |
  |      (user types code)        |<-- pairing.claim {code,name} --|
  |                               |-- ok {deviceId, token} ------->|  (token saved; socket is now authed)
  |<-- device.status {online} ----|                               |
```

### Session + signaling

```
Mobile                          Relay                          Agent
  |-- session.start {deviceId} -->|                               |
  |<-- ok {sessionId} ------------|-- session.request {sessionId}->|
  |                               |<-- session.accept {sessionId} -|
  |<-- session.accepted ----------|                               |
  |-- signal.offer {sdp} -------->|-- signal.offer {sdp} --------->|
  |<-- signal.answer {sdp} -------|<-- signal.answer {sdp} --------|
  |-- signal.ice <-------------->|<--------------> signal.ice ----|
  |        (WebRTC media flows peer-to-peer; relay is out of path) |
  |-- session.end {sessionId} --->|--- session.ended ------------->|
```

### Device command

```
Mobile                          Relay                          Agent
  |-- device.command ------------>|                               |
  |   {deviceId, command, id}     |-- device.command ------------->|
  |                               |   {commandId, command, params} |
  |                               |   (executes; no session needed)|
  |                               |<-- device.command.result ------|
  |<-- ok {replyTo, result} ------|   {commandId, ok, result}      |
  |   (or error: command_failed / command_timeout)                |
```

---

## Appendix: data-channel protocol

The WebRTC data channel used inside a session (pointer/keyboard input,
clipboard sync, quality control, per-session system actions, JPEG framing in
degraded mode) is peer-to-peer and never touches the relay. Its binding
contract is [`../docs/DATA_CHANNEL.md`](../docs/DATA_CHANNEL.md).
