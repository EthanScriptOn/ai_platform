package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"
)

const (
	host        = "127.0.0.1"
	port        = "18765"
	appName     = "yuebai-wechat-collector"
	version     = "0.2.0-mitm"
	maxCaptures = 1000
)

var (
	mediaGetterRe   = regexp.MustCompile(`get\s*media\(\)\{`)
	commentDetailRe = regexp.MustCompile(`async\s*finderGetCommentDetail\((\w+)\)\s*\{return(.*?)\s*}\s*async`)
	mediaHookPath   = "/res-" + "down" + "loader/wechat"
	mediaHookURL    = "https://wxapp.tc.qq.com" + mediaHookPath
	state           = &collectorState{startedAt: time.Now(), selectedType: "all", seen: map[string]bool{}}
)

type collectorState struct {
	mu            sync.Mutex
	startedAt     time.Time
	listening     bool
	selectedType  string
	captures      []capture
	seen          map[string]bool
	suppressUntil time.Time
}

type persistedCollectorState struct {
	Listening    bool      `json:"listening"`
	SelectedType string    `json:"selectedType"`
	Captures     []capture `json:"captures"`
}

type capture struct {
	ID             string            `json:"id"`
	URL            string            `json:"url"`
	CoverURL       string            `json:"coverUrl,omitempty"`
	Description    string            `json:"description,omitempty"`
	Classify       string            `json:"classify"`
	Suffix         string            `json:"suffix"`
	Size           float64           `json:"size,omitempty"`
	Domain         string            `json:"domain,omitempty"`
	DecodeKey      string            `json:"decodeKey,omitempty"`
	ContentType    string            `json:"contentType,omitempty"`
	CapturedAt     string            `json:"capturedAt"`
	DownloadStatus string            `json:"downloadStatus"`
	Progress       int               `json:"progress"`
	Downloaded     float64           `json:"downloaded,omitempty"`
	SavePath       string            `json:"savePath,omitempty"`
	Error          string            `json:"error,omitempty"`
	OtherData      map[string]string `json:"otherData,omitempty"`
}

func stableCaptureID(rawURL string) string {
	return shortID(captureIdentitySign(rawURL))
}

func clearResponsePayload(message string) map[string]any {
	trusted := certTrusted()
	proxyEnabled := systemProxyEnabled()
	state.mu.Lock()
	if proxyEnabled {
		setListeningLocked(true, "proxy probe")
	}
	defer state.mu.Unlock()
	return map[string]any{
		"ok":                 true,
		"connected":          true,
		"installed":          true,
		"listening":          state.listening,
		"selectedType":       state.selectedType,
		"certificateTrusted": trusted,
		"certificatePath":    filepath.Join(installDir(), "ca.crt"),
		"captures":           []capture{},
		"message":            message,
	}
}

func main() {
	if err := configureCA(); err != nil {
		log.Fatalf("configure ca: %v", err)
	}
	loadCollectorState()
	if platform := platformBaseURL(); platform != "" {
		go remoteControlLoop(platform)
	}

	proxy := goproxy.NewProxyHttpServer()
	proxy.Verbose = false
	proxy.OnRequest().HandleConnectFunc(func(target string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
		if shouldMitm(target) {
			return goproxy.MitmConnect, target
		}
		return goproxy.OkConnect, target
	})
	proxy.OnRequest().DoFunc(onProxyRequest)
	proxy.OnResponse().DoFunc(onProxyResponse)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/proxy.pac" {
			writePAC(w)
			return
		}
		if r.URL.Path == "/bridge.html" {
			writeBridge(w)
			return
		}
		if isLocalAPI(r) {
			handleAPI(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})

	addr := net.JoinHostPort(host, port)
	log.Printf("%s %s listening on http://%s", appName, version, addr)
	log.Fatal(http.ListenAndServe(addr, handler))
}

