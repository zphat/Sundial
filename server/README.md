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

The token list is read when the server starts:

- Taking a token out of `SUNDIAL_TOKENS` and restarting revokes it. Its account and documents stay in the database,
  and listing the token again gives them back.
- "Erase synced copy" in the app empties the token's account, and the same token keeps working (before 0.1.14 it
  answered 401 until the next restart). Signing out in the app does not stop a static token from working.
- Before 0.1.14 an account was named after the first 8 characters of its token, so tokens that start alike
  (`sundial-alice-…`, `sundial-bob-…`) opened one shared account. From 0.1.14 a new token gets an id made from its
  hash and never shares. Accounts that were already merged stay merged: the server cannot tell whose document is
  whose. To separate people, give all but one of them a new token; each new token opens a new, empty account.
  One thing to know on a database from before 0.1.14: an old account that no token opens any more goes to the next
  new token that starts with the same 8 characters. List the removed token again before you add a similar one, if
  that account should stay with it.

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
| `SUNDIAL_APP_URL` | `https://app.sundial.services` | base of the code page's "Open in the browser" button (`/?code=`); set it empty to hide the button |
| `RUST_LOG`        | `info`                      | log level                                                   |

Put it behind HTTPS (Caddy does this in two lines). The app refuses nothing over plain HTTP, but your sync
token travels in the header, so use TLS for anything beyond your own LAN.
The proxy matters for a second reason: the server limits request sizes and gives every request 60 seconds once its
headers have arrived, but it does not time out a connection that never finishes sending its headers. Caddy and
nginx do. Do not expose port 8768 to the internet directly.

To use the web app at https://app.sundial.services with your own server, set `SUNDIAL_ORIGINS=https://app.sundial.services`
(comma-separate more origins); the browser only talks to an https server, so plain HTTP will not work from the web app.

Docker: no image is published, build it yourself from the repository root.

```bash
docker build -t sundial-sync server/
docker run -d --name sundial-sync -p 8768:8768 -v sundial:/data \
  -e SUNDIAL_TOKENS="pick-a-long-random-secret" sundial-sync
```

The image listens on `0.0.0.0:8768`, keeps its database in `/data/sundial-sync.sqlite` and runs as user 10001. A
named volume like the one above is writable from the start. If you mount a host folder on `/data` instead, run
`chown 10001 <folder>` first.

Limits on requests, in both modes: a body may be 8 MB on `/v1/sync` and 4 KB everywhere else (`413` above that),
and `/v1/sync` only keeps a body for a token it knows. A request that is not answered 60 seconds after its headers
arrived gets `408` and its connection is closed; a held `/v1/sync` request takes 25 seconds at most.

## Hosted mode (email sign-in)

`SUNDIAL_MODE=hosted` turns on sign-in codes by email through Resend. This is how sync.sundial.services runs: the
binary bound to `127.0.0.1:8768`, Caddy in front for TLS. What hosted mode adds, as of 0.1.3:

- **Limits on sign-in emails.** Code requests: 5 per hour and 20 per day per client address, 5 per hour per email
  address, 80 per day in total (Resend's free plan allows 100). The client's own limits are checked first, so a
  client that is over them cannot use up someone else's address. Over a limit the app gets
  `503 "too many sign-in emails from here right now, try again later"`; when Resend refuses or does not answer within
  10 seconds it gets `503 "email could not be sent right now, try again in a few minutes"`. Neither is a false
  "code sent".
  Asking again while a code is still valid re-sends the same code. Once an address has had its 5 emails for the hour,
  another request while that code is still valid gives the code 10 more minutes and answers as sent, without a new
  email; the person already holds the code.
  A send that fails counts against none of these limits, so an outage at Resend does not use up anyone's allowance.
  Failed or not, one client address gets 30 tries per hour.
- **Guessing protection.** A wrong code is counted only while a code for that address is valid. 10 wrong codes from
  one network (the /24 of an IPv4 address, the /48 of an IPv6 one) lock that network out of that address for 24
  hours, so someone sending junk codes for an address does not keep its owner out. 50 wrong codes for one address
  from all networks together lock the address for 24 hours (kept in the database, so a restart does not clear it).
  Verify calls are capped at 30 per hour per client address.
- **Client address.** Taken from the first `X-Forwarded-For` value, but only when the connection comes from localhost
  or a private address, i.e. from your proxy; from anywhere else the peer address is used, so the header cannot be
  spoofed on a server bound to a public address. Caddy with default settings replaces incoming `X-Forwarded-For` with
  the real client address. If another proxy sits in front of Caddy, set Caddy's `trusted_proxies`, or every client
  looks like that proxy and the per-address limits hit everyone at once.
- **Account deletion** needs the bearer token plus a fresh sign-in code in the body (`{"code":"123456"}`), so a token
  alone cannot wipe someone's synced copy. `POST /v1/auth/logout` forgets a token on sign-out (a static token from
  `SUNDIAL_TOKENS` is left alone).
- **Tokens are stored hashed** (SHA-256). A database from before 0.1.3 still holds plaintext tokens; each is rewritten
  to its hash the first time it is used (static `SUNDIAL_TOKENS` at startup).

Every counter except the 24-hour lock on an address lives in memory, so a restart clears it.

## Build

```bash
cd server && cargo build --release      # → target/release/sundial-sync
```

`reference/sync_server.py` is a standard-library Python implementation of the same protocol, used for tests;
either server works with the app. The Python one has no rate limits and no request timeout (only a 24-hour lock after ten wrong codes for an address) and no email provider.

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
        output file /var/log/caddy/access.log {
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
                request>headers delete
            }
        }
    }
}
```

`request>headers delete` drops every request header (user agent, language, client hints, cookies, Authorization),
so an entry is the time, method, host, path, protocol, status, size, duration and the masked address, which is
what PRIVACY.md says. The hosted box uses the same filter from the `privlog` snippet in `ops/web/Caddyfile`.

Caddy redacts `Authorization` headers unless `log_credentials` is turned on; leave it off.
