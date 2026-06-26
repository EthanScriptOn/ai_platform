#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  uv venv --python 3.12 .venv
fi

uv pip install --python .venv/bin/python -r requirements.txt "fastapi>=0.100" "uvicorn>=0.23" "pydantic>=2.0" "playwright>=1.40.0"
.venv/bin/python -m playwright install chromium

exec .venv/bin/python -m uvicorn tiktok_res_app.app:app --host 127.0.0.1 --port 8765
