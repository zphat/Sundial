#!/usr/bin/env bash
# Starts the test copy built by build.sh: hidden in the tray, with WebView2's debug port open on localhost.
#   PORT=9333 tools/selftest/run.sh
# Stop it with the debug command: deno run -A tools/selftest/cdp.js 9333 "=http://tauri.localhost/" quit.js
# where quit.js holds:  await window.__TAURI__.core.invoke('dev_quit');
# (dev_quit exists in debug builds only and goes through the same quit as the tray menu.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${SUNDIAL_SELFTEST_DIR:-$ROOT/.selftest}"
cd "$OUT/target/debug"
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=${PORT:-9333}" exec ./sundial --minimized
