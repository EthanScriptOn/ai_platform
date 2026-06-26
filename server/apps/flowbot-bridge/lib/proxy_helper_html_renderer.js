"use strict";

function createProxyHelperHtmlRenderer({
  DASHBOARD_UI_VERSION,
  DEFAULT_LOGIN_REGION,
  DEFAULT_NOTIFY_URL,
  LOGIN_REGION_OPTIONS,
  buildProxyProviderUrl,
  escapeHtml,
}) {
  function renderProxyHelperHtml() {
    const providerUrlTemplate = buildProxyProviderUrl("__REGION__");
    return `<!doctype html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>代理辅助登录</title>
    <style>
      :root {
        --bg: #f4efe7;
        --panel: rgba(255,255,255,0.92);
        --line: #d8cbb8;
        --text: #241d16;
        --muted: #76695b;
        --accent: #295f4e;
        --accent-soft: #dceee7;
        --warn: #b25b2a;
        --danger: #a5382c;
        --ok: #2f7d53;
        --shadow: 0 16px 34px rgba(47, 35, 22, 0.08);
        font-family: "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(41,95,78,0.12), transparent 28%),
          radial-gradient(circle at top right, rgba(178,91,42,0.1), transparent 24%),
          linear-gradient(180deg, #f7f2ea 0%, var(--bg) 100%);
        color: var(--text);
      }
      .wrap {
        width: min(100% - 24px, 1120px);
        margin: 24px auto 48px;
      }
      .hero, .panel {
        background: var(--panel);
        border: 1px solid rgba(216,203,184,0.8);
        border-radius: 22px;
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 22px 24px;
        margin-bottom: 18px;
      }
      .hero h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      .hero p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .hero .meta {
        margin-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .layout {
        display: grid;
        grid-template-columns: 1.05fr 0.95fr;
        gap: 18px;
      }
      .panel {
        padding: 18px;
      }
      .panel h2 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .hint {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
        margin: 0 0 12px;
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field.full {
        grid-column: 1 / -1;
      }
      label {
        font-size: 13px;
        color: var(--muted);
      }
      input, select, textarea, button {
        font: inherit;
      }
      input, select, textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: #fffdfa;
        color: var(--text);
        padding: 12px 14px;
      }
      textarea {
        min-height: 120px;
        resize: vertical;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
        align-items: center;
      }
      button, .link-btn {
        border: none;
        border-radius: 999px;
        padding: 11px 16px;
        cursor: pointer;
        background: #ece2d3;
        color: var(--text);
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.18s ease, opacity 0.18s ease, background 0.18s ease;
      }
      button:hover, .link-btn:hover {
        transform: translateY(-1px);
      }
      button.primary {
        background: var(--accent);
        color: white;
      }
      button.secondary {
        background: #f4eadf;
        color: #5f4530;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }
      .flash {
        font-size: 13px;
        color: var(--muted);
      }
      .status {
        border-radius: 16px;
        border: 1px solid rgba(216,203,184,0.8);
        background: rgba(255,253,250,0.86);
        padding: 14px;
        line-height: 1.6;
      }
      .status strong {
        display: block;
        margin-bottom: 8px;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .meta-card {
        border: 1px solid rgba(216,203,184,0.8);
        border-radius: 16px;
        padding: 12px 14px;
        background: rgba(255,253,250,0.9);
      }
      .meta-card .label {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 6px;
      }
      .meta-card .value {
        font-size: 14px;
        word-break: break-all;
      }
      .preview {
        display: grid;
        gap: 12px;
      }
      .qr-box {
        min-height: 320px;
        border-radius: 20px;
        border: 1px dashed rgba(41,95,78,0.35);
        background:
          linear-gradient(180deg, rgba(220,238,231,0.56), rgba(255,255,255,0.92)),
          radial-gradient(circle at center, rgba(41,95,78,0.08), transparent 55%);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        text-align: center;
      }
      .qr-box img {
        width: min(100%, 280px);
        border-radius: 18px;
        background: white;
        padding: 12px;
        box-shadow: 0 14px 30px rgba(41,95,78,0.16);
      }
      .steps {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
        line-height: 1.8;
        font-size: 14px;
      }
      .proxy-result {
        border-radius: 14px;
        background: rgba(220,238,231,0.45);
        border: 1px solid rgba(41,95,78,0.18);
        padding: 12px 14px;
        font-size: 13px;
        word-break: break-all;
        color: #244739;
        min-height: 52px;
      }
      .top-links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      @media (max-width: 920px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .form-grid, .meta-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <h1>代理辅助页</h1>
        <p>这个页面现在只负责一件事：在公司网络里拿到代理接口返回结果，然后自动回填到主面板。真正的登录、设置回调地址、展示二维码、提交验证码，统一都回到主看板里完成。</p>
        <div class="meta">
          <span>UI 版本：<strong>${DASHBOARD_UI_VERSION}</strong></span>
          <span>入口：代理结果导入 -> 回到主面板自动继续</span>
        </div>
        <div class="top-links">
          <a class="link-btn" href="/flowbot/dashboard" target="_blank" rel="noreferrer">打开主看板</a>
        </div>
      </section>
  
      <div class="layout">
        <section class="panel">
          <h2>代理结果导入</h2>
          <p class="hint">先填实例 GUID 和地区。然后点“打开取代理接口”，在新页面拿到代理原始结果后，这里会把结果带回主面板，并自动触发登录。</p>
          <div class="form-grid">
            <div class="field full">
              <label for="helper-guid">实例 GUID</label>
              <input id="helper-guid" type="text" placeholder="例如：49d07411-00f9-3baf-b5d4-4b34dc0ef0df">
            </div>
            <div class="field">
              <label for="helper-region-select">地区预设</label>
              <select id="helper-region-select"></select>
            </div>
            <div class="field">
              <label for="helper-region">地区代码</label>
              <input id="helper-region" type="text" placeholder="例如：370200">
            </div>
            <div class="field full">
              <label for="helper-notify-url">回调地址</label>
              <input id="helper-notify-url" type="text" placeholder="https://your-flowbot.example.com/flowbot/callback" value="${DEFAULT_NOTIFY_URL.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}">
            </div>
          </div>
          <div class="actions">
            <button class="secondary" id="open-provider" type="button">打开取代理接口</button>
            <button class="primary" id="clipboard-login" type="button">从剪贴板导入并回到主面板</button>
            <span class="flash" id="helper-flash">等待开始</span>
          </div>
  
          <h2 style="margin-top: 22px;">代理原始结果</h2>
          <p class="hint">如果浏览器没法直接读剪贴板，或者你想手动确认内容，可以把代理接口返回的 JSON 或 ip:port 粘贴到这里，再点“带回主面板继续”。</p>
          <div class="field full">
            <label for="helper-proxy-raw">代理接口返回原文</label>
            <textarea id="helper-proxy-raw" placeholder='例如：{"code":1000,"data":[{"ip":"101.89.131.164","port":54202}]}'></textarea>
          </div>
          <div class="actions">
            <button class="primary" id="pasted-login" type="button">带回主面板继续</button>
          </div>
          <div style="margin-top: 12px;">
            <div class="hint">当前解析出的代理</div>
            <div class="proxy-result" id="helper-proxy-result">还没有解析出代理。</div>
          </div>
  
          <h2 style="margin-top: 22px;">使用步骤</h2>
          <ol class="steps">
            <li>填写 GUID 和地区。</li>
            <li>点“打开取代理接口”，在公司网络环境里拿到代理接口返回结果。</li>
            <li>复制那段返回内容。</li>
            <li>回到本页点“从剪贴板导入并回到主面板”，或者粘贴后点“带回主面板继续”。</li>
            <li>主面板会自动接住代理结果，并继续登录。</li>
          </ol>
        </section>
  
        <section class="panel">
          <h2>当前状态</h2>
          <div class="status" id="helper-status">
            <strong>等待代理结果</strong>
            <div style="color: var(--muted);">这个页面不再直接展示二维码。拿到代理结果后，会跳回主面板继续。</div>
          </div>
          <div class="meta-grid" id="helper-meta-grid" style="margin-top: 12px;"></div>
        </section>
      </div>
    </div>
  
    <script>
      const LOGIN_REGION_OPTIONS = ${JSON.stringify(LOGIN_REGION_OPTIONS)};
      const DEFAULT_LOGIN_REGION = ${JSON.stringify(DEFAULT_LOGIN_REGION)};
      const DEFAULT_NOTIFY_URL = ${JSON.stringify(DEFAULT_NOTIFY_URL)};
      const PROVIDER_URL_TEMPLATE = ${JSON.stringify(providerUrlTemplate)};
      const LOGIN_BRIDGE_STORAGE_KEY = "flowbot-upstream-login-bridge";
      const guidInput = document.getElementById("helper-guid");
      const regionSelect = document.getElementById("helper-region-select");
      const regionInput = document.getElementById("helper-region");
      const notifyUrlInput = document.getElementById("helper-notify-url");
      const rawInput = document.getElementById("helper-proxy-raw");
      const flash = document.getElementById("helper-flash");
      const proxyResult = document.getElementById("helper-proxy-result");
      const metaGrid = document.getElementById("helper-meta-grid");
      const statusBox = document.getElementById("helper-status");
      const clipboardLoginButton = document.getElementById("clipboard-login");
      const pastedLoginButton = document.getElementById("pasted-login");
      const openProviderButton = document.getElementById("open-provider");
      let busy = false;
  
      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }
  
      function setFlash(message, tone = "normal") {
        flash.textContent = message;
        flash.style.color = tone === "error"
          ? "var(--danger)"
          : (tone === "ok" ? "var(--ok)" : "var(--muted)");
      }
  
      function setStatus(title, lines, tone = "normal") {
        const color = tone === "error" ? "var(--danger)" : (tone === "ok" ? "var(--ok)" : "var(--muted)");
        statusBox.innerHTML =
          "<strong>" + escapeHtml(title) + "</strong>"
          + lines.map((line) => (
            '<div style="color: ' + color + ';">' + escapeHtml(line) + "</div>"
          )).join("");
      }
  
      function renderMeta(cards) {
        metaGrid.innerHTML = cards.map((item) => (
          '<div class="meta-card">'
          + '<div class="label">' + escapeHtml(item.label) + '</div>'
          + '<div class="value">' + escapeHtml(item.value) + '</div>'
          + '</div>'
        )).join("");
      }
  
      function renderRegions() {
        regionSelect.innerHTML = LOGIN_REGION_OPTIONS.map((item) => (
          '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label + " (" + item.value + ")") + '</option>'
        )).join("");
        const params = new URLSearchParams(window.location.search);
        const region = params.get("region") || DEFAULT_LOGIN_REGION;
        const guid = params.get("guid") || "";
        regionSelect.value = region;
        regionInput.value = region;
        guidInput.value = guid;
        notifyUrlInput.value = params.get("notifyUrl") || DEFAULT_NOTIFY_URL;
      }
  
      function getPayload() {
        return {
          guid: guidInput.value.trim(),
          region: regionInput.value.trim() || regionSelect.value || DEFAULT_LOGIN_REGION,
          notifyUrl: notifyUrlInput.value.trim() || DEFAULT_NOTIFY_URL,
          proxyFetchResult: rawInput.value.trim(),
        };
      }
  
      function buildProviderUrl(region) {
        return PROVIDER_URL_TEMPLATE.replace("__REGION__", encodeURIComponent(region || DEFAULT_LOGIN_REGION));
      }
  
      function renderProxyInfo(proxyInfo) {
        if (!proxyInfo?.proxy) {
          proxyResult.textContent = "还没有解析出代理。";
          return;
        }
        proxyResult.textContent = proxyInfo.proxy;
      }
  
      function renderBridgePreview(payload, proxyInfo) {
        renderProxyInfo(proxyInfo || null);
        renderMeta([
          { label: "GUID", value: payload?.guid || "-" },
          { label: "地区", value: payload?.region || "-" },
          { label: "回调地址", value: payload?.notifyUrl || "-" },
          { label: "代理", value: proxyInfo?.proxy || "待主面板继续处理" },
        ]);
        setStatus("准备返回主面板", [
          "代理结果已经收好，正在回到主面板。",
          "主面板会继续执行登录并展示二维码。",
        ], "ok");
      }
  
      function goBackToDashboard(payload) {
        const target = new URL("/flowbot/dashboard", window.location.origin);
        if (payload.guid) {
          target.searchParams.set("loginGuid", payload.guid);
        }
        if (payload.region) {
          target.searchParams.set("loginRegion", payload.region);
        }
        target.searchParams.set("autostartLogin", "1");
        window.location.href = target.toString();
      }
  
      function bridgeToDashboard(rawText) {
        const payload = getPayload();
        if (!payload.guid) {
          setFlash("请先填写 GUID", "error");
          setStatus("无法继续", ["缺少 GUID"], "error");
          return;
        }
        if (!String(rawText || "").trim()) {
          setFlash("请先提供代理接口返回内容", "error");
          setStatus("无法继续", ["缺少代理接口返回内容"], "error");
          return;
        }
        if (busy) {
          return;
        }
        busy = true;
        clipboardLoginButton.disabled = true;
        pastedLoginButton.disabled = true;
        setFlash("正在把代理结果带回主面板...");
        rawInput.value = String(rawText || "").trim();
        try {
          const bridgePayload = {
            guid: payload.guid,
            region: payload.region,
            notifyUrl: payload.notifyUrl,
            proxyFetchResult: String(rawText || "").trim(),
            createdAt: new Date().toISOString(),
          };
          window.localStorage.setItem(LOGIN_BRIDGE_STORAGE_KEY, JSON.stringify(bridgePayload));
          renderBridgePreview(bridgePayload, null);
          setFlash("已写入主面板，正在跳转...", "ok");
          setTimeout(() => {
            goBackToDashboard(bridgePayload);
          }, 180);
        } catch (error) {
          setStatus("回填失败", [String(error?.message || error)], "error");
          setFlash("回填失败：" + String(error?.message || error), "error");
        } finally {
          busy = false;
          clipboardLoginButton.disabled = false;
          pastedLoginButton.disabled = false;
        }
      }
  
      async function startFromClipboard() {
        try {
          const text = await navigator.clipboard.readText();
          if (!String(text || "").trim()) {
            throw new Error("clipboard_empty");
          }
          bridgeToDashboard(text);
        } catch (error) {
          setFlash("读取剪贴板失败，请改用手动粘贴：" + String(error?.message || error), "error");
          setStatus("无法从剪贴板继续", ["请把代理接口返回内容粘贴到左侧文本框后再试。"], "error");
        }
      }
  
      regionSelect.addEventListener("change", () => {
        regionInput.value = regionSelect.value || DEFAULT_LOGIN_REGION;
      });
      openProviderButton.addEventListener("click", () => {
        const region = regionInput.value.trim() || regionSelect.value || DEFAULT_LOGIN_REGION;
        window.open(buildProviderUrl(region), "_blank", "noopener,noreferrer");
        setFlash("已打开取代理接口页面，请复制返回内容后回到本页。");
        setStatus("等待代理结果", [
          "代理接口已在新页面打开。",
          "复制返回内容后，可直接点“从剪贴板导入并回到主面板”。",
        ]);
      });
      clipboardLoginButton.addEventListener("click", () => {
        startFromClipboard().catch((error) => {
          setFlash("回填失败：" + String(error?.message || error), "error");
        });
      });
      pastedLoginButton.addEventListener("click", () => {
        try {
          bridgeToDashboard(rawInput.value);
        } catch (error) {
          setFlash("回填失败：" + String(error?.message || error), "error");
        }
      });
      
      const params = new URLSearchParams(window.location.search);
      if (params.get("autofill") === "1") {
        setFlash("拿到代理结果后会自动回到主面板。");
        setStatus("等待代理结果", [
          "当前页只负责代理获取与回填。",
          "二维码和验证码都在主面板里继续。",
        ]);
      }
  
      rawInput.addEventListener("input", () => {
        const text = rawInput.value.trim();
        if (!text) {
          renderProxyInfo(null);
          return;
        }
        const matched = text.match(/(\\d{1,3}(?:\\.\\d{1,3}){3})\\s*[:：]\\s*(\\d{2,5})/);
        if (matched) {
          renderProxyInfo({ proxy: matched[1] + ":" + matched[2] });
        } else {
          renderProxyInfo({ proxy: text.slice(0, 120) + (text.length > 120 ? "..." : "") });
        }
      });
  
      regionSelect.addEventListener("change", () => {
        regionInput.value = regionSelect.value || DEFAULT_LOGIN_REGION;
      });
      openProviderButton.addEventListener("click", () => {
        const region = regionInput.value.trim() || regionSelect.value || DEFAULT_LOGIN_REGION;
        window.open(buildProviderUrl(region), "_blank", "noopener,noreferrer");
        setFlash("已打开取代理接口页面，请复制返回内容后回到本页。");
        setStatus("等待代理结果", [
          "代理接口已在新页面打开。",
          "复制返回内容后，回到本页继续。",
        ]);
      });
  
      renderRegions();
    </script>
  </body>
  </html>`;
  }

  return { renderProxyHelperHtml };
}

module.exports = { createProxyHelperHtmlRenderer };
