# Roadmap

Where Sundial stands and what comes next, written at the end of the first beta week (2026-10-19). The order below is the order of work.

## Where it stands

- **Windows app**: feature-complete for the beta. Self-updating, tray, hotkeys, reminders, voice input, sync with the email flow, the add-a-device handshake, and the task bank on the timeline. Unsigned, so Windows warns once on first run.
- **Web app** (https://app.sundial.services): the same code, served from the Swiss VPS, installable on phones, offline-capable. Phone layout for narrow viewports. Drag and drop does not work on touch yet.
- **Sync**: end-to-end encrypted, hosted in Switzerland, free during the beta. Protocol 1 is documented in [SYNC-PROTOCOL.md](SYNC-PROTOCOL.md). Billing is not built; pricing is decided ($2.49 a month or $19.99 a year, founding price $9.99 a year for beta accounts that stay subscribed).
- **Operations**: nightly on-box backups, uptime check every 15 minutes, privacy-filtered access logs, pull-based deploy of the web app, DMARC on the mail domain. Off-site backups to Exoscale object storage (zone ch-dk-2) are scripted and wait for a bucket.

## Loose ends to close before new platforms

1. **Windows signing.** Apply to the SignPath Foundation once the project has a few weeks of visible activity (the policy page is [CODE-SIGNING.md](CODE-SIGNING.md)). Until then the warning stays; it is cosmetic, not a security problem.
2. **Off-site backups.** Create the Exoscale bucket and an access key limited to it; the installer steps are in `server/ops/backup-offsite.sh`.
3. **Web bundle signing.** The VPS installs whatever the latest GitHub release carries after a checksum; signing the bundle with the updater key and verifying it on the VPS closes the gap described in `server/ops/web/README.md`.
4. **Old token account.** The first sync account (created with the static token before email sign-in existed) can be deleted from the server, and the static token removed from `SUNDIAL_TOKENS`, once no device uses it.

## Next platforms, in order

### Linux
Tauri builds a `.deb` and an AppImage on an `ubuntu-latest` runner; the updater works for AppImage. Add a Linux job to `build.yml` beside the Windows one, attach both files to the release, and extend `latest.json`. Tray icons on Linux need `libayatana-appindicator`; test on one GNOME and one KDE machine. Flatpak can come later through Flathub.

### macOS
Tauri builds a `.dmg` on a `macos-latest` runner (universal binary). Without an Apple Developer account ($99 a year) the app is unsigned and Gatekeeper requires right-click → Open; with one, the build job notarizes it. Decide the account question first; the CI job is the same either way.

### Android
Tauri 2 Mobile produces an APK and an AAB from the same `ui/`. The CI job needs the Android SDK and NDK and a release keystore kept as a GitHub secret. Distribution for privacy-first phones (GrapheneOS, CalyxOS, any de-Googled device), in the order that costs the least:
1. **GitHub Releases + Obtainium**: ship the signed APK on every release; Obtainium users add the repository URL and get updates. Zero setup beyond the APK.
2. **IzzyOnDroid**: a repository that imports APKs from GitHub releases; reachable from any F-Droid client. One request to be listed.
3. **Accrescent**: a security-focused store popular on GrapheneOS; requires a developer registration and a signed AAB.
4. **F-Droid main repository**: builds from source on their servers; Rust + Android is supported, but every dependency must be free software and the build reproducible. Worth it later.
Google Play is optional; it needs a developer account and Google's review.

### iOS
Needs an Apple Developer account and a macOS runner; Tauri 2 Mobile builds the app, TestFlight distributes the beta, the App Store the release. Last because of the account cost and review process. Until then, the web app on an iPhone's Home Screen is the iOS version.

## Refinement, alongside everything

Use it daily, collect what friends report at hello@sundial.services, and fix what hurts. Known items: drag and drop on touch, routines and settings in the JSON export, reminders only while a web tab is open, a scroll-to-now on the phone timeline.
