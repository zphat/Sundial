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
| `pair`     | `pair:<random>` and `pair:<random>:grant` | plaintext (see "Approving another PC"); `nonce` is empty |

Settings are per device and are not synced. The `keycheck` document lets a new device confirm the secret
before touching anything.

Wire shape of a document (push and pull are identical):

```json
{ "id": "…", "kind": "task", "updated_at": 1791900000000, "deleted": false, "nonce": "<base64 12 bytes>", "ct": "<base64>" }
```

A tombstone is `deleted: true` with an empty `ct`. Documents are at most 64 KB of ciphertext.

## Encryption

- Key: AES-256-GCM. Derived on the device from the account secret (the recovery code the app invents on the first PC, or a passphrase typed in older versions) with PBKDF2-HMAC-SHA256, 600 000 iterations,
  and a 32-byte per-account salt the server hands out at sign-in (the salt is random and public).
- Each document: fresh random 12-byte nonce; additional authenticated data (AAD) is the UTF-8 string `kind:id`,
  so a ciphertext cannot be moved to a different document.
- The derived key is kept on the device (OS credential store on desktop; browser storage on the web, with a warning).
  The secret itself is never sent; the first PC keeps the recovery code in the OS credential store so it can be shown again, and an approved PC receives it inside the handshake.
- Losing the secret, with no PC left that holds the key, loses the ability to read the synced copy. Local data on existing devices is untouched. The UI says this in plain words when the code is shown.

## Endpoints

All bodies are JSON. Authentication is `Authorization: Bearer <token>`. Errors are `{ "error": "…" }` with the
status codes listed below. The server keeps only a SHA-256 hash of each token, so a copy of its database signs
nobody in.

### `GET /v1/health`
→ `{ "ok": true, "version": "…", "mode": "hosted" | "self", "protocol": 1 }`

### Sign-in (hosted mode)
- `POST /v1/auth/request` `{ "email": "…" }` → `204`. The server emails a 6-digit code and a button link carrying
  the same code. A malformed address is `204` too: nothing is revealed about addresses. While a code for the address
  is still valid, asking again re-sends that same code, so the first email keeps working.
  → `503 { "error": "email could not be sent right now, try again in a few minutes" }` when a request limit is hit
  (5 per hour per address; 5 per hour and 20 per day per client address; 80 per day in total) or the email provider
  refuses or times out. Clients show that message instead of "code sent".
- `POST /v1/auth/verify` `{ "email": "…", "code": "482913", "device": { "id": "…", "name": "…", "platform": "…" } }`
  → `{ "token": "…", "account_id": "…", "salt": "<base64 32 bytes>", "plan": "beta" }`. Codes expire after 10 minutes
  and work once; anything but digits in `code` is ignored.
  → `401 { "error": "wrong or expired code" }` for a wrong, missing or expired code.
  → `429 { "error": "too many attempts, try later" }` once an address has had 10 wrong codes: it is locked for
  24 hours from the tenth, whatever happens to the codes in between (a correct code before that clears the count).
  Also `429` beyond 30 verify calls per hour from one client address.
- `POST /v1/auth/logout` (bearer, no body needed) → `204`. Forgets that token; a repeat is still `204`. Clients call
  it on sign-out, so a token left behind in a backup file is dead.

### Self-hosted mode
The operator configures one or more tokens. There is no email step. `GET /v1/account` with the token
→ `{ "account_id": "…", "salt": "…" }` (the salt is created on first use and kept).

### `POST /v1/sync`
```json
{ "protocol": 1, "device_id": "…", "cursor": 1234, "docs": [ …documents to push… ] }
```
→
```json
{ "protocol": 1, "cursor": 1290, "epoch": 1,
  "docs": [ …documents with seq > request cursor, not pushed by this device in this call… ], "more": false,
  "rejected": [ { "id": "2026-10-17", "kind": "note", "reason": "size" } ] }
```
Server rules for each pushed document: if there is no stored version, or the pushed `updated_at` is greater than or
equal to the stored one, store it and give it a new sequence number. Otherwise ignore it; the stored version will
come back in the pull and the client converges. At most 500 documents are returned per call; `more: true` means
call again with the new cursor.

