#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${FLOWBOT_CONFIG_PATH:-${ROOT}/../shared/flowbot.json}"

export FLOWBOT_CONFIG_PATH="${CONFIG_FILE}"
exec /bin/bash "${ROOT}/scripts/dev-flowbot-worker.sh"
