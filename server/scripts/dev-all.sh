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
CONFIG_FILE="${FLOWBOT_CONFIG_PATH:-${ROOT}/config/flowbot.local.json}"
MANAGED_ENV_FILE="${FLOWBOT_LOCAL_MANAGED_ENV_PATH:-${ROOT}/config/flowbot.local.env}"

DATA_DIR="${FLOWBOT_DATA_DIR:-$("${NODE_BIN}" "${ROOT}/scripts/json-config-get.js" "${CONFIG_FILE}" FLOWBOT_DATA_DIR "${ROOT}/data/customer-bot-data")}"
KNOWLEDGE_DIR="${FLOWBOT_KNOWLEDGE_DIR:-$("${NODE_BIN}" "${ROOT}/scripts/json-config-get.js" "${CONFIG_FILE}" FLOWBOT_KNOWLEDGE_DIR "${ROOT}/apps/flowbot-knowledge")}"

mkdir -p "${DATA_DIR}"

if [ -f "${MANAGED_ENV_FILE}" ]; then
  set -a
  . "${MANAGED_ENV_FILE}"
  set +a
fi

cleanup() {
  jobs -p | xargs -r kill
}
trap cleanup EXIT

FLOWBOT_HOST_VALUE="${FLOWBOT_HOST:-$("${NODE_BIN}" "${ROOT}/scripts/json-config-get.js" "${CONFIG_FILE}" FLOWBOT_HOST "127.0.0.1")}"
FLOWBOT_PORT_VALUE="${FLOWBOT_PORT:-$("${NODE_BIN}" "${ROOT}/scripts/json-config-get.js" "${CONFIG_FILE}" FLOWBOT_PORT "3010")}"
echo "==> Starting Flowbot on http://${FLOWBOT_HOST_VALUE}:${FLOWBOT_PORT_VALUE}"
(
  cd "${ROOT}/apps/flowbot-bridge"
  env \
    PORT="${FLOWBOT_PORT_VALUE}" \
    FLOWBOT_DATA_DIR="${DATA_DIR}" \
    FLOWBOT_KNOWLEDGE_DIR="${KNOWLEDGE_DIR}" \
    FLOWBOT_CONFIG_PATH="${CONFIG_FILE}" \
    FLOWBOT_LOCAL_MANAGED_ENV_PATH="${MANAGED_ENV_FILE}" \
    FLOWBOT_DASHBOARD_PUBLIC_URL="${FLOWBOT_DASHBOARD_PUBLIC_URL:-http://127.0.0.1:8788}" \
    "${NODE_BIN}" server.js
) &

echo "==> Starting Flowbot worker"
(
  cd "${ROOT}/apps/flowbot-bridge"
  env \
    FLOWBOT_AGENT_BASE_URL="${FLOWBOT_AGENT_BASE_URL:-http://${FLOWBOT_HOST_VALUE}:${FLOWBOT_PORT_VALUE}/flowbot/agent}" \
    FLOWBOT_CONFIG_PATH="${CONFIG_FILE}" \
    FLOWBOT_LOCAL_MANAGED_ENV_PATH="${MANAGED_ENV_FILE}" \
    "${NODE_BIN}" scripts/agent_task_worker.js
) &

echo "==> Starting platform API on http://${AI_ADMIN_HOST:-127.0.0.1}:${AI_ADMIN_PORT:-8788}"
(
  cd "${ROOT}"
  env \
    AI_ADMIN_PORT="${AI_ADMIN_PORT:-8788}" \
    AI_ADMIN_CONFIG_PATH="${ROOT}/config/ai-admin.local.json" \
    FLOWBOT_BASE_URL="${FLOWBOT_BASE_URL:-http://${FLOWBOT_HOST_VALUE}:${FLOWBOT_PORT_VALUE}}" \
    FLOWBOT_DATA_DIR="${DATA_DIR}" \
    FLOWBOT_KNOWLEDGE_DIR="${KNOWLEDGE_DIR}" \
    "${NODE_BIN}" server.js
) &

wait
