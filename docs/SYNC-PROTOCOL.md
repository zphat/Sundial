# Sundial Sync Protocol, version 1

The rules every Sundial client (desktop, web, mobile) and every sync server (hosted or self-hosted) follow.
Short version: the server is a dumb, encrypted mailbox of documents. It never sees a task.

## Principles

- **Local-first.** Every client works fully offline. Sync is an exchange of documents, never a dependency.
- **End-to-end encrypted.** Each document is encrypted on the device with a key the server never has.
  The server stores ciphertext, a document id, a kind, a timestamp and a sequence number. That is all it knows.
- **Last writer wins per document.** The client's `updated_at` (milliseconds since the epoch) decides between two
  versions of the same document. Deleted documents are kept as tombstones so a deletion beats a stale edit.
- **Version-tolerant.** Every request carries `protocol: 1`. Servers keep accepting the previous protocol
  version for at least a year after a new one ships, because app stores deliver updates late.

## Documents

| kind       | id                | plaintext                                      |
|------------|-------------------|------------------------------------------------|
| `task`     | task id           | the task object (title, date, time, …)         |
| `note`     | `YYYY-MM-DD`      | `{html}`                                       |
| `labels`   | `labels`          | the six color names                            |
| `routines` | `routines`        | the routines array                             |
| `keycheck` | `keycheck`        | `{"ok":true,"account":"<account id>"}`         |

Settings are per device and are not synced. The `keycheck` document lets a new device confirm the passphrase
before touching anything.

Wire shape of a document (push and pull are identical):

```json
{ "id": "…", "kind": "task", "updated_at": 1791900000000, "deleted": false, "nonce": "<base64 12 bytes>", "ct": "<base64>" }
```

A tombstone is `deleted: true` with an empty `ct`. Documents are at most 64 KB of ciphertext.

## Encryption

- Key: AES-256-GCM. Derived on the device from the user's passphrase with PBKDF2-HMAC-SHA256, 600 000 iterations,
  and a 32-byte per-account salt the server hands out at sign-in (the salt is random and public).
- Each document: fresh random 12-byte nonce; additional authenticated data (AAD) is the UTF-8 string `kind:id`,
  so a ciphertext cannot be moved to a different document.
- The derived key is kept on the device (OS credential store on desktop; browser storage on the web, with a warning).
  The passphrase itself is never stored or sent.
- Losing the passphrase loses the ability to read the synced copy. Local data on existing devices is untouched.
  The UI says this in plain words when the passphrase is set.

## Endpoints

All bodies are JSON. Authentication is `Authorization: Bearer <token>`.

### `GET /v1/health`
→ `{ "ok": true, "version": "…", "mode": "hosted" | "self", "protocol": 1 }`

### Sign-in (hosted mode)
- `POST /v1/auth/request` `{ "email": "…" }` → `204`. The server emails a 6-digit code and a magic link
  carrying the same code. Always `204`, whether or not the address is known.
- `POST /v1/auth/verify` `{ "email": "…", "code": "482913", "device": { "id": "…", "name": "…", "platform": "…" } }`
  → `{ "token": "…", "account_id": "…", "salt": "<base64 32 bytes>" }`. Codes expire after 10 minutes; five wrong tries
  invalidate the code.

### Self-hosted mode
The operator configures one or more tokens. There is no email step. `GET /v1/account` with the token
→ `{ "account_id": "…", "salt": "…" }` (the salt is created on first use and kept).

### `POST /v1/sync`
```json
{ "protocol": 1, "device_id": "…", "cursor": 1234, "docs": [ …documents to push… ] }
```
→
```json
{ "protocol": 1, "cursor": 1290, "docs": [ …documents with seq > request cursor, not pushed by this device in this call… ], "more": false }
```
Server rules for each pushed document: if there is no stored version, or the pushed `updated_at` is greater than or
equal to the stored one, store it and give it a new sequence number. Otherwise ignore it; the stored version will
come back in the pull and the client converges. At most 500 documents are returned per call; `more: true` means
call again with the new cursor. The cursor is per account, monotonically increasing, assigned by the server.

### `DELETE /v1/account`
Deletes the account and every document. Hosted mode requires a fresh sign-in code in the body.

## Client behaviour

- Every local mutation marks the affected document ids dirty. Dirty ids survive restarts.
- Sync runs: 2 s after the last edit, on launch, every 5 minutes, and when the network returns.
  One sync in flight at a time; a sync requested while one runs is queued once.
- Push: encrypt every dirty document, send them with the current cursor. On success, clear the dirty marks that were
  set before the request started (edits made during the request stay dirty).
- Pull: decrypt each returned document and apply: a task replaces the local one if its `updated_at` is newer;
  a tombstone removes the local task if the local `updated_at` is not newer and records the tombstone; notes,
  labels and routines compare their own timestamps. Applying never marks anything dirty.
- Clocks: `updated_at` comes from device clocks. A device whose clock is badly ahead "wins" edits it should not;
  clients therefore cap their own `updated_at` at `max(now, last seen server time)` and the server rejects
  documents more than 24 hours in the future.

## Operator notes

- Storage per account is a handful of kilobytes per task; a busy year is well under 10 MB.
- Rate limits: 60 sync calls per minute per token; 5 sign-in code requests per hour per address.
- Backups are the operator's job; the database is a single SQLite file, copy it while the server runs
  (`VACUUM INTO` or `sqlite3 .backup`).
- Logs keep no request bodies and truncate IP addresses to /24 (IPv4) or /48 (IPv6).
