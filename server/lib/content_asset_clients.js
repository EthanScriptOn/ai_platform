"use strict";

const crypto = require("crypto");

function normalizeContentAssetStatus(status = {}) {
  const raw = status && typeof status === "object" ? status : {};
  return {
    ok: raw.ok !== false,
    connected: true,
    installed: true,
    likelyLoggedIn: Boolean(raw.likely_logged_in || raw.likelyLoggedIn),
    hasCookie: Boolean(raw.has_cookie || raw.hasCookie),
    jobCount: Number(raw.job_count || raw.jobCount || 0),
    runningCount: Number(raw.running_count || raw.runningCount || 0),
    lastJobAt: raw.last_job_at || raw.lastJobAt || "",
    message: raw.message || "抖音本地执行端已连接平台。",
    data: raw.data && typeof raw.data === "object" ? raw.data : {},
  };
}

function isContentAssetStatusLike(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  return (
    Object.prototype.hasOwnProperty.call(payload, "likely_logged_in") ||
    Object.prototype.hasOwnProperty.call(payload, "likelyLoggedIn") ||
    Object.prototype.hasOwnProperty.call(payload, "has_cookie") ||
    Object.prototype.hasOwnProperty.call(payload, "hasCookie") ||
    Object.prototype.hasOwnProperty.call(payload, "job_count") ||
    Object.prototype.hasOwnProperty.call(payload, "jobCount") ||
    Object.prototype.hasOwnProperty.call(payload, "running_count") ||
    Object.prototype.hasOwnProperty.call(payload, "runningCount") ||
    Object.prototype.hasOwnProperty.call(payload, "data") ||
    Object.prototype.hasOwnProperty.call(payload, "connected") ||
    Object.prototype.hasOwnProperty.call(payload, "installed")
  );
}

function mergeContentAssetStatus(currentStatus, nextPayload) {
  const current = normalizeContentAssetStatus(currentStatus || {});
  const next = normalizeContentAssetStatus(nextPayload || {});
  return {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "ok") ? { ok: next.ok } : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "connected")
      ? { connected: next.connected }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "installed")
      ? { installed: next.installed }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "likely_logged_in") ||
    Object.prototype.hasOwnProperty.call(nextPayload || {}, "likelyLoggedIn")
      ? { likelyLoggedIn: next.likelyLoggedIn }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "has_cookie") ||
    Object.prototype.hasOwnProperty.call(nextPayload || {}, "hasCookie")
      ? { hasCookie: next.hasCookie }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "job_count") ||
    Object.prototype.hasOwnProperty.call(nextPayload || {}, "jobCount")
      ? { jobCount: next.jobCount }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(nextPayload || {}, "running_count") ||
    Object.prototype.hasOwnProperty.call(nextPayload || {}, "runningCount")
      ? { runningCount: next.runningCount }
      : {}),
    lastJobAt: nextPayload?.last_job_at || nextPayload?.lastJobAt || current.lastJobAt,
    data:
      nextPayload?.data && typeof nextPayload.data === "object" && Object.keys(nextPayload.data).length
        ? next.data
        : current.data,
    message: nextPayload?.message || current.message,
  };
}

