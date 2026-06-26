"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MANAGED_SERVICE_ENV_KEYS = [
  "FLOWBOT_STORAGE_BACKEND",
  "FLOWBOT_DATA_DIR",
  "FLOWBOT_KNOWLEDGE_DIR",
  "FLOWBOT_MYSQL_BIN",
  "FLOWBOT_MYSQL_HOST",
  "FLOWBOT_MYSQL_PORT",
  "FLOWBOT_MYSQL_DATABASE",
  "FLOWBOT_MYSQL_USER",
  "FLOWBOT_MYSQL_PASSWORD",
  "FLOWBOT_MYSQL_AUTO_MIGRATE",
  "FLOWBOT_TARGET_ROOM_IDS",
  "FLOWBOT_ROOM_NAME_MAP",
  "FLOWBOT_FEISHU_TARGET_CHAT_IDS",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_OAUTH_REDIRECT_URI",
  "FEISHU_OAUTH_SCOPE",
  "FLOWBOT_ARCHIVE_ENABLED",
  "FLOWBOT_CASE_ARCHIVE_NOTIFY_ENABLED",
  "FLOWBOT_AGENT_WAKE_NAMES",
  "FLOWBOT_LLM_CLASSIFY_ENABLED",
  "FLOWBOT_LLM_API_URL",
  "FLOWBOT_LLM_API_KEY",
  "FLOWBOT_LLM_MODEL",
  "FLOWBOT_LLM_TIMEOUT_MS",
  "FLOWBOT_LLM_TIMEOUT_RETRY_ATTEMPTS",
  "FLOWBOT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS",
  "FLOWBOT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS",
  "FLOWBOT_LLM_MAX_REPAIR_ATTEMPTS",
  "FLOWBOT_IMAGE_SUMMARY_ENABLED",
  "FLOWBOT_IMAGE_SUMMARY_MODEL",
  "FLOWBOT_IMAGE_SUMMARY_TIMEOUT_MS",
  "FLOWBOT_IMAGE_SUMMARY_MAX_BYTES",
  "FLOWBOT_TRANSCRIBE_ENABLED",
  "FLOWBOT_TRANSCRIBE_PYTHON",
  "FLOWBOT_TRANSCRIBE_MODEL",
  "FLOWBOT_TRANSCRIBE_LANGUAGE",
  "FLOWBOT_TRANSCRIBE_TIMEOUT_MS",
  "FLOWBOT_KNOWLEDGE_HARVEST_ENABLED",
  "FLOWBOT_KNOWLEDGE_HARVEST_ROOM_IDS",
  "FLOWBOT_KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS",
  "FLOWBOT_KNOWLEDGE_HARVEST_READY_AGE_MS",
  "FLOWBOT_KNOWLEDGE_HARVEST_MAX_PER_SCAN",
  "FLOWBOT_RAGFLOW_CHAT_ID",
];

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= 8) {
    return "*".repeat(text.length);
  }
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function normalizeBooleanInput(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return fallback;
}

function normalizeIntegerInput(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizeTargetRoomIdsInput(value, fallback = "") {
  const items = String(value ?? fallback)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items)).join(",");
}

function normalizeAgentWakeNamesInput(value, fallback = "") {
  const items = String(value ?? fallback)
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items)).join(",");
}

function normalizeStorageBackendInput(value, fallback = "file") {
  const text = String(value ?? fallback).trim().toLowerCase();
  if (text === "mysql") {
    return "mysql";
  }
  return "file";
}

function normalizePathInput(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || String(fallback || "").trim();
}

function parseSystemdEnvironmentEntries(serviceText) {
  const env = {};
  for (const line of String(serviceText || "").split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Environment=")) {
      continue;
    }
    const raw = trimmed.slice("Environment=".length);
    const delimiterIndex = raw.indexOf("=");
    if (delimiterIndex <= 0) {
      continue;
    }
    const key = raw.slice(0, delimiterIndex).trim();
    let value = raw.slice(delimiterIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    env[key] = value;
  }
  return env;
}

function parseSimpleEnvFile(text) {
  const env = {};
  for (const line of String(text || "").split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const raw = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const delimiterIndex = raw.indexOf("=");
    if (delimiterIndex <= 0) {
      continue;
    }
    const key = raw.slice(0, delimiterIndex).trim();
    let value = raw.slice(delimiterIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
    }
    env[key] = value;
  }
  return env;
}

