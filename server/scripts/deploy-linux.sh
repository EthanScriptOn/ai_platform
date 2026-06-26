#!/usr/bin/env bash
set -euo pipefail

APP_NAME="yuebai-ai-platform"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/${APP_NAME}}"
RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${INSTALL_ROOT}/releases/${RELEASE_ID}"
SHARED_DIR="${INSTALL_ROOT}/shared"
CURRENT_LINK="${INSTALL_ROOT}/current"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${WEB_DIR:-$(cd "${REPO_DIR}/.." && pwd)/yuebai-ai-tool-platform-web}"
USER_NAME="${DEPLOY_USER:-yfduser}"
INSTALL_FLOWBOT="${INSTALL_FLOWBOT:-1}"
INSTALL_CONTENT_ASSETS="${INSTALL_CONTENT_ASSETS:-1}"
INSTALL_INTEL_API="${INSTALL_INTEL_API:-1}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PYTHON3_BIN="${PYTHON3_BIN:-$(command -v python3.11 || command -v python3 || true)}"

if [ -z "${NODE_BIN}" ]; then
  for candidate in /usr/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${PYTHON3_BIN}" ]; then
  for candidate in /usr/bin/python3.11 /usr/local/bin/python3.11 /usr/bin/python3 /usr/local/bin/python3; do
    if [ -x "${candidate}" ]; then
      PYTHON3_BIN="${candidate}"
      break
    fi
  done
fi

render_service_template() {
  local src="$1"
  local dest="$2"
  sudo sed \
    -e "s|__INSTALL_ROOT__|${INSTALL_ROOT}|g" \
    -e "s|__DEPLOY_USER__|${USER_NAME}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    "${src}" > "${dest}"
}

copy_config_if_missing() {
  local src="$1"
  local dest="$2"
  if [ ! -f "${dest}" ]; then
    sudo cp "${src}" "${dest}"
    echo "==> Created ${dest}"
  fi
}

echo "==> Building ${APP_NAME} backend"
cd "${REPO_DIR}"
npm install

if [ -d "${WEB_DIR}" ]; then
  echo "==> Building ${APP_NAME} frontend from ${WEB_DIR}"
  (cd "${WEB_DIR}" && npm install && npm run build)
else
  echo "==> Frontend project not found at ${WEB_DIR}; static dist will not be refreshed."
fi

echo "==> Creating release ${RELEASE_DIR}"
sudo mkdir -p "${RELEASE_DIR}" "${SHARED_DIR}" "${INSTALL_ROOT}/apps" "${INSTALL_ROOT}/data"
sudo rsync -a \
  --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude 'config/*.local.env' \
  --exclude collector/yuebai-wechat-collector \
  "${REPO_DIR}/" "${RELEASE_DIR}/"

if [ -d "${WEB_DIR}/dist" ]; then
  sudo rsync -a --delete "${WEB_DIR}/dist/" "${RELEASE_DIR}/dist/"
fi

copy_config_if_missing "${REPO_DIR}/config/ai-admin.local.example.json" "${SHARED_DIR}/ai-admin.json"
copy_config_if_missing "${REPO_DIR}/config/flowbot.local.example.json" "${SHARED_DIR}/flowbot.json"
copy_config_if_missing "${REPO_DIR}/config/content-assets.local.json" "${SHARED_DIR}/content-assets.json"
copy_config_if_missing "${REPO_DIR}/config/intel-api.local.example.json" "${SHARED_DIR}/intel-api.json"
copy_config_if_missing "${REPO_DIR}/deploy/env.example" "${SHARED_DIR}/.env"

sudo ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}"
sudo chown -R "${USER_NAME}:${USER_NAME}" "${INSTALL_ROOT}"
sudo chmod +x \
  "${CURRENT_LINK}/scripts/dev-ai-admin.sh" \
  "${CURRENT_LINK}/scripts/prod-intel-api.sh" \
  "${CURRENT_LINK}/scripts/dev-flowbot.sh" \
  "${CURRENT_LINK}/scripts/dev-flowbot-worker.sh" \
  "${CURRENT_LINK}/scripts/dev-content-assets-console.sh" \
  "${CURRENT_LINK}/scripts/prod-flowbot.sh" \
  "${CURRENT_LINK}/scripts/prod-flowbot-worker.sh" \
  "${CURRENT_LINK}/scripts/prod-content-assets-console.sh"

