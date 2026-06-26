#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${FLOWBOT_MYSQL_DOCKER_CONTAINER:-local-mysql}"
DOCKER_BIN="${FLOWBOT_DOCKER_BIN:-$(command -v docker || true)}"

if [ -z "${DOCKER_BIN}" ]; then
  for candidate in /usr/local/bin/docker /opt/homebrew/bin/docker; do
    if [ -x "${candidate}" ]; then
      DOCKER_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${DOCKER_BIN}" ]; then
  echo "docker binary not found in PATH" >&2
  exit 1
fi

exec "${DOCKER_BIN}" exec -i -e MYSQL_PWD="${MYSQL_PWD:-}" "${CONTAINER}" mysql "$@"
