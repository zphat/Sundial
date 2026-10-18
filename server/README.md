# Sundial Sync server

One small program, one SQLite file. It stores your Sundial documents **encrypted on your devices before they are
sent**; the server never sees a task, a note or a color name, only ciphertext, document ids and timestamps.
Protocol: [`docs/SYNC-PROTOCOL.md`](../docs/SYNC-PROTOCOL.md). License: AGPL-3.0.

## Run your own (self-hosted mode)

```bash
SUNDIAL_TOKENS="pick-a-long-random-secret" SUNDIAL_BIND=0.0.0.0:8768 ./sundial-sync
```

Then in Sundial: Settings → Data & sync → **My own server** → URL + that token → Connect. The app makes the key and shows a recovery code once.
Every token is its own account, so a household can share one server with one token per person.

Environment:

| variable          | default                     | meaning                                                     |
|-------------------|-----------------------------|-------------------------------------------------------------|
| `SUNDIAL_TOKENS`  | (required in self mode)     | comma-separated tokens; each is an account                  |
| `SUNDIAL_BIND`    | `127.0.0.1:8768`            | address to listen on (`0.0.0.0:8768` to accept remote)      |
| `SUNDIAL_DB`      | `sundial-sync.sqlite`       | database path (back this file up)                           |
| `SUNDIAL_MODE`    | `self`                      | `hosted` turns on email sign-in                             |
| `SUNDIAL_ORIGINS` | unset                       | extra browser origins allowed to call the API, comma-separated (the desktop app's own origins and `http://localhost` on ports 8767 and 8000 are always allowed; another port needs this variable) |
| `RESEND_API_KEY`  | unset                       | hosted mode: send codes through Resend; unset = print to log |
| `SUNDIAL_FROM`    | `Sundial <sign-in@…>`       | hosted mode: sender address                                 |
| `SUNDIAL_PUBLIC_URL` | `https://sync.sundial.services` | hosted mode: base of the email's button link (`GET /signin?code=`) |
| `RUST_LOG`        | `info`                      | log level                                                   |

Put it behind HTTPS (Caddy does this in two lines). The app refuses nothing over plain HTTP, but your sync
token travels in the header, so use TLS for anything beyond your own LAN.

Docker:

```bash
docker run -d --name sundial-sync -p 8768:8768 -v sundial:/data \
  -e SUNDIAL_TOKENS="pick-a-long-random-secret" -e SUNDIAL_BIND=0.0.0.0:8768 -e SUNDIAL_DB=/data/sundial-sync.sqlite \
  ghcr.io/zphat/sundial-sync:latest
```

## Hosted mode (email sign-in)

`SUNDIAL_MODE=hosted` turns on sign-in codes by email through Resend. This is how sync.sundial.services runs: the
binary bound to `127.0.0.1:8768`, Caddy in front for TLS. What hosted mode adds, as of 0.1.3:

- **Limits on sign-in emails.** Code requests: 5 per hour per address, 5 per hour and 20 per day per client address,
  80 per day in total (Resend's free plan allows 100). Over a limit, or when Resend refuses or does not answer within
  10 seconds, the app gets `503 "email could not be sent right now, try again in a few minutes"` instead of a false
  "code sent". Asking again while a code is still valid re-sends the same code.
- **Guessing protection.** 10 wrong codes lock an address for 24 hours (kept in the database, so a restart does not
  clear it); verify calls are capped at 30 per hour per client address.
- **Client address.** Taken from the first `X-Forwarded-For` value, but only when the connection comes from localhost
  or a private address, i.e. from your proxy; from anywhere else the peer address is used, so the header cannot be
  spoofed on a server bound to a public address. Caddy with default settings replaces incoming `X-Forwarded-For` with
  the real client address. If another proxy sits in front of Caddy, set Caddy's `trusted_proxies`, or every client
  looks like that proxy and the per-address limits hit everyone at once.
- **Account deletion** needs the bearer token plus a fresh sign-in code in the body (`{"code":"123456"}`), so a token
  alone cannot wipe someone's synced copy. `POST /v1/auth/logout` forgets a token on sign-out.
- **Tokens are stored hashed** (SHA-256). A database from before 0.1.3 still holds plaintext tokens; each is rewritten
  to its hash the first time it is used (static `SUNDIAL_TOKENS` at startup).

Every counter except the 24-hour lock lives in memory, so a restart clears it.

## Build

```bash
cd server && cargo build --release      # → target/release/sundial-sync
```

`reference/sync_server.py` is a standard-library Python implementation of the same protocol, used for tests;
either server works with the app. The Python one has no rate limits at all (only the 24-hour lock after ten wrong codes) and no email provider.

## Backups and restores

The whole state is the SQLite file. Copy it while the server runs with `sqlite3 sundial-sync.sqlite ".backup copy.sqlite"`,
and keep copies off the box too.

If you ever restore an older copy, bump the epoch once, so every client forgets its place in the server's history and
offers everything it has again:

```bash
sqlite3 sundial-sync.sqlite "UPDATE meta SET value=value+1 WHERE key='epoch'"
```

The server also returns its real sequence number when nothing is new, so the first sync after a restore already
corrects each client's cursor; the epoch bump is what makes clients re-upload the documents the backup is missing.

## Logs

The server's own log never contains request bodies or client addresses. It prints sign-in codes only when no
`RESEND_API_KEY` is set (development), and logs a refused code request without the address.

The reverse proxy's access log is a different matter. Caddy's default JSON log keeps the full client IP, the
timestamp and the request URI, and the email button opens `/signin?code=NNNNNN`, so the code lands in that log too.
For the hosted server, mask the address and drop the code in the Caddyfile (Caddy 2.7 or newer; run
`caddy validate --config /etc/caddy/Caddyfile` after editing):

```
sync.sundial.services {
    reverse_proxy 127.0.0.1:8768
    log {
        output file /var/log/caddy/sync.log {
            roll_keep_for 14d
        }
        format filter {
            wrap json
            fields {
                request>remote_ip ip_mask {
                    ipv4 24
                    ipv6 48
                }
                request>client_ip ip_mask {
                    ipv4 24
                    ipv6 48
                }
                request>uri query {
                    delete code
                }
            }
        }
    }
}
```

Caddy redacts `Authorization` headers unless `log_credentials` is turned on; leave it off.
