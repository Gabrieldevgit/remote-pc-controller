# Security Notes

## Blink secret key — rotation no longer blocks this repo

The legacy Blink backend was removed entirely (code, dependency and the
committed keys). `src/lib/blink.ts`, the `.env.local` copy of the secret and
the legacy Profile fallback no longer exist in the current tree.

If this archive was ever shared, the previously embedded secret
(`blnk_sk_eous0gap_…`) should still be treated as compromised: revoke/rotate
it in the Blink dashboard for project `remote-pc-control-eous0gap` if that
project is still active.

## Current credential handling

- The app authenticates only against the self-hosted relay (`/api/register`,
  `/api/login`, JWT over the WebSocket). No third-party BaaS remains.
- The relay server generates its own JWT signing secret at first start
  (`relay/data/secret.key`, mode 0600) or accepts `RELAY_JWT_SECRET` from the
  environment.
- Device tokens are issued once during pairing and stored only as SHA-256
  hashes in the relay's JSON store; the agent keeps its token in
  `agent/config.json`, which is excluded from git.
- The Android release keystore (`android/app/release.keystore`) is personal to
  this machine; its credentials live in `android/keystore.properties`
  (git-ignored). Regenerate both before any public distribution.

## General notes

- All inbound relay and data-channel messages are shape-validated; unknown
  types are ignored and nothing is dynamically evaluated.
- Input injection, power actions and process killing happen only on explicit
  client requests inside an authenticated, owner-matched context.
- If you self-host the relay, put it behind TLS (`RELAY_TLS_CERT` /
  `RELAY_TLS_KEY`) before exposing it beyond localhost.
