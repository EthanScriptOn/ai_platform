package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func platformBaseURL() string {
	if strings.TrimSpace(os.Getenv("YUEBAI_DISABLE_REMOTE_CONTROL")) == "1" {
		return ""
	}
	if value := strings.TrimSpace(os.Getenv("YUEBAI_AI_PLATFORM_URL")); value != "" {
		return strings.TrimRight(value, "/")
	}
	configPath := filepath.Join(installDir(), "platform_url")
	if raw, err := os.ReadFile(configPath); err == nil {
		return strings.TrimRight(strings.TrimSpace(string(raw)), "/")
	}
	return ""
}

func remoteClientID() string {
	path := filepath.Join(installDir(), "client_id")
	if raw, err := os.ReadFile(path); err == nil {
		if value := strings.TrimSpace(string(raw)); value != "" {
			return value
		}
	}
	hostName, _ := os.Hostname()
	value := fmt.Sprintf("%s-%s-%s", appName, sanitizeFilename(hostName), shortID(time.Now().String()))
	_ = os.WriteFile(path, []byte(value), 0600)
	return value
}

func remoteControlLoop(platform string) {
	clientID := remoteClientID()
	client := &http.Client{Timeout: 15 * time.Second}
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	_ = postRemoteStatus(client, platform, clientID)
	for {
		select {
		case <-ticker.C:
			_ = postRemoteStatus(client, platform, clientID)
			command, err := fetchRemoteCommand(client, platform, clientID)
			if err != nil || command.Noop || command.ID == "" {
				continue
			}
			payload := executeRemoteCommand(command)
			_ = postRemoteCommandResult(client, platform, clientID, command.ID, payload)
		}
	}
}

type remoteCommand struct {
	ID      string `json:"id"`
	Path    string `json:"path"`
	Options struct {
		Method  string            `json:"method"`
		Body    string            `json:"body"`
		Headers map[string]string `json:"headers"`
	} `json:"options"`
	Noop bool `json:"noop"`
}

func postRemoteStatus(client *http.Client, platform string, clientID string) error {
	return postRemoteJSON(client, platform+"/api/wechat-video/agent/status", map[string]any{
		"clientId": clientID,
		"status":   statusPayload(),
	})
}

func fetchRemoteCommand(client *http.Client, platform string, clientID string) (remoteCommand, error) {
	var out struct {
		OK      bool          `json:"ok"`
		Command remoteCommand `json:"command"`
	}
	reqURL := platform + "/api/wechat-video/agent/command?clientId=" + url.QueryEscape(clientID)
	resp, err := client.Get(reqURL)
	if err != nil {
		return remoteCommand{}, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return remoteCommand{}, err
	}
	if !out.Command.Noop && out.Command.ID != "" {
		log.Printf("received remote command: id=%s path=%s", out.Command.ID, out.Command.Path)
	}
	return out.Command, nil
}

func postRemoteCommandResult(client *http.Client, platform string, clientID string, commandID string, payload map[string]any) error {
	return postRemoteJSON(client, platform+"/api/wechat-video/agent/command-result", map[string]any{
		"clientId":  clientID,
		"commandId": commandID,
		"payload":   payload,
	})
}

func postRemoteJSON(client *http.Client, endpoint string, payload any) error {
	body, _ := json.Marshal(payload)
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("remote HTTP %d", resp.StatusCode)
	}
	return nil
}

func executeRemoteCommand(command remoteCommand) map[string]any {
	pathOnly := command.Path
	if parsed, err := url.Parse(command.Path); err == nil {
		pathOnly = parsed.Path
	}
	switch pathOnly {
	case "/api/status", "/api/app-info":
		return statusPayload()
	case "/api/clear":
		state.mu.Lock()
		state.captures = []capture{}
		state.seen = map[string]bool{}
		state.suppressUntil = time.Now().Add(8 * time.Second)
		log.Printf("captures cleared (remote command)")
		persistCollectorStateLocked()
		state.mu.Unlock()
		return clearResponsePayload("捕获列表已清空，采集保持开启；新的资源会继续进入列表。")
	case "/api/set-type":
		var body struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal([]byte(command.Options.Body), &body)
		if body.Type == "" {
			body.Type = "all"
		}
		state.mu.Lock()
		state.selectedType = body.Type
		persistCollectorStateLocked()
		state.mu.Unlock()
		return statusPayload()
	case "/api/trust-cert":
		if err := trustCertificate(); err != nil {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = err.Error()
			return payload
		}
		return statusPayload()
	case "/api/proxy-open", "/api/start":
		if runtime.GOOS == "darwin" && !certTrusted() {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = "本地 HTTPS 证书尚未被系统信任，暂不能启动采集。请先点击“信任证书”。"
			return payload
		}
		err := setSystemProxy(true)
		state.mu.Lock()
		if err == nil {
			setListeningLocked(true, "remote start")
		}
		state.mu.Unlock()
		payload := statusPayload()
		if err != nil {
			payload["ok"] = false
			payload["message"] = err.Error()
		}
		return payload
	case "/api/proxy-unset", "/api/stop":
		err := setSystemProxy(false)
		state.mu.Lock()
		if err == nil {
			setListeningLocked(false, "remote stop")
		}
		state.mu.Unlock()
		payload := statusPayload()
		if err != nil {
			payload["ok"] = false
			payload["message"] = err.Error()
		}
		return payload
	case "/api/download":
		var body struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(command.Options.Body), &body)
		if body.ID == "" {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = "missing id"
			return payload
		}
		if err := startDownload(body.ID); err != nil {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = err.Error()
			return payload
		}
		return statusPayload()
	case "/api/preview-data":
		var body struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(command.Options.Body), &body)
		if body.ID == "" {
			if parsed, err := url.Parse(command.Path); err == nil {
				body.ID = parsed.Query().Get("id")
			}
		}
		payload, err := capturePreviewData(body.ID)
		if err != nil {
			status := statusPayload()
			status["ok"] = false
			status["message"] = err.Error()
			return status
		}
		return payload
	case "/api/reveal":
		id := ""
		if parsed, err := url.Parse(command.Path); err == nil {
			id = parsed.Query().Get("id")
		}
		if err := revealCapture(id); err != nil {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = err.Error()
			return payload
		}
		return statusPayload()
	default:
		payload := statusPayload()
		payload["ok"] = false
		payload["message"] = "unknown command"
		return payload
	}
}
