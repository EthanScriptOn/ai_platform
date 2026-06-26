package main

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

func writeMediaHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type")
}

func statusMessage(listening bool, trusted bool) string {
	if runtime.GOOS == "darwin" && !trusted {
		return "后台包已安装，但本地 HTTPS 证书尚未被系统信任；信任证书后才能捕获视频号资源。"
	}
	if listening {
		return "本机代理已打开。请完全退出并重新打开微信或浏览器后，再浏览视频号；捕获结果会回传到这里。"
	}
	return "后台包已安装，等待从网页启动采集服务。若刚完成证书信任，请先完全退出并重新打开微信或浏览器。"
}

func certTrusted() bool {
	if runtime.GOOS != "darwin" {
		return true
	}
	certPath := filepath.Join(installDir(), "ca.crt")
	if _, err := os.Stat(certPath); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "security", "verify-cert", "-c", certPath).Run() == nil
}

func trustCertificate() error {
	certPath := filepath.Join(installDir(), "ca.crt")
	if _, err := os.Stat(certPath); err != nil {
		return fmt.Errorf("证书文件不存在：%s", certPath)
	}
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(
			`do shell script %q with administrator privileges`,
			"security add-trusted-cert -p ssl -d -r trustRoot -k /Library/Keychains/System.keychain "+shellQuote(certPath),
		)
		if err := run("osascript", "-e", script); err != nil {
			return fmt.Errorf("证书信任失败：请在系统授权弹窗中输入电脑密码后重试。%v", err)
		}
		loginKeychain := filepath.Join(os.Getenv("HOME"), "Library", "Keychains", "login.keychain-db")
		_ = run("security", "add-trusted-cert", "-p", "ssl", "-r", "trustRoot", "-k", loginKeychain, certPath)
	case "windows":
		if err := run("certutil", "-addstore", "-f", "Root", certPath); err != nil {
			return fmt.Errorf("证书信任失败：请用管理员权限运行后重试。%v", err)
		}
	default:
		return fmt.Errorf("当前系统暂不支持自动信任证书：%s", runtime.GOOS)
	}
	if !certTrusted() {
		return errors.New("系统尚未确认信任证书，请稍后刷新状态或重试")
	}
	return nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func writeJSON(w http.ResponseWriter, payload any, status ...int) {
	body, _ := json.Marshal(payload)
	code := http.StatusOK
	if len(status) > 0 {
		code = status[0]
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func writeJSONP(w http.ResponseWriter, r *http.Request, payload any, status ...int) {
	callback := r.URL.Query().Get("_jsonp")
	if callback == "" {
		writeJSON(w, payload, status...)
		return
	}
	if !regexp.MustCompile(`^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$`).MatchString(callback) {
		writeJSON(w, map[string]any{"ok": false, "error": "invalid callback"}, http.StatusBadRequest)
		return
	}
	body, _ := json.Marshal(payload)
	code := http.StatusOK
	if len(status) > 0 {
		code = status[0]
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.WriteHeader(code)
	_, _ = fmt.Fprintf(w, "%s(%s);", callback, body)
}

func isLocalAPI(r *http.Request) bool {
	return strings.HasPrefix(r.URL.Path, "/api/") &&
		(r.Host == net.JoinHostPort(host, port) || strings.HasPrefix(r.Host, host+":") || r.Host == "localhost:"+port)
}

func setSystemProxy(enable bool) error {
	if runtime.GOOS != "darwin" {
		state.mu.Lock()
		setListeningLocked(enable, "non-darwin proxy toggle")
		state.mu.Unlock()
		return nil
	}
	services, err := networkServices()
	if err != nil {
		return err
	}
	for _, service := range services {
		if enable {
			if err := run("networksetup", "-setwebproxy", service, host, port); err != nil {
				return err
			}
			if err := run("networksetup", "-setsecurewebproxy", service, host, port); err != nil {
				return err
			}
			_ = run("networksetup", "-setautoproxystate", service, "off")
			_ = run("networksetup", "-setwebproxystate", service, "on")
			_ = run("networksetup", "-setsecurewebproxystate", service, "on")
		} else {
			_ = run("networksetup", "-setautoproxystate", service, "off")
			_ = run("networksetup", "-setwebproxystate", service, "off")
			_ = run("networksetup", "-setsecurewebproxystate", service, "off")
		}
	}
	state.mu.Lock()
	setListeningLocked(enable, "system proxy toggle")
	state.mu.Unlock()
	return nil
}

func systemProxyEnabled() bool {
	if runtime.GOOS != "darwin" {
		state.mu.Lock()
		defer state.mu.Unlock()
		return state.listening
	}
	out, err := exec.Command("scutil", "--proxy").Output()
	if err != nil {
		return false
	}
	text := string(out)
	return strings.Contains(text, "HTTPEnable : 1") &&
		strings.Contains(text, "HTTPSEnable : 1") &&
		strings.Contains(text, "HTTPProxy : "+host) &&
		strings.Contains(text, "HTTPSProxy : "+host) &&
		strings.Contains(text, "HTTPPort : "+port) &&
		strings.Contains(text, "HTTPSPort : "+port)
}

func networkServices() ([]string, error) {
	out, err := exec.Command("networksetup", "-listallnetworkservices").Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(out), "\n")
	services := []string{}
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "*") || strings.Contains(line, "Serial Port") {
			continue
		}
		info, err := exec.Command("networksetup", "-getinfo", line).Output()
		if err != nil || !strings.Contains(string(info), "IP address:") {
			continue
		}
		services = append(services, line)
	}
	if len(services) == 0 {
		return nil, errors.New("没有找到可配置的网络服务")
	}
	return services, nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s failed: %v %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func installDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".yuebai", "wechat-collector")
}

func md5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

func shortID(value string) string {
	sum := sha1.Sum([]byte(value + time.Now().String()))
	return strings.ToUpper(hex.EncodeToString(sum[:])[:16])
}

func topLevelDomain(rawURL string) string {
	value := rawURL
	if idx := strings.Index(value, "://"); idx >= 0 {
		value = value[idx+3:]
	}
	value = strings.Split(value, "/")[0]
	parts := strings.Split(value, ".")
	if len(parts) >= 2 {
		return strings.Join(parts[len(parts)-2:], ".")
	}
	return value
}
