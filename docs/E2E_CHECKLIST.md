# End-to-End Manual Test Checklist

A step-by-step script for verifying the full system on one Windows PC and one
Android/iOS phone on the same network (or via TURN over the internet). Run the
automated suites first — all three must pass before starting here:

```
node relay/test/smoke.js          # 31/31 steps
node agent/test/protocol-test.js  # 14/14 steps
cd remote-pc-controller-main-src && npm run tsc
```

**Setup:** relay and agent on the Windows PC; phone app installed (dev build).
Note the PC's LAN IP (e.g. `192.168.1.10`).

---

## 1. Start the relay

```bat
cd relay
set RELAY_JWT_SECRET=any-long-random-hex   (optional; otherwise auto-generated)
node src\server.js
```

**Expected:** log line `listening on ws://0.0.0.0:8080 (data: …\db.json)`.
`http://<pc-ip>:8080/api/health` returns `{"ok":true,…}` from the phone's
browser.

## 2. Create an account (phone)

1. Open the app → **Profile** tab → set the relay URL to `http://<pc-ip>:8080`.
2. Register an email + password (8+ chars), then sign in.

**Expected:** Profile shows the signed-in email; the relay logs
`user registered` and `user … authenticated`. Settings → relay test reports
"Reachable".

## 3. Pair the agent

1. Phone: **Devices** tab → **+ Add device** → a 6-digit code appears
   (valid 5 minutes).
2. PC:

   ```bat
   cd agent
   node src\index.js pair
   ```

   Enter the 6-digit code when prompted (accept the default device name).

**Expected:** agent prints `paired successfully as "…" (device <id>)` and
stays connected (`connected and serving sessions`). The device appears in the
phone's device list with a green **Online** dot within a few seconds. The
relay logs `device … paired for user …`.

**Negative check:** enter a wrong code 5 times against a fresh code → the
code is burned and the app must request a new one. Restart the relay and
confirm previously burned codes stay burned (failure counts are persisted).

## 4. Start a session (stream)

1. Phone: tap the online device card.

**Expected:** phase overlay walks *Starting → Waiting → Negotiating →*
connected; the PC's screen appears as live video (1–3 s). The relay logs
`session … requested`; the agent logs `session …: answered offer (native
mode)` (or `jpeg mode` if `@roamhq/wrtc` is not installed). The stats overlay
(RTT/fps/bitrate) shows plausible numbers.

## 5. Trackpad input

With the trackpad panel visible (bottom of the session screen):

| Gesture | Expected on the PC |
|---|---|
| One-finger drag | Pointer moves relative to the drag, ~1.4× sensitivity |
| Single tap | Left click |
| Two-finger tap | Right click (context menu opens) |
| Two-finger drag | Scroll follows the drag direction |
| Long-press + drag | Text/selection drag (button held while moving) |

**Expected:** every gesture maps to the matching `pointer.move` / `click` /
`button` / `wheel` data-channel message (visible in agent logs at debug, or
just observed on screen). No disconnects.

## 6. Direct-touch mode + keyboard

1. Toolbar 🖱 button → direct mode: taps click where you touch; a pan drags.
2. Toolbar ⌨ button → keyboard bar: type text and submit; try Esc, Tab,
   arrows, Enter, and the sticky Ctrl/Alt/Shift/Win modifiers.

**Expected:** taps land at the touched position (`pointer.abs` + `click`);
typed text appears in the focused Windows field (`text`); special keys fire
(`key` with KeyboardEvent.code values, e.g. `Escape`, `ArrowUp`).

## 7. Clipboard sync

1. On the PC: copy some text (Ctrl+C anywhere).
2. Phone: wait ~2 s, then toolbar 📋 long-press → **pull remote**.

**Expected:** a toast shows the PC's clipboard text; **Copy** puts it on the
phone. Reverse: copy text on the phone → it appears on the PC clipboard
within ~2 s (pushed on connect and on change). Agent replies to
`clipboard.get` with `clipboard.set` (see `docs/DATA_CHANNEL.md`).

## 8. Quick actions (`device.command`) — no session needed

1. End the session (✕). The device must still be **Online**.
2. Device card → **▸ Quick actions**:
   - **Lock** → PC locks immediately.
   - **Vol Up / Vol Down / Mute** → volume changes / mute toggles.
   - **Find Me** → PC beeps three times.
3. **Shutdown / Restart / Hibernate** → confirmation dialog first, then the
   action runs.

**Expected:** a green toast "… sent to …" on success; a red toast with the
reason on failure (e.g. "… is offline" when the agent is stopped). The relay
logs `device.command … queued for device …`. Unknown command names are
rejected by the relay with `unknown_command` (never forwarded).

## 9. Session-scoped system actions (optional)

Inside a session these exercise the data-channel system messages:
`screenshot.request` (writes `agent/screenshots/screenshot-*.png`),
`system.processes`, `system.kill`, `system.info`.

**Expected:** agent logs the request and replies with the matching
`*.result` message; no crash on unsupported actions (clear `error` reply
instead).

## 10. Reconnection & teardown

1. Kill the agent (Ctrl+C) while the device list is open.

**Expected:** the device flips to **Offline** within ~45 s; any open session
ends with `device_disconnected`.

2. Restart the agent (`node src\index.js run`).

**Expected:** it re-authenticates with the saved token and flips back to
**Online** automatically.

3. Delete the device (long-press → Delete).

**Expected:** the agent socket closes with code `4001` and the agent logs
`device was deleted on the relay (close 4001) — re-pair required`.

---

## Pass criteria

Every numbered section behaves as described with no crashes on any of the
three components. Any failure: capture the relay log line, the agent log
line, and the on-screen error before investigating.
