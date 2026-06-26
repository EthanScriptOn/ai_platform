package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
)

func writePAC(w http.ResponseWriter) {
	body := fmt.Sprintf(`function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (
    dnsDomainIs(host, "channels.weixin.qq.com") ||
    dnsDomainIs(host, "res.wx.qq.com") ||
    dnsDomainIs(host, "wxapp.tc.qq.com")
  ) {
    return "PROXY %s:%s";
  }
  return "DIRECT";
}
`, host, port)
	w.Header().Set("Content-Type", "application/x-ns-proxy-autoconfig; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
	_, _ = w.Write([]byte(body))
}

func writeBridge(w http.ResponseWriter) {
	body := `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Yuebai Collector Bridge</title>
  </head>
  <body>
    <script>
      const params = new URLSearchParams(location.search);
      const parentOrigin = params.get("origin") || "*";

      async function requestLocal(message) {
        const request = message && message.request ? message.request : {};
        const path = request.path || "/api/status";
        const options = request.options || {};
        const response = await fetch(path, options);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
          ? await response.json()
          : { ok: response.ok, body: await response.text() };
        if (!response.ok) {
          throw new Error(data.error || data.message || "HTTP " + response.status);
        }
        return data;
      }

      window.addEventListener("message", async (event) => {
        if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
        const message = event.data || {};
        if (message.source !== "yuebai-platform" || !message.id) return;
        try {
          const data = await requestLocal(message);
          event.source.postMessage({
            source: "yuebai-collector-bridge",
            id: message.id,
            ok: true,
            data,
          }, event.origin);
        } catch (error) {
          event.source.postMessage({
            source: "yuebai-collector-bridge",
            id: message.id,
            ok: false,
            error: error && error.message ? error.message : "请求失败",
          }, event.origin);
        }
      });

      window.parent.postMessage({ source: "yuebai-collector-bridge", ready: true }, parentOrigin);
    </script>
  </body>
</html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
	_, _ = w.Write([]byte(body))
}

func emptyResponse(r *http.Request) *http.Response {
	return &http.Response{
		StatusCode:    http.StatusNoContent,
		Status:        "204 No Content",
		Header:        make(http.Header),
		Body:          io.NopCloser(bytes.NewReader(nil)),
		ContentLength: 0,
		Request:       r,
	}
}
