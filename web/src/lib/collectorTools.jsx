import React, { useEffect, useRef, useState } from "react";
import { Modal, Typography } from "antd";
import { requestJson } from "./apiClient";

const { Text } = Typography;
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export function CollectorPill({ tone = "neutral", children }) {
  return <span className={`collector-pill collector-pill-${tone}`}>{children}</span>;
}

export function CollectorButton({
  variant = "secondary",
  size = "normal",
  icon,
  loading = false,
  children,
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`collector-button collector-button-${variant} collector-button-${size} ${className}`.trim()}
      {...props}
    >
      {loading ? (
        <span className="collector-button-spinner" aria-hidden="true" />
      ) : icon ? (
        <span className="collector-button-icon">{icon}</span>
      ) : null}
      <span>{children}</span>
    </button>
  );
}

export const WECHAT_LOCAL_DIRECT_BASE_URL = "https://collector.yuebai.localhost:18766";

const collectorBridgeState = {
  iframe: null,
  baseUrl: "",
  ready: null,
  pending: new Map(),
  counter: 0,
  listenerBound: false,
};

function isLocalCollectorUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return LOCAL_HOST_RE.test(url.hostname || "");
  } catch {
    return false;
  }
}

function shouldUseCollectorBridge(baseUrl) {
  return !isLocalPlatformOrigin() && isLocalCollectorUrl(baseUrl);
}

function ensureCollectorBridge(baseUrl, bridgePath = "/bridge.html") {
  if (
    collectorBridgeState.iframe &&
    collectorBridgeState.baseUrl === baseUrl &&
    collectorBridgeState.bridgePath === bridgePath &&
    collectorBridgeState.ready
  ) {
    return collectorBridgeState.ready;
  }

  if (!collectorBridgeState.listenerBound) {
    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.source !== "yuebai-collector-bridge") return;
      if (message.ready) {
        collectorBridgeState.readyResolver?.();
        return;
      }
      const pending = collectorBridgeState.pending.get(message.id);
      if (!pending) return;
      collectorBridgeState.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.data);
      } else {
        pending.reject(new Error(message.error || "本机后台包请求失败"));
      }
    });
    collectorBridgeState.listenerBound = true;
  }

  if (collectorBridgeState.iframe) {
    collectorBridgeState.iframe.remove();
  }

  const bridgeUrl = new URL(buildUrl(baseUrl, bridgePath));
  bridgeUrl.searchParams.set("origin", window.location.origin);

  const iframe = document.createElement("iframe");
  iframe.title = "yuebai-wechat-collector-bridge";
  iframe.src = bridgeUrl.toString();
  iframe.style.display = "none";
  iframe.setAttribute("aria-hidden", "true");

  collectorBridgeState.iframe = iframe;
  collectorBridgeState.baseUrl = baseUrl;
  collectorBridgeState.bridgePath = bridgePath;
  collectorBridgeState.ready = new Promise((resolve, reject) => {
    collectorBridgeState.readyResolver = resolve;
    window.setTimeout(() => {
      if (collectorBridgeState.baseUrl === baseUrl) {
        collectorBridgeState.ready = null;
        collectorBridgeState.readyResolver = null;
      }
      reject(new Error("本机后台包连接超时"));
    }, 8000);
  });
  document.body.appendChild(iframe);
  return collectorBridgeState.ready;
}

async function requestCollectorViaBridge(baseUrl, path, options = {}, bridgePath = "/bridge.html") {
  await ensureCollectorBridge(baseUrl, bridgePath);
  const iframe = collectorBridgeState.iframe;
  const targetOrigin = new URL(baseUrl).origin;
  const id = `collector-${Date.now()}-${++collectorBridgeState.counter}`;

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      collectorBridgeState.pending.delete(id);
      reject(new Error("本机后台包请求超时"));
    }, 10000);
    collectorBridgeState.pending.set(id, { resolve, reject, timer });
    iframe.contentWindow.postMessage(
      {
        source: "yuebai-platform",
        id,
        request: {
          path,
          options,
        },
      },
      targetOrigin
    );
  });
}

