# Developing Sundial

Notes for building, releasing and changing Sundial. Users want the [README](../README.md).

## Layout

- `ui/` is the whole app: static files, no build step. `index.html` is the one page; the desktop shell loads it and https://app.sundial.services serves it. `data.js` holds state, the one-line parser, undo, the oplog, recurrence, reminders and import/export. `ui.js` renders and handles events, banners, settings and search. `audio.js` synthesizes the sounds and captures voice. `ai.js` is the optional parsing through Anthropic, OpenAI or an OpenAI-compatible URL, with the user's own key. `sync.js` is the end-to-end-encrypted sync client. `desktop.js` is the bridge to the shell (`window.SundialDesktop`, present only under Tauri); everything web-only in the other files is guarded by `!window.SundialDesktop`, everything desktop-only by its presence. `toast.html` is the corner notification window. For the web app: `sw.js` is the service worker, `manifest.webmanifest` and `icons/` make it installable, `fonts.css` and `fonts/` are the self-hosted fonts (see Fonts below).
- `src-tauri/` is the Tauri 2 shell. `src/lib.rs`: file storage with daily backups, tray icon and close-to-tray, system-wide hotkeys, native notifications, start with Windows, secrets in Windows Credential Manager through `keyring`, the updater, `sundial://` deep links. `tauri.conf.json` is the app config; CI merges `tauri.updater.conf.json` into it on signed builds. `updater.key` (encrypted) and `updater.pub` are the update-signing keypair.
- `server/` is the sync server: Rust, axum, one SQLite file, AGPL-3.0. `reference/sync_server.py` speaks the same protocol with only the Python standard library and is what to test against. `server/README.md` covers running and self-hosting it. `server/ops/web/` holds the VPS files for the web app (Caddyfile, update script, systemd units, landing page) with their own README; `server/ops/backup-offsite.sh` is the nightly off-site backup.
- `docs/`: this file, `SYNC-PROTOCOL.md` (protocol v1) and `FRIENDS-MESSAGE.md` (the invite text).
- `.github/workflows/`: `build.yml` syntax-checks `ui/`, builds the installer, the server and the web bundle, and publishes releases; `keygen.yml` makes the updater keypair.

## Running the UI in a browser

