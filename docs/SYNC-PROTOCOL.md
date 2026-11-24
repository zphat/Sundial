# Sundial Sync Protocol, version 1

The rules every Sundial client (desktop, web, mobile) and every sync server (hosted or self-hosted) follow.
Short version: the server is a dumb, encrypted mailbox of documents. It never sees a task.

## Principles

- **Local-first.** Every client works fully offline. Sync is an exchange of documents, never a dependency.
- **End-to-end encrypted.** Each document is encrypted on the device with a key the server never has.
  The server stores ciphertext, a document id, a kind, a timestamp and a sequence number. That is all it knows.
- **Last writer wins per document.** The client's `updated_at` (milliseconds since the epoch) decides between two
  versions of the same document. Deleted documents are kept as tombstones so a deletion beats a stale edit.
- **The key vouches for deletions and stamps.** The server orders documents, but making a device delete one, or
  passing an old version of a task off as a new one, needs the account key. "Stamps and deletions" says exactly what
  is covered, from when, and what is not.
- **Version-tolerant.** Every request carries `protocol: 1`. Servers keep accepting the previous protocol
  version for at least a year after a new one ships, because app stores deliver updates late.

## Documents

| kind       | id                | plaintext                                      |
|------------|-------------------|------------------------------------------------|
| `task`     | task id           | the task object (title, date, time, …)         |
| `note`     | `YYYY-MM-DD`      | `{html, u}` (`u`: the document's own `updated_at`, app 0.1.46 and later) |
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

A tombstone is `deleted: true` with an empty `ct`; its `nonce` holds a 28-byte seal instead of a nonce (see
"Stamps and deletions"). Documents are at most 64 KB of ciphertext. A server stores `nonce` and returns it unchanged
for every document, deleted ones included (every released server does).

## Encryption

- Key: AES-256-GCM. Derived on the device from the account secret (the recovery code the app invents on the first PC, or a passphrase typed in older versions) with PBKDF2-HMAC-SHA256, 600 000 iterations,
  and a 32-byte per-account salt the server hands out at sign-in (the salt is random and public).
- Each document: fresh random 12-byte nonce; additional authenticated data (AAD) is the UTF-8 string `kind:id`,
  so a ciphertext cannot be moved to a different document.
- The derived key is kept on the device (OS credential store on desktop; browser storage on the web, with a warning).
  The secret itself is never sent; the first PC keeps the recovery code in the OS credential store so it can be shown again, and an approved PC receives it inside the handshake.
- Losing the secret, with no PC left that holds the key, loses the ability to read the synced copy. Local data on existing devices is untouched. The UI says this in plain words when the code is shown.

### Stamps and deletions (app 0.1.46 and later)

Until 0.1.46 `updated_at` and `deleted` were plain fields beside the ciphertext. Whoever could write to an account
without the key (a copied device token, the server itself) could push a tombstone for any id and every device
deleted that document, or push an old ciphertext again under a newer `updated_at` and every device rolled back.
The key now vouches for both. `FLIP` below is 2027-01-18T00:00:00Z (`1800230400000`), the same for every device.

- **A deletion is sealed.** The `nonce` of a tombstone is base64 of 28 bytes: 12 random bytes, then the 16-byte
  AES-GCM tag of an empty message encrypted under the account key with those 12 bytes as the nonce and the AAD
  `gone:kind:id:updated_at` (`updated_at` in decimal). A device applies a tombstone only when that tag verifies. A
  28-byte value that does not verify is a forgery and is ignored.
- **A stamp is sealed.** A live document whose `updated_at` is `FLIP` or later is encrypted with the AAD
  `v2:kind:id:updated_at`, so the ciphertext opens only under the stamp it was written with. A live document with an
  earlier stamp keeps the AAD `kind:id`, because versions before 0.1.46 can read nothing else and must keep syncing
  with newer ones until `FLIP`. The form follows from the stamp alone; there is no version field to lie about.
- **A task and a note carry their stamp twice.** The task object inside the ciphertext has `updatedAt`, a note
  written by 0.1.46 or later has `u`, and a device refuses one whose inner stamp differs from the document's
  `updated_at`, in either form. So an older version of a task, or of a note last written by 0.1.46 or later, cannot
  be served under a newer stamp even before `FLIP`. A body with no inner stamp (a note from before 0.1.46, a task
  from a version so old that it had no `updatedAt`) is not checked this way. Labels and routines have no inner stamp
  (versions before 0.1.46 would stumble over it); they get the protection from the AAD, for stamps from `FLIP` on.
- **The old forms end at `FLIP`.** A tombstone without a seal is accepted only while the device's clock is before
  `FLIP` and the tombstone's stamp is too. A live document in the old form is accepted only with a stamp before
  `FLIP`. A device that refuses something stamped `FLIP` or later for being in the old form tells the person that
  another device needs updating; that device's changes arrive once it runs 0.1.46 or later (see the upgrade step
  under "Client behaviour"). An unsealed tombstone with an earlier stamp, met after `FLIP`, is passed over without a
  word: it is a leftover, not a sign of an old device. To leave as few of those as possible, a 0.1.46 device that
  accepts an unsealed tombstone before `FLIP` pushes it again with a seal, under the same stamp.