Documents that fail validation are not stored and are listed in `rejected` with a reason: `id` (empty or over
128 characters), `kind` (not one of the six), `size` (ciphertext over 64 KB), `future` (`updated_at` more than
24 hours ahead of the server clock) or `quota` (the account would pass 50 MB of ciphertext). A client must not
treat a rejected document as synced: keep it dirty or tell the user. Documents skipped because the stored copy is
newer are not listed; they come back in the pull.

`cursor` is per account, assigned by the server, and opaque to clients: store whatever comes back and send it next
time. When nothing newer than the sent cursor exists, the server returns the account's current sequence number,
which is lower than the sent cursor after the operator restored the database from a backup.

`epoch` is one integer for the whole server, `1` unless the operator bumped it after a restore from backup. A
client that sees it differ from the value it stored resets its cursor to 0 and marks everything dirty, so both
sides converge again on what each still has.

### `DELETE /v1/account`
Deletes the account, every document and every token. Bearer token required. For a hosted account (one with an
email) the body must also carry a fresh sign-in code for that address, `{ "code": "482913" }`, requested with
`POST /v1/auth/request` moments before: a leaked token alone cannot wipe a synced copy. The code goes through the
same check and lockout as `/v1/auth/verify`: `400` when it is missing, `401` wrong or expired, `429` locked.
Self-hosted (token) accounts: bearer only, no body.

## Client behaviour

- Every local mutation marks the affected document ids dirty. Dirty ids survive restarts.
- Sync runs: 2 s after the last edit, on launch, every 5 minutes, and when the network returns.
  One sync in flight at a time; a sync requested while one runs is queued once.
- Push: encrypt every dirty document, send them with the current cursor. On success, clear the dirty marks that were
  set before the request started (edits made during the request stay dirty). Ids in `rejected` are not treated as synced: the app clears their dirty mark, keeps them in a rejected list it shows to the user, and sends them again the next time they are edited.
- Pull: decrypt each returned document and apply: a task replaces the local one if its `updated_at` is newer;
  a tombstone removes the local task if the local `updated_at` is not newer and records the tombstone; notes,
  labels and routines compare their own timestamps. Applying never marks anything dirty.
- A `401` from `/v1/sync` means the token is gone (signed out elsewhere, account deleted or reset): the client drops
  its sync state and asks for a new sign-in. Local data stays.
- Clocks: `updated_at` comes from device clocks. A device whose clock is badly ahead "wins" edits it should not;
  clients therefore cap their own `updated_at` at `max(now, last seen server time)` and the server rejects
  documents more than 24 hours in the future.

## Approving another PC

The server never has the account key, so a new PC must get it from the user (the recovery code) or from a PC
that already holds it. The second path is a commit-then-reveal handshake relayed as `pair` documents. The server
stores and forwards them like any other bytes; their `ct` is base64 JSON, not ciphertext, and `nonce` is empty.
Anyone holding a device token for the account can read and write these documents, and the server operator can
answer them itself, which is why the person compares a code on both screens and confirms on the new PC.

1. The new PC generates an ephemeral ECDH P-256 key pair (private key not extractable) and pushes `pair:<id>` with
   `{"t":"req","commit":"<base64 SHA-256(raw public key)>","name":"<this PC's name>"}`. It shows nothing yet and polls
   `/v1/sync` from the cursor it got back every 3 seconds, for up to 15 minutes.
2. An unlocked PC that pulls the request, and has no other request open, generates its own ephemeral key pair and
   pushes `pair:<id>:ack` with `{"t":"ack","commit":"<base64 SHA-256(its raw public key)>"}`. It reveals nothing and
   shows no prompt yet. It answers one request at a time, never answers the same id twice, and expires requests by
   its own clock: unopened after 2 minutes, unapproved after 15 (tombstoning the request so the new PC learns of it).
3. The new PC pulls the ack and pushes `pair:<id>:open` with `{"t":"open","pub":"<its base64 raw public key>"}`.
4. The unlocked PC verifies `SHA-256(P_new)` equals the commit from step 1 (an open that does not match is ignored;
   the real one may still arrive). In one step it pushes `pair:<id>:reveal` with `{"t":"reveal","pub":"<P_old>"}` and
   shows the prompt "Add a PC? Approve only if it shows <code>", where code = the first four bytes of
   `SHA-256("sundial-pair-1" | id | P_new | P_old)` as an unsigned integer modulo 10000, shown as two pairs of digits.
   Every code this PC ever computes therefore costs it a visible prompt.