func handleAPI(w http.ResponseWriter, r *http.Request) {
	writeAPIJSON := func(payload any, status ...int) {
		writeJSONP(w, r, payload, status...)
	}
	if r.Method == http.MethodOptions {
		writeAPIJSON(map[string]any{"ok": true})
		return
	}
	switch r.URL.Path {
	case "/api/app-info", "/api/status":
		writeAPIJSON(statusPayload())
	case "/api/is-proxy":
		state.mu.Lock()
		value := state.listening
		state.mu.Unlock()
		writeAPIJSON(map[string]any{"ok": true, "data": map[string]bool{"value": value}})
	case "/api/captures":
		state.mu.Lock()
		captures := cloneCaptures(state.captures)
		state.mu.Unlock()
		writeAPIJSON(map[string]any{"ok": true, "captures": captures})
	case "/api/clear":
		state.mu.Lock()
		state.captures = []capture{}
		state.seen = map[string]bool{}
		state.suppressUntil = time.Now().Add(8 * time.Second)
		log.Printf("captures cleared (local api)")
		persistCollectorStateLocked()
		state.mu.Unlock()
		writeAPIJSON(clearResponsePayload("捕获列表已清空，采集保持开启；新的资源会继续进入列表。"))
	case "/api/download":
		var body struct {
			ID string `json:"id"`
		}
		_ = decodeRequestBody(r, &body)
		if body.ID == "" {
			body.ID = r.URL.Query().Get("id")
		}
		if body.ID == "" {
			writeAPIJSON(map[string]any{"ok": false, "error": "missing id"}, http.StatusBadRequest)
			return
		}
		if err := startDownload(body.ID); err != nil {
			writeAPIJSON(map[string]any{"ok": false, "error": err.Error()}, http.StatusBadRequest)
			return
		}
		writeAPIJSON(statusPayload())
	case "/api/preview-data":
		var body struct {
			ID string `json:"id"`
		}
		_ = decodeRequestBody(r, &body)
		if body.ID == "" {
			body.ID = r.URL.Query().Get("id")
		}
		payload, err := capturePreviewData(body.ID)
		if err != nil {
			writeAPIJSON(map[string]any{"ok": false, "error": err.Error()}, http.StatusBadRequest)
			return
		}
		writeAPIJSON(payload)
	case "/api/preview":
		if err := streamCapture(w, r, r.URL.Query().Get("id")); err != nil {
			writeAPIJSON(map[string]any{"ok": false, "error": err.Error()}, http.StatusBadRequest)
		}
	case "/api/reveal":
		if err := revealCapture(r.URL.Query().Get("id")); err != nil {
			writeAPIJSON(map[string]any{"ok": false, "error": err.Error()}, http.StatusBadRequest)
			return
		}
		writeAPIJSON(map[string]any{"ok": true})
	case "/api/set-type":
		var body struct {
			Type string `json:"type"`
		}
		_ = decodeRequestBody(r, &body)
		if body.Type == "" {
			body.Type = "all"
		}
		state.mu.Lock()
		state.selectedType = body.Type
		persistCollectorStateLocked()
		state.mu.Unlock()
		writeAPIJSON(statusPayload())
	case "/api/trust-cert":
		if err := trustCertificate(); err != nil {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = err.Error()
			writeAPIJSON(payload)
			return
		}
		writeAPIJSON(statusPayload())
	case "/api/proxy-open", "/api/start":
		if runtime.GOOS == "darwin" && !certTrusted() {
			payload := statusPayload()
			payload["ok"] = false
			payload["message"] = "本地 HTTPS 证书尚未被系统信任，暂不能启动采集。请先点击“信任证书”。"
			writeAPIJSON(payload)
			return
		}
		err := setSystemProxy(true)
		state.mu.Lock()
		if err == nil {
			setListeningLocked(true, "local start")
		}
		state.mu.Unlock()
		payload := statusPayload()
		if err != nil {
			payload["ok"] = false
			payload["message"] = err.Error()
		}
		writeAPIJSON(payload)
	case "/api/proxy-unset", "/api/stop":
		err := setSystemProxy(false)
		state.mu.Lock()
		if err == nil {
			setListeningLocked(false, "local stop")
		}
		state.mu.Unlock()
		payload := statusPayload()
		if err != nil {
			payload["ok"] = false
			payload["message"] = err.Error()
		}
		writeAPIJSON(payload)
	default:
		writeAPIJSON(map[string]any{"ok": false, "error": "not found"}, http.StatusNotFound)
	}
}

func decodeRequestBody(r *http.Request, target any) error {
	if body := r.URL.Query().Get("_body"); body != "" {
		return json.Unmarshal([]byte(body), target)
	}
	return json.NewDecoder(r.Body).Decode(target)
}

func statusPayload() map[string]any {
	trusted := certTrusted()
	proxyEnabled := systemProxyEnabled()
	state.mu.Lock()
	if proxyEnabled {
		setListeningLocked(true, "proxy probe")
	}
	defer state.mu.Unlock()
	return map[string]any{
		"ok": true,
		"data": map[string]any{
			"AppName":   appName,
			"Version":   version,
			"StartedAt": state.startedAt.Format(time.RFC3339),
		},
		"connected":          true,
		"installed":          true,
		"listening":          state.listening,
		"selectedType":       state.selectedType,
		"certificateTrusted": trusted,
		"certificatePath":    filepath.Join(installDir(), "ca.crt"),
		"captures":           cloneCaptures(state.captures),
		"message":            statusMessage(state.listening, trusted),
	}
}

func collectorStatePath() string {
	return filepath.Join(installDir(), "state.json")
}

