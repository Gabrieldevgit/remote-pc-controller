# Supabase backend

Project: `remote-pc-controller` — ref `hmhjlpxzuoyvxzqyfkqc`
(`https://hmhjlpxzuoyvxzqyfkqc.supabase.co`). The mobile app and the
Windows agent talk to it directly; no relay server is needed.

| Supabase feature | Used for |
|---|---|
| **Auth** | App accounts (email + password). Each paired PC gets its own restricted login (`device-<id>@devices.remote-pc.invalid`). |
| **Database** | `devices`, `remote_sessions`, `device_commands` (public, RLS) and `private.pairing_codes` / `private.pairing_failures` (not exposed). |
| **Realtime** | `postgres_changes` on the three public tables (live online status, session requests, command results) and private broadcast channels `session:<uuid>` for WebRTC offer / answer / ICE. |
| **Storage** | Private bucket `screenshots`, one folder per device (`<device_id>/<file>.png`). |
| **Edge Functions** | `pair-device` — exchanges a 6-digit code for a device login. |

Screen video and input never pass through Supabase: they flow peer-to-peer
over WebRTC (DTLS/SRTP).

## Flows

- **Pairing** — app calls `rpc('create_pairing_code')` (6 digits, 5 min, max
  3 live per user). The PC posts the code to `functions/v1/pair-device`,
  which burns it (`claim_pairing_code`, 10 failures / 10 min per IP), creates
  the device login and the `devices` row, and returns the login once.
- **Presence** — the agent calls `rpc('device_heartbeat')` every 20 s and
  `rpc('device_offline')` on shutdown. A device counts as online when
  `online` is true and `last_seen_at` is under 60 s old.
- **Session** — app inserts `remote_sessions` (device must be online). The
  agent sees the insert, joins `session:<id>`, and sets `state = accepted`.
  The app then joins the channel and sends the offer. Either side ends it by
  setting `state = ended`.
- **Quick actions** — app inserts `device_commands`; the agent marks it
  `running`, then `succeeded` / `failed` with `result`. Screenshots are
  uploaded to Storage and the row carries `result.storagePath`.
- **Removing a PC** — deleting the `devices` row also deletes its device
  login (trigger), so the agent is locked out immediately.

## Security model

- Clients only ever hold the **publishable** key. No `service_role` key is in
  the app, the agent or this repo (Edge Functions read it from their own env).
- RLS on every table; column-level grants limit what each role can change
  (owners may only rename devices; presence goes through `device_heartbeat`).
- Realtime broadcast topics are private and authorized by
  `private.can_use_session_topic()` — only the requester and the device's
  agent can join, and only while the session is open.

## Auth settings to review (dashboard)

- **Confirm email** is on by default: new accounts must click the emailed
  link before signing in (the app shows a "check your email" notice with a
  resend button). Turn it off under *Authentication → Sign In / Providers →
  Email* if you prefer instant sign-up.
- For real users, configure a custom SMTP provider — Supabase's built-in
  mailer is rate-limited and meant for testing.
- Optionally disable *Realtime → Settings → Allow public access* so only
  private channels can be used.

## Applying changes

```powershell
npx supabase link --project-ref hmhjlpxzuoyvxzqyfkqc
npx supabase db push
npx supabase functions deploy pair-device --no-verify-jwt
```

`migrations/20261114235000_remote_pc_backend.sql` and
`20261114235100_merge_session_update_policies.sql` are already applied to the
project. `migrations/20261028023437_remote_controller_core.sql` is an older
draft written for a different project; it was never applied here and
conflicts with the current schema — delete it before using `db push`.