5. The new PC verifies `SHA-256(P_old)` equals the commit from step 2 (otherwise it fails: "tampered with on the
   way") and shows the same code.
6. On Approve, the unlocked PC derives the shared secret with ECDH, runs it through HKDF-SHA256 (empty salt, info
   `"sundial-pair-1" | id | P_new | P_old`) into an AES-256-GCM key, encrypts
   `{"k":"<base64 raw account key>","rc":"<recovery code or null>"}` with a random 12-byte IV and additional data
   `pair:<id>`, and pushes `pair:<id>:grant` `{"t":"grant","iv":"<base64>","wrapped":"<base64>"}` together with
   tombstones for the request, ack, open and reveal. Approve is bound to the code that was shown; a prompt cannot
   approve a request that replaced it. "Not mine" tombstones the request instead, which the new PC reports as declined.
7. The new PC derives the same key, decrypts the grant, requires a 32-byte key, and proves it by decrypting the
   `keycheck` document with it. It then asks the person: "Your other PC approved. Did it show <code>, and did you
   click Approve there yourself?" Only on "Yes, finish" does it keep the key (and the recovery code, so this PC can
   show it too), tombstone the grant, drop its starter examples and offer its own documents.

What each piece defends against. The two commits mean neither key can be chosen after seeing the other, so a party
in the middle changes the code the person compares. The reveal-with-prompt rule means a stolen token cannot collect
codes silently: every attempt is a prompt on the real PC. The keycheck proof defeats a grant forged by a token
holder. Against the server operator, who can serve a keycheck of their own, the protection is the person: the real
PC never showed a prompt, and the new PC asks before keeping anything. The `keycheck` document is write-once and
cannot be tombstoned (`rejected` reason `exists`), so two PCs setting up a brand-new account at the same moment
cannot split it and a token holder cannot lock new PCs out. Tombstones are dated after the document they delete,
whatever the other PC's clock said.

The recovery code (20 characters from an alphabet without look-alikes, invented by the app on the first PC; or a
passphrase typed in older versions) remains the other way in, and "erase the synced copy and start over" the way out.

## Operator notes

- Storage per account is a handful of kilobytes per task; a busy year is well under 10 MB. The cap is 50 MB of
  ciphertext per account (`rejected` reason `quota`).
- Rate limits, counted in memory (a restart clears them): 60 sync calls per minute per token; sign-in code requests
  5 per hour per address, 5 per hour and 20 per day per client address, 80 per day in total; verify 30 per hour per
  client address. The 24-hour lock after 10 wrong codes is kept in the database.
- Behind a reverse proxy the client address is the first `X-Forwarded-For` value, trusted only when the connection
  itself comes from localhost or a private address, i.e. from the proxy. Caddy with default settings replaces that
  header with the real client address.
- Browsers may call the API only from the desktop app's origins (`http://tauri.localhost`, `https://tauri.localhost`,
  `tauri://localhost`) and the local preview (`http://localhost:8767`, `http://127.0.0.1:8767`, and the same on port 8000). Self-hosters add
  origins with `SUNDIAL_ORIGINS`.
- Backups are the operator's job; the database is a single SQLite file, copy it while the server runs
  (`VACUUM INTO` or `sqlite3 .backup`). After restoring an older copy, bump the epoch so every client resyncs:
  `sqlite3 sundial-sync.sqlite "UPDATE meta SET value=value+1 WHERE key='epoch'"`.
- Tokens are stored hashed (SHA-256) since server 0.1.3; rows from before hold the token itself and are rewritten
  the first time they are used.
- Logs: the server's own log has no request bodies and no client addresses (a sign-in code is printed only when no
  email provider is configured, i.e. in development). The reverse proxy's access log is separate and, left at its
  defaults, keeps full client IPs and request URIs including `/signin?code=…`; mask or drop those there (the server
  README has the Caddy lines). Earlier versions of this document said addresses were truncated; they were not.
