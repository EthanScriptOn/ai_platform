package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/elazarl/goproxy"
)

func configureCA() error {
	dir := installDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	certPath := filepath.Join(dir, "ca.crt")
	keyPath := filepath.Join(dir, "ca.key")
	if _, err := os.Stat(certPath); errors.Is(err, os.ErrNotExist) {
		if err := generateCA(certPath, keyPath); err != nil {
			return err
		}
	}
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	ca, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return err
	}
	if ca.Leaf, err = x509.ParseCertificate(ca.Certificate[0]); err != nil {
		return err
	}
	goproxy.GoproxyCa = ca
	goproxy.OkConnect = &goproxy.ConnectAction{Action: goproxy.ConnectAccept, TLSConfig: goproxy.TLSConfigFromCA(&ca)}
	goproxy.MitmConnect = &goproxy.ConnectAction{Action: goproxy.ConnectMitm, TLSConfig: goproxy.TLSConfigFromCA(&ca)}
	goproxy.HTTPMitmConnect = &goproxy.ConnectAction{Action: goproxy.ConnectHTTPMitm, TLSConfig: goproxy.TLSConfigFromCA(&ca)}
	goproxy.RejectConnect = &goproxy.ConnectAction{Action: goproxy.ConnectReject, TLSConfig: goproxy.TLSConfigFromCA(&ca)}
	return nil
}

func generateCA(certPath, keyPath string) error {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	template := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "Yuebai WeChat Collector Local CA",
			Organization: []string{"Yuebai"},
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	certOut := bytes.Buffer{}
	if err := pem.Encode(&certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		return err
	}
	keyOut := bytes.Buffer{}
	if err := pem.Encode(&keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}); err != nil {
		return err
	}
	if err := os.WriteFile(certPath, certOut.Bytes(), 0644); err != nil {
		return err
	}
	return os.WriteFile(keyPath, keyOut.Bytes(), 0600)
}

func shouldMitm(target string) bool {
	hostOnly := strings.Split(target, ":")[0]
	return strings.HasSuffix(hostOnly, "channels.weixin.qq.com") ||
		strings.HasSuffix(hostOnly, "res.wx.qq.com") ||
		strings.HasSuffix(hostOnly, "wxapp.tc.qq.com") ||
		hostOnly == "qq.com" ||
		strings.HasSuffix(hostOnly, ".qq.com")
}

func onProxyRequest(r *http.Request, ctx *goproxy.ProxyCtx) (*http.Request, *http.Response) {
	if strings.Contains(r.Host, "qq.com") && strings.Contains(r.URL.Path, mediaHookPath) {
		body, _ := io.ReadAll(r.Body)
		go handleWechatMedia(body)
		return r, emptyResponse(r)
	}
	return r, nil
}

func onProxyResponse(resp *http.Response, ctx *goproxy.ProxyCtx) *http.Response {
	if resp == nil || resp.Request == nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp
	}
	req := resp.Request
	path := req.URL.Path
	if item, ok := captureFromResponse(resp); ok {
		addCapture(item)
	}
	if strings.HasSuffix(req.Host, "channels.weixin.qq.com") &&
		(strings.Contains(path, "/web/pages/feed") || strings.Contains(path, "/web/pages/home")) {
		return replaceBody(resp, `.js"`, `.js?v=yuebai"`)
	}
	if strings.HasSuffix(req.Host, "res.wx.qq.com") {
		if strings.HasSuffix(req.URL.RequestURI(), ".js?v=yuebai") {
			resp = replaceBody(resp, `.js"`, `.js?v=yuebai"`)
		}
		if strings.Contains(path, "web/web-finder/res/js/virtual_svg-icons-register.publish") {
			return injectWechatHooks(resp)
		}
	}
	return resp
}

func injectWechatHooks(resp *http.Response) *http.Response {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp
	}
	text := string(body)
	text = mediaGetterRe.ReplaceAllString(text, `
get media(){
  if(this.objectDesc){
    fetch("`+mediaHookURL+`?type=1", {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(this.objectDesc),
    });
  };
`)
	text = commentDetailRe.ReplaceAllString(text, `
async finderGetCommentDetail($1) {
  var res = await$2;
  if (res?.data?.object?.objectDesc) {
    fetch("`+mediaHookURL+`?type=2", {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(res.data.object.objectDesc),
    });
  }
  return res;
}async
`)
	return setBody(resp, []byte(text))
}

func replaceBody(resp *http.Response, from, to string) *http.Response {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp
	}
	return setBody(resp, []byte(strings.ReplaceAll(string(body), from, to)))
}

func setBody(resp *http.Response, body []byte) *http.Response {
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.Header.Del("Content-Encoding")
	return resp
}