- What this does not do:
  - Until `FLIP`, whoever can write to the account can still delete a document on every device with an unsealed
    tombstone stamped before `FLIP`. That is the price of syncing with versions before 0.1.46 until then.
  - Old ciphertexts of labels, routines, and notes last written before 0.1.46 can be served again under any stamp
    that is later than the device's copy and earlier than `FLIP`, for as long as that document has not been written
    again with a stamp of `FLIP` or later. Tasks, and notes written by 0.1.46 or later, are covered at once.
  - The server can withhold documents, or serve a device that has never synced an older state of the account. A
    token holder can do a version of the same: overwrite the stored copy of a document with one nobody can open, at
    an equal or later stamp. Devices that hold the document keep it and put it back at their next edit of it (see
    "Client behaviour"); a device that had not received it yet does not get it until then.
  - A forged old-form document or unsealed tombstone stamped `FLIP` or later sets off the "another device needs
    updating" note on the devices that refuse it. Nothing else happens.

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
  → `503 { "error": "too many sign-in emails from here right now, try again later" }` when a request limit is hit,
  and `503 { "error": "email could not be sent right now, try again in a few minutes" }` when the email provider
  refuses or times out. Clients show that message instead of "code sent". The limits, in the order they are
  checked: per client address 5 per hour and 20 per day, then 5 per hour per email address, then 80 per day in
  total. A client over its own allowance is refused before it counts against anyone's address. Once an address has
  had its 5 for the hour, a request made while its code is still valid answers `204`, gives that code another
  10 minutes and sends no email. A send that fails counts against none of these (server 0.1.14); what does count
  whatever the outcome is 30 tries per hour per client address.
- `POST /v1/auth/verify` `{ "email": "…", "code": "482913", "device": { "id": "…", "name": "…", "platform": "…" } }`
  → `{ "token": "…", "account_id": "…", "salt": "<base64 32 bytes>", "plan": "beta" }`. Codes expire after 10 minutes
  and work once; anything but digits in `code` is ignored.
  → `401 { "error": "wrong or expired code" }` for a wrong, missing or expired code.
  → `429 { "error": "too many attempts, try later" }` after too many wrong codes. A wrong code counts only while a
  code for the address is valid (server 0.1.14; with none there is nothing to guess, and counting only let a
  stranger lock an address). Ten wrong codes from one network (IPv4 /24, IPv6 /48) lock that network out of that
  address for 24 hours; 50 for one address from all networks lock the address for 24 hours. A correct code clears
  the count. Also `429` beyond 30 verify calls per hour from one client address.
- `POST /v1/auth/logout` (bearer, no body needed) → `204`. Forgets that token; a repeat is still `204`. Clients call
  it on sign-out, so a token left behind in a backup file is dead. A static token (self-hosted mode) is left alone:
  it is the operator's, and only leaving `SUNDIAL_TOKENS` ends it.

### Self-hosted mode
The operator configures one or more tokens in `SUNDIAL_TOKENS`. There is no email step. `GET /v1/account` with the
token → `{ "account_id": "…", "salt": "…" }` (the salt is created on first use and kept). Each token is its own
account; from server 0.1.14 a new token's account id is `acct_` plus 16 hex characters of the token's SHA-256
(accounts made before keep their ids), and a token taken out of the list stops working at the next start, while
its account and documents stay for the day it is listed again.

