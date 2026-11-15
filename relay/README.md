# Relay Server

Self-hosted coordination server for the Remote PC Controller: account auth, device
pairing/registry with real online status, and WebRTC signaling between the mobile
client and a Windows agent. Original implementation — Node.js + `ws` only, no
database, no third-party services.

See [`PROTOCOL.md`](./PROTOCOL.md) for the complete message contract.

## Requirements

- Node.js 20+ (developed and tested on Node 24)
- One dependency: `ws`

## Run

```bash
cd relay
npm install
npm start          # node src/server.js
# or, for auto-reload during development:
npm run dev        # node --watch src/server.js
```

The server listens on `ws://0.0.0.0:8080` (HTTP) by default. REST endpoints:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/register` | — | create account (email + password) |
| `POST /api/login` | — | get a JWT (7-day expiry) |
| `GET /api/turn` | Bearer JWT | STUN/TURN ice-server config |
| `GET /api/health` | — | liveness probe |

Everything else happens over the WebSocket at `/ws` — see the protocol doc.

## Smoke test

```bash
node test/smoke.js        # from the repo root
# or: npm test            # from relay/
```

Spins the server on a random port with a throwaway data directory and exercises
register → login → pairing → agent claim → heartbeat → device list → signaling,
printing PASS/FAIL per step.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP(S) listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `RELAY_DATA_DIR` | `relay/data` | Where `db.json` and `secret.key` live |
| `RELAY_JWT_SECRET` | auto-generated | HS256 secret. **Set this in production** (any 64-hex-char string); otherwise a random secret is generated and persisted to `data/secret.key` on first run. |
| `RELAY_TLS_CERT` | — | Path to a PEM certificate. Set together with `RELAY_TLS_KEY` to serve `wss://` / HTTPS. |
| `RELAY_TLS_KEY` | — | Path to the PEM private key. |
| `RELAY_STUN_URLS` | Google STUN ×2 | Comma-separated STUN URLs returned by `/api/turn`. |
| `RELAY_TURN_URL` | — | e.g. `turn:turn.example.com:3478`. When set, a TURN entry is included in `/api/turn`. |
| `RELAY_TURN_USERNAME` | — | TURN username (static credential auth). |
| `RELAY_TURN_CREDENTIAL` | — | TURN password. |

## Data & persistence

All state lives in `relay/data/db.json` (users with scrypt password hashes, devices
with **hashed** device tokens, pairing codes). Writes are atomic (tmp file +
rename) and debounced. `relay/data/` is gitignored — back it up if you care about
accounts; delete it to reset the server. `secret.key` holds the JWT signing
secret; losing it invalidates all outstanding tokens (users just log in again).

## Security notes

- Passwords: scrypt (N=16384, r=8, p=1) with per-user random salt; login verifies
  against a dummy hash for unknown users to flatten timing.
- JWTs: HS256, 7-day expiry, signature compared with `timingSafeEqual`, `alg`
  confusion rejected.
- Device tokens: random 32-byte hex, issued once at pairing, stored only as
  SHA-256 hashes, compared in constant time. Never logged.
- Pairing: 6-digit code, 5-minute expiry, single-use, burned after 5 failed
  claims, plus a 10/min/IP rate limit on claims and 30/min/IP on auth endpoints.
- Tokens/secrets are never written to logs; logs contain only ids and event types.

## Deploy behind a reverse proxy

The relay speaks plain HTTP/WS when TLS is terminated upstream (recommended), or
terminates TLS itself via `RELAY_TLS_CERT`/`RELAY_TLS_KEY`.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    # REST
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;          # keep idle WS connections alive
        proxy_send_timeout 300s;
    }
}
```

### Caddy

```caddy
relay.example.com {
    reverse_proxy /ws* 127.0.0.1:8080     # websockets are proxied automatically
    reverse_proxy /api/* 127.0.0.1:8080
}
```

Run the relay under a process manager (systemd unit, `pm2`, etc.). Example systemd unit:

```ini
[Unit]
Description=Remote PC Controller relay
After=network-online.target

[Service]
WorkingDirectory=/opt/relay
ExecStart=/usr/bin/node src/server.js
Environment=PORT=8080
Environment=RELAY_JWT_SECRET=change-me-to-64-hex-chars
Restart=on-failure
User=relay
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/relay/data

[Install]
WantedBy=multi-user.target
```

## Optional TURN server (coturn)

WebRTC works peer-to-peer on most networks via STUN alone. If a client or agent
sits behind a symmetric NAT, add a TURN server and point `RELAY_TURN_URL` at it.

Install and configure [coturn](https://github.com/coturn/coturn):

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
# Long-term credential mechanism with a static user for the relay to hand out:
lt-cred-mech
user=relayuser:some-long-password
realm=relay.example.com
# Limit relayed bandwidth if desired; cert for TURN/TLS (optional):
# cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
# pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
# Allow only RFC1918 peers and refuse to relay to localhost (anti-abuse):
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=127.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
no-multicast-peers
```

Open firewall ports `3478/udp+tcp` and the relay port range (`min-port`/`max-port`,
default 49152–65535/udp). Then run the relay with:

```bash
RELAY_TURN_URL=turn:turn.example.com:3478 \
RELAY_TURN_USERNAME=relayuser \
RELAY_TURN_CREDENTIAL=some-long-password \
node src/server.js
```

For one-off short-lived credentials you can front coturn with the REST API
(`turn/credentials` mechanism); the static-credential setup above is the simplest
correct starting point.

## Layout

```
relay/
├── package.json
├── PROTOCOL.md      # message contract (agent + mobile build against this)
├── README.md
├── .gitignore       # excludes data/ and node_modules/
├── src/
│   ├── server.js    # HTTP/WS server, routing, registry, signaling
│   ├── auth.js      # scrypt, HS256 JWT, constant-time helpers
│   └── store.js     # atomic JSON file store
├── test/
│   └── smoke.js     # end-to-end smoke test
└── data/            # created at runtime; gitignored
```
