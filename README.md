# Sundial

Days · tasks · notes. A calendar and to-do app that is fast enough to actually use.
"Sundial" is a placeholder name until a final one is chosen.

Live prototype (same link every version): https://claude.ai/artifact/HzhVqj4tbdPWainYbfEDBt

## What is here

- `ui/` — the whole app as it runs today. Open `ui/sundial.html` through a local server
  (not double-click; the scripts need http). Files: `sundial.html` (shell), `styles.css`,
  `data.js` (state, parser, undo, oplog, recurrence, reminders, import/export),
  `audio.js` (synthesized sounds + voice capture), `ui.js` (rendering, events, banners, settings, search).

## Decisions so far (2026-10-12)

- Desktop first (Windows), then web + mobile companions. Same UI code everywhere.
- Desktop shell: **Tauri 2** = a small native wrapper around the `ui/` files that produces a
  normal `Sundial-Setup.exe` (and later `.dmg`, iOS/Android). ~6 MB, uses the WebView2 engine
  already on Windows 11.
- Local-first. No account needed, ever. Optional paid "Sundial Sync" later, plus a free
  "bring your own server" option. Open-source candidate (Obsidian-style: free app, paid sync).
- AI parsing: optional, user supplies their own API key (Anthropic or OpenAI-compatible).
- Sync readiness is already in the data layer: UUIDs, `updatedAt`, device id, append-only
  change log (`oplog`), tombstones for deletes, newest-wins merge on import.

## Next session: build the Windows app

Machine check done on 2026-10-12: WebView2 present, git present, **no Rust, no C++ Build Tools,
no Node, no winget**. Two one-time installs are needed before the first `.exe`:

1. Microsoft C++ Build Tools (~6 GB, admin prompt): https://aka.ms/vs/17/release/vs_BuildTools.exe
   with the "Desktop development with C++" workload.
2. Rust via rustup (~1 GB, no admin): https://win.rustup.rs/x86_64

Alternative with zero local installs: GitHub Actions builds the `.exe` on every push.

Then: `cargo install tauri-cli --version "^2"`, scaffold `src-tauri/` (storage in
`%APPDATA%\Sundial\sundial.json` with daily backups, tray icon, close-to-tray, system-wide
`Ctrl+Space` quick add, native notifications, start-with-Windows, API keys in Windows
Credential Manager, auto-update plumbing), `cargo tauri build` → `src-tauri/target/release/bundle/nsis/`.

Code signing (so Windows doesn't warn on install): Azure Trusted Signing (~$10/mo) when ready to share.
