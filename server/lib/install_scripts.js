"use strict";

function createInstallScriptRenderer({
  CONTENT_ASSET_LOCAL_HOST,
  CONTENT_ASSET_LOCAL_HTTPS_PORT,
  HOST,
  PORT,
  WECHAT_COLLECTOR_INSTALL_BASE_URL,
  WECHAT_COLLECTOR_LOCAL_HOST,
  WECHAT_COLLECTOR_LOCAL_HTTPS_PORT,
  createContentAssetToken,
  createWechatCollectorToken,
}) {
  function collectorInstallBaseUrl() {
    return String(WECHAT_COLLECTOR_INSTALL_BASE_URL || `http://${HOST}:${PORT}`).trim().replace(/\/+$/, "");
  }
  
  function renderWechatCollectorMacInstallScript(token = "") {
    const baseUrl = collectorInstallBaseUrl();
    const safeToken = String(token || "").trim() || createWechatCollectorToken();
    return `#!/bin/bash
  set -euo pipefail
  
  BASE_URL="\${YUEBAI_AI_PLATFORM_URL:-${baseUrl}}"
  CLIENT_TOKEN="\${YUEBAI_WECHAT_COLLECTOR_TOKEN:-${safeToken}}"
  LOCAL_HOST="${WECHAT_COLLECTOR_LOCAL_HOST}"
  INSTALL_DIR="$HOME/.yuebai/wechat-collector"
  PLIST="$HOME/Library/LaunchAgents/com.yuebai.wechat-collector.plist"
  BINARY="$INSTALL_DIR/yuebai-wechat-collector"
  CERT="$INSTALL_DIR/ca.crt"
  HOSTS_HELPER="$INSTALL_DIR/update-hosts.sh"
  
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "$BASE_URL/install/yuebai-wechat-collector-darwin-arm64" -o "$BINARY"
  chmod +x "$BINARY"
  printf "%s" "$BASE_URL" > "$INSTALL_DIR/platform_url"
  printf "%s" "$CLIENT_TOKEN" > "$INSTALL_DIR/client_token"
  
  cat > "$HOSTS_HELPER" <<'EOF'
  #!/bin/bash
  set -euo pipefail
  HOST_NAME="${WECHAT_COLLECTOR_LOCAL_HOST}"
  if ! grep -qE "(^|[[:space:]])\${HOST_NAME}([[:space:]]|$)" /etc/hosts; then
    printf "\\n127.0.0.1 %s\\n::1 %s\\n" "\${HOST_NAME}" "\${HOST_NAME}" >> /etc/hosts
  fi
  EOF
  chmod +x "$HOSTS_HELPER"
  if "$HOSTS_HELPER" >/dev/null 2>&1; then
    echo "本地域名已配置：$LOCAL_HOST -> 127.0.0.1"
  else
    echo "正在触发系统授权以配置本地域名..."
    osascript -e "do shell script \\"'$HOSTS_HELPER'\\" with administrator privileges" >/dev/null
    echo "本地域名已配置：$LOCAL_HOST -> 127.0.0.1"
  fi
  
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yuebai.wechat-collector</string>
    <key>ProgramArguments</key>
    <array>
      <string>$BINARY</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>YUEBAI_AI_PLATFORM_URL</key>
      <string>$BASE_URL</string>
      <key>YUEBAI_WECHAT_COLLECTOR_TOKEN</key>
      <string>$CLIENT_TOKEN</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/stderr.log</string>
  </dict>
  </plist>
  EOF
  
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/com.yuebai.wechat-collector" >/dev/null 2>&1 || true
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  pkill -f "$BINARY" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST"
  launchctl kickstart -k "$DOMAIN/com.yuebai.wechat-collector" >/dev/null 2>&1 || true
  
  for i in $(seq 1 20); do
    if [ -f "$CERT" ]; then
      break
    fi
    sleep 0.3
  done
  
  if [ -f "$CERT" ]; then
    echo "正在触发系统授权以信任本地 HTTPS 证书..."
    security add-trusted-cert -p ssl -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT" >/dev/null 2>&1 || true
    if security verify-cert -c "$CERT" >/dev/null 2>&1; then
      echo "本地 HTTPS 证书已信任。"
    else
      TRUST_CMD="security add-trusted-cert -p ssl -d -r trustRoot -k /Library/Keychains/System.keychain '$CERT'"
      if osascript -e "do shell script \\"$TRUST_CMD\\" with administrator privileges"; then
        if security verify-cert -c "$CERT" >/dev/null 2>&1; then
          echo "本地 HTTPS 证书已信任。"
          echo "请完全退出并重新打开微信或浏览器，然后再启动采集服务。"
        else
          echo "系统授权已完成，但证书校验仍未通过；请稍后刷新页面或重试安装命令。"
        fi
      else
        echo "证书信任未完成：请在系统授权弹窗里输入电脑密码后重试。"
      fi
    fi
  fi
  
  echo "悦拜视频号采集后台包已安装并启动。"
  echo "本机后台包：https://${WECHAT_COLLECTOR_LOCAL_HOST}:${WECHAT_COLLECTOR_LOCAL_HTTPS_PORT}/api/status"
  echo "采集代理：http://${WECHAT_COLLECTOR_LOCAL_HOST}:18765/proxy.pac"
  echo "平台绑定：$BASE_URL"
  `;
  }
  
  function renderWechatCollectorWindowsInstallScript(token = "") {
    const baseUrl = collectorInstallBaseUrl();
    const safeToken = String(token || "").trim() || createWechatCollectorToken();
    return `$ErrorActionPreference = "Stop"
  
  $BaseUrl = $env:YUEBAI_AI_PLATFORM_URL
  if (-not $BaseUrl) { $BaseUrl = "${baseUrl}" }
  $ClientToken = $env:YUEBAI_WECHAT_COLLECTOR_TOKEN
  if (-not $ClientToken) { $ClientToken = "${safeToken}" }
  $LocalHostName = "${WECHAT_COLLECTOR_LOCAL_HOST}"
  
  $InstallDir = Join-Path $env:LOCALAPPDATA "Yuebai\\WechatCollector"
  $Collector = Join-Path $InstallDir "yuebai-wechat-collector.exe"
  
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Invoke-WebRequest -Uri "$BaseUrl/install/yuebai-wechat-collector-windows-amd64.exe" -OutFile $Collector
  Set-Content -Path (Join-Path $InstallDir "platform_url") -Value $BaseUrl -NoNewline
  Set-Content -Path (Join-Path $InstallDir "client_token") -Value $ClientToken -NoNewline
  [Environment]::SetEnvironmentVariable("YUEBAI_AI_PLATFORM_URL", $BaseUrl, "User")
  [Environment]::SetEnvironmentVariable("YUEBAI_WECHAT_COLLECTOR_TOKEN", $ClientToken, "User")
  
  $HostsPath = Join-Path $env:WINDIR "System32\\drivers\\etc\\hosts"
  $HostsText = if (Test-Path $HostsPath) { Get-Content $HostsPath -Raw } else { "" }
  if ($HostsText -notmatch "(^|\\s)$([regex]::Escape($LocalHostName))(\\s|$)") {
    $Append = [Environment]::NewLine + "127.0.0.1 $LocalHostName" + [Environment]::NewLine + "::1 $LocalHostName" + [Environment]::NewLine
    try {
      Add-Content -Path $HostsPath -Value $Append -ErrorAction Stop
      Write-Host "本地域名已配置：$LocalHostName -> 127.0.0.1"
    } catch {
      Write-Host "需要管理员权限配置本地域名，正在请求授权..."
      $Command = "Add-Content -Path '$HostsPath' -Value '$Append'"
      Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command \\"$Command\\""
      Write-Host "本地域名已配置：$LocalHostName -> 127.0.0.1"
    }
  }
  
  $Action = New-ScheduledTaskAction -Execute $Collector
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel LeastPrivilege
  Register-ScheduledTask -TaskName "YuebaiWechatCollector" -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null
  Stop-ScheduledTask -TaskName "YuebaiWechatCollector" -ErrorAction SilentlyContinue
  Get-Process "yuebai-wechat-collector" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName "YuebaiWechatCollector"
  
  Write-Host "悦拜视频号采集后台包已安装并启动。"
  Write-Host "本机后台包：https://${WECHAT_COLLECTOR_LOCAL_HOST}:${WECHAT_COLLECTOR_LOCAL_HTTPS_PORT}/api/status"
  Write-Host "采集代理：http://${WECHAT_COLLECTOR_LOCAL_HOST}:18765/proxy.pac"
  Write-Host "平台绑定：$BaseUrl"
  `;
  }
  
  function renderDouyinCollectorMacInstallScript(token = "") {
    const baseUrl = collectorInstallBaseUrl();
    const safeToken = String(token || "").trim() || createContentAssetToken();
    return `#!/bin/bash
  set -euo pipefail
  
  BASE_URL="\${YUEBAI_AI_PLATFORM_URL:-${baseUrl}}"
  CLIENT_TOKEN="\${YUEBAI_CONTENT_ASSET_TOKEN:-${safeToken}}"
  LOCAL_HOST="${CONTENT_ASSET_LOCAL_HOST}"
  LOCAL_HTTPS_PORT="${CONTENT_ASSET_LOCAL_HTTPS_PORT}"
  INSTALL_DIR="$HOME/.yuebai/douyin-collector"
  APP_DIR="$INSTALL_DIR/app"
  VENV_DIR="$INSTALL_DIR/.venv"
  CONFIG_PATH="$INSTALL_DIR/config.local.yml"
  PLIST="$HOME/Library/LaunchAgents/com.yuebai.douyin-collector.plist"
  MEDIA_PLIST="$HOME/Library/LaunchAgents/com.yuebai.douyin-collector-media.plist"
  PYTHON_BIN="\${PYTHON_BIN:-$(command -v python3 || true)}"
  CLIENT_ID="\${YUEBAI_COLLECTOR_CLIENT_ID:-$(hostname)-$(whoami)}"
  CERT="$INSTALL_DIR/local-media.crt"
  KEY="$INSTALL_DIR/local-media.key"
  OPENSSL_CONFIG="$INSTALL_DIR/local-media-openssl.cnf"
  HOSTS_HELPER="$INSTALL_DIR/update-hosts.sh"
  
  if [ -z "$PYTHON_BIN" ]; then
    echo "未找到 python3，请先安装 Python 3。"
    exit 1
  fi
  
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "$BASE_URL/install/yuebai-douyin-collector-app.tar.gz" -o "$INSTALL_DIR/app.tar.gz"
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  tar -xzf "$INSTALL_DIR/app.tar.gz" -C "$APP_DIR"
  mkdir -p "$INSTALL_DIR/Downloaded"
  
  cat > "$HOSTS_HELPER" <<EOF
  #!/bin/bash
  set -euo pipefail
  HOST_NAME="$LOCAL_HOST"
  TMP_FILE="\\$(mktemp)"
  awk -v host="\\\${HOST_NAME}" '{
    found = 0
    for (i = 1; i <= NF; i += 1) {
      if (\\$i == host) {
        found = 1
        break
      }
    }
    if (!found) {
      print
    }
  }' /etc/hosts > "\\\${TMP_FILE}"
  cat "\\\${TMP_FILE}" > /etc/hosts
  rm -f "\\\${TMP_FILE}"
  printf "\\n127.0.0.1 %s\\n" "\\\${HOST_NAME}" >> /etc/hosts
  EOF
  chmod +x "$HOSTS_HELPER"
  if "$HOSTS_HELPER" >/dev/null 2>&1; then
    echo "本地域名已配置：$LOCAL_HOST -> 127.0.0.1"
  else
    echo "正在触发系统授权以配置本地域名..."
    osascript -e "do shell script \\"'$HOSTS_HELPER'\\" with administrator privileges" >/dev/null
    echo "本地域名已配置：$LOCAL_HOST -> 127.0.0.1"
  fi
  
  cat > "$OPENSSL_CONFIG" <<EOF
  [req]
  distinguished_name = req_distinguished_name
  x509_extensions = v3_req
  prompt = no
  [req_distinguished_name]
  CN = $LOCAL_HOST
  [v3_req]
  subjectAltName = @alt_names
  [alt_names]
  DNS.1 = $LOCAL_HOST
  DNS.2 = localhost
  IP.1 = 127.0.0.1
  EOF
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout "$KEY" -out "$CERT" -config "$OPENSSL_CONFIG" >/dev/null 2>&1
  
  cat > "$CONFIG_PATH" <<EOF
  path: "$INSTALL_DIR/Downloaded"
  database: false
  mysql:
    enabled: false
  platform:
    enabled: true
    base_url: "$BASE_URL"
    token: "$CLIENT_TOKEN"
    client_id: "$CLIENT_ID"
    timeout_seconds: 20
  EOF
  
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -r "$APP_DIR/requirements.txt" fastapi uvicorn pydantic
  "$VENV_DIR/bin/python" -m playwright install chromium
  
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yuebai.douyin-collector</string>
    <key>ProgramArguments</key>
    <array>
      <string>$VENV_DIR/bin/python</string>
      <string>-m</string>
      <string>uvicorn</string>
      <string>tiktok_res_app.server_app:app</string>
      <string>--host</string>
      <string>127.0.0.1</string>
      <string>--port</string>
      <string>8767</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CONTENT_ASSET_CONFIG_PATH</key>
      <string>$CONFIG_PATH</string>
      <key>YUEBAI_AI_PLATFORM_URL</key>
      <string>$BASE_URL</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/stderr.log</string>
  </dict>
  </plist>
  EOF
  
  cat > "$MEDIA_PLIST" <<EOF
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yuebai.douyin-collector-media</string>
    <key>ProgramArguments</key>
    <array>
      <string>$VENV_DIR/bin/python</string>
      <string>-m</string>
      <string>uvicorn</string>
      <string>tiktok_res_app.server_app:app</string>
      <string>--host</string>
      <string>127.0.0.1</string>
      <string>--port</string>
      <string>$LOCAL_HTTPS_PORT</string>
      <string>--ssl-certfile</string>
      <string>$CERT</string>
      <string>--ssl-keyfile</string>
      <string>$KEY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CONTENT_ASSET_CONFIG_PATH</key>
      <string>$CONFIG_PATH</string>
      <key>YUEBAI_AI_PLATFORM_URL</key>
      <string>$BASE_URL</string>
      <key>CONTENT_ASSET_DISABLE_PLATFORM_AGENT</key>
      <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/media-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/media-stderr.log</string>
  </dict>
  </plist>
  EOF
  
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl unload "$MEDIA_PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  launchctl load "$MEDIA_PLIST"
  
  echo "正在触发系统授权以信任本地 HTTPS 预览证书..."
  security add-trusted-cert -p ssl -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT" >/dev/null 2>&1 || true
  if security verify-cert -c "$CERT" >/dev/null 2>&1; then
    echo "本地 HTTPS 预览证书已信任。"
  else
    TRUST_CMD="security add-trusted-cert -p ssl -d -r trustRoot -k /Library/Keychains/System.keychain '$CERT'"
    osascript -e "do shell script \\"$TRUST_CMD\\" with administrator privileges" >/dev/null || true
  fi
  
  echo "悦拜抖音采集本机服务已安装并启动。"
  echo "状态接口：http://127.0.0.1:8767/api/health"
  echo "预览接口：https://${CONTENT_ASSET_LOCAL_HOST}:${CONTENT_ASSET_LOCAL_HTTPS_PORT}/api/media"
  echo "平台绑定：$BASE_URL"
  `;
  }
  
  function renderDouyinCollectorWindowsInstallScript(token = "") {
    const baseUrl = collectorInstallBaseUrl();
    const safeToken = String(token || "").trim() || createContentAssetToken();
    return `$ErrorActionPreference = "Stop"
  
  $BaseUrl = $env:YUEBAI_AI_PLATFORM_URL
  if (-not $BaseUrl) { $BaseUrl = "${baseUrl}" }
  $ClientToken = $env:YUEBAI_CONTENT_ASSET_TOKEN
  if (-not $ClientToken) { $ClientToken = "${safeToken}" }
  
  $InstallDir = Join-Path $env:LOCALAPPDATA "Yuebai\\DouyinCollector"
  $AppDir = Join-Path $InstallDir "app"
  $VenvDir = Join-Path $InstallDir ".venv"
  $Archive = Join-Path $InstallDir "app.tar.gz"
  $ConfigPath = Join-Path $InstallDir "config.local.yml"
  $StartScript = Join-Path $InstallDir "start.ps1"
  $ClientId = $env:YUEBAI_COLLECTOR_CLIENT_ID
  if (-not $ClientId) { $ClientId = "$env:COMPUTERNAME-$env:USERNAME" }
  
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Invoke-WebRequest -Uri "$BaseUrl/install/yuebai-douyin-collector-app.tar.gz" -OutFile $Archive
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  tar -xzf $Archive -C $AppDir
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "Downloaded") | Out-Null
  
  @"
  path: "$($InstallDir -replace '\\\\','/')/Downloaded"
  database: false
  mysql:
    enabled: false
  platform:
    enabled: true
    base_url: "$BaseUrl"
    token: "$ClientToken"
    client_id: "$ClientId"
    timeout_seconds: 20
  "@ | Set-Content -Path $ConfigPath -Encoding utf8
  
  $Python = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $Python) { $Python = (Get-Command py -ErrorAction SilentlyContinue).Source }
  if (-not $Python) { throw "未找到 Python，请先安装 Python 3。" }
  
  & $Python -m venv $VenvDir
  $VenvPython = Join-Path $VenvDir "Scripts\\python.exe"
  & $VenvPython -m pip install --upgrade pip
  & $VenvPython -m pip install -r (Join-Path $AppDir "requirements.txt") fastapi uvicorn pydantic
  & $VenvPython -m playwright install chromium
  
  @(
    '$env:CONTENT_ASSET_CONFIG_PATH = "' + $ConfigPath + '"'
    '$env:YUEBAI_AI_PLATFORM_URL = "' + $BaseUrl + '"'
    '& "' + $VenvPython + '" -m uvicorn tiktok_res_app.server_app:app --host 127.0.0.1 --port 8767'
  ) | Set-Content -Path $StartScript -Encoding utf8
  
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $StartScript + '"') -WorkingDirectory $AppDir
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel LeastPrivilege
  Register-ScheduledTask -TaskName "YuebaiDouyinCollector" -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null
  Start-ScheduledTask -TaskName "YuebaiDouyinCollector"
  
  Write-Host "悦拜抖音采集本机服务已安装并启动。"
  Write-Host "状态接口：http://127.0.0.1:8767/api/health"
  Write-Host "平台绑定：$BaseUrl"
  `;
  }

  return {
    collectorInstallBaseUrl,
    renderDouyinCollectorMacInstallScript,
    renderDouyinCollectorWindowsInstallScript,
    renderWechatCollectorMacInstallScript,
    renderWechatCollectorWindowsInstallScript,
  };
}

module.exports = {
  createInstallScriptRenderer,
};
