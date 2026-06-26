const $ = (id) => document.getElementById(id);
let currentMode = "video";
let currentAuthStatus = null;
let authRenderKey = "";
let jobsRenderKey = "";
let jobsTimer = null;
let clipState = { sourcePath: "", duration: 0 };
const expandedJobs = new Set();
const expandedLibraryGroups = new Set();
let jobItems = [];
let jobFilter = "all";
let libraryItems = [];
let libraryFilter = "all";
let videoProductMappingReady = false;
let videoProductMappingMessage = "请先完善视频识别配置";
const productMatchPayloads = new Map();
const productPreviewStates = new Map();
const candidateCommentPayloads = new Map();
const candidateCommentStates = new Map();
const chunkPreviewStates = new Map();
const PRODUCT_PAGE_SIZE = 20;
const CHUNK_PAGE_SIZE = 20;

const modes = {
  video: { label: "下载视频", path: "/api/video/download", button: "开始下载", hint: "适合普通视频或分享短链。" },
  live: { label: "处理直播", path: "", button: "开始处理", hint: "勾选需要的直播动作后开始。" }
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => node.classList.remove("show"), 4200);
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function domToken(text, prefix = "id") {
  let hash = 0;
  const source = String(text ?? "");
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0;
  }
  return `${prefix}-${Math.abs(hash)}`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${ms}`;
}

function formatMatchMetricNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 10000) {
    const wan = number / 10000;
    return `${wan >= 10 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, "")}万`;
  }
  if (number >= 1000) return number.toLocaleString("zh-CN");
  return String(Math.round(number * 100) / 100).replace(/\.0$/, "");
}

function formatMatchPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  const percent = number > 1 ? number : number * 100;
  return `${String(Math.round(percent * 10) / 10).replace(/\.0$/, "")}%`;
}

function setPill(id, state, text) {
  const node = $(id);
  node.className = `pill ${state}`;
  node.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    videoProductMappingReady = Boolean(health.video_product_mapping_ready);
    videoProductMappingMessage = health.video_product_mapping_message || "请先完善视频识别配置";
    setPill("healthPill", "ok", "服务在线");
  } catch {
    setPill("healthPill", "bad", "服务不可用");
  }
}

async function refreshAuth() {
  try {
    const status = await api("/api/auth/status");
    renderAuth(status);
  } catch (err) {
    setPill("authPill", "bad", "登录状态读取失败");
    $("loginState").className = "login-state bad";
    $("loginState").innerHTML = `<div class="state-icon">!</div><div><div class="state-title">读取失败</div><div class="state-sub">${escapeHtml(err.message || String(err))}</div></div>`;
  }
}

function renderAuth(status) {
  currentAuthStatus = status;
  const state = status.likely_logged_in ? "ok" : (status.has_cookie ? "warn" : "bad");
  const title = status.likely_logged_in ? "已登录" : (status.auth_issue ? "商品需重新登录" : (status.has_cookie ? "登录信息不完整" : "未登录"));
  const sub = status.likely_logged_in
    ? "已经可以抓商品和录直播。"
    : (status.auth_issue ? "直播可能仍可录制，但商品列表需要重新登录。" : (status.has_cookie ? "请重新登录一次。" : "点击打开抖音并同步登录，在弹出的窗口完成扫码或账号登录。"));
  const active = status.login_session_active ? "抖音窗口已打开，完成登录后会自动识别。" : "抖音窗口未打开";
  const detail = status.auth_issue ? `商品接口提示：${status.auth_issue}` : (status.likely_logged_in ? "当前账号可用。" : "直播录制和商品抓取建议先登录。");
  const nextKey = JSON.stringify({
    state,
    title,
    sub,
    passed: Boolean(status.likely_logged_in),
    updated_at: status.updated_at || "",
    active,
    detail,
    auth_issue: status.auth_issue || ""
  });
  if (nextKey === authRenderKey) return;
  authRenderKey = nextKey;
  setPill("authPill", state === "ok" ? "ok" : (state === "warn" ? "warn" : "bad"), title);
  $("loginState").className = `login-state ${state}`;
  $("loginState").innerHTML = `<div class="state-icon">${state === "ok" ? "✓" : "!"}</div><div><div class="state-title">${escapeHtml(title)}</div><div class="state-sub">${escapeHtml(sub)}</div></div>`;
  $("cookieCount").textContent = status.likely_logged_in ? "已通过" : "未完成";
  $("cookieTime").textContent = formatTime(status.updated_at);
  $("cookieKeys").textContent = `${active} · ${detail}`;
  const loginButton = document.querySelector("button[onclick='startLogin()']");
  if (loginButton) {
    const loggedIn = Boolean(status.likely_logged_in && !status.auth_issue);
    loginButton.textContent = loggedIn ? "已登录" : (status.auth_issue ? "重新打开抖音并登录" : "打开抖音并同步登录");
    loginButton.disabled = loggedIn;
  }
}

async function startLogin() {
  try {
    if (currentAuthStatus?.likely_logged_in && !currentAuthStatus?.auth_issue) {
      toast("当前账号已登录，无需重复登录。");
      return;
    }
    const url = "https://www.douyin.com/";
    const fresh = Boolean(currentAuthStatus?.auth_issue);
    await api("/api/auth/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, fresh })
    });
    toast(fresh ? "已打开抖音登录窗口。登录完成后这里会自动变成已登录。" : "已打开抖音窗口。登录完成后这里会自动变成已登录。");
    await refreshAuth();
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function cancelLogin() {
  try {
    const data = await api("/api/auth/login/cancel", { method: "POST" });
    renderAuth(data.status);
    toast("抖音窗口已关闭。");
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function logout() {
  if (!confirm("退出后这个平台会忘记当前抖音账号，需要重新登录。")) return;
  try {
    const data = await api("/api/auth/logout", { method: "POST" });
    renderAuth(data.status);
    toast(data.backup_path ? `已退出登录，备份在 ${data.backup_path}` : "已退出登录。");
  } catch (err) {
    toast(err.message || String(err));
  }
}

function selectMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  updateTaskUi();
}

function updateTaskUi() {
  const isLive = currentMode === "live";
  const record = $("recordLive").checked;
  const products = $("grabProducts").checked;
  const untilEnd = $("recordUntilEnd").checked;
  const allProducts = $("grabAllProducts").checked;
  $("selectedMode").textContent = modes[currentMode].label;
  $("liveOptions").style.display = isLive ? "grid" : "none";
  $("recordUntilEnd").disabled = !record;
  $("grabAllProducts").disabled = !products;
  $("durationField").style.display = isLive && record && !untilEnd ? "block" : "none";
  $("limitField").style.display = isLive && products && !allProducts ? "block" : "none";
  if (!isLive) {
    $("submitButton").textContent = "开始下载";
    $("modeHint").textContent = "适合普通视频或分享短链。";
    return;
  }
  if (record && products) {
    $("submitButton").textContent = "录制并抓商品";
    $("modeHint").textContent = `${untilEnd ? "会一直录到直播结束" : "会按秒数录制"}，${allProducts ? "并尽量获取全部商品" : "并按数量获取商品"}。`;
  } else if (record) {
    $("submitButton").textContent = "开始录制";
    $("modeHint").textContent = untilEnd ? "会一直录到直播结束。" : "达到设置秒数后会自动停止。";
  } else if (products) {
    $("submitButton").textContent = "抓取商品";
    $("modeHint").textContent = allProducts ? "会自动翻页，尽量获取直播间全部商品。" : "会按设置数量获取商品，最多 100 个。";
  } else {
    $("submitButton").textContent = "选择后开始";
    $("modeHint").textContent = "至少勾选一个直播动作。";
  }
}

function selectedPath() {
  if (currentMode === "video") return "/api/video/download";
  const record = $("recordLive").checked;
  const products = $("grabProducts").checked;
  if (record && products) return "/api/live/record-with-products";
  if (record) return "/api/live/record";
  if (products) return "/api/live/products";
  return "";
}

function payloadFor(path) {
  const url = extractUrl($("url").value);
  const duration = $("recordUntilEnd").checked ? 0 : Number($("duration").value || 30);
  const limit = Number($("limit").value || 20);
  const allProducts = $("grabAllProducts").checked;
  if (path.includes("record-with-products")) return { url, duration_seconds: duration, limit, all_products: allProducts };
  if (path.includes("record")) return { url, duration_seconds: duration };
  if (path.includes("products")) return { url, limit, all_products: allProducts };
  return { url };
}

function extractUrl(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/https?:\/\/[^\s，,。]+/);
  return match ? match[0].replace(/[。，,.!！?？]+$/, "") : raw;
}

function isLiveUrl(url) {
  return /live\.douyin\.com|douyin\.com\/(?:follow\/)?live\//i.test(String(url || ""));
}

async function submitSelected() {
  try {
    const path = selectedPath();
    if (!path) {
      toast("请至少勾选一个直播动作。");
      return;
    }
    const payload = payloadFor(path);
    if (!payload.url) {
      toast("先粘贴一个抖音视频或直播链接。");
      return;
    }
    if (currentMode === "video" && isLiveUrl(payload.url)) {
      selectMode("live");
      toast("这是直播链接，已切换到处理直播。请选择录制、抓商品或录制+商品。");
      return;
    }
    await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    toast("任务已创建。");
    await refreshJobs();
    startJobsPolling();
  } catch (err) {
    toast(err.message || String(err));
  }
}
