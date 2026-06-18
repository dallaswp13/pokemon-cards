#!/usr/bin/env bash
# Double-click launcher (macOS) — starts the Flask server and opens the browser.
set -euo pipefail
cd "$(dirname "$0")"
python3 app/server.py &
SERVER_PID=$!
sleep 1
open "http://localhost:5050"
trap "kill $SERVER_PID 2>/dev/null || true" EXIT
wait $SERVER_PID
