#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if [ ! -d ".venv" ]; then
  echo "[ZeppBridge] Creating Python virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q -r requirements.txt

echo "[ZeppBridge] Starting Zepp Auto-Sync Bridge on http://localhost:${ZEPP_BRIDGE_PORT:-8010} ..."
exec python3 server.py