`GET /v1/account` works in both modes and, from server 0.1.13, also says how full the account is:
`"bytes"` (ciphertext stored), `"quota"` (the limit, 50 MB) and `"docs"` (documents that are not tombstones).

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
equal to the stored one, store it and give it a new sequence number. Otherwise it is not stored, and the stored
version is returned in `docs` of the same response, whatever the cursor says (server 0.1.12 and later): a device that
already pulled that version, and then edited with a clock that runs behind the writer's, would otherwise keep showing
an edit the server never took. At most 500 documents or about 2 MB of ciphertext are returned per call, whichever
comes first; `more: true` means call again with the new cursor. A client pushes in batches of about 2 MB too (the
request body limit is 8 MB), so a long spell offline never has to fit in one request. `device_id` is at most 64
characters.

Limits on requests (server 0.1.14): the 8 MB body limit is for `/v1/sync` only; every other route takes 4096 bytes
(`413` above). `/v1/sync` answers `401` for a missing or unknown token before it keeps any of the body. A body over
256 KB is read under one of six permits: when all are busy for ten seconds the answer is
`503 { "error": "busy, try again in a moment" }` and the device sends again at its next sync. Any request not answered
60 seconds after its headers arrived gets `408` and the connection is closed; a client's own limits (30 seconds, or
the `wait` plus 12) stay below that.

Documents that fail validation are not stored and are listed in `rejected` with a reason: `id` (empty or over
128 characters), `kind` (not one of the six), `size` (ciphertext over 64 KB, or a nonce over 64 characters), `future` (`updated_at` more than
24 hours ahead of the server clock) or `quota` (the account would pass 50 MB of ciphertext). A client must not
treat a rejected document as synced: keep it dirty or tell the user. Documents skipped because the stored copy is
newer are not listed; the stored copy comes back in `docs`.

`cursor` is per account, assigned by the server, and opaque to clients: store whatever comes back and send it next
time. When nothing newer than the sent cursor exists, the server returns the account's current sequence number,
which is lower than the sent cursor after the operator restored the database from a backup.

`epoch` is one integer for the whole server, `1` unless the operator bumped it after a restore from backup. A
client that sees it differ from the value it stored resets its cursor to 0 and marks everything dirty, so both
sides converge again on what each still has.

Which account (server 0.1.14 and later, app 0.1.46 and later). A request may carry `"salt"`, the account salt the
device received when it signed in. When it is not the salt of the account the token opens now, the server stores
nothing and answers `409 { "error": "account was reset" }`. That happens after `DELETE /v1/account` on an account
with a static token: the token keeps working, but the account behind it is a new, empty one with a new salt. A
device that sees `409` fetches the new salt with `GET /v1/account` and resets its cursor. One that holds a key
forgets it first and asks to be approved (or for the recovery code), as any device without the key does; one that
holds no key simply repeats its request with the new salt. When the salt cannot be fetched the device changes
nothing and asks again later. Without this, a device that was offline during the erase would go on pushing documents
encrypted under the old key into the new account. Older servers ignore the field; older apps do not send it.

Listening (server 0.1.13 and later). A request with no documents may add `"wait": 25`: when nothing is newer than
the cursor, the server holds the request until another device writes to the account, or for that many seconds (25
at most), and then answers as usual. A client that sees `"wait": true` in a response knows the server does this and
keeps one such request open while its window is visible, so a change made elsewhere arrives within a second; with
an older server it checks every 10 seconds instead. Before it pushes, a client lets its waiting request go.
Every response also carries `"now"`, the server's clock in milliseconds, so a device can notice that its own clock
is off.

### Devices (server 0.1.13 and later)
`GET /v1/devices` → `{ "devices": [ { "id": "…", "name": "…", "platform": "…", "device_id": "…", "created_at": …,
"last_seen": …, "current": true } ], "can_revoke": true }`: the sign-ins of the caller's account. `last_seen` is
written at most every ten minutes. `id` is a short handle, not the token.

`POST /v1/devices/revoke` with `{ "id": "…" }` signs that device out: its token stops working (`204`), and the device
drops its sync state at its next request, as after any `401`. What it holds locally stays. Accounts with an email
only (`can_revoke`); a static token is the operator's to manage.

