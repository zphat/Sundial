# Developing Sundial

Notes for building, releasing and changing Sundial. Users want the [README](../README.md).

## Layout

- `ui/` is the whole app: static files, no build step. `index.html` is the page the desktop shell loads; `sundial.html` is the same page without `desktop.js`, for a plain browser. `data.js` holds state, the one-line parser, undo, the oplog, recurrence, reminders and import/export. `ui.js` renders and handles events, banners, settings and search. `audio.js` synthesizes the sounds and captures voice. `ai.js` is the optional parsing through Anthropic, OpenAI or an OpenAI-compatible URL, with the user's own key. `sync.js` is the end-to-end-encrypted sync client. `desktop.js` is the bridge to the shell (`window.SundialDesktop`, present only under Tauri). `toast.html` is the corner notification window.
- `src-tauri/` is the Tauri 2 shell. `src/lib.rs`: file storage with daily backups, tray icon and close-to-tray, system-wide hotkeys, native notifications, start with Windows, secrets in Windows Credential Manager through `keyring`, the updater, `sundial://` deep links. `tauri.conf.json` is the app config; CI merges `tauri.updater.conf.json` into it on signed builds. `updater.key` (encrypted) and `updater.pub` are the update-signing keypair.
- `server/` is the sync server: Rust, axum, one SQLite file, AGPL-3.0. `reference/sync_server.py` speaks the same protocol with only the Python standard library and is what to test against. `server/README.md` covers running and self-hosting it.
- `docs/`: this file, `SYNC-PROTOCOL.md` (protocol v1) and `FRIENDS-MESSAGE.md` (the invite text).
- `.github/workflows/`: `build.yml` builds the installer and the server and publishes releases; `keygen.yml` makes the updater keypair.

## Running the UI in a browser

Serve `ui/` over http; opening the file directly doesn't work because the scripts need it. From the repo root: `python -m http.server 8000 --directory ui`, then open http://localhost:8000/sundial.html. In a browser the data lives in localStorage, and the desktop features (tray, hotkeys, notifications, updates, Credential Manager) are absent.

## Building the Windows app

Nothing compiles on the development machine: it has git and WebView2, but no Rust, no C++ Build Tools and no Node. GitHub Actions builds every push to `main` (`build.yml`, job `windows`). The installer is in that run's Artifacts as `Sundial-windows-installer`, and compiler errors are repeated as annotations so they can be read without the log viewer.

To build locally you need Rust (rustup: https://win.rustup.rs/x86_64), the Microsoft C++ Build Tools with the "Desktop development with C++" workload (https://aka.ms/vs/17/release/vs_BuildTools.exe), Node 20 and WebView2. Then `npm install` and `npm run tauri build`; the installer appears in `src-tauri/target/release/bundle/nsis/`.

The installer is NSIS, per-user (`installMode: currentUser`, so no admin prompt) and not code-signed, which is why Windows shows its SmartScreen warnings. A signing certificate is still to do.

## Data on disk

`%APPDATA%\app.sundial.desktop\sundial.json`, which is Tauri's `app_data_dir()` for the identifier `app.sundial.desktop`. `save_db` in `lib.rs` writes a temp file and renames it, then on the first save of each UTC day copies the file to `backups\sundial-YYYY-MM-DD.json` and prunes that folder to the newest 30. `desktop.js` coalesces writes (250 ms). The sync key and API keys go to Windows Credential Manager under the service name `Sundial`.

## Releases and the updater

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same number. CI commits the matching `Cargo.lock` after the next build on `main`.
2. Commit and push `main`. Then tag with an annotated tag whose message is the release note, and push it:
   `git tag -a v0.1.23 -m "v0.1.23: what changed, in a sentence or three"` and `git push origin v0.1.23`.
3. `build.yml` creates the release "Sundial v0.1.23". Its body is the tag message followed by the install note. Attached: the versioned installer and its `.sig`, `latest.json`, a copy named `Sundial-Setup.exe` (so https://github.com/zphat/Sundial/releases/latest/download/Sundial-Setup.exe always serves the newest build) and, once the Windows job has finished, the Linux server tarball.

Rules that keep installed copies working:

- Releases are regular releases, never pre-releases or drafts. The updater reads https://github.com/zphat/Sundial/releases/latest/download/latest.json, and GitHub leaves pre-releases out of `/latest`.
- Don't delete a release anyone was sent a link to, and never publish a release without `latest.json` (the server tarball is attached only after the Windows job for that reason).
- The app checks for updates 4 seconds after launch and every 6 hours, verifies the download against the public key in `tauri.conf.json` and installs it in passive mode. Every release means a restart prompt for everyone, so batch changes.

Update signing: the private key is `src-tauri/updater.key`, stored encrypted (scrypt, as minisign does) and unlocked in CI by the `TAURI_UPDATER_KEY_PASSWORD` secret. `keygen.yml` generates a new pair whenever `.keygen` changes (it reads `generation: 2` today) and commits the encrypted key, the public key and the updated `tauri.conf.json`. Without the secret the build still succeeds but makes no `.sig` and no `latest.json`, so nothing unsigned can reach the updater. Rotation: bump `.keygen`, let keygen commit the new pair, put the previous private key in the `TAURI_SIGNING_PRIVATE_KEY` secret and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (generation 1 had none; from generation 2 on it is the old `TAURI_UPDATER_KEY_PASSWORD` value), and create `src-tauri/updater.transition`; the next release is signed with the old key but carries the new public key, and after it ships the transition file is removed. v0.1.22 was that transition release for generation 2.

## Sync server

Hosted at https://sync.sundial.services on an Exoscale VM in Switzerland, behind a reverse proxy (Caddy). The `sync-server` job in `build.yml` builds the Linux binary on every push, smoke-tests it in self-hosted mode and attaches `sundial-sync-linux-x86_64.tar.gz` to tag releases. There's no deploy workflow; the VM is updated by hand. Sign-in codes go out through Resend from sign-in@sundial.services.

What the hosted server stores, logs and keeps is written for users in [PRIVACY.md](../PRIVACY.md). Keep that page true when the server changes.

## Decisions

From the 2026-10-12 notes, as they stand now:

- Desktop first, Windows. Web and mobile companions later, from the same `ui/` code. Only the Windows build exists today.
- Tauri 2 as the shell: a small native wrapper around static files, using the WebView2 that Windows 11 already has.
- Local-first. The app never needs an account. Sync is optional and is the paid part (free app, paid sync, as Obsidian does it), with a free bring-your-own-server mode.
- Pricing: free during the beta, then $2.49 a month or $19.99 a year. Beta accounts keep $9.99 a year for as long as they stay subscribed. No card is taken during the beta.
- Licenses: the app is MIT (`LICENSE`), the server is AGPL-3.0 (`server/LICENSE`).
- AI parsing is optional and uses the user's own API key.
- The data layer was built for sync from day one: UUIDs, `updatedAt`, a device id, an append-only `oplog`, tombstones for deletes, newest-wins merge on import.
