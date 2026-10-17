# Sundial

Sundial is a calendar, a task list and a page of notes for each day, in one window. It is fast, and it works without an internet connection. Everything you type is saved on your own PC. It runs on Windows only, and it is a beta: expect rough edges, and say so when you find them.

## Download for Windows

**[Download Sundial-Setup.exe](https://github.com/zphat/Sundial/releases/latest/download/Sundial-Setup.exe)**

Sundial isn't signed with a paid certificate yet, so Windows doesn't know it. The first time, you may see two warnings:

1. Edge may say the file "isn't commonly downloaded". Choose **Keep**, then **Show more**, then **Keep anyway**.
2. Windows may show a blue box titled "Windows protected your PC". Click **More info**, then **Run anyway**.

The warning means Windows hasn't seen this app before. It isn't a virus detection. The installer needs no admin password and installs for your user only. Updates are signed and install on their own.

If Windows says Smart App Control blocked the file, there's no Run anyway button. Don't change any settings. That PC can't run Sundial until a signed build exists.

## Where your data lives

Everything is one file: `%APPDATA%\app.sundial.desktop\sundial.json`. Paste `%APPDATA%pp.sundial.desktop` into the File Explorer address bar to open the folder. Next to the file, a `backups` folder keeps one copy for each day you used Sundial, the newest 30. Your tasks and notes don't leave your PC unless you turn Sync on. On its own the app only contacts github.com to check for updates and Google for its fonts; [PRIVACY.md](PRIVACY.md) lists everything.

## Sync (optional)

Sync keeps the same days on more than one Windows PC. You sign in with your email and a six-digit code, then choose a passphrase.

Your tasks and notes are encrypted on your PC with that passphrase before they're sent. The server, in Switzerland, holds your email address, the names of your PCs and encrypted data it can't read.

Nobody can recover the passphrase, including us. Lose it and the synced copy can't be opened; the data on your PCs is untouched.

Sync is free during the beta. After that it's $2.49 a month or $19.99 a year, and beta accounts keep $9.99 a year for as long as they stay subscribed. No card is asked for today.

What the server stores is written up in [PRIVACY.md](PRIVACY.md). You can also run your own server, see [server/README.md](server/README.md).

## Feedback

Open an issue at https://github.com/zphat/Sundial/issues. Say what you did, what you expected and what happened; the version number is in Settings. An email address for feedback is coming. Issues are public, so keep private details out of them.

## For developers

Repo layout, build and release notes: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Sync protocol: [docs/SYNC-PROTOCOL.md](docs/SYNC-PROTOCOL.md).

The app (everything outside `server/`) is MIT licensed, see [LICENSE](LICENSE). The sync server in `server/` is AGPL-3.0, see [server/LICENSE](server/LICENSE).