### `DELETE /v1/account`
Deletes the account, every document and every token (one transaction). Bearer token required. For a hosted account (one with an
email) the body must also carry a fresh sign-in code for that address, `{ "code": "482913" }`, requested with
`POST /v1/auth/request` moments before: a leaked token alone cannot wipe a synced copy. The code goes through the
same check and lockout as `/v1/auth/verify`: `400` when it is missing, `401` wrong or expired, `429` locked.
Self-hosted (token) accounts: bearer only, no body. A static token is not deleted with its account: the account
comes straight back empty under the same `account_id`, with a new salt and sequence 0, and every listed token that
opened it keeps working (server 0.1.14; before, the token answered `401` until the server was restarted). Devices
holding the old salt get `409` from then on (see "Which account" above), and requests they had waiting end at once.

## Client behaviour

- Every local mutation marks the affected document ids dirty. Dirty ids survive restarts.
- Sync runs: 2 s after the last edit, on launch, every 10 seconds while the window is visible and every minute hidden, and when the network returns.
  One sync in flight at a time; a sync requested while one runs is queued once.
- Push: encrypt every dirty document, send them with the current cursor. On success, clear the dirty marks that were
  set before the request started (edits made during the request stay dirty). Ids in `rejected` are not treated as synced: the app clears their dirty mark, keeps them in a rejected list it shows to the user, and sends them again the next time they are edited.
- Pull: decrypt each returned document and apply: a task replaces the local one if its `updated_at` is newer;
  a tombstone removes the local task if the local `updated_at` is not newer and records the tombstone; notes,
  labels and routines compare their own timestamps. Applying never marks anything dirty.
- A document that fails its check (a seal that does not verify, a task or note under a stamp it was not written
  with, a ciphertext that does not open, an old form stamped `FLIP` or later) is ignored and the cursor moves on.
  When that document is the stored copy of one the device has changed and just pushed, and so came back because its
  stamp is higher (servers 0.1.12 and later return it), the device stamps its own copy one above it and pushes
  again: otherwise a forged copy with a stamp a few hours ahead would silently swallow every later edit of that
  document. Three limits: a refused copy of a document the device is not changing is left alone; so is one that
  only went out in a bulk re-send (after a sign-in, an import, the upgrade step, an epoch change), because the copy
  the device holds may then be the older one; and a stamp more than a day ahead of the clock is never followed.
- Upgrade step, once per device on its first start of 0.1.46 or later: push every tombstone it holds again with a
  seal, and every document stamped `FLIP` or later again in the new form, all under their existing stamps (the
  server takes an equal stamp), then pull from cursor 0. A version before 0.1.46 skips documents it cannot read and
  never asks for them again, and writes the old forms; this step repairs both for a device that updates late.
  `pair` documents at or below the old cursor are skipped during that pull, so a finished or abandoned approval is
  not shown again.
- A `401` from `/v1/sync` means the token is gone (signed out elsewhere, account deleted or reset): the client drops
  its sync state and asks for a new sign-in. Local data stays.
- Clocks: `updated_at` comes from device clocks, and a clock that runs ahead must not shadow later edits made
  elsewhere. So a client stamps every change with `max(now, stamp of the version it replaces + 1)`: an edit is
  always later than what it edits, whichever clock wrote that. Tombstones follow the same rule, and a task put back
  after a delete is stamped later than its tombstone. The server rejects documents more than 24 hours in the future.

## Approving another PC

The server never has the account key, so a new PC must get it from the user (the recovery code) or from a PC
that already holds it. The second path is a handshake relayed as `pair` documents. The server stores and forwards
them like any other bytes; their `ct` is base64 JSON, not ciphertext, and `nonce` is empty. Anyone holding a device
token for the account can read and write these documents, and the server operator can answer them itself; the
design assumes both and asks the person for two small things: on the approving PC, to type the code the new PC
shows; on the new PC, to type the finish code the approving PC shows afterwards.

Document ids: `pair:<id>` (request), `pair:<id>:open` (new PC), and `pair:<id>:ack:<dev>`, `pair:<id>:reveal:<dev>`,
`pair:<id>:grant:<dev>` where `<dev>` is the answering PC's device id, so several unlocked PCs never overwrite one
another.

1. The new PC generates an ephemeral ECDH P-256 key pair (private key not extractable) and pushes the request
   `{"t":"req","commit":"<base64 SHA-256(raw public key)>","name":"<this PC's name>"}`. It shows nothing yet and polls
   `/v1/sync` from the cursor it got back every 2 seconds for the first two minutes (and again for two minutes after
   the code is shown), then every 5 seconds, for up to 15 minutes.
