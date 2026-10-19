# Code signing policy

Sundial's Windows installer is not code-signed yet, which is why Windows shows its "Windows protected your PC" box once on first run. This page is the policy that will apply once signing is in place, written to the requirements of the [SignPath Foundation](https://signpath.org), which provides free code signing certificates to open source projects.

## Program statement

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

In plain words: the Windows app contacts github.com to check for updates. Everything else, Sync and AI parsing included, happens only after you turn it on in Settings. [PRIVACY.md](../PRIVACY.md) lists every request the app makes.

## Signing

Free code signing on Windows provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). Until the project is accepted, releases are unsigned, and the installer's integrity rests on the auto-updater's minisign signature (public key in `src-tauri/updater.pub`) and on GitHub's release checksums.

Every release is built from a tagged commit on the public repository by GitHub Actions ([build.yml](../.github/workflows/build.yml)); no binary is built or signed on a personal machine. The signing step requires a manual approval by an approver for each release.

## Team roles

| Role | Who |
| --- | --- |
| Committers and reviewers | [zphat](https://github.com/zphat) |
| Approvers | [zphat](https://github.com/zphat) |

The project has a single maintainer during the beta. Two-factor authentication is enabled on the GitHub account that owns the repository and on the accounts that can trigger a release.

## Privacy policy

[PRIVACY.md](../PRIVACY.md), also linked from the app's Settings and from https://sundial.services.

## Where this page is linked

https://sundial.services (home and download page) and the repository README, as the SignPath terms ask.
