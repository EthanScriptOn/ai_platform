"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function normalizeCollectorStatus(status = {}) {
  const listening = Boolean(status.listening);
  return {
    ok: status.ok !== false,
    connected: true,
    installed: true,
    listening,
    selectedType: status.selectedType || "all",
    certificateTrusted: Boolean(status.certificateTrusted),
    certificatePath: status.certificatePath || "",
    captures: Array.isArray(status.captures) ? status.captures : [],
    message: status.message || `后台包已连接，采集监听${listening ? "已开启" : "未开启"}。`,
    data: status.data || {},
  };
}

function isCollectorStatusLike(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  return (
    Object.prototype.hasOwnProperty.call(payload, "captures") ||
    Object.prototype.hasOwnProperty.call(payload, "listening") ||
    Object.prototype.hasOwnProperty.call(payload, "certificateTrusted") ||
    Object.prototype.hasOwnProperty.call(payload, "selectedType") ||
    Object.prototype.hasOwnProperty.call(payload, "data") ||
    Object.prototype.hasOwnProperty.call(payload, "connected") ||
    Object.prototype.hasOwnProperty.call(payload, "installed")
  );
}

function mergeCollectorStatus(currentStatus, nextPayload) {
  const current = normalizeCollectorStatus(currentStatus || {});
  const next = normalizeCollectorStatus(nextPayload || {});
  return {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "ok") ? { ok: next.ok } : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "connected")
      ? { connected: next.connected }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "installed")
      ? { installed: next.installed }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "listening")
      ? { listening: next.listening }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "certificateTrusted")
      ? { certificateTrusted: next.certificateTrusted }
      : {}),
    captures: Array.isArray(nextPayload?.captures) ? next.captures : current.captures,
    selectedType: nextPayload?.selectedType ? next.selectedType : current.selectedType,
    certificatePath: nextPayload?.certificatePath || current.certificatePath,
    data:
      nextPayload?.data && typeof nextPayload.data === "object" && Object.keys(nextPayload.data).length
        ? next.data
        : current.data,
    message: nextPayload?.message || current.message,
  };
}

function safeWechatCollectorStatus(status = {}) {
  const next = normalizeCollectorStatus(status || {});
  return {
    ...next,
    captures: Array.isArray(next.captures) ? next.captures.slice(0, 200) : [],
  };
}

function wechatTokenFromRequest(req, payload = {}, url = null) {
  const header = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  return String(payload.token || url?.searchParams?.get("token") || "").trim();
}