2. Every unlocked PC that pulls the request, and could show a prompt right now (window visible, or corner toasts
   on), generates its own ephemeral key pair and pushes its ack `{"t":"ack","commit":"<base64 SHA-256(its raw public
   key)>"}`. An ack reveals nothing and shows no prompt; a PC that cannot prompt waits until it can before answering.
3. The new PC binds to the first ack it sees and pushes `{"t":"open","pub":"<its base64 raw public key>","to":"<dev>"}`.
   Other PCs drop the request when they see an open addressed elsewhere.
4. The addressed PC verifies `SHA-256(P_new)` equals the commit from step 1 (an open that does not match is ignored;
   the real one may still arrive). It shows the prompt "Add a PC? Approve only if it shows <code>" and pushes
   `{"t":"reveal","pub":"<P_old>"}` in the same breath, prompt first. The code is the first four bytes of
   `SHA-256("sundial-pair-1" | id | P_new | P_old)` as an unsigned integer modulo 10000, shown as two pairs of digits.
   A PC shows one prompt at a time (later requests wait their turn), only while a person can see it (window visible,
   or corner toasts on), and at most five an hour; past that it stops answering and shows a warning that only the
   person can dismiss. A prompted request that is withdrawn by someone else leaves a note on screen. An answering PC
   polls every 2 seconds for 90 seconds after it acks, prompts or approves, otherwise every 5 seconds while a request
   is open, and backs off to 5 seconds for a minute after a 429.
5. The new PC verifies `SHA-256(P_old)` equals the ack commit (otherwise it fails: "tampered with on the way") and
   shows the same code.
6. The person types the new PC's code on the old PC (three misses decline the request). On that match the old PC derives the shared secret with ECDH, runs it through
   HKDF-SHA256 (empty salt, info `"sundial-pair-1" | id | P_new | P_old`) into an AES-256-GCM key, encrypts
   `{"k":"<base64 raw account key>","rc":"<recovery code or null>"}` with a random 12-byte IV and additional data
   `pair:<id>`, and pushes the grant `{"t":"grant","iv":"<base64>","wrapped":"<base64>"}`. It then shows a finish
   code: the first four bytes of `SHA-256("sundial-pair-done" | id | K | P_new | P_old)` modulo 10000, where K is the
   raw account key. "Not mine" tombstones the request instead, which the new PC reports as declined.
7. The new PC derives the same key, decrypts the grant, requires a 32-byte key, proves it by decrypting the `keycheck`
   document (which lives only at id `keycheck`), computes the finish code itself, and asks the person to type the
   code their other PC shows. After three mismatches it gives up. On a match it keeps the key (and the recovery
   code, so this PC can show it too), tombstones the pair documents, drops its starter examples and offers its own
   documents.

What each piece defends against. The two commits mean neither key can be chosen after seeing the other. The finish
code is bound to the key and to both public keys: a party in the middle who swapped a key, or a server that answered
the request itself, cannot make the real PC display the code the new PC expects, and the real PC displays nothing at
all when it never approved. The keycheck proof defeats a grant forged by a token holder. Prompts cannot be collected
silently: a code exists on the old PC only once a prompt is on screen, prompts are one at a time and capped, and a
withdrawn prompt leaves a trace. The `keycheck` document is write-once at a single id, cannot be tombstoned, and no
document can change kind (`rejected` reasons `exists`, `id`, `kind`), so two PCs setting up a brand-new account at the
same moment cannot split it and a token holder cannot lock new PCs out or plant a key record of their own. Tombstones
are dated after the document they delete, whatever the other PC's clock said.

The recovery code (20 characters from an alphabet without look-alikes, invented by the app on the first PC; or a
passphrase typed in older versions) remains the other way in, and "erase the synced copy and start over" the way out.

## Operator notes

- Storage per account is a handful of kilobytes per task; a busy year is well under 10 MB. The cap is 50 MB of
  ciphertext per account (`rejected` reason `quota`).
- Rate limits, counted in memory (a restart clears them): 60 sync calls per minute per token; sign-in code requests
  5 per hour per address, 5 per hour and 20 per day per client address, 80 per day in total; verify 30 per hour per
  client address. Wrong codes: 10 per client network and address (in memory, so no network is written to disk) and
  50 per address (in the database), each for 24 hours.
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
