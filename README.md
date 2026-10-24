# Sundial

Sundial is a calendar, a task list and a page of notes for each day, in one window. It is fast, and it works without an internet connection. Everything you type stays on your own PC, or in your own browser. There is a Windows app, a Linux app and a web app at https://app.sundial.services. It is a beta: expect rough edges, and say so when you find them.

## Download for Windows

**[Download Sundial-Setup.exe](https://github.com/zphat/Sundial/releases/latest/download/Sundial-Setup.exe)**

Sundial isn't signed with a paid certificate yet, so Windows doesn't know it. The first time, you may see two warnings:

1. Edge may say the file "isn't commonly downloaded". Choose **Keep**, then **Show more**, then **Keep anyway**.
2. Windows may show a blue box titled "Windows protected your PC". Click **More info**, then **Run anyway**.

The warning means Windows hasn't seen this app before. It isn't a virus detection. The installer needs no admin password and installs for your user only. Updates are signed and install on their own.

If Windows says Smart App Control blocked the file, there's no Run anyway button. Don't change any settings. That PC can't run Sundial until a signed build exists; the browser version below works there. The plan for signing is in [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md).

## Linux

- Fedora, openSUSE and other rpm distros: **[Sundial.rpm](https://github.com/zphat/Sundial/releases/latest/download/Sundial.rpm)**. Open it with your software center, or `sudo dnf install ./Sundial.rpm`.
- Ubuntu, Mint, Debian and other deb distros: **[Sundial.deb](https://github.com/zphat/Sundial/releases/latest/download/Sundial.deb)**. Open it with your software center, or `sudo apt install ./Sundial.deb`.
- Anything else (Arch, CachyOS, Bazzite, SteamOS desktop mode): **[Sundial.AppImage](https://github.com/zphat/Sundial/releases/latest/download/Sundial.AppImage)**. Run `chmod +x Sundial.AppImage` once, then start it like any program.

The AppImage updates itself; the rpm and the deb show a Download button in Settings when a new version is out. On Wayland, the default on Fedora KDE and GNOME, no app can register a system-wide shortcut, so Settings → General shows how to add one in your desktop's keyboard settings that runs `xdg-open sundial://quick-add`. The tray icon needs the appindicator library (`libayatana-appindicator3`); on GNOME it also needs the AppIndicator extension, and without a tray the close button quits. A Flatpak on Flathub is coming.

## In the browser

Sundial also runs at https://app.sundial.services, on a phone, a Mac or any PC, with nothing to install. It is the same app and the same account: sign in with your email and it joins your sync like another PC.

Your days live in that browser until you sign in to Sync. Clearing the site's data removes them, so turn Sync on if you want to keep them. On a phone, "Add to Home Screen" installs it with its own icon. On an iPhone the installed copy keeps its own data, so sign in to Sync before you install it. Safari also deletes the site's data on its own if you do not open it for seven days, unless Sundial is on the Home Screen; add it, or keep Sync on and keep the recovery code, which is what brings the synced copy back into a cleared browser.

Drag and drop does not work on phones yet. To move a task, open it and change the time or the day.

## Where your data lives

Everything is one file: `%APPDATA%\app.sundial.desktop\sundial.json`. On Linux it is `~/.local/share/app.sundial.desktop/sundial.json`. Paste `%APPDATA%\app.sundial.desktop` into the File Explorer address bar to open the folder. Next to the file, a `backups` folder keeps one copy for each day you used Sundial, the newest 30. On Linux the sync key and any AI key go to your desktop's keyring (KWallet or GNOME Keyring); if no keyring is running, they are kept in `secrets.json` next to the data file, readable only by your user account. Your tasks and notes don't leave your PC unless you turn Sync on. On its own the app only contacts github.com to check for updates; its fonts ship with it. [PRIVACY.md](PRIVACY.md) lists everything.

## Sync (optional)

Sync keeps the same days on more than one PC, and in the browser. You sign in with your email and a six-digit code; that's it, syncing starts.

Your tasks and notes are encrypted on your PC before they're sent. The key is made on your first PC and shown to you once as a recovery code; save it somewhere. The server, in Switzerland, holds your email address, the names of your PCs and encrypted data it can't read.

To add a second PC, or the web app, sign in there with the same email. Your first PC asks whether to approve it: type the code the new PC shows, then type the finish code on the new PC. No recovery code needed while a PC of yours is around. The recovery code is for when none is: a lost PC, or a fresh start. Nobody can recover it, including us. Lose it with no PC left signed in and the synced copy can't be opened; the data on your PCs is untouched.

Sync is free during the beta. After that it's $2.49 a month or $19.99 a year, and beta accounts keep $9.99 a year for as long as they stay subscribed. No card is asked for today.

What the server stores is written up in [PRIVACY.md](PRIVACY.md). You can also run your own server, see [server/README.md](server/README.md).

## Feedback

Email hello@sundial.services. The Send feedback button in Settings starts the email with the version number in the subject. Say what you did, what you expected and what happened. Bugs that aren't private can also go to https://github.com/zphat/Sundial/issues; issues are public, so keep private details out of them.

## For developers

Repo layout, build and release notes: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Sync protocol: [docs/SYNC-PROTOCOL.md](docs/SYNC-PROTOCOL.md). What comes next: [docs/ROADMAP.md](docs/ROADMAP.md).

The app (everything outside `server/`) is MIT licensed, see [LICENSE](LICENSE). The sync server in `server/` is AGPL-3.0, see [server/LICENSE](server/LICENSE).
