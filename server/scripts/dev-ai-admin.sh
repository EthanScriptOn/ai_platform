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

CONFIG_FILE="${AI_ADMIN_CONFIG_PATH:-${ROOT}/config/ai-admin.local.json}"
LEGACY_ENV_FILE="${AI_ADMIN_ENV_FILE:-}"

if [ -f "${LEGACY_ENV_FILE}" ]; then
  set -a
  . "${LEGACY_ENV_FILE}"
  set +a
fi

mkdir -p "${ROOT}/runtime/ragflow"

cd "${ROOT}"
export AI_ADMIN_CONFIG_PATH="${CONFIG_FILE}"
exec "${NODE_BIN}" server.js