function formatSystemdEnvironmentLine(key, value) {
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
  return `Environment=${key}="${escaped}"`;
}

function upsertManagedServiceConfig(serviceText, managedEnv) {
  const beginMarker = "# BEGIN FLOWBOT DASHBOARD CONFIG";
  const endMarker = "# END FLOWBOT DASHBOARD CONFIG";
  const blockLines = [
    beginMarker,
    ...Object.entries(managedEnv).map(([key, value]) => formatSystemdEnvironmentLine(key, value)),
    endMarker,
  ];
  const lines = String(serviceText || "").split(/\r?\n/g);
  const beginIndex = lines.findIndex((line) => line.trim() === beginMarker);
  const endIndex = lines.findIndex((line) => line.trim() === endMarker);
  if (beginIndex >= 0 && endIndex > beginIndex) {
    lines.splice(beginIndex, endIndex - beginIndex + 1, ...blockLines);
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Environment=")) {
      return true;
    }
    const raw = trimmed.slice("Environment=".length);
    const delimiterIndex = raw.indexOf("=");
    if (delimiterIndex <= 0) {
      return true;
    }
    const key = raw.slice(0, delimiterIndex).trim();
    return !MANAGED_SERVICE_ENV_KEYS.includes(key);
  });
  const insertIndex = Math.max(0, filteredLines.findIndex((line) => line.trim().startsWith("ExecStart=")));
  const targetIndex = insertIndex > 0 ? insertIndex : filteredLines.length;
  filteredLines.splice(targetIndex, 0, ...blockLines);
  return `${filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createFlowbotConfigManager({
  AGENT_WAKE_NAMES,
  ARCHIVE_ENABLED,
  ARCHIVE_MODE,
  CASE_ARCHIVE_NOTIFY_ENABLED,
  CONFIG_TEST_PATH,
  DATA_DIR,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_OAUTH_REDIRECT_URI,
  FEISHU_OAUTH_SCOPE,
  FEISHU_TARGET_CHAT_IDS,
  FEISHU_VERIFICATION_TOKEN,
  FLOWBOT_STORAGE_BACKEND,
  KNOWLEDGE_HARVEST_ENABLED,
  KNOWLEDGE_HARVEST_MAX_PER_SCAN,
  KNOWLEDGE_HARVEST_READY_AGE_MS,
  KNOWLEDGE_HARVEST_ROOM_IDS,
  KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
  KNOWLEDGE_DIR,
  LLM_API_URL,
  LLM_CLASSIFY_ENABLED,
  LLM_MAX_REPAIR_ATTEMPTS,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  LLM_TIMEOUT_RETRY_ATTEMPTS,
  LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
  LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
  RAGFLOW_CHAT_ID,
  IMAGE_SUMMARY_ENABLED,
  IMAGE_SUMMARY_MAX_BYTES,
  IMAGE_SUMMARY_MODEL,
  IMAGE_SUMMARY_TIMEOUT_MS,
  LOCAL_LAUNCH_AGENT_LABEL,
  LOCAL_LAUNCH_AGENT_PLIST_PATH,
  LOCAL_MANAGED_CONFIG_PATH,
  SERVICE_FILE_PATH,
  SERVICE_NAME,
  TARGET_ROOM_IDS,
  TRANSCRIBE_ENABLED,
  TRANSCRIBE_LANGUAGE,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_PYTHON,
  TRANSCRIBE_TIMEOUT_MS,
  legacyLocalManagedEnvPath,
  readRuntimeSettings = () => ({}),
  readJsonFile,
  spawnImpl = spawn,
  writeRuntimeSettings,
}) {
  function buildFlowbotConfigFromEnv(env, { includeSecrets = false } = {}) {
    const targetRoomIds = normalizeTargetRoomIdsInput(env.FLOWBOT_TARGET_ROOM_IDS || Array.from(TARGET_ROOM_IDS).join(","));
    const feishuTargetChatIds = normalizeTargetRoomIdsInput(env.FLOWBOT_FEISHU_TARGET_CHAT_IDS || Array.from(FEISHU_TARGET_CHAT_IDS).join(","));
    const agentWakeNames = normalizeAgentWakeNamesInput(env.FLOWBOT_AGENT_WAKE_NAMES || AGENT_WAKE_NAMES.join(","));
    const llmApiKey = String(env.FLOWBOT_LLM_API_KEY || "");
    const mysqlPassword = String(env.FLOWBOT_MYSQL_PASSWORD || "");
    const feishuAppSecret = String(env.FEISHU_APP_SECRET || "");
    const feishuVerificationToken = String(env.FEISHU_VERIFICATION_TOKEN || "");
    return {
      storageBackend: normalizeStorageBackendInput(env.FLOWBOT_STORAGE_BACKEND, FLOWBOT_STORAGE_BACKEND || "file"),
      dataDir: normalizePathInput(env.FLOWBOT_DATA_DIR, DATA_DIR),
      knowledgeDir: normalizePathInput(env.FLOWBOT_KNOWLEDGE_DIR, KNOWLEDGE_DIR),
      mysqlBin: String(env.FLOWBOT_MYSQL_BIN || process.env.FLOWBOT_MYSQL_BIN || "mysql").trim() || "mysql",
      mysqlHost: String(env.FLOWBOT_MYSQL_HOST || process.env.FLOWBOT_MYSQL_HOST || "127.0.0.1").trim(),
      mysqlPort: normalizeIntegerInput(env.FLOWBOT_MYSQL_PORT || process.env.FLOWBOT_MYSQL_PORT, 3306, { min: 1, max: 65535 }),
      mysqlDatabase: String(env.FLOWBOT_MYSQL_DATABASE || process.env.FLOWBOT_MYSQL_DATABASE || "").trim(),
      mysqlUser: String(env.FLOWBOT_MYSQL_USER || process.env.FLOWBOT_MYSQL_USER || "").trim(),
      mysqlPassword: includeSecrets ? mysqlPassword : "",
      mysqlPasswordConfigured: Boolean(mysqlPassword),
      mysqlPasswordMasked: maskSecret(mysqlPassword),
      mysqlAutoMigrate: normalizeBooleanInput(env.FLOWBOT_MYSQL_AUTO_MIGRATE, true),
      targetRoomIds,
      roomNameMap: String(env.FLOWBOT_ROOM_NAME_MAP || process.env.FLOWBOT_ROOM_NAME_MAP || "").trim(),
      feishuTargetChatIds,
      feishuAppId: String(env.FEISHU_APP_ID || FEISHU_APP_ID || "").trim(),
      feishuAppSecret: includeSecrets ? feishuAppSecret : "",
      feishuAppSecretConfigured: Boolean(feishuAppSecret.trim()),
      feishuAppSecretMasked: maskSecret(feishuAppSecret),
      feishuVerificationToken: includeSecrets ? feishuVerificationToken : "",
      feishuVerificationTokenConfigured: Boolean(feishuVerificationToken.trim()),
      feishuVerificationTokenMasked: maskSecret(feishuVerificationToken),
      feishuOauthRedirectUri: String(env.FEISHU_OAUTH_REDIRECT_URI || FEISHU_OAUTH_REDIRECT_URI || "").trim(),
      feishuOauthScope: String(
        env.FEISHU_OAUTH_SCOPE
        || FEISHU_OAUTH_SCOPE
        || "wiki:space:retrieve wiki:node:read docx:document:readonly",
      ).trim(),
      archiveEnabled: normalizeBooleanInput(env.FLOWBOT_ARCHIVE_ENABLED, ARCHIVE_ENABLED),
      caseArchiveNotifyEnabled: normalizeBooleanInput(
        env.FLOWBOT_CASE_ARCHIVE_NOTIFY_ENABLED,
        CASE_ARCHIVE_NOTIFY_ENABLED,
      ),
      agentWakeNames,
      llmClassifyEnabled: normalizeBooleanInput(env.FLOWBOT_LLM_CLASSIFY_ENABLED, LLM_CLASSIFY_ENABLED),
      llmApiUrl: String(env.FLOWBOT_LLM_API_URL || LLM_API_URL).trim(),
      llmApiKey: includeSecrets ? llmApiKey : "",
      llmApiKeyConfigured: Boolean(llmApiKey.trim()),
      llmApiKeyMasked: maskSecret(llmApiKey),
      llmModel: String(env.FLOWBOT_LLM_MODEL || LLM_MODEL).trim(),
      llmTimeoutMs: normalizeIntegerInput(env.FLOWBOT_LLM_TIMEOUT_MS, LLM_TIMEOUT_MS, { min: 1000, max: 300000 }),
      llmTimeoutRetryAttempts: normalizeIntegerInput(
        env.FLOWBOT_LLM_TIMEOUT_RETRY_ATTEMPTS,
        LLM_TIMEOUT_RETRY_ATTEMPTS,
        { min: 1, max: 5 },
      ),
      llmTimeoutRetryBaseDelayMs: normalizeIntegerInput(
        env.FLOWBOT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
        LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
        { min: 100, max: 10000 },
      ),
      llmTimeoutRetryMaxDelayMs: normalizeIntegerInput(
        env.FLOWBOT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
        LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
        { min: 1000, max: 60000 },
      ),
      llmMaxRepairAttempts: normalizeIntegerInput(env.FLOWBOT_LLM_MAX_REPAIR_ATTEMPTS, LLM_MAX_REPAIR_ATTEMPTS, { min: 0, max: 5 }),
      imageSummaryEnabled: normalizeBooleanInput(env.FLOWBOT_IMAGE_SUMMARY_ENABLED, IMAGE_SUMMARY_ENABLED),
      imageSummaryModel: String(env.FLOWBOT_IMAGE_SUMMARY_MODEL || IMAGE_SUMMARY_MODEL || "qwen-vl-plus").trim(),
      imageSummaryTimeoutMs: normalizeIntegerInput(
        env.FLOWBOT_IMAGE_SUMMARY_TIMEOUT_MS,
        IMAGE_SUMMARY_TIMEOUT_MS,
        { min: 1000, max: 120000 },
      ),
      imageSummaryMaxBytes: normalizeIntegerInput(
        env.FLOWBOT_IMAGE_SUMMARY_MAX_BYTES,
        IMAGE_SUMMARY_MAX_BYTES,
        { min: 1024, max: 8 * 1024 * 1024 },
      ),
      transcribeEnabled: normalizeBooleanInput(env.FLOWBOT_TRANSCRIBE_ENABLED, TRANSCRIBE_ENABLED),
      transcribePython: String(env.FLOWBOT_TRANSCRIBE_PYTHON || TRANSCRIBE_PYTHON).trim(),
      transcribeModel: String(env.FLOWBOT_TRANSCRIBE_MODEL || TRANSCRIBE_MODEL).trim(),
      transcribeLanguage: String(env.FLOWBOT_TRANSCRIBE_LANGUAGE || TRANSCRIBE_LANGUAGE).trim(),
      transcribeTimeoutMs: normalizeIntegerInput(env.FLOWBOT_TRANSCRIBE_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS, { min: 1000, max: 300000 }),
      knowledgeHarvestEnabled: normalizeBooleanInput(env.FLOWBOT_KNOWLEDGE_HARVEST_ENABLED, KNOWLEDGE_HARVEST_ENABLED),
      knowledgeHarvestRoomIds: normalizeTargetRoomIdsInput(env.FLOWBOT_KNOWLEDGE_HARVEST_ROOM_IDS || Array.from(KNOWLEDGE_HARVEST_ROOM_IDS).join(",")),
      knowledgeHarvestScanIntervalMs: normalizeIntegerInput(
        env.FLOWBOT_KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
        KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
        { min: 10000, max: 3600000 },
      ),
      knowledgeHarvestReadyAgeMs: normalizeIntegerInput(
        env.FLOWBOT_KNOWLEDGE_HARVEST_READY_AGE_MS,
        KNOWLEDGE_HARVEST_READY_AGE_MS,
        { min: 0, max: 3600000 },
      ),
      knowledgeHarvestMaxPerScan: normalizeIntegerInput(
        env.FLOWBOT_KNOWLEDGE_HARVEST_MAX_PER_SCAN,
        KNOWLEDGE_HARVEST_MAX_PER_SCAN,
        { min: 1, max: 20 },
      ),
      ragflowChatId: String(env.FLOWBOT_RAGFLOW_CHAT_ID || RAGFLOW_CHAT_ID || "").trim(),
    };
  }

  function detectConfigManagerMode() {
    if (fs.existsSync(SERVICE_FILE_PATH)) {
      return "systemd";
    }
    if (fs.existsSync(LOCAL_LAUNCH_AGENT_PLIST_PATH) || process.platform === "darwin") {
      return "launchagent";
    }
    return "process";
  }

  function readLocalManagedEnv() {
    if (fs.existsSync(LOCAL_MANAGED_CONFIG_PATH)) {
      return readJsonFile(LOCAL_MANAGED_CONFIG_PATH, {});
    }
    if (!fs.existsSync(legacyLocalManagedEnvPath)) {
      return {};
    }
    return parseSimpleEnvFile(fs.readFileSync(legacyLocalManagedEnvPath, "utf8"));
  }

  function readServiceConfig({ includeSecrets = false } = {}) {
    const managerMode = detectConfigManagerMode();
    const serviceFileExists = managerMode === "systemd" && fs.existsSync(SERVICE_FILE_PATH);
    const serviceText = serviceFileExists ? fs.readFileSync(SERVICE_FILE_PATH, "utf8") : "";
    const serviceEnv = managerMode === "systemd"
      ? (serviceFileExists ? parseSystemdEnvironmentEntries(serviceText) : {})
      : (managerMode === "launchagent" ? readLocalManagedEnv() : {});
    const runtimeSettings = readRuntimeSettings() || {};
    const mergedEnv = {
      ...process.env,
      ...serviceEnv,
      ...runtimeSettings,
    };
    const config = buildFlowbotConfigFromEnv(mergedEnv, { includeSecrets });
    const runtimeConfig = buildFlowbotConfigFromEnv(process.env, { includeSecrets: false });
    return {
      serviceFileExists,
      serviceFilePath: managerMode === "systemd" ? SERVICE_FILE_PATH : LOCAL_MANAGED_CONFIG_PATH,
      serviceName: managerMode === "systemd" ? SERVICE_NAME : LOCAL_LAUNCH_AGENT_LABEL,
      managerMode,
      archiveMode: ARCHIVE_MODE,
      configStorage: Object.keys(runtimeSettings).length ? "mysql" : managerMode,
      config,
      runtimeConfig,
      lastTest: readJsonFile(CONFIG_TEST_PATH, null),
    };
  }

  function mergeConfigInput(currentConfig, rawInput) {
    const next = {
      ...currentConfig,
      storageBackend: normalizeStorageBackendInput(rawInput?.storageBackend, currentConfig.storageBackend),
      dataDir: normalizePathInput(rawInput?.dataDir, currentConfig.dataDir),
      knowledgeDir: normalizePathInput(rawInput?.knowledgeDir, currentConfig.knowledgeDir),
      mysqlBin: normalizePathInput(rawInput?.mysqlBin, currentConfig.mysqlBin || "mysql"),
      mysqlHost: String(rawInput?.mysqlHost ?? currentConfig.mysqlHost ?? "127.0.0.1").trim(),
      mysqlPort: normalizeIntegerInput(rawInput?.mysqlPort, currentConfig.mysqlPort || 3306, { min: 1, max: 65535 }),
      mysqlDatabase: String(rawInput?.mysqlDatabase ?? currentConfig.mysqlDatabase ?? "").trim(),
      mysqlUser: String(rawInput?.mysqlUser ?? currentConfig.mysqlUser ?? "").trim(),
      mysqlAutoMigrate: normalizeBooleanInput(rawInput?.mysqlAutoMigrate, currentConfig.mysqlAutoMigrate),
      targetRoomIds: normalizeTargetRoomIdsInput(rawInput?.targetRoomIds, currentConfig.targetRoomIds),
      roomNameMap: String(rawInput?.roomNameMap ?? currentConfig.roomNameMap ?? "").trim(),
      feishuTargetChatIds: normalizeTargetRoomIdsInput(rawInput?.feishuTargetChatIds, currentConfig.feishuTargetChatIds),
      feishuAppId: String(rawInput?.feishuAppId ?? currentConfig.feishuAppId ?? "").trim(),
      feishuOauthRedirectUri: String(
        rawInput?.feishuOauthRedirectUri ?? currentConfig.feishuOauthRedirectUri ?? "",
      ).trim(),
      feishuOauthScope: String(rawInput?.feishuOauthScope ?? currentConfig.feishuOauthScope ?? "").trim(),
      archiveEnabled: normalizeBooleanInput(rawInput?.archiveEnabled, currentConfig.archiveEnabled),
      caseArchiveNotifyEnabled: normalizeBooleanInput(
        rawInput?.caseArchiveNotifyEnabled,
        currentConfig.caseArchiveNotifyEnabled,
      ),
      agentWakeNames: normalizeAgentWakeNamesInput(rawInput?.agentWakeNames, currentConfig.agentWakeNames),
      llmClassifyEnabled: normalizeBooleanInput(rawInput?.llmClassifyEnabled, currentConfig.llmClassifyEnabled),
      llmApiUrl: String(rawInput?.llmApiUrl ?? currentConfig.llmApiUrl).trim(),
      llmModel: String(rawInput?.llmModel ?? currentConfig.llmModel).trim(),
      llmTimeoutMs: normalizeIntegerInput(rawInput?.llmTimeoutMs, currentConfig.llmTimeoutMs, { min: 1000, max: 300000 }),
      llmTimeoutRetryAttempts: normalizeIntegerInput(
        rawInput?.llmTimeoutRetryAttempts,
        currentConfig.llmTimeoutRetryAttempts,
        { min: 1, max: 5 },
      ),
      llmTimeoutRetryBaseDelayMs: normalizeIntegerInput(
        rawInput?.llmTimeoutRetryBaseDelayMs,
        currentConfig.llmTimeoutRetryBaseDelayMs,
        { min: 100, max: 10000 },
      ),
      llmTimeoutRetryMaxDelayMs: normalizeIntegerInput(
        rawInput?.llmTimeoutRetryMaxDelayMs,
        currentConfig.llmTimeoutRetryMaxDelayMs,
        { min: 1000, max: 60000 },
      ),
      llmMaxRepairAttempts: normalizeIntegerInput(rawInput?.llmMaxRepairAttempts, currentConfig.llmMaxRepairAttempts, { min: 0, max: 5 }),
      imageSummaryEnabled: normalizeBooleanInput(rawInput?.imageSummaryEnabled, currentConfig.imageSummaryEnabled),
      imageSummaryModel: String(rawInput?.imageSummaryModel ?? currentConfig.imageSummaryModel ?? "qwen-vl-plus").trim(),
      imageSummaryTimeoutMs: normalizeIntegerInput(
        rawInput?.imageSummaryTimeoutMs,
        currentConfig.imageSummaryTimeoutMs,
        { min: 1000, max: 120000 },
      ),
      imageSummaryMaxBytes: normalizeIntegerInput(
        rawInput?.imageSummaryMaxBytes,
        currentConfig.imageSummaryMaxBytes,
        { min: 1024, max: 8 * 1024 * 1024 },
      ),
      transcribeEnabled: normalizeBooleanInput(rawInput?.transcribeEnabled, currentConfig.transcribeEnabled),
      transcribePython: String(rawInput?.transcribePython ?? currentConfig.transcribePython).trim(),
      transcribeModel: String(rawInput?.transcribeModel ?? currentConfig.transcribeModel).trim(),
      transcribeLanguage: String(rawInput?.transcribeLanguage ?? currentConfig.transcribeLanguage).trim(),
      transcribeTimeoutMs: normalizeIntegerInput(rawInput?.transcribeTimeoutMs, currentConfig.transcribeTimeoutMs, { min: 1000, max: 300000 }),
      knowledgeHarvestEnabled: normalizeBooleanInput(rawInput?.knowledgeHarvestEnabled, currentConfig.knowledgeHarvestEnabled),
      knowledgeHarvestRoomIds: normalizeTargetRoomIdsInput(rawInput?.knowledgeHarvestRoomIds, currentConfig.knowledgeHarvestRoomIds),
      knowledgeHarvestScanIntervalMs: normalizeIntegerInput(
        rawInput?.knowledgeHarvestScanIntervalMs,
        currentConfig.knowledgeHarvestScanIntervalMs,
        { min: 10000, max: 3600000 },
      ),
      knowledgeHarvestReadyAgeMs: normalizeIntegerInput(
        rawInput?.knowledgeHarvestReadyAgeMs,
        currentConfig.knowledgeHarvestReadyAgeMs,
        { min: 0, max: 3600000 },
      ),
      knowledgeHarvestMaxPerScan: normalizeIntegerInput(
        rawInput?.knowledgeHarvestMaxPerScan,
        currentConfig.knowledgeHarvestMaxPerScan,
        { min: 1, max: 20 },
      ),
      ragflowChatId: String(rawInput?.ragflowChatId ?? currentConfig.ragflowChatId ?? "").trim(),
    };
    const nextKey = String(rawInput?.llmApiKey || "").trim();
    next.llmApiKey = nextKey || currentConfig.llmApiKey || "";
    next.llmApiKeyConfigured = Boolean(next.llmApiKey);
    next.llmApiKeyMasked = maskSecret(next.llmApiKey);
    const nextFeishuAppSecret = String(rawInput?.feishuAppSecret || "").trim();
    next.feishuAppSecret = nextFeishuAppSecret || currentConfig.feishuAppSecret || "";
    next.feishuAppSecretConfigured = Boolean(next.feishuAppSecret);
    next.feishuAppSecretMasked = maskSecret(next.feishuAppSecret);
    const nextFeishuVerificationToken = String(rawInput?.feishuVerificationToken || "").trim();
    next.feishuVerificationToken = nextFeishuVerificationToken || currentConfig.feishuVerificationToken || "";
    next.feishuVerificationTokenConfigured = Boolean(next.feishuVerificationToken);
    next.feishuVerificationTokenMasked = maskSecret(next.feishuVerificationToken);
    const nextMysqlPassword = String(rawInput?.mysqlPassword || "").trim();
    next.mysqlPassword = nextMysqlPassword || currentConfig.mysqlPassword || "";
    next.mysqlPasswordConfigured = Boolean(next.mysqlPassword);
    next.mysqlPasswordMasked = maskSecret(next.mysqlPassword);
    if (!next.dataDir) {
      throw new Error("flowbot_data_dir_required");
    }
    if (!next.knowledgeDir) {
      throw new Error("flowbot_knowledge_dir_required");
    }
    if (next.storageBackend === "mysql") {
      if (!next.mysqlDatabase) {
        throw new Error("flowbot_mysql_database_required");
      }
      if (!next.mysqlUser) {
        throw new Error("flowbot_mysql_user_required");
      }
    }
    if (!next.llmApiUrl) {
      throw new Error("llm_api_url_required");
    }
    if (!/^https?:\/\//i.test(next.llmApiUrl)) {
      throw new Error("llm_api_url_invalid");
    }
    if (!next.llmModel) {
      throw new Error("llm_model_required");
    }
    if (next.transcribeEnabled && !next.transcribePython) {
      throw new Error("transcribe_python_required");
    }
    if (next.transcribeEnabled && !next.transcribeModel) {
      throw new Error("transcribe_model_required");
    }
    return next;
  }

  function configToManagedEnvironment(config) {
    return {
      FLOWBOT_STORAGE_BACKEND: config.storageBackend,
      FLOWBOT_DATA_DIR: config.dataDir,
      FLOWBOT_KNOWLEDGE_DIR: config.knowledgeDir,
      FLOWBOT_MYSQL_BIN: config.mysqlBin,
      FLOWBOT_MYSQL_HOST: config.mysqlHost,
      FLOWBOT_MYSQL_PORT: String(config.mysqlPort),
      FLOWBOT_MYSQL_DATABASE: config.mysqlDatabase,
      FLOWBOT_MYSQL_USER: config.mysqlUser,
      FLOWBOT_MYSQL_PASSWORD: config.mysqlPassword || "",
      FLOWBOT_MYSQL_AUTO_MIGRATE: config.mysqlAutoMigrate ? "1" : "0",
      FLOWBOT_TARGET_ROOM_IDS: config.targetRoomIds,
      FLOWBOT_ROOM_NAME_MAP: config.roomNameMap || "",
      FLOWBOT_FEISHU_TARGET_CHAT_IDS: config.feishuTargetChatIds,
      FEISHU_APP_ID: config.feishuAppId || "",
      FEISHU_APP_SECRET: config.feishuAppSecret || "",
      FEISHU_VERIFICATION_TOKEN: config.feishuVerificationToken || "",
      FEISHU_OAUTH_REDIRECT_URI: config.feishuOauthRedirectUri || "",
      FEISHU_OAUTH_SCOPE: config.feishuOauthScope || "",
      FLOWBOT_ARCHIVE_ENABLED: config.archiveEnabled ? "1" : "0",
      FLOWBOT_CASE_ARCHIVE_NOTIFY_ENABLED: config.caseArchiveNotifyEnabled ? "1" : "0",
      FLOWBOT_AGENT_WAKE_NAMES: config.agentWakeNames,
      FLOWBOT_LLM_CLASSIFY_ENABLED: config.llmClassifyEnabled ? "1" : "0",
      FLOWBOT_LLM_API_URL: config.llmApiUrl,
      FLOWBOT_LLM_API_KEY: config.llmApiKey || "",
      FLOWBOT_LLM_MODEL: config.llmModel,
      FLOWBOT_LLM_TIMEOUT_MS: String(config.llmTimeoutMs),
      FLOWBOT_LLM_TIMEOUT_RETRY_ATTEMPTS: String(config.llmTimeoutRetryAttempts),
      FLOWBOT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS: String(config.llmTimeoutRetryBaseDelayMs),
      FLOWBOT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS: String(config.llmTimeoutRetryMaxDelayMs),
      FLOWBOT_LLM_MAX_REPAIR_ATTEMPTS: String(config.llmMaxRepairAttempts),
      FLOWBOT_IMAGE_SUMMARY_ENABLED: config.imageSummaryEnabled ? "1" : "0",
      FLOWBOT_IMAGE_SUMMARY_MODEL: config.imageSummaryModel,
      FLOWBOT_IMAGE_SUMMARY_TIMEOUT_MS: String(config.imageSummaryTimeoutMs),
      FLOWBOT_IMAGE_SUMMARY_MAX_BYTES: String(config.imageSummaryMaxBytes),
      FLOWBOT_TRANSCRIBE_ENABLED: config.transcribeEnabled ? "1" : "0",
      FLOWBOT_TRANSCRIBE_PYTHON: config.transcribePython,
      FLOWBOT_TRANSCRIBE_MODEL: config.transcribeModel,
      FLOWBOT_TRANSCRIBE_LANGUAGE: config.transcribeLanguage,
      FLOWBOT_TRANSCRIBE_TIMEOUT_MS: String(config.transcribeTimeoutMs),
      FLOWBOT_KNOWLEDGE_HARVEST_ENABLED: config.knowledgeHarvestEnabled ? "1" : "0",
      FLOWBOT_KNOWLEDGE_HARVEST_ROOM_IDS: config.knowledgeHarvestRoomIds,
      FLOWBOT_KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS: String(config.knowledgeHarvestScanIntervalMs),
      FLOWBOT_KNOWLEDGE_HARVEST_READY_AGE_MS: String(config.knowledgeHarvestReadyAgeMs),
      FLOWBOT_KNOWLEDGE_HARVEST_MAX_PER_SCAN: String(config.knowledgeHarvestMaxPerScan),
      FLOWBOT_RAGFLOW_CHAT_ID: config.ragflowChatId || "",
    };
  }

  function writeServiceConfig(config) {
    if (detectConfigManagerMode() !== "systemd") {
      throw new Error(`service_file_missing:${SERVICE_FILE_PATH}`);
    }
    if (!fs.existsSync(SERVICE_FILE_PATH)) {
      throw new Error(`service_file_missing:${SERVICE_FILE_PATH}`);
    }
    const currentText = fs.readFileSync(SERVICE_FILE_PATH, "utf8");
    const nextText = upsertManagedServiceConfig(currentText, configToManagedEnvironment(config));
    fs.writeFileSync(SERVICE_FILE_PATH, nextText, "utf8");
  }

  function writeLocalServiceConfig(config) {
    const managedEnv = configToManagedEnvironment(config);
    fs.mkdirSync(path.dirname(LOCAL_MANAGED_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_MANAGED_CONFIG_PATH, `${JSON.stringify(managedEnv, null, 2)}\n`, "utf8");
  }

  function writeRuntimeConfig(config) {
    if (!writeRuntimeSettings) {
      throw new Error("mysql_runtime_config_writer_missing");
    }
    return writeRuntimeSettings(configToManagedEnvironment(config));
  }

  function scheduleServiceRestart() {
    const command = `sleep 1 && systemctl daemon-reload && systemctl restart ${shellEscape(SERVICE_NAME)}`;
    const child = spawnImpl("sh", ["-lc", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  function scheduleLocalServiceRestart() {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : "$(id -u)";
    const command = [
      "sleep 1",
      `launchctl kickstart -k gui/${uid}/${shellEscape(LOCAL_LAUNCH_AGENT_LABEL)}`,
    ].join(" && ");
    const child = spawnImpl("sh", ["-lc", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  return {
    buildFlowbotConfigFromEnv,
    configToManagedEnvironment,
    detectConfigManagerMode,
    mergeConfigInput,
    readLocalManagedEnv,
    readServiceConfig,
    scheduleLocalServiceRestart,
    scheduleServiceRestart,
    writeLocalServiceConfig,
    writeRuntimeConfig,
    writeServiceConfig,
  };
}

module.exports = {
  MANAGED_SERVICE_ENV_KEYS,
  createFlowbotConfigManager,
  formatSystemdEnvironmentLine,
  maskSecret,
  normalizeAgentWakeNamesInput,
  normalizeBooleanInput,
  normalizeIntegerInput,
  normalizeTargetRoomIdsInput,
  parseSimpleEnvFile,
  parseSystemdEnvironmentEntries,
  shellEscape,
  upsertManagedServiceConfig,
};
