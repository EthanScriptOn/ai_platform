"use strict";

const RAGFLOW_KEYS = [
  "RAGFLOW_BASE_URL",
  "RAGFLOW_CHAT_URL",
  "RAGFLOW_AGENT_ID",
  "RAGFLOW_DATASET_ID",
  "RAGFLOW_SHARE_AUTH",
  "RAGFLOW_LOGIN_EMAIL",
  "RAGFLOW_LOGIN_PASSWORD",
  "RAGFLOW_LOGIN_PUBLIC_KEY",
];

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function valueFrom(configObject, key, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(configObject || {}, key)) {
    return configObject[key] == null ? "" : String(configObject[key]);
  }
  return fallback == null ? "" : String(fallback);
}

function mask(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function createRagflowConfigManager({
  current = {},
  loadRagflowSettings = () => ({}),
  loadRagflowToken,
  saveRagflowSettings,
  saveRagflowToken,
} = {}) {
  function mergedConfig() {
    return {
      ...current,
      ...loadRagflowSettings(),
    };
  }

  function getConfig() {
    const configObject = mergedConfig();
    const baseUrl = normalizeBaseUrl(
      valueFrom(configObject, "RAGFLOW_BASE_URL", "http://127.0.0.1:8080"),
    );
    const token = String(loadRagflowToken?.() || "").trim();
    return {
      ok: true,
      needsRestartAfterSave: true,
      storage: "mysql",
      config: {
        baseUrl,
        chatUrl: valueFrom(configObject, "RAGFLOW_CHAT_URL", `${baseUrl}/yuebai-workbench/`),
        agentId: valueFrom(configObject, "RAGFLOW_AGENT_ID", ""),
        datasetId: valueFrom(configObject, "RAGFLOW_DATASET_ID", ""),
        tokenStorage: "mysql",
        tokenMasked: mask(token),
        tokenConfigured: Boolean(token),
        loginEmail: valueFrom(configObject, "RAGFLOW_LOGIN_EMAIL", ""),
        loginPasswordConfigured: Boolean(valueFrom(configObject, "RAGFLOW_LOGIN_PASSWORD", "")),
        loginPublicKeyConfigured: Boolean(valueFrom(configObject, "RAGFLOW_LOGIN_PUBLIC_KEY", "")),
        shareAuthConfigured: Boolean(valueFrom(configObject, "RAGFLOW_SHARE_AUTH", "")),
      },
    };
  }

  function saveConfig(payload = {}) {
    const currentPayload = payload || {};
    const baseUrl = normalizeBaseUrl(currentPayload.baseUrl || currentPayload.RAGFLOW_BASE_URL);
    const settings = {};
    if (baseUrl) settings.RAGFLOW_BASE_URL = baseUrl;
    settings.RAGFLOW_CHAT_URL = String(
      currentPayload.chatUrl || currentPayload.RAGFLOW_CHAT_URL || (baseUrl ? `${baseUrl}/yuebai-workbench/` : ""),
    ).trim();
    settings.RAGFLOW_AGENT_ID = String(currentPayload.agentId || currentPayload.RAGFLOW_AGENT_ID || "").trim();
    settings.RAGFLOW_DATASET_ID = String(currentPayload.datasetId || currentPayload.RAGFLOW_DATASET_ID || "").trim();
    settings.RAGFLOW_LOGIN_EMAIL = String(currentPayload.loginEmail || currentPayload.RAGFLOW_LOGIN_EMAIL || "").trim();

    const loginPassword = String(currentPayload.loginPassword || currentPayload.RAGFLOW_LOGIN_PASSWORD || "").trim();
    if (loginPassword) settings.RAGFLOW_LOGIN_PASSWORD = loginPassword;
    const loginPublicKey = String(currentPayload.loginPublicKey || currentPayload.RAGFLOW_LOGIN_PUBLIC_KEY || "").trim();
    if (loginPublicKey) settings.RAGFLOW_LOGIN_PUBLIC_KEY = loginPublicKey;
    const shareAuth = String(currentPayload.shareAuth || currentPayload.RAGFLOW_SHARE_AUTH || "").trim();
    if (shareAuth) settings.RAGFLOW_SHARE_AUTH = shareAuth;

    const filteredSettings = Object.fromEntries(
      Object.entries(settings).filter(([key]) => RAGFLOW_KEYS.includes(key)),
    );
    if (!saveRagflowSettings?.(filteredSettings)) {
      throw new Error("RAGFlow 配置需要写入 MySQL，但当前 MySQL 配置不可用。");
    }

    const token = String(currentPayload.apiToken || currentPayload.token || "").trim();
    if (token && !saveRagflowToken?.(token)) {
      throw new Error("RAGFlow API Token 需要写入 MySQL，但当前 MySQL 配置不可用。");
    }

    return getConfig();
  }

  return { getConfig, saveConfig };
}

module.exports = { createRagflowConfigManager };