func handleWechatMedia(body []byte) {
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return
	}
	mediaArr, ok := root["media"].([]any)
	if !ok || len(mediaArr) == 0 {
		return
	}
	first, ok := mediaArr[0].(map[string]any)
	if !ok {
		return
	}
	rawURL, _ := first["url"].(string)
	if rawURL == "" {
		return
	}
	token, _ := first["urlToken"].(string)
	finalURL := rawURL + token
	sign := captureIdentitySign(finalURL)

	item := capture{
		ID:             stableCaptureID(finalURL),
		URL:            finalURL,
		Classify:       "video",
		Suffix:         ".mp4",
		Domain:         topLevelDomain(rawURL),
		ContentType:    "video/mp4",
		CapturedAt:     time.Now().Format(time.RFC3339),
		DownloadStatus: "ready",
		OtherData:      map[string]string{},
	}
	if mediaType, ok := first["mediaType"].(float64); ok && mediaType == 9 {
		item.Classify = "image"
		item.Suffix = ".png"
		item.ContentType = "image/png"
	}
	if cover, ok := first["coverUrl"].(string); ok {
		item.CoverURL = cover
	}
	if decodeKey, ok := first["decodeKey"].(string); ok {
		item.DecodeKey = decodeKey
	}
	if desc, ok := root["description"].(string); ok {
		item.Description = desc
	}
	switch size := first["fileSize"].(type) {
	case float64:
		item.Size = size
	case string:
		if value, err := strconv.ParseFloat(size, 64); err == nil {
			item.Size = value
		}
	}
	if spec, ok := first["spec"].([]any); ok {
		formats := []string{}
		for _, value := range spec {
			if m, ok := value.(map[string]any); ok {
				if format, ok := m["fileFormat"].(string); ok {
					formats = append(formats, format)
				}
			}
		}
		item.OtherData["wx_file_formats"] = strings.Join(formats, "#")
	}

	addCaptureWithSign(sign, item)
}

func captureFromResponse(resp *http.Response) (capture, bool) {
	contentType := strings.ToLower(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	classify, suffix := classifyContentType(contentType)
	if classify == "" || resp.Request == nil || resp.Request.URL == nil {
		return capture{}, false
	}
	rawURL := resp.Request.URL.String()
	if rawURL == "" {
		return capture{}, false
	}
	if !shouldCaptureResourceURL(rawURL) {
		return capture{}, false
	}
	item := capture{
		ID:             stableCaptureID(rawURL),
		URL:            rawURL,
		Classify:       classify,
		Suffix:         suffix,
		Domain:         topLevelDomain(rawURL),
		ContentType:    contentType,
		CapturedAt:     time.Now().Format(time.RFC3339),
		DownloadStatus: "ready",
		OtherData:      map[string]string{},
	}
	if size, err := strconv.ParseFloat(resp.Header.Get("Content-Length"), 64); err == nil {
		item.Size = size
	}
	if headers, err := json.Marshal(resp.Request.Header); err == nil {
		item.OtherData["headers"] = string(headers)
	}
	return item, true
}

func shouldCaptureResourceURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	hostName := strings.ToLower(parsed.Hostname())
	if hostName == "" {
		return false
	}
	return strings.HasSuffix(hostName, ".qq.com") || hostName == "qq.com"
}

func classifyContentType(contentType string) (string, string) {
	switch contentType {
	case "video/mp4":
		return "video", ".mp4"
	case "video/webm":
		return "video", ".webm"
	case "video/ogg":
		return "video", ".ogv"
	case "video/quicktime":
		return "video", ".mov"
	case "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/x-mpegurl":
		return "m3u8", ".m3u8"
	case "image/png":
		return "image", ".png"
	case "image/jpeg", "image/jpg":
		return "image", ".jpg"
	case "image/webp":
		return "image", ".webp"
	case "image/gif":
		return "image", ".gif"
	default:
		if strings.HasPrefix(contentType, "video/") {
			return "video", ".mp4"
		}
		if strings.HasPrefix(contentType, "image/") {
			return "image", ".img"
		}
	}
	return "", ""
}

func addCapture(item capture) {
	addCaptureWithSign(captureIdentitySign(item.URL), item)
}

func addCaptureWithSign(sign string, item capture) {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.seen[sign] {
		mergeCaptureLocked(sign, item)
		return
	}
	if !state.suppressUntil.IsZero() && time.Now().Before(state.suppressUntil) {
		return
	}
	if state.selectedType != "all" && state.selectedType != item.Classify {
		return
	}
	state.seen[sign] = true
	state.captures = append([]capture{item}, state.captures...)
	if len(state.captures) > maxCaptures {
		state.captures = state.captures[:maxCaptures]
	}
	persistCollectorStateLocked()
}

func captureIdentitySign(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err == nil {
		if value := parsed.Query().Get("encfilekey"); value != "" {
			return "media:" + value
		}
	}
	return md5Hex(rawURL)
}

func mergeCaptureLocked(sign string, item capture) {
	for i := range state.captures {
		if captureIdentitySign(state.captures[i].URL) != sign {
			continue
		}
		current := &state.captures[i]
		if item.DecodeKey != "" {
			current.URL = item.URL
			current.DecodeKey = item.DecodeKey
		}
		if current.ID == "" {
			current.ID = stableCaptureID(current.URL)
		}
		if item.Description != "" {
			current.Description = item.Description
		}
		if item.CoverURL != "" {
			current.CoverURL = item.CoverURL
		}
		if item.Size > current.Size {
			current.Size = item.Size
		}
		if item.ContentType != "" {
			current.ContentType = item.ContentType
		}
		if item.Suffix != "" {
			current.Suffix = item.Suffix
		}
		if item.Classify != "" {
			current.Classify = item.Classify
		}
		if current.OtherData == nil {
			current.OtherData = map[string]string{}
		}
		for key, value := range item.OtherData {
			if _, exists := current.OtherData[key]; !exists || item.DecodeKey != "" {
				current.OtherData[key] = value
			}
		}
		persistCollectorStateLocked()
		return
	}
}
