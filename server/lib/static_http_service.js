"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function createStaticHttpService({
  DIST,
  HOST,
  PORT,
  PUBLIC_DIR,
  ROOT,
  renderDouyinCollectorMacInstallScript,
  renderDouyinCollectorWindowsInstallScript,
  renderWechatCollectorMacInstallScript,
  renderWechatCollectorWindowsInstallScript,
  spawnImpl = childProcess.spawn,
}) {
  function sendJson(res, payload, status = 200) {
    sendJsonWithHeaders(res, payload, status);
  }

  function sendJsonWithHeaders(res, payload, status = 200, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    if (res.jsonpCallback) {
      const script = `${res.jsonpCallback}(${body});`;
      res.writeHead(status, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": Buffer.byteLength(script),
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        ...extraHeaders,
      });
      res.end(script);
      return;
    }
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendFile(res, filePath) {
    fs.readFile(filePath, (err, content) => {
      if (err) {
        sendJson(res, { error: "not found" }, 404);
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      res.end(content);
    });
  }

  function streamDouyinCollectorArchive(res) {
    const appDir = path.join(ROOT, "apps", "content-assets-console");
    if (!fs.existsSync(appDir)) {
      sendJson(res, { ok: false, error: "content assets app missing" }, 404);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    const tar = spawnImpl("tar", [
      "--exclude=__pycache__",
      "--exclude=.venv",
      "--exclude=Downloaded",
      "--exclude=config/douyin_login_profile",
      "--exclude=config/cookies*.json",
      "--exclude=*.db",
      "--exclude=*.sqlite",
      "--exclude=*.pyc",
      "-czf",
      "-",
      ".",
    ], { cwd: appDir });
    tar.stdout.pipe(res);
    tar.stderr.on("data", (chunk) => console.error(`[douyin-collector-tar] ${chunk}`));
    tar.on("error", (error) => {
      if (!res.headersSent) sendJson(res, { ok: false, error: error.message }, 500);
      else res.end();
    });
  }

  function serveStatic(req, res, pathname) {
    if (pathname === "/install/yuebai-wechat-collector-macos.sh") {
      res.writeHead(200, {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      res.end(renderWechatCollectorMacInstallScript(url.searchParams.get("token") || ""));
      return;
    }
    if (pathname === "/install/yuebai-wechat-collector-windows.ps1") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      res.end(renderWechatCollectorWindowsInstallScript(url.searchParams.get("token") || ""));
      return;
    }
    if (pathname === "/install/yuebai-douyin-collector-macos.sh") {
      res.writeHead(200, {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      res.end(renderDouyinCollectorMacInstallScript(url.searchParams.get("token") || ""));
      return;
    }
    if (pathname === "/install/yuebai-douyin-collector-windows.ps1") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      res.end(renderDouyinCollectorWindowsInstallScript(url.searchParams.get("token") || ""));
      return;
    }
    if (pathname === "/install/yuebai-douyin-collector-app.tar.gz") {
      streamDouyinCollectorArchive(res);
      return;
    }
    if (pathname.startsWith("/install/")) {
      const installPath = path.join(PUBLIC_DIR, pathname);
      if (installPath.startsWith(PUBLIC_DIR) && fs.existsSync(installPath) && fs.statSync(installPath).isFile()) {
        sendFile(res, installPath);
        return;
      }
    }
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(DIST, safePath === "/" ? "index.html" : safePath);
    if (!filePath.startsWith(DIST)) {
      sendJson(res, { error: "invalid path" }, 400);
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      sendFile(res, filePath);
      return;
    }
    sendFile(res, path.join(DIST, "index.html"));
  }

  return {
    sendFile,
    sendJson,
    sendJsonWithHeaders,
    serveStatic,
    streamDouyinCollectorArchive,
  };
}

module.exports = {
  MIME,
  createStaticHttpService,
};
