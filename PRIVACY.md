# Sundial privacy

Last updated 2026-10-24. This page covers the Sundial app for Windows and Linux, the web app at app.sundial.services and the optional Sundial Sync service. All three are run by zphat during the beta.

## What Sundial stores on your PC

Your tasks, daily notes, label names, routines and settings live in one file, `%APPDATA%\app.sundial.desktop\sundial.json`. On Linux the file is `~/.local/share/app.sundial.desktop/sundial.json`. A `backups` folder next to it keeps one copy for each day you used Sundial and deletes all but the newest 30 itself. If you turn Sync on, your sign-in token is kept in that file, and the key that encrypts your data is kept in Windows Credential Manager on Windows, or on Linux in your desktop's keyring (KWallet or GNOME Keyring, through the Secret Service). If no keyring service is running (no KWallet or GNOME Keyring on the session bus), Sundial keeps it instead in `secrets.json` next to the data file, readable only by your user account.

The app makes one kind of request on its own: to github.com, to check for updates shortly after launch and every six hours. GitHub's own privacy statement covers that request. The fonts ship with the app; earlier versions fetched them from fonts.googleapis.com and fonts.gstatic.com, the current one contacts Google for nothing.

If you turn on AI parsing in Settings, the text you type into the add box is sent to the provider you picked (Anthropic, OpenAI or a server you name) with your own API key. The key is kept in Windows Credential Manager, or in the desktop keyring on Linux. If no keyring is running, it goes in `secrets.json` next to the data file, readable only by your user account.

Nothing else leaves your PC unless you turn Sync on. The microphone button: if the system web view offers a speech engine (Windows does; the Linux web view does not), Sundial uses it for the words and the audio goes wherever that engine sends it; without one, only the level meter runs and no audio leaves your PC. Turn Voice off in Settings if you do not want the microphone used at all.

## The web app (app.sundial.services)

The web app is the same Sundial, served from the same server in Switzerland. No other host is involved: no CDN, no analytics, no cookies and no request to any third party on its own. The server sends a Content-Security-Policy that lets the page load only its own files and talk only to https servers you choose, such as Sync or an AI provider you set up. One exception is voice input: while the microphone button is lit, the browser's own speech engine turns your words into text. In Chrome that sends the audio to Google, in Edge to Microsoft, in Safari to Apple. Nothing is sent while the button is off, and with Voice turned off in Settings Sundial never opens the microphone.

Your days are kept in that browser's site storage for app.sundial.services. When Sync is on, the sign-in token, the sync key and the recovery code are kept there too, because a browser has no credential store; so is an AI key if you enter one. Anyone who can read this browser's data for the site, such as an extension you installed or a person using the device while it is unlocked, can read them too. On a shared device, sign out of Sync when you are done. Clearing the site's data removes all of it. The synced copy stays on the server and comes back when you sign in again and either approve the browser from another device or enter the recovery code, so keep the recovery code. Safari deletes a site's data on its own if you do not open the site for seven days, unless Sundial is on the Home Screen. A copy installed from Safari's Add to Home Screen has its own storage, separate from the browser tab.

A service worker keeps a copy of the app's own files in your browser, so it opens without a connection. It never caches anything from Sync or an AI provider. Reminders fire only while a tab is open or the installed app is running.

What the server logs for the web app is the same masked access log as for Sync, described under Logs: time, method and path without its query string, response status, IP address cut to /24 or /48, kept 14 days. Request headers, the browser's user agent string among them, are not logged.

## What Sundial Sync stores

Sync is off until you turn it on. When you do, the server keeps:

- your email address;
- an account salt, a random public number your PC uses to turn your recovery code into a key;
- for each PC or browser you sign in: a hashed sign-in token, a device id, the device name and the platform (for a browser, something like "Chrome on Windows"), when it signed in and when it last synced;
- your data as ciphertext: each task, each day's note, your label names and your routines, encrypted on your PC before upload. Each encrypted item also carries an id, a type (task, note, labels or routines), a last-changed time, a sequence number, which of your PCs sent it and when the server received it, so your PCs can tell what's new. A note's id is its date.

There's no payment during the beta, so there are no card details to store.

## What we can and cannot see

Your data is encrypted on your PC with AES-256-GCM. The key is made on your PC from a recovery code the app invents (or a passphrase you typed, in older versions) with PBKDF2. The recovery code and the key are never sent. When you approve a second PC from the first, the key travels inside an end-to-end handshake between the two PCs; the server relays bytes it cannot open. We can't read your tasks, notes, label names or routines, and we can't reset or recover your recovery code. If you lose it and have no PC left that is signed in, nobody can open the synced copy; the copy on each of your PCs keeps working.

We can see your email address, the names of your PCs, when each one last synced, how many encrypted items you have, which days have a note, and the masked IP addresses in the logs described below.

## Email

The only email Sundial sends is the six-digit sign-in code, from sign-in@sundial.services. It goes out through Resend, a US company, so your address and the code pass through Resend's systems in the United States. The sync server itself runs on an Exoscale virtual machine in Switzerland.

## Logs

The sync server doesn't log request bodies. The reverse proxy in front of it keeps an access log with the time, the method and path without its query string (so sign-in codes never land in it), the response status and size, and a masked IP address: IPv4 addresses are cut to /24 (the last number dropped), IPv6 addresses to /48. Request headers are dropped before the entry is written, so the browser's user agent string and language are not kept. Entries are deleted after 14 days.

## Backups

On your PC: the 30 daily copies described above. Delete them yourself if you don't want them.

On the server: the database is backed up every night on the same machine and kept 30 days, so deleted data can remain in those backups for a time. A second copy is being set up: each night an encrypted copy goes to Exoscale object storage in a second Swiss zone (ch-dk-2), kept 30 days. It is encrypted on the server before upload with a key the storage provider does not have, and it stays in Switzerland.

## Deleting your account

Deleting your sync account removes your email, your devices' tokens and all of your encrypted data from the server. The data on your PCs stays. In Settings, under Data & sync, choose Erase synced copy; it asks for a fresh sign-in code, then deletes the account on the server. Or email the contact below from the address on the account; we'll confirm it's you first.

Signing out on a PC removes that PC's token from the server; the account and its encrypted data stay until the account is deleted.

## Contact

hello@sundial.services. Bugs that aren't private can also go to https://github.com/zphat/Sundial/issues; issues are public, so don't post your email address or anything private there.

## Changes

This page changes when the app or the service changes. The date at the top moves, and the change is mentioned in the release notes of the version that ships it.
