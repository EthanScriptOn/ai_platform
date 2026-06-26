#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${CONTENT_ASSET_APP_DIR:-${ROOT}/apps/content-assets-console}"
CONFIG_FILE="${CONTENT_ASSET_CONFIG_FILE:-${ROOT}/config/content-assets.local.json}"
ENV_FILE="${CONTENT_ASSET_LOCAL_ENV_PATH:-${ROOT}/config/content-assets.local.env}"
JSON_GET="${ROOT}/scripts/json-config-get.js"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "${NODE_BIN}" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  . "${ENV_FILE}"
  set +a
fi

APP_DIR="${CONTENT_ASSET_APP_DIR:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" CONTENT_ASSET_APP_DIR "${APP_DIR}")}"

PYTHON_BIN="${CONTENT_ASSET_PYTHON_BIN:-}"
if [ -z "${PYTHON_BIN}" ]; then
  JSON_PYTHON_BIN="$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" CONTENT_ASSET_PYTHON_BIN "")"
  for candidate in \
    "${JSON_PYTHON_BIN}" \
    "${CONTENT_ASSET_VENV_DIR:-${ROOT}/.venv-content-assets-console}/bin/python" \
    "${APP_DIR}/.venv/bin/python" \
    "$(command -v python3 || true)"
  do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
      PYTHON_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${PYTHON_BIN}" ]; then
  echo "content-assets python binary not found; set CONTENT_ASSET_PYTHON_BIN" >&2
  exit 1
fi

HOST="${CONTENT_ASSET_HOST:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" CONTENT_ASSET_HOST "127.0.0.1")}"
PORT="${CONTENT_ASSET_PORT:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" CONTENT_ASSET_PORT "8767")}"
CONFIG_PATH="${CONTENT_ASSET_CONFIG_PATH:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" CONTENT_ASSET_CONFIG_PATH "${APP_DIR}/config.server.local.yml")}"

cd "${APP_DIR}"
export CONTENT_ASSET_CONFIG_PATH="${CONFIG_PATH}"
exec "${PYTHON_BIN}" -m uvicorn tiktok_res_app.server_app:app --host "${HOST}" --port "${PORT}"
