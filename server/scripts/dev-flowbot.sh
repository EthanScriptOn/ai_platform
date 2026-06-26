#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "node binary not found in PATH" >&2
  exit 1
fi
DEFAULT_CONFIG_FILE="${ROOT}/config/flowbot.local.json"
if [ -z "${FLOWBOT_CONFIG_PATH:-}" ] && [ -f "/opt/yuebai-ai-platform/shared/flowbot.json" ]; then
  DEFAULT_CONFIG_FILE="/opt/yuebai-ai-platform/shared/flowbot.json"
fi
CONFIG_FILE="${FLOWBOT_CONFIG_PATH:-${DEFAULT_CONFIG_FILE}}"
LEGACY_ENV_FILE="${FLOWBOT_LOCAL_MANAGED_ENV_PATH:-${ROOT}/config/flowbot.local.env}"
JSON_GET="${ROOT}/scripts/json-config-get.js"

if [ -f "${LEGACY_ENV_FILE}" ]; then
  set -a
  . "${LEGACY_ENV_FILE}"
  set +a
fi

DATA_DIR="${FLOWBOT_DATA_DIR:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" FLOWBOT_DATA_DIR "${ROOT}/data/customer-bot-data")}"
KNOWLEDGE_DIR="${FLOWBOT_KNOWLEDGE_DIR:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" FLOWBOT_KNOWLEDGE_DIR "${ROOT}/apps/flowbot-knowledge")}"
HOST="${FLOWBOT_HOST:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" FLOWBOT_HOST "127.0.0.1")}"
PORT_VALUE="${FLOWBOT_PORT:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" FLOWBOT_PORT "3010")}"
BASE_URL="${FLOWBOT_BASE_URL:-$("${NODE_BIN}" "${JSON_GET}" "${CONFIG_FILE}" FLOWBOT_BASE_URL "http://${HOST}:${PORT_VALUE}")}"

mkdir -p "${DATA_DIR}"

cd "${ROOT}/apps/flowbot-bridge"
env \
  PORT="${PORT_VALUE}" \
  FLOWBOT_BASE_URL="${BASE_URL}" \
  FLOWBOT_DATA_DIR="${DATA_DIR}" \
  FLOWBOT_KNOWLEDGE_DIR="${KNOWLEDGE_DIR}" \
  FLOWBOT_CONFIG_PATH="${CONFIG_FILE}" \
  FLOWBOT_LOCAL_MANAGED_ENV_PATH="${LEGACY_ENV_FILE}" \
  "${NODE_BIN}" server.js