echo "==> Installing platform systemd service"
render_service_template \
  "${REPO_DIR}/deploy/yuebai-ai-platform.service" \
  /etc/systemd/system/yuebai-ai-platform.service

if [ "${INSTALL_FLOWBOT}" = "1" ]; then
  if [ -d "${RELEASE_DIR}/apps/flowbot-bridge" ]; then
    echo "==> Installing Flowbot managed module services"
    sudo mkdir -p "${INSTALL_ROOT}/data/customer-bot-data"
    render_service_template \
      "${REPO_DIR}/deploy/wecom-flowbot.service" \
      /etc/systemd/system/wecom-flowbot.service
    render_service_template \
      "${REPO_DIR}/deploy/wecom-flowbot-agent-worker.service" \
      /etc/systemd/system/wecom-flowbot-agent-worker.service
  else
    echo "==> apps/flowbot-bridge not found in release; skipped Flowbot service install."
  fi
fi

if [ "${INSTALL_CONTENT_ASSETS}" = "1" ]; then
  if [ -d "${RELEASE_DIR}/apps/content-assets-console" ]; then
    echo "==> Installing Content Assets managed module service"
    sudo mkdir -p \
      "${INSTALL_ROOT}/data/content-assets/downloads" \
      "${INSTALL_ROOT}/data/content-assets/runtime" \
      "${INSTALL_ROOT}/venvs"
    sudo "${PYTHON3_BIN}" -m venv "${INSTALL_ROOT}/venvs/content-assets"
    sudo "${INSTALL_ROOT}/venvs/content-assets/bin/python" -m pip install --upgrade pip
    sudo "${INSTALL_ROOT}/venvs/content-assets/bin/python" -m pip install \
      -r "${RELEASE_DIR}/apps/content-assets-console/requirements.txt" \
      fastapi uvicorn pydantic
    render_service_template \
      "${REPO_DIR}/deploy/content-assets.service" \
      /etc/systemd/system/content-assets.service
  else
    echo "==> apps/content-assets-console not found in release; skipped Content Assets service install."
  fi
fi

if [ "${INSTALL_INTEL_API}" = "1" ]; then
  if [ -d "${RELEASE_DIR}/apps/intel-api-service" ]; then
    echo "==> Installing Intel API managed service"
    sudo mkdir -p "${INSTALL_ROOT}/venvs"
    sudo "${PYTHON3_BIN}" -m venv "${INSTALL_ROOT}/venvs/intel-api"
    sudo "${INSTALL_ROOT}/venvs/intel-api/bin/python" -m pip install --upgrade pip
    sudo "${INSTALL_ROOT}/venvs/intel-api/bin/python" -m pip install \
      -r "${RELEASE_DIR}/apps/intel-api-service/requirements.txt" \
      httpx beautifulsoup4
    render_service_template \
      "${REPO_DIR}/deploy/intel-api.service" \
      /etc/systemd/system/intel-api.service
  else
    echo "==> apps/intel-api-service not found in release; skipped Intel API service install."
  fi
fi

sudo chown -R "${USER_NAME}:${USER_NAME}" "${INSTALL_ROOT}"

echo "==> Restarting services"
sudo systemctl daemon-reload
sudo systemctl enable yuebai-ai-platform.service
sudo systemctl restart yuebai-ai-platform.service

if [ "${INSTALL_FLOWBOT}" = "1" ] && [ -f /etc/systemd/system/wecom-flowbot.service ]; then
  sudo systemctl enable wecom-flowbot.service wecom-flowbot-agent-worker.service
  sudo systemctl restart wecom-flowbot.service wecom-flowbot-agent-worker.service
fi

if [ "${INSTALL_CONTENT_ASSETS}" = "1" ] && [ -f /etc/systemd/system/content-assets.service ]; then
  sudo systemctl enable content-assets.service
  sudo systemctl restart content-assets.service
fi

if [ "${INSTALL_INTEL_API}" = "1" ] && [ -f /etc/systemd/system/intel-api.service ]; then
  sudo systemctl enable intel-api.service
  sudo systemctl restart intel-api.service
fi

echo "==> Done"
echo "Platform: http://127.0.0.1:8788"
echo "Configs:"
echo "- ${SHARED_DIR}/ai-admin.json"
echo "- ${SHARED_DIR}/flowbot.json"
echo "- ${SHARED_DIR}/content-assets.json"
echo "- ${SHARED_DIR}/intel-api.json"
