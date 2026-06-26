#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
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

FLOWBOT_LABEL="${FLOWBOT_LOCAL_LAUNCH_AGENT_LABEL:-com.yuebai.flowbot}"
FLOWBOT_WORKER_LABEL="${FLOWBOT_LOCAL_WORKER_LAUNCH_AGENT_LABEL:-com.yuebai.flowbot-worker}"
AI_ADMIN_LABEL="${AI_ADMIN_LAUNCH_AGENT_LABEL:-com.yuebai.ai-admin-platform}"
CONTENT_ASSET_LABEL="${CONTENT_ASSET_LAUNCH_AGENT_LABEL:-com.yuebai.content-assets-console}"

mkdir -p "${LAUNCH_AGENTS_DIR}"

write_plist() {
  local plist_path="$1"
  local label="$2"
  local workdir="$3"
  local out_log="$4"
  local err_log="$5"
  shift 5
  cat > "${plist_path}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${workdir}</string>
  <key>ProgramArguments</key>
  <array>
EOF
  for arg in "$@"; do
    printf '    <string>%s</string>\n' "${arg}" >> "${plist_path}"
  done
  cat >> "${plist_path}" <<EOF
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${out_log}</string>
  <key>StandardErrorPath</key>
  <string>${err_log}</string>
</dict>
</plist>
EOF
}

bootstrap_plist() {
  local plist_path="$1"
  launchctl bootout "gui/$(id -u)" "${plist_path}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${plist_path}"
}

AI_ADMIN_PLIST="${LAUNCH_AGENTS_DIR}/${AI_ADMIN_LABEL}.plist"
write_plist \
  "${AI_ADMIN_PLIST}" \
  "${AI_ADMIN_LABEL}" \
  "${ROOT}" \
  "/tmp/ai-admin-platform.log" \
  "/tmp/ai-admin-platform.err.log" \
  "/bin/bash" \
  "${ROOT}/scripts/dev-ai-admin.sh"
bootstrap_plist "${AI_ADMIN_PLIST}"

FLOWBOT_PLIST="${LAUNCH_AGENTS_DIR}/${FLOWBOT_LABEL}.plist"
write_plist \
  "${FLOWBOT_PLIST}" \
  "${FLOWBOT_LABEL}" \
  "${ROOT}" \
  "/tmp/yuebai-flowbot.log" \
  "/tmp/yuebai-flowbot.err.log" \
  "/bin/bash" \
  "${ROOT}/scripts/dev-flowbot.sh"
bootstrap_plist "${FLOWBOT_PLIST}"

FLOWBOT_WORKER_PLIST="${LAUNCH_AGENTS_DIR}/${FLOWBOT_WORKER_LABEL}.plist"
write_plist \
  "${FLOWBOT_WORKER_PLIST}" \
  "${FLOWBOT_WORKER_LABEL}" \
  "${ROOT}" \
  "/tmp/yuebai-flowbot-worker.log" \
  "/tmp/yuebai-flowbot-worker.err.log" \
  "/bin/bash" \
  "${ROOT}/scripts/dev-flowbot-worker.sh"
bootstrap_plist "${FLOWBOT_WORKER_PLIST}"

CONTENT_ASSET_PLIST="${LAUNCH_AGENTS_DIR}/${CONTENT_ASSET_LABEL}.plist"
write_plist \
  "${CONTENT_ASSET_PLIST}" \
  "${CONTENT_ASSET_LABEL}" \
  "${ROOT}" \
  "/tmp/content-assets-console.launchd.log" \
  "/tmp/content-assets-console.launchd.err.log" \
  "/bin/bash" \
  "${ROOT}/scripts/dev-content-assets-console.sh"
bootstrap_plist "${CONTENT_ASSET_PLIST}"

echo "本地 LaunchAgents 已按当前环境生成并加载："
echo "- ${AI_ADMIN_LABEL}"
echo "- ${FLOWBOT_LABEL}"
echo "- ${FLOWBOT_WORKER_LABEL}"
echo "- ${CONTENT_ASSET_LABEL}"