function requestCollectorViaJsonp(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = `__yuebaiCollectorJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const requestUrl = new URL(buildUrl(baseUrl, path));
    const method = options.method || "GET";
    requestUrl.searchParams.set("_jsonp", callbackName);
    if (method !== "GET") requestUrl.searchParams.set("_method", method);
    if (options.body) requestUrl.searchParams.set("_body", options.body);
    const timer = window.setTimeout(() => {
      delete window[callbackName];
      script.remove();
      reject(new Error("本机后台包连接超时"));
    }, 10000);

    window[callbackName] = (payload) => {
      window.clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (payload?.ok === false || payload?.error) {
        reject(new Error(payload.error || payload.message || "本机后台包请求失败"));
        return;
      }
      resolve(payload);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      reject(new Error("本机后台包连接失败"));
    };
    script.src = requestUrl.toString();
    document.head.appendChild(script);
  });
}

export function requestPublicCollector(baseUrl, path, options = {}, bridgePath = "/bridge.html") {
  return requestCollectorViaJsonp(baseUrl, path, options).catch(() =>
    requestCollectorViaBridge(baseUrl, path, options, bridgePath)
  );
}

export function probeCollectorPage(baseUrl, path = "/bridge.html", timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    const timer = window.setTimeout(() => {
      iframe.remove();
      reject(new Error("本机页面响应超时"));
    }, timeoutMs);

    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.onload = () => {
      window.clearTimeout(timer);
      iframe.remove();
      resolve(true);
    };
    iframe.onerror = () => {
      window.clearTimeout(timer);
      iframe.remove();
      reject(new Error("本机页面加载失败"));
    };
    iframe.src = buildUrl(baseUrl, path);
    document.body.appendChild(iframe);
  });
}

export function formatBytes(value) {
  const size = Number(value || 0);
  if (!size) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let next = size;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function resourceTypeLabel(item) {
  if (isLikelyImageCapture(item)) return "图片";
  if (item.classify === "video") return "视频";
  if (item.classify === "image") return "图片";
  if (item.classify === "m3u8") return "直播流";
  return item.classify || "资源";
}

function isLikelyImageCapture(item = {}) {
  const contentType = String(item.contentType || "").toLowerCase();
  const suffix = String(item.suffix || "").toLowerCase();
  const url = String(item.url || "").toLowerCase();
  return item.classify === "image"
    || contentType.startsWith("image/")
    || [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(suffix)
    || url.includes("/20304/stodownload");
}

export function normalizeWechatCaptureForView(item = {}) {
  if (!isLikelyImageCapture(item)) return item;
  return {
    ...item,
    classify: "image",
    suffix: item.suffix && !String(item.suffix).toLowerCase().includes("mp4") ? item.suffix : ".jpg",
    contentType: "image/jpeg",
  };
}

export function downloadStatusLabel(item) {
  if (item.downloadStatus === "downloading") return "下载中";
  if (item.downloadStatus === "downloaded") return "已下载";
  if (item.downloadStatus === "error") return "失败";
  return "待下载";
}

export function buildUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) throw new Error("copy_empty");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "readonly");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("clipboard_unavailable");
}

function buildCollectorPreviewUrl(baseUrl, item, token = "") {
  if (baseUrl) {
    return buildUrl(baseUrl, `/api/preview?id=${encodeURIComponent(item.id)}`);
  }
  return "";
}

export function isLocalPlatformOrigin() {
  return LOCAL_HOST_RE.test(window.location.hostname || "");
}

export function requestCollectorJson(baseUrl, path, options = {}) {
  if (isLocalCollectorUrl(baseUrl)) {
    if (!isLocalPlatformOrigin()) {
      return requestPublicCollector(baseUrl, path, options, "/bridge.html");
    }
    return requestJson(buildUrl(baseUrl, path), options);
  }
  if (!isLocalPlatformOrigin()) {
    const method = options.method || "GET";
    if (path === "/api/status") return requestJson("/api/wechat-video/status");
    if (path === "/api/set-type") {
      return requestJson("/api/wechat-video/set-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: options.body || JSON.stringify({ type: "all" }),
      });
    }
    if (path === "/api/start") {
      return requestJson("/api/wechat-video/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "all" }),
      });
    }
    if (path === "/api/stop") return requestJson("/api/wechat-video/stop", { method: "POST" });
    if (path === "/api/trust-cert") return requestJson("/api/wechat-video/trust-cert", { method: "POST" });
    if (path === "/api/download") {
      return requestJson("/api/wechat-video/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: options.body || "{}",
      });
    }
    if (path.startsWith("/api/reveal")) {
      const id = new URL(buildUrl(baseUrl, path)).searchParams.get("id") || "";
      return requestJson("/api/wechat-video/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    }
    if (path === "/api/clear") return requestJson("/api/wechat-video/clear", { method });
  }
  return requestJson(buildUrl(baseUrl, path), options);
}

export function resourceTitle(item) {
  return item.description || `${resourceTypeLabel(item)}资源`;
}

export function shortResourceUrl(url = "") {
  if (!url) return "";
  return url.length > 96 ? `${url.slice(0, 96)}...` : url;
}

export function captureListSignature(items = []) {
  return JSON.stringify(
    items.map((item) => [
      item.id,
      item.classify,
      item.downloadStatus,
      item.progress,
      item.downloaded,
      item.savePath,
      item.error,
      item.capturedAt,
    ])
  );
}

export function CollectorPreviewModal({ open, item, collectorBaseUrl, collectorToken = "", onClose }) {
  const videoRef = useRef(null);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAsImage = item ? isLikelyImageCapture(item) : false;

  useEffect(() => {
    if (!open || !item) return undefined;
    if (previewAsImage || item.classify !== "video") return undefined;

    const previewSrc = buildCollectorPreviewUrl(collectorBaseUrl, item, collectorToken);
    let videoEl = null;
    let timer = 0;

    setPreviewError("");
    setPreviewLoading(true);

    const startPreview = () => {
      videoEl = videoRef.current;
      if (!videoEl) {
        setPreviewError("视频组件还未准备好，请关闭后重试。");
        setPreviewLoading(false);
        return;
      }

      videoEl.src = previewSrc;
      videoEl.load();
    };

    timer = window.setTimeout(startPreview, 80);

    return () => {
      window.clearTimeout(timer);
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute("src");
        videoEl.load();
      }
    };
  }, [open, item, collectorBaseUrl, collectorToken, previewAsImage]);

  return (
    <Modal
      open={open}
      title={item ? `${resourceTypeLabel(item)}预览` : "资源预览"}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnHidden
    >
      {!item ? null : previewAsImage ? (
        <div className="collector-preview-modal">
          <img
            src={buildCollectorPreviewUrl(collectorBaseUrl, item, collectorToken)}
            alt={resourceTitle(item)}
            onLoad={() => setPreviewLoading(false)}
            onError={() => {
              setPreviewLoading(false);
              setPreviewError("图片预览失败，请先下载后查看。");
            }}
          />
          {previewError ? <div className="collector-preview-error">{previewError}</div> : null}
        </div>
      ) : (
        <div className="collector-preview-modal">
          <video
            ref={videoRef}
            controls
            playsInline
            preload="metadata"
            poster={item.coverUrl || ""}
            onLoadedData={() => setPreviewLoading(false)}
            onCanPlay={() => setPreviewLoading(false)}
            onError={() => {
              setPreviewLoading(false);
              setPreviewError("视频预览失败，请先下载后查看。");
            }}
          />
          {previewError ? <div className="collector-preview-error">{previewError}</div> : null}
          {previewLoading ? <Text type="secondary">正在准备视频预览...</Text> : null}
          {item.decodeKey ? <Text type="secondary">该视频来自微信视频号加密资源，已由后台包处理后预览。</Text> : null}
        </div>
      )}
    </Modal>
  );
}

export function CaptureListPreview({ item, collectorBaseUrl, collectorToken = "", prioritize = false }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="resource-preview-fallback">
        <div>{resourceTypeLabel(item)}</div>
        <small>{item.capturedAt ? item.capturedAt.slice(11, 19) : item.suffix || ""}</small>
      </div>
    );
  }

  if (isLikelyImageCapture(item)) {
    return (
      <img
        src={buildCollectorPreviewUrl(collectorBaseUrl, item, collectorToken)}
        alt={item.description || item.id}
        loading={prioritize ? "eager" : "lazy"}
        onError={() => setFailed(true)}
      />
    );
  }

  if (item.coverUrl) {
    return (
      <img
        src={item.coverUrl}
        alt={item.description || item.id}
        loading={prioritize ? "eager" : "lazy"}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="resource-preview-fallback">
      <div>{resourceTypeLabel(item)}</div>
      <small>{item.capturedAt ? item.capturedAt.slice(11, 19) : item.suffix || ""}</small>
    </div>
  );
}
