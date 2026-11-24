#!/usr/bin/env bash
# Builds a private test copy of the desktop app that cannot touch an installed Sundial.
#
#   own identifier        -> its own data folder, WebView2 profile and single-instance lock
#   own link scheme       -> the installed app keeps sundial://
#   own keyring service   -> it never reads or writes the installed app's sync key or API keys
#   main window hidden    -> it runs in the tray; drive it through the debug port (run.sh, cdp.js)
#
# The assets are embedded and served the way a release serves them (the custom-protocol feature), so the
# Content-Security-Policy and the IPC behave as in an installed build. See docs/DEVELOPMENT.md, "Testing a real build".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${SUNDIAL_SELFTEST_DIR:-$ROOT/.selftest}"

rm -rf "$OUT/src"
mkdir -p "$OUT/src"
# A copy, so the working tree's Cargo.toml stays as it is. The signing key is not needed and is left behind.
(cd "$ROOT" && tar cf - --exclude=src-tauri/target --exclude=src-tauri/updater.key src-tauri ui) | (cd "$OUT/src" && tar xf -)
# The library is built as an rlib only. The other kinds are for mobile, and GNU ld cannot link the debug cdylib on
# Windows ("export ordinal too large").
sed -i 's/^crate-type = .*/crate-type = ["rlib"]/' "$OUT/src/src-tauri/Cargo.toml"
grep -q 'option_env!("SUNDIAL_KEYRING_SERVICE")' "$OUT/src/src-tauri/src/lib.rs" || {
  echo "lib.rs has no keyring override: refusing to build a copy that would share the installed app's secrets" >&2
  exit 1
}

export TAURI_CONFIG='{"identifier":"app.sundial.desktop.selftest","productName":"Sundial Selftest","plugins":{"deep-link":{"desktop":{"schemes":["sundial-selftest"]}}},"app":{"windows":[{"label":"main","title":"Sundial Selftest","width":1000,"height":720,"minWidth":720,"minHeight":520,"center":true,"dragDropEnabled":false,"backgroundColor":"#0B0C0B","visible":false,"skipTaskbar":true}]}}'
export SUNDIAL_KEYRING_SERVICE="SundialSelftest"
export CARGO_TARGET_DIR="$OUT/target"
cd "$OUT/src/src-tauri"
cargo build --features tauri/custom-protocol "$@"
# Windows, GNU toolchain: the binary needs WebView2Loader.dll beside it. The build script copies it only when it runs,
# which a cached build skips.
if [ ! -f "$OUT/target/debug/WebView2Loader.dll" ]; then
  dll="$(find "$OUT/target/debug/build" -path "*webview2-com-sys*/out/x64/WebView2Loader.dll" 2>/dev/null | head -n 1)"
  if [ -n "$dll" ]; then cp "$dll" "$OUT/target/debug/"; fi
fi
echo "built: $OUT/target/debug/sundial"
