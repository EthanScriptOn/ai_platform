#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

HOST="${1:-0.0.0.0}"
PORT="${2:-8765}"

exec .venv/bin/python -m uvicorn tiktok_res_app.server_app:app --host "$HOST" --port "$PORT"