func loadCollectorState() {
	path := collectorStatePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var persisted persistedCollectorState
	if err := json.Unmarshal(raw, &persisted); err != nil {
		log.Printf("load collector state failed: %v", err)
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if persisted.SelectedType != "" {
		state.selectedType = persisted.SelectedType
	}
	state.listening = persisted.Listening
	for index := range persisted.Captures {
		persisted.Captures[index].ID = stableCaptureID(persisted.Captures[index].URL)
	}
	state.captures = persisted.Captures
	state.seen = map[string]bool{}
	for _, item := range persisted.Captures {
		state.seen[captureIdentitySign(item.URL)] = true
	}
	log.Printf("collector state restored: listening=%v captures=%d", state.listening, len(state.captures))
}

func persistCollectorStateLocked() {
	snapshot := persistedCollectorState{
		Listening:    state.listening,
		SelectedType: state.selectedType,
		Captures:     append([]capture{}, state.captures...),
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		log.Printf("persist collector state marshal failed: %v", err)
		return
	}
	if err := os.WriteFile(collectorStatePath(), data, 0600); err != nil {
		log.Printf("persist collector state write failed: %v", err)
	}
}

func setListeningLocked(next bool, reason string) {
	if state.listening == next {
		return
	}
	state.listening = next
	log.Printf("listening changed -> %v (%s)", next, reason)
	persistCollectorStateLocked()
}

func cloneCaptures(items []capture) []capture {
	if len(items) == 0 {
		return []capture{}
	}
	return append([]capture{}, items...)
}

func startDownload(id string) error {
	item, ok := getCapture(id)
	if !ok {
		return errors.New("未找到捕获资源")
	}
	if item.DownloadStatus == "downloading" {
		return nil
	}
	updateCapture(id, func(c *capture) {
		c.DownloadStatus = "downloading"
		c.Progress = 0
		c.Downloaded = 0
		c.Error = ""
	})
	go downloadCapture(item)
	return nil
}

func getCapture(id string) (capture, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, item := range state.captures {
		if item.ID == id {
			return item, true
		}
	}
	return capture{}, false
}

func updateCapture(id string, fn func(*capture)) {
	state.mu.Lock()
	defer state.mu.Unlock()
	for i := range state.captures {
		if state.captures[i].ID == id {
			fn(&state.captures[i])
			persistCollectorStateLocked()
			return
		}
	}
}

func capturePreviewData(id string) (map[string]any, error) {
	item, ok := getCapture(id)
	if !ok {
		return nil, errors.New("未找到捕获资源")
	}
	var data []byte
	var err error
	if item.SavePath != "" {
		if _, statErr := os.Stat(item.SavePath); statErr == nil {
			data, err = os.ReadFile(item.SavePath)
		}
	}
	if len(data) == 0 {
		req, reqErr := newCaptureRequest(http.MethodGet, item.URL, item, false)
		if reqErr != nil {
			return nil, reqErr
		}
		resp, respErr := http.DefaultClient.Do(req)
		if respErr != nil {
			return nil, respErr
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("预览读取失败：HTTP %d", resp.StatusCode)
		}
		limit := int64(20 * 1024 * 1024)
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if int64(len(data)) > limit {
			return nil, errors.New("预览资源过大，请先下载后查看")
		}
	}
	if err != nil {
		return nil, err
	}
	if item.DecodeKey != "" {
		key := mediaDecryptionArray(item.DecodeKey, 128*1024)
		decryptWechatMediaChunk(data, key, 0)
	}
	contentType := item.ContentType
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	return map[string]any{
		"ok":          true,
		"contentType": contentType,
		"base64":      base64.StdEncoding.EncodeToString(data),
		"id":          item.ID,
	}, nil
}

func downloadCapture(item capture) {
	savePath, err := captureSavePath(item)
	if err != nil {
		markDownloadError(item.ID, err)
		return
	}
	req, err := newCaptureRequest(http.MethodGet, item.URL, item, false)
	if err != nil {
		markDownloadError(item.ID, err)
		return
	}
	client := &http.Client{Timeout: 0}
	resp, err := client.Do(req)
	if err != nil {
		markDownloadError(item.ID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		markDownloadError(item.ID, fmt.Errorf("下载失败：HTTP %d", resp.StatusCode))
		return
	}
	if err := os.MkdirAll(filepath.Dir(savePath), 0755); err != nil {
		markDownloadError(item.ID, err)
		return
	}
	file, err := os.Create(savePath)
	if err != nil {
		markDownloadError(item.ID, err)
		return
	}
	defer file.Close()

	total := resp.ContentLength
	if total <= 0 && item.Size > 0 {
		total = int64(item.Size)
	}
	buf := make([]byte, 128*1024)
	var downloaded int64
	lastProgress := -1
	var decryptionKey []byte
	if item.DecodeKey != "" {
		decryptionKey = mediaDecryptionArray(item.DecodeKey, 128*1024)
	}
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			decryptWechatMediaChunk(chunk, decryptionKey, downloaded)
			if _, err := file.Write(chunk); err != nil {
				markDownloadError(item.ID, err)
				return
			}
			downloaded += int64(n)
			progress := 0
			if total > 0 {
				progress = int(float64(downloaded) * 100 / float64(total))
				if progress > 99 {
					progress = 99
				}
			}
			if progress != lastProgress {
				lastProgress = progress
				updateCapture(item.ID, func(c *capture) {
					c.Progress = progress
					c.Downloaded = float64(downloaded)
					c.SavePath = savePath
				})
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			markDownloadError(item.ID, readErr)
			return
		}
	}
	updateCapture(item.ID, func(c *capture) {
		c.DownloadStatus = "downloaded"
		c.Progress = 100
		c.Downloaded = float64(downloaded)
		c.SavePath = savePath
		c.DecodeKey = ""
		c.Error = ""
	})
}

func markDownloadError(id string, err error) {
	updateCapture(id, func(c *capture) {
		c.DownloadStatus = "error"
		c.Error = err.Error()
	})
}

func captureSavePath(item capture) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads", "YuebaiWechatCollector", time.Now().Format("2006-01-02"))
	nameBase := item.Description
	if nameBase == "" {
		nameBase = item.ID
	}
	nameBase = sanitizeFilename(nameBase)
	if len([]rune(nameBase)) > 48 {
		nameBase = string([]rune(nameBase)[:48])
	}
	if nameBase == "" {
		nameBase = item.ID
	}
	suffix := item.Suffix
	if suffix == "" {
		suffix = ".bin"
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%s%s", nameBase, item.ID, suffix)), nil
}

func sanitizeFilename(value string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_", "\n", " ", "\r", " ")
	return strings.TrimSpace(replacer.Replace(value))
}

func newCaptureRequest(method string, rawURL string, item capture, keepCapturedRange bool) (*http.Request, error) {
	req, err := http.NewRequest(method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if rawHeaders := item.OtherData["headers"]; rawHeaders != "" {
		var headers map[string][]string
		if err := json.Unmarshal([]byte(rawHeaders), &headers); err == nil {
			for key, values := range headers {
				for _, value := range values {
					req.Header.Add(key, value)
				}
			}
		}
	}
	if !keepCapturedRange {
		req.Header.Del("Range")
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
	}
	return req, nil
}

func streamCapture(w http.ResponseWriter, r *http.Request, id string) error {
	item, ok := getCapture(id)
	if !ok {
		return errors.New("未找到捕获资源")
	}
	writeMediaHeaders(w)
	if item.SavePath != "" {
		if _, err := os.Stat(item.SavePath); err == nil {
			if item.ContentType != "" {
				w.Header().Set("Content-Type", item.ContentType)
			}
			http.ServeFile(w, r, item.SavePath)
			return nil
		}
	}
	req, err := newCaptureRequest(http.MethodGet, item.URL, item, false)
	if err != nil {
		return err
	}
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	for _, key := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if value := resp.Header.Get(key); value != "" {
			w.Header().Set(key, value)
		}
	}
	if w.Header().Get("Content-Type") == "" && item.ContentType != "" {
		w.Header().Set("Content-Type", item.ContentType)
	}
	w.WriteHeader(resp.StatusCode)
	if item.DecodeKey == "" {
		_, err = io.Copy(w, resp.Body)
		return err
	}

	decryptionKey := mediaDecryptionArray(item.DecodeKey, 128*1024)
	offset := rangeStartOffset(r.Header.Get("Range"))
	buf := make([]byte, 128*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			decryptWechatMediaChunk(chunk, decryptionKey, offset)
			offset += int64(n)
			if _, err = w.Write(chunk); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func rangeStartOffset(rangeHeader string) int64 {
	if rangeHeader == "" || !strings.HasPrefix(rangeHeader, "bytes=") {
		return 0
	}
	value := strings.TrimPrefix(rangeHeader, "bytes=")
	startText := strings.SplitN(value, "-", 2)[0]
	if startText == "" {
		return 0
	}
	start, err := strconv.ParseInt(startText, 10, 64)
	if err != nil || start < 0 {
		return 0
	}
	return start
}

func revealCapture(id string) error {
	item, ok := getCapture(id)
	if !ok {
		return errors.New("未找到捕获资源")
	}
	target := item.SavePath
	if target == "" {
		home, _ := os.UserHomeDir()
		target = filepath.Join(home, "Downloads", "YuebaiWechatCollector")
	}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat(target); err == nil {
			return run("open", "-R", target)
		}
		return run("open", filepath.Dir(target))
	}
	return nil
}
