#!/bin/bash
set -euo pipefail

BASE_URL="${YUEBAI_AI_PLATFORM_URL:-http://47.104.81.250}"
INSTALL_DIR="$HOME/.yuebai/wechat-collector"
PLIST="$HOME/Library/LaunchAgents/com.yuebai.wechat-collector.plist"
BINARY="$INSTALL_DIR/yuebai-wechat-collector"
CERT="$INSTALL_DIR/ca.crt"

mkdir -p "$INSTALL_DIR"
curl -fsSL "$BASE_URL/install/yuebai-wechat-collector-darwin-arm64" -o "$BINARY"
chmod +x "$BINARY"
printf "%s" "$BASE_URL" > "$INSTALL_DIR/platform_url"

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

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"

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
    if osascript -e "do shell script \"$TRUST_CMD\" with administrator privileges"; then
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
echo "状态接口：http://127.0.0.1:18765/api/status"