function createContentAssetClientManager({
  commandTimeoutMs = 30000,
  now = () => Date.now(),
  randomBytes = (size) => crypto.randomBytes(size),
} = {}) {
  const clients = new Map();

  function ensureContentAssetClient(token) {
    const value = String(token || "").trim();
    if (!value) return null;
    const current = clients.get(value) || {
      token: value,
      clientId: "",
      queue: [],
      pending: new Map(),
      lastSeenAt: 0,
      status: null,
    };
    clients.set(value, current);
    return current;
  }

  function createContentAssetToken() {
    const token = `content_${randomBytes(24).toString("hex")}`;
    ensureContentAssetClient(token);
    return token;
  }

  function activeContentAssetClient(token = "") {
    const value = String(token || "").trim();
    if (value) return clients.get(value) || null;
    let active = null;
    for (const client of clients.values()) {
      if (!active || client.lastSeenAt > active.lastSeenAt) active = client;
    }
    return active;
  }

  function updateContentAssetClient(token, clientId, status) {
    const current = ensureContentAssetClient(token);
    if (!current) return null;
    current.clientId = String(clientId || current.clientId || "").trim();
    current.lastSeenAt = now();
    if (status && isContentAssetStatusLike(status)) {
      current.status = mergeContentAssetStatus(current.status, status);
    }
    return current;
  }

  function updateLegacyContentAssetClient(clientId, status) {
    if (!clientId) return null;
    const current = clients.get(clientId) || {
      token: clientId,
      clientId,
      queue: [],
      pending: new Map(),
      lastSeenAt: 0,
      status: null,
    };
    current.lastSeenAt = now();
    if (status && isContentAssetStatusLike(status)) {
      current.status = mergeContentAssetStatus(current.status, status);
    }
    clients.set(clientId, current);
    return current;
  }

  function contentAssetRemoteStatus(token = "") {
    const client = activeContentAssetClient(token);
    if (!client) {
      return {
        ok: false,
        connected: false,
        installed: false,
        message: "抖音本地执行端未连接平台服务器。",
      };
    }
    if (!client.lastSeenAt) {
      return {
        ok: false,
        connected: false,
        installed: false,
        clientId: client.clientId || "",
        message: "抖音本地执行端尚未上报状态。请先复制安装命令并在这台电脑终端运行。",
      };
    }
    if (now() - client.lastSeenAt > 15000) {
      return {
        ...normalizeContentAssetStatus(client.status || {}),
        ok: false,
        connected: false,
        installed: true,
        clientId: client.clientId,
        lastSeenAt: new Date(client.lastSeenAt).toISOString(),
        message: "抖音本地执行端连接暂时中断，当前展示的是最后一次同步状态。",
      };
    }
    return {
      ...normalizeContentAssetStatus(client.status || {}),
      clientId: client.clientId,
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
    };
  }

  function sendContentAssetCommand(apiPath, options = {}) {
    return sendContentAssetCommandForToken("", apiPath, options);
  }

  function sendContentAssetCommandForToken(token, apiPath, options = {}) {
    const client = activeContentAssetClient(token);
    if (!client || now() - client.lastSeenAt > 15000) {
      return Promise.resolve({
        ...contentAssetRemoteStatus(token),
        ok: false,
        message: "抖音本地执行端未连接平台服务器，无法下发命令。",
      });
    }
    const commandId = `content-cmd-${now()}-${randomBytes(4).toString("hex")}`;
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
          ok: false,
          ...contentAssetRemoteStatus(token),
          message: "抖音本地执行端响应超时，请稍后刷新状态后重试。",
        });
      }, commandTimeoutMs);
      client.pending.set(commandId, { resolve, timer });
    });
  }

  function completeContentAssetCommand(token, commandId, payload) {
    const client = activeContentAssetClient(token);
    if (!client) return false;
    client.lastSeenAt = now();
    if (payload && isContentAssetStatusLike(payload)) {
      client.status = mergeContentAssetStatus(client.status, payload);
    }
    const pending = client.pending.get(commandId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    client.pending.delete(commandId);
    pending.resolve(payload || contentAssetRemoteStatus());
    return true;
  }

  return {
    activeContentAssetClient,
    completeContentAssetCommand,
    contentAssetRemoteStatus,
    createContentAssetToken,
    ensureContentAssetClient,
    sendContentAssetCommand,
    sendContentAssetCommandForToken,
    updateContentAssetClient,
    updateLegacyContentAssetClient,
  };
}

module.exports = {
  createContentAssetClientManager,
  isContentAssetStatusLike,
  mergeContentAssetStatus,
  normalizeContentAssetStatus,
};
