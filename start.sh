#!/usr/bin/env bash
# Starts the VSWarehouse Token Monitor and opens it in the browser.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

URL="http://localhost:${PORT:-4173}"
echo "Starting Token Monitor at $URL"

( sleep 1 && xdg-open "$URL" >/dev/null 2>&1 ) &

node server.js
