"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function createWechatCollectorService({
  WECHAT_COLLECTOR_BASE_URL,
  WECHAT_COLLECTOR_BIN,
  WECHAT_COLLECTOR_HOME,
  WECHAT_COLLECTOR_LABEL,
  WECHAT_COLLECTOR_PAC_URL,
  WECHAT_COLLECTOR_PLIST,
  sendWechatCollectorCommand,
}) {
  function execFileAsync(file, args = []) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(file, args, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
  
  function collectorInstalled() {
    return fs.existsSync(WECHAT_COLLECTOR_BIN) || fs.existsSync(WECHAT_COLLECTOR_PLIST);
  }
  
  function collectorOfflineStatus(message = "后台包已安装，但当前未运行。") {
    return {
      ok: false,
      connected: false,
      installed: collectorInstalled(),
      listening: false,
      certificateTrusted: false,
      certificatePath: path.join(WECHAT_COLLECTOR_HOME, "ca.crt"),
      captures: [],
      message,
    };
  }

  function collectorNotReady() {
    return {
      ok: false,
      connected: false,
      installed: false,
      listening: false,
      captures: [],
      message: "悦拜视频号采集服务尚未部署。需要把采集代理核心接入平台后台后，页面才能直接捕获视频号资源。",
    };
  }
  
  async function collectorJson(apiPath, options = {}) {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const response = await fetch(`${WECHAT_COLLECTOR_BASE_URL}${apiPath}`, options);
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      throw new Error(parsed.message || parsed.error || text || `collector HTTP ${response.status}`);
    }
    return parsed;
  }
  
  async function getWechatCollectorStatus() {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    let status;
    try {
      status = await collectorJson("/api/status");
    } catch (error) {
      return collectorOfflineStatus(
        collectorInstalled()
          ? "后台包已安装，但当前未运行；可在页面点击“启动后台包”。"
          : "后台包未安装。"
      );
    }
    const appName = status?.data?.AppName || "悦拜视频号采集服务";
    const version = status?.data?.Version ? ` v${status.data.Version}` : "";
    const listening = Boolean(status?.listening);
    return {
      ok: true,
      connected: true,
      installed: true,
      listening,
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      message: status.message || `${appName}${version} 已连接，采集监听${listening ? "已开启" : "未开启"}`,
    };
  }
  
  async function waitForWechatCollectorStatus({
    attempts = 8,
    delayMs = 500,
  } = {}) {
    let lastStatus = collectorOfflineStatus(
      collectorInstalled()
        ? "后台包已安装，但当前未运行；可在页面点击“启动后台包”。"
        : "后台包未安装。"
    );
    for (let index = 0; index < attempts; index += 1) {
      lastStatus = await getWechatCollectorStatus();
      if (lastStatus.connected) return lastStatus;
      if (index < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return lastStatus;
  }
  
  async function startWechatCollectorPackage() {
    if (process.platform !== "darwin") {
      return { ok: false, message: "当前页面暂只支持 macOS 后台包起停。" };
    }
    if (!fs.existsSync(WECHAT_COLLECTOR_PLIST)) {
      return { ok: false, connected: false, installed: false, listening: false, message: "后台包未安装，请先执行安装命令。" };
    }
    const domain = `gui/${process.getuid()}`;
    try {
      await execFileAsync("launchctl", ["bootstrap", domain, WECHAT_COLLECTOR_PLIST]);
    } catch (error) {
      const output = `${error.stderr || ""}${error.stdout || ""}${error.message || ""}`;
      if (!/already|exists|in progress|5:|37:|service/i.test(output)) {
        throw error;
      }
    }
    try {
      await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${WECHAT_COLLECTOR_LABEL}`]);
    } catch (error) {
      const output = `${error.stderr || ""}${error.stdout || ""}${error.message || ""}`;
      if (!/Could not find service|No such process|service/i.test(output)) {
        throw error;
      }
    }
    const status = await waitForWechatCollectorStatus({ attempts: 10, delayMs: 600 });
    return {
      ...status,
      ok: status.connected,
      message: status.connected ? "后台包已启动。" : (status.message || "后台包启动失败，请稍后重试。"),
    };
  }
  
  async function stopWechatCollectorPackage() {
    if (process.platform !== "darwin") {
      return { ok: false, message: "当前页面暂只支持 macOS 后台包起停。" };
    }
    try {
      await collectorJson("/api/proxy-unset");
    } catch {
      // The package may already be offline; bootout below is the source of truth.
    }
    const domain = `gui/${process.getuid()}`;
    try {
      await execFileAsync("launchctl", ["bootout", domain, WECHAT_COLLECTOR_PLIST]);
    } catch (error) {
      const output = `${error.stderr || ""}${error.stdout || ""}${error.message || ""}`;
      if (!/No such process|not found|Could not find|3:|113:/i.test(output)) {
        throw error;
      }
    }
    return collectorOfflineStatus("后台包进程已退出；采集监听已停止。");
  }
  
  async function trustWechatCollectorCert() {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const status = await collectorJson("/api/trust-cert", { method: "POST" });
    return {
      ok: status.ok !== false,
      connected: true,
      installed: true,
      listening: Boolean(status.listening),
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      message: status.message || "证书信任操作已完成。",
    };
  }
  
  async function startWechatCollector(payload = {}) {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const type = payload.type || "all";
    await collectorJson("/api/set-type", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    });
    const status = await collectorJson("/api/proxy-open");
    return {
      ok: status.ok !== false,
      connected: true,
      installed: true,
      listening: Boolean(status.listening),
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      message: status.message || "采集监听已开启；现在可以在微信视频号里边看边刷。",
    };
  }
  
  async function stopWechatCollector() {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const status = await collectorJson("/api/proxy-unset");
    return {
      ok: status.ok !== false,
      connected: true,
      installed: true,
      listening: Boolean(status.listening),
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      message: status.message || "采集监听已停止。",
    };
  }
  
  async function downloadWechatCapture(payload = {}) {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const status = await collectorJson("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: payload.id }),
    });
    return {
      ok: status.ok !== false,
      connected: true,
      installed: true,
      listening: Boolean(status.listening),
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      message: status.message || "已开始下载。",
    };
  }
  
  async function revealWechatCapture(payload = {}) {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    return collectorJson(`/api/reveal?id=${encodeURIComponent(payload.id || "")}`, { method: "POST" });
  }
  
  async function clearWechatCaptures() {
    if (!WECHAT_COLLECTOR_BASE_URL) return collectorNotReady();
    const status = await collectorJson("/api/clear", { method: "POST" });
    return {
      ok: status.ok !== false,
      connected: true,
      installed: true,
      listening: Boolean(status.listening),
      certificateTrusted: Boolean(status.certificateTrusted),
      certificatePath: status.certificatePath || "",
      captures: status.captures || [],
      selectedType: status.selectedType || "all",
      message: status.message || "捕获列表已清空，采集保持开启。",
    };
  }
  
  async function getWechatCapturePreview(id = "") {
    if (!id) {
      throw new Error("missing id");
    }
    return collectorJson(`/api/preview-data?id=${encodeURIComponent(id)}`);
  }
  
  async function fetchWechatCapturePreviewBuffer(id = "") {
    const preview = await getWechatCapturePreview(id);
    if (!preview || preview.ok === false) {
      throw new Error(preview?.message || preview?.error || "预览失败");
    }
    const base64 = preview.base64 || "";
    const contentType = normalizeWechatPreviewContentType(preview.contentType || "application/octet-stream");
    return {
      contentType,
      buffer: Buffer.from(base64, "base64"),
    };
  }
  
  function normalizeWechatPreviewContentType(contentType = "") {
    const value = String(contentType || "").trim().toLowerCase();
    if (value === "image/jpg") return "image/jpeg";
    return contentType || "application/octet-stream";
  }
  
  async function fetchWechatCapturePreviewBufferByToken(token = "", id = "") {
    const preview = await sendWechatCollectorCommand(token, `/api/preview-data?id=${encodeURIComponent(id)}`, {
      method: "GET",
    });
    if (!preview || preview.ok === false) {
      throw new Error(preview?.message || preview?.error || "预览失败");
    }
    return {
      contentType: normalizeWechatPreviewContentType(preview.contentType || "application/octet-stream"),
      buffer: Buffer.from(preview.base64 || "", "base64"),
    };
  }
  
  async function streamWechatCapturePreview(req, res, id = "", token = "") {
    if (!id) {
      throw new Error("missing id");
    }
    if (token) {
      const preview = await fetchWechatCapturePreviewBufferByToken(token, id);
      res.writeHead(200, {
        "Content-Type": preview.contentType,
        "Content-Length": preview.buffer.length,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      res.end(preview.buffer);
      return;
    }
    if (!WECHAT_COLLECTOR_BASE_URL) {
      throw new Error("collector_not_ready");
    }
    const previewUrl = `${WECHAT_COLLECTOR_BASE_URL}/api/preview?id=${encodeURIComponent(id)}`;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const response = await fetch(previewUrl, { headers });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `collector HTTP ${response.status}`);
    }
    const responseHeaders = {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    };
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(key);
      if (value) responseHeaders[key] = key === "content-type" ? normalizeWechatPreviewContentType(value) : value;
    }
    res.writeHead(response.status, responseHeaders);
    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  }
  
  async function openWechatCollectorBrowser() {
    if (process.platform !== "darwin") {
      return { ok: false, message: "当前仅实现了 macOS 专用采集浏览器启动。" };
    }
    await collectorJson("/api/proxy-open");
    const profileDir = path.join(process.env.HOME || "/tmp", ".yuebai", "wechat-collector", "chrome-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const args = [
      "-na",
      "Google Chrome",
      "--args",
      `--user-data-dir=${profileDir}`,
      `--proxy-pac-url=${WECHAT_COLLECTOR_PAC_URL}`,
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "https://channels.weixin.qq.com/web/pages/home",
    ];
    await new Promise((resolve, reject) => {
      childProcess.execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });
    return {
      ok: true,
      message: "已打开视频号采集专用 Chrome 窗口；请在这个窗口里浏览视频号。",
    };
  }

  return {
    clearWechatCaptures,
    collectorJson,
    collectorNotReady,
    downloadWechatCapture,
    fetchWechatCapturePreviewBuffer,
    fetchWechatCapturePreviewBufferByToken,
    getWechatCapturePreview,
    getWechatCollectorStatus,
    normalizeWechatPreviewContentType,
    openWechatCollectorBrowser,
    revealWechatCapture,
    startWechatCollector,
    startWechatCollectorPackage,
    stopWechatCollector,
    stopWechatCollectorPackage,
    streamWechatCapturePreview,
    trustWechatCollectorCert,
  };
}

module.exports = {
  createWechatCollectorService,
};