function createWechatCollectorClientManager({
  statePath = "",
  commandTimeoutMs = 30000,
  now = () => Date.now(),
  isoNow = () => new Date().toISOString(),
  randomBytes = (size) => crypto.randomBytes(size),
} = {}) {
  const clients = new Map();

  function saveWechatCollectorClients() {
    if (!statePath) return;
    const items = Array.from(clients.values()).map((client) => ({
      token: client.token,
      clientId: client.clientId || "",
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      lastSeenAt: client.lastSeenAt || 0,
      status: client.status || null,
    }));
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(items, null, 2));
  }

  function loadWechatCollectorClients() {
    if (!statePath) return;
    try {
      const raw = fs.readFileSync(statePath, "utf-8");
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const token = String(item.token || "").trim();
        if (!token) continue;
        clients.set(token, {
          token,
          clientId: String(item.clientId || "").trim(),
          createdAt: item.createdAt || isoNow(),
          updatedAt: item.updatedAt || item.createdAt || isoNow(),
          lastSeenAt: Number(item.lastSeenAt || 0),
          status: item.status || null,
          queue: [],
          pending: new Map(),
        });
      }
    } catch {
      // Missing state is fine; tokens are created lazily by the web page or install script.
    }
  }

  function createWechatCollectorToken() {
    const nextIso = isoNow();
    const token = `wechat_${randomBytes(24).toString("hex")}`;
    clients.set(token, {
      token,
      clientId: "",
      createdAt: nextIso,
      updatedAt: nextIso,
      lastSeenAt: 0,
      status: null,
      queue: [],
      pending: new Map(),
    });
    saveWechatCollectorClients();
    return token;
  }

  function ensureWechatCollectorClient(token) {
    const value = String(token || "").trim();
    if (!value) return null;
    let client = clients.get(value);
    if (!client) {
      const nextIso = isoNow();
      client = {
        token: value,
        clientId: "",
        createdAt: nextIso,
        updatedAt: nextIso,
        lastSeenAt: 0,
        status: null,
        queue: [],
        pending: new Map(),
      };
      clients.set(value, client);
      saveWechatCollectorClients();
    }
    return client;
  }

  function updateWechatCollectorClient(token, clientId, status) {
    const client = ensureWechatCollectorClient(token);
    if (!client) return null;
    client.clientId = String(clientId || client.clientId || "").trim();
    client.lastSeenAt = now();
    client.updatedAt = isoNow();
    if (status && isCollectorStatusLike(status)) {
      client.status = safeWechatCollectorStatus(mergeCollectorStatus(client.status, status));
    }
    saveWechatCollectorClients();
    return client;
  }

  function wechatCollectorStatusForToken(token) {
    const client = clients.get(String(token || "").trim());
    if (!client) {
      return {
        ok: false,
        connected: false,
        installed: false,
        captures: [],
        message: "还没有为这台电脑创建后台包绑定，请先复制安装/启动命令。",
      };
    }
    if (!client.lastSeenAt) {
      return {
        ok: false,
        connected: false,
        installed: false,
        captures: [],
        token: client.token,
        message: "后台包尚未上报状态。请先复制安装/启动命令并在这台电脑终端运行。",
      };
    }
    const stale = now() - client.lastSeenAt > 20000;
    return {
      ...safeWechatCollectorStatus(client.status || {}),
      ok: !stale,
      connected: !stale,
      installed: true,
      token: client.token,
      clientId: client.clientId || "",
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      message: stale
        ? "后台包刚才在线，但当前上报已中断。请确认本机后台包仍在运行。"
        : client.status?.message || "后台包已通过服务器连接到页面。",
    };
  }

  function sendWechatCollectorCommand(token, apiPath, options = {}) {
    const client = ensureWechatCollectorClient(token);
    const status = wechatCollectorStatusForToken(token);
    if (!client || !status.connected) {
      return Promise.resolve({
        ...status,
        ok: false,
        message: "本机后台包未连接平台服务器，无法下发命令。",
      });
    }
    const commandId = `wechat-cmd-${now()}-${randomBytes(4).toString("hex")}`;
    const command = {
      id: commandId,
      path: apiPath,
      options: {
        method: options.method || "GET",
        body: options.body || "",
        headers: options.headers || {},
      },
      createdAt: now(),
    };
    client.queue.push(command);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.pending.delete(commandId);
        resolve({
          ...wechatCollectorStatusForToken(token),
          ok: false,
          message: "本机后台包响应超时，请稍后刷新状态后重试。",
        });
      }, commandTimeoutMs);
      client.pending.set(commandId, { resolve, timer });
    });
  }

  function completeWechatCollectorCommand(token, commandId, payload) {
    const client = clients.get(String(token || "").trim());
    if (!client) return false;
    client.lastSeenAt = now();
    client.updatedAt = isoNow();
    if (payload && isCollectorStatusLike(payload)) {
      client.status = safeWechatCollectorStatus(mergeCollectorStatus(client.status, payload));
      saveWechatCollectorClients();
    }
    const pending = client.pending.get(commandId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    client.pending.delete(commandId);
    pending.resolve(payload || wechatCollectorStatusForToken(token));
    return true;
  }

  return {
    completeWechatCollectorCommand,
    createWechatCollectorToken,
    ensureWechatCollectorClient,
    loadWechatCollectorClients,
    saveWechatCollectorClients,
    sendWechatCollectorCommand,
    updateWechatCollectorClient,
    wechatCollectorStatusForToken,
  };
}

module.exports = {
  createWechatCollectorClientManager,
  isCollectorStatusLike,
  mergeCollectorStatus,
  normalizeCollectorStatus,
  safeWechatCollectorStatus,
  wechatTokenFromRequest,
};
