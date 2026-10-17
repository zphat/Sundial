# Sundial privacy

Last updated 2026-10-17. This page covers the Sundial app for Windows and the optional Sundial Sync service. Both are run by zphat during the beta.

## What Sundial stores on your PC

Your tasks, daily notes, label names, routines and settings live in one file, `%APPDATA%\app.sundial.desktop\sundial.json`. A `backups` folder next to it keeps one copy for each day you used Sundial and deletes all but the newest 30 itself. If you turn Sync on, your sign-in token is kept in that file, and the key that encrypts your data is kept in Windows Credential Manager.

The app makes two kinds of request on its own: to github.com, to check for updates shortly after launch and every six hours, and to fonts.googleapis.com and fonts.gstatic.com for the fonts it uses. GitHub's and Google's own privacy statements cover those requests.

If you turn on AI parsing in Settings, the text you type into the add box is sent to the provider you picked (Anthropic, OpenAI or a server you name) with your own API key. The key is kept in Windows Credential Manager.

Nothing else leaves your PC unless you turn Sync on.

## What Sundial Sync stores

Sync is off until you turn it on. When you do, the server keeps:

- your email address;
- an account salt, a random public number your PC uses to turn your recovery code into a key;
- for each PC you sign in: a hashed sign-in token, a device id, the device name and the platform, when it signed in and when it last synced;
- your data as ciphertext: each task, each day's note, your label names and your routines, encrypted on your PC before upload. Each encrypted item also carries an id, a type (task, note, labels or routines), a last-changed time, a sequence number, which of your PCs sent it and when the server received it, so your PCs can tell what's new. A note's id is its date.

There's no payment during the beta, so there are no card details to store.

## What we can and cannot see

Your data is encrypted on your PC with AES-256-GCM. The key is made on your PC from a recovery code the app invents (or a passphrase you typed, in older versions) with PBKDF2. The recovery code and the key are never sent. When you approve a second PC from the first, the key travels inside an end-to-end handshake between the two PCs; the server relays bytes it cannot open. We can't read your tasks, notes, label names or routines, and we can't reset or recover your recovery code. If you lose it and have no PC left that is signed in, nobody can open the synced copy; the copy on each of your PCs keeps working.

We can see your email address, the names of your PCs, when each one last synced, how many encrypted items you have, which days have a note, and the masked IP addresses in the logs described below.

## Email

The only email Sundial sends is the six-digit sign-in code, from sign-in@sundial.services. It goes out through Resend, a US company, so your address and the code pass through Resend's systems in the United States. The sync server itself runs on an Exoscale virtual machine in Switzerland.

## Logs

The sync server doesn't log request bodies. The reverse proxy in front of it keeps an access log with the time, the path without its query string (so sign-in codes never land in it) and a masked IP address: IPv4 addresses are cut to /24 (the last number dropped), IPv6 addresses to /48. Entries are deleted after 14 days.

## Backups

On your PC: the 30 daily copies described above. Delete them yourself if you don't want them.

On the server: the database is backed up every night on the same machine, so deleted data can remain in those backups for a time. Backups to a second location are planned.

## Deleting your account

Deleting your sync account removes your email, your devices' tokens and all of your encrypted data from the server. The data on your PCs stays. In Settings, under Data & sync, choose Erase synced copy; it asks for a fresh sign-in code, then deletes the account on the server. Or ask through the contact below; we'll confirm you control the email address first, privately, not in a public issue.

Signing out on a PC removes that PC's token from the server; the account and its encrypted data stay until the account is deleted.

## Contact

https://github.com/zphat/Sundial/issues for now. An email address is coming. Issues are public, so don't post your email address or anything private there; say you need a private channel and we'll set one up.

## Changes

This page changes when the app or the service changes. The date at the top moves, and the change is mentioned in the release notes of the version that ships it.