Serve `ui/` over http; opening the file directly doesn't work because the scripts need it. From the repo root: `python -m http.server 8000 --directory ui`, then open http://localhost:8000/. This is the web app as users get it, minus two things: the service worker only registers on https, never in the desktop shell or in this http preview, and the version reads `dev` because nothing stamped the `sundial-version` meta. In a browser the data lives in localStorage under the key `sundial.v3`, and the desktop features (tray, hotkeys, native notifications, updates, Credential Manager) are absent. The sync server allows `http://localhost:8000` by default, so sync can be tested from the preview.

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
3. `build.yml` creates the release "Sundial v0.1.23". Its body is the tag message followed by the install note. Attached: the versioned installer and its `.sig`, `latest.json`, a copy named `Sundial-Setup.exe` (so https://github.com/zphat/Sundial/releases/latest/download/Sundial-Setup.exe always serves the newest build) and, once the Windows job has finished, the Linux server tarball and the web bundle `sundial-web.tar.gz`. The VPS picks the web bundle up on its own within 10 minutes (see below).

Rules that keep installed copies working:

- Releases are regular releases, never pre-releases or drafts. The updater reads https://github.com/zphat/Sundial/releases/latest/download/latest.json, and GitHub leaves pre-releases out of `/latest`.
- Don't delete a release anyone was sent a link to, and never publish a release without `latest.json` (the server and web tarballs are attached only after the Windows job for that reason).
- The app checks for updates 4 seconds after launch and every 6 hours, verifies the download against the public key in `tauri.conf.json` and installs it in passive mode. Every release means a restart prompt for everyone, so batch changes.

Update signing: the private key is `src-tauri/updater.key`, stored encrypted (scrypt, as minisign does) and unlocked in CI by the `TAURI_UPDATER_KEY_PASSWORD` secret. `keygen.yml` generates a new pair whenever `.keygen` changes (it reads `generation: 2` today) and commits the encrypted key, the public key and the updated `tauri.conf.json`. Without the secret the build still succeeds but makes no `.sig` and no `latest.json`, so nothing unsigned can reach the updater. Rotation: bump `.keygen`, let keygen commit the new pair, put the previous private key in the `TAURI_SIGNING_PRIVATE_KEY` secret and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (generation 1 had none; from generation 2 on it is the old `TAURI_UPDATER_KEY_PASSWORD` value), and create `src-tauri/updater.transition`; the next release is signed with the old key but carries the new public key, and after it ships the transition file is removed. v0.1.22 was that transition release for generation 2.

## Sync server

Hosted at https://sync.sundial.services on an Exoscale VM in Switzerland (zone ch-gva-2), behind a reverse proxy (Caddy). The `sync-server` job in `build.yml` builds the Linux binary on every push, smoke-tests it in self-hosted mode and attaches `sundial-sync-linux-x86_64.tar.gz` to tag releases. There's no deploy workflow; the VM is updated by hand. Sign-in codes go out through Resend from sign-in@sundial.services. The database is copied nightly on the box (30 days); `server/ops/backup-offsite.sh`, once installed, also sends an encrypted copy each night to Exoscale object storage in a second Swiss zone (ch-dk-2), kept 30 days.

What the hosted server stores, logs and keeps is written for users in [PRIVACY.md](../PRIVACY.md). Keep that page true when the server changes.

## Web app hosting and deploy

https://app.sundial.services is the same `ui/`, served as static files by the Caddy on the sync VPS. No third-party host, no CDN, nothing runs server-side for it. Install steps, checks and rollback are in [server/ops/web/README.md](../server/ops/web/README.md).

In the browser the whole state, including the sync key, the recovery code, the sign-in token and an AI key when they exist, is one localStorage entry, `sundial.v3`; a browser has no credential store. `navigator.storage.persist()` is asked once after onboarding (or on the first click or key press for existing users). Reminders fire only while a tab is open or the installed app is running. A Safari Home Screen install has its own storage, so the Install row tells people to turn sync on first. The sign-in email's button opens the server's `/signin` code page, which offers Open Sundial (`sundial://signin?code=`) and, from the first sync-server build after 0.1.7, Open in the browser (`https://app.sundial.services/?code=482913`; the base comes from `SUNDIAL_APP_URL`). The web app removes the code from the URL and runs the same flow. Until that server build is deployed, phone users copy the code from the page into the app.

CI, in `build.yml`:

- `check` runs `node --check` on every `ui/*.js`, then parses the scripts `index.html` loads concatenated into one function body, in `<script>` order (the list is read from `index.html`, so it cannot drift). Classic scripts share one global scope, and a top-level `let` or `const` declared in two files throws "already been declared" at load and blanks the app in both runtimes; the per-file check cannot see that. It also parses `ui/manifest.webmanifest`. Every other job waits for it, so a syntax error in these no-build files cannot reach the auto-updater or the web. Third-party actions are pinned to commit SHAs; the comment next to each names the version.
- `web` copies `ui/` minus `toast.html` into `sundial-web.tar.gz`, replacing `content="dev"` in the `sundial-version` meta of `index.html` and `__VERSION__` in `sw.js` with the version from `package.json`. It fails if the meta tag is missing. The service worker's cache is named `sundial-<version>`, so each release drops the previous cache on activate.
- `attach-assets` (tags only) puts the server tarball and the web bundle on the release after the Windows job has published `latest.json`.

On the VPS (files in `server/ops/web/`):

- `sundial-web-update`, run by a systemd timer every 10 minutes, asks the GitHub API for the latest release and compares its tag with `/var/www/app/current/VERSION`. When they differ it downloads `sundial-web.tar.gz`, checks the sha256 against the digest the API reports, unpacks into `/var/www/app/releases/<version>/` and swaps the `current` symlink. The newest three releases stay for rollback. Nothing downloaded is executed.
- Caddy serves three sites from one Caddyfile: `sync.sundial.services` (reverse proxy to the Rust server, unchanged), `app.sundial.services` (root `/var/www/app/current`) and `sundial.services` with `www` (the landing page, `/var/www/root/index.html`). HTML, JS, CSS, `sw.js` and the manifest go out with `Cache-Control: no-cache`; `/fonts/*` and `/icons/*` are immutable for a year, so a changed font or icon needs a new file name.
- CSP on the app: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https:; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`. `connect-src https:` is what lets sync, AI providers and own servers work, and why an own-server URL must be https. CSP scheme matching has no localhost exception (that belongs to the mixed-content rules), so `http://localhost:11434/v1` for Ollama or an own sync server at `http://localhost:8768` fail from the web app; they work from the desktop app and from the http dev preview.
- Logs: `/var/log/caddy/access.log` (the name the box already had), `app.log` and `root.log`, all through the same `privlog` snippet: IP masked to /24 and /48, `?code=` dropped, request headers dropped as a whole, kept 14 days. `journalctl -u sundial-web-update` for the timer, which runs as the `caddy` user.
- The sync server accepts the web origin only through `SUNDIAL_ORIGINS=https://app.sundial.services` in `/etc/sundial/sync.env`, followed by `systemctl restart sundial-sync`. Without it every `/v1` call from the web app fails CORS.

## Fonts

The four families (Silkscreen 400 and 700, Syne 600 to 800, Manrope 400 to 700, Space Mono 400 and 700) are self-hosted: `ui/fonts.css` and twelve woff2 files in `ui/fonts/`, latin and latin-ext subsets, about 177 KB. They are unmodified Google Fonts builds under the SIL Open Font License 1.1; `ui/fonts/OFL.txt` has the notices. Neither the desktop app nor the web app contacts Google. To regenerate: fetch the Google Fonts css2 URL for those families and weights with a current Chrome user agent (older agents get ttf instead of woff2), keep the latin and latin-ext `@font-face` blocks, download their files into `ui/fonts/` under new names and point the `url()`s in `fonts.css` at them. The service worker reads the font list from `fonts.css` at install time, so nothing else needs updating.

## What comes next

[ROADMAP.md](ROADMAP.md): the state at the end of the first beta week, the loose ends, and the platform order (Linux, macOS, Android with Obtainium/IzzyOnDroid/Accrescent/F-Droid, iOS).

## Decisions

From the 2026-10-12 notes, as they stand now:

- Desktop first, Windows. Web and mobile companions from the same `ui/` code. The Windows build and the web app exist today; phones use the web app.
- Tauri 2 as the shell: a small native wrapper around static files, using the WebView2 that Windows 11 already has.
- Local-first. The app never needs an account. Sync is optional and is the paid part (free app, paid sync, as Obsidian does it), with a free bring-your-own-server mode.
- Pricing: free during the beta, then $2.49 a month or $19.99 a year. Beta accounts keep $9.99 a year for as long as they stay subscribed. No card is taken during the beta.
- Licenses: the app is MIT (`LICENSE`), the server is AGPL-3.0 (`server/LICENSE`).
- Web app is the same `ui/` served statically from the Swiss VPS; no third-party hosts at all; fonts self-hosted; backups stay in Switzerland (Exoscale SOS, zone ch-dk-2).
- AI parsing is optional and uses the user's own API key.
- The data layer was built for sync from day one: UUIDs, `updatedAt`, a device id, an append-only `oplog`, tombstones for deletes, newest-wins merge on import.
