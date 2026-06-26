#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${CONTENT_ASSET_CONFIG_FILE:-${ROOT}/../shared/content-assets.json}"

export CONTENT_ASSET_CONFIG_FILE="${CONFIG_FILE}"
exec /bin/bash "${ROOT}/scripts/dev-content-assets-console.sh"
