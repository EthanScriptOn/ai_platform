#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${INTEL_API_VENV_DIR:-/opt/yuebai-ai-platform/venvs/intel-api}"
CONFIG_FILE="${INTEL_API_CONFIG_PATH:-/opt/yuebai-ai-platform/shared/intel-api.json}"
HOST="${INTEL_API_HOST:-127.0.0.1}"
PORT="${INTEL_API_PORT:-8010}"

if [ -f "${ROOT}/shared/.env" ]; then
  set -a
  . "${ROOT}/shared/.env"
  set +a
fi

if [ -f "/opt/yuebai-ai-platform/shared/.env" ]; then
  set -a
  . "/opt/yuebai-ai-platform/shared/.env"
  set +a
fi

export INTEL_API_CONFIG_PATH="${CONFIG_FILE}"
cd "${ROOT}/apps/intel-api-service"
exec "${VENV_DIR}/bin/python" -m uvicorn app:app --host "${HOST}" --port "${PORT}"
