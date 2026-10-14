# Sundial Sync server

One small program, one SQLite file. It stores your Sundial documents **encrypted on your devices before they are
sent**; the server never sees a task, a note or a color name, only ciphertext, document ids and timestamps.
Protocol: [`docs/SYNC-PROTOCOL.md`](../docs/SYNC-PROTOCOL.md). License: AGPL-3.0.

## Run your own (self-hosted mode)

```bash
SUNDIAL_TOKENS="pick-a-long-random-secret" SUNDIAL_BIND=0.0.0.0:8768 ./sundial-sync
```

Then in Sundial: Settings → Data & sync → **My own server** → URL + that token → Connect → choose a passphrase.
Every token is its own account, so a household can share one server with one token per person.

Environment:

| variable          | default                     | meaning                                                     |
|-------------------|-----------------------------|-------------------------------------------------------------|
| `SUNDIAL_TOKENS`  | (required in self mode)     | comma-separated tokens; each is an account                  |
| `SUNDIAL_BIND`    | `127.0.0.1:8768`            | address to listen on (`0.0.0.0:8768` to accept remote)      |
| `SUNDIAL_DB`      | `sundial-sync.sqlite`       | database path (back this file up)                           |
| `SUNDIAL_MODE`    | `self`                      | `hosted` turns on email sign-in                             |
| `RESEND_API_KEY`  | unset                       | hosted mode: send codes through Resend; unset = print to log |
| `SUNDIAL_FROM`    | `Sundial <sign-in@…>`       | hosted mode: sender address                                 |
| `RUST_LOG`        | `info`                      | log level                                                   |

Put it behind HTTPS (Caddy does this in two lines). The app refuses nothing over plain HTTP, but your sync
token travels in the header, so use TLS for anything beyond your own LAN.

Docker:

```bash
docker run -d --name sundial-sync -p 8768:8768 -v sundial:/data \
  -e SUNDIAL_TOKENS="pick-a-long-random-secret" -e SUNDIAL_BIND=0.0.0.0:8768 -e SUNDIAL_DB=/data/sundial-sync.sqlite \
  ghcr.io/zphat/sundial-sync:latest
```

## Build

```bash
cd server && cargo build --release      # → target/release/sundial-sync
```

`reference/sync_server.py` is a standard-library Python implementation of the same protocol, used for tests;
either server works with the app.

## Backups

The whole state is the SQLite file. Copy it while the server runs with `sqlite3 sundial-sync.sqlite ".backup copy.sqlite"`.
Logs never contain request bodies, and IP addresses are truncated.
