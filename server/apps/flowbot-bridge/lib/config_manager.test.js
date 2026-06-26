"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createFlowbotConfigManager,
  maskSecret,
  normalizeAgentWakeNamesInput,
  parseSimpleEnvFile,
  parseSystemdEnvironmentEntries,
  upsertManagedServiceConfig,
} = require("./config_manager");

function createManager(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-config-manager-test-"));
  const serviceFilePath = path.join(dir, "wecom-flowbot.service");
  const localConfigPath = path.join(dir, "flowbot.local.json");
  const launchAgentPath = path.join(dir, "flowbot.plist");
  const configTestPath = path.join(dir, "flowbot-config-test.json");
  const manager = createFlowbotConfigManager({
    AGENT_WAKE_NAMES: ["小智"],
    ARCHIVE_ENABLED: true,
    ARCHIVE_MODE: "batch_llm_scan",
    CASE_ARCHIVE_NOTIFY_ENABLED: true,
    CONFIG_TEST_PATH: configTestPath,
    DATA_DIR: path.join(dir, "customer-bot-data"),
    FEISHU_APP_ID: "cli_default",
    FEISHU_APP_SECRET: "",
    FEISHU_OAUTH_REDIRECT_URI: "",
    FEISHU_OAUTH_SCOPE: "wiki:space:retrieve wiki:node:read docx:document:readonly",
    FEISHU_TARGET_CHAT_IDS: new Set(["chat-1"]),
    FEISHU_VERIFICATION_TOKEN: "",
    FLOWBOT_STORAGE_BACKEND: "mysql",
    KNOWLEDGE_HARVEST_ENABLED: true,
    KNOWLEDGE_HARVEST_MAX_PER_SCAN: 5,
    KNOWLEDGE_HARVEST_READY_AGE_MS: 120000,
    KNOWLEDGE_HARVEST_ROOM_IDS: new Set(["room-k"]),
    KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS: 60000,
    KNOWLEDGE_DIR: path.join(dir, "flowbot-knowledge"),
    LLM_API_URL: "https://llm.example/v1",
    LLM_CLASSIFY_ENABLED: true,
    LLM_MAX_REPAIR_ATTEMPTS: 1,
    LLM_MODEL: "qwen",
    LLM_TIMEOUT_MS: 90000,
    LLM_TIMEOUT_RETRY_ATTEMPTS: 3,
    LLM_TIMEOUT_RETRY_BASE_DELAY_MS: 500,
    LLM_TIMEOUT_RETRY_MAX_DELAY_MS: 5000,
    LOCAL_LAUNCH_AGENT_LABEL: "com.test.flowbot",
    LOCAL_LAUNCH_AGENT_PLIST_PATH: launchAgentPath,
    LOCAL_MANAGED_CONFIG_PATH: localConfigPath,
    SERVICE_FILE_PATH: serviceFilePath,
    SERVICE_NAME: "wecom-flowbot",
    TARGET_ROOM_IDS: new Set(["room-1"]),
    TRANSCRIBE_ENABLED: true,
    TRANSCRIBE_LANGUAGE: "zh",
    TRANSCRIBE_MODEL: "base",
    TRANSCRIBE_PYTHON: "python3",
    TRANSCRIBE_TIMEOUT_MS: 45000,
    legacyLocalManagedEnvPath: path.join(dir, "legacy.env"),
    readJsonFile(filePath, fallback) {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    },
    ...overrides,
  });
  return { configTestPath, dir, launchAgentPath, localConfigPath, manager, serviceFilePath };
}

test("parses env formats and masks secrets", () => {
  assert.deepEqual(
    parseSystemdEnvironmentEntries('Environment=FLOWBOT_LLM_API_KEY="abc\\"def"\nEnvironment=FLOWBOT_LLM_MODEL=qwen'),
    { FLOWBOT_LLM_API_KEY: 'abc"def', FLOWBOT_LLM_MODEL: "qwen" }
  );
  assert.deepEqual(
    parseSimpleEnvFile("export A='one\\ntwo'\n# skip\nB=plain"),
    { A: "one\ntwo", B: "plain" }
  );
  assert.equal(maskSecret("1234567890"), "1234...7890");
  assert.equal(normalizeAgentWakeNamesInput("小智, 小智\n小白"), "小智,小白");
});

test("upserts managed systemd block and removes old managed env lines", () => {
  const serviceText = [
    "[Service]",
    "Environment=FLOWBOT_LLM_MODEL=\"old\"",
    "Environment=OTHER=\"keep\"",
    "ExecStart=/usr/bin/node server.js",
  ].join("\n");

  const next = upsertManagedServiceConfig(serviceText, {
    FLOWBOT_LLM_MODEL: "new",
    FLOWBOT_LLM_API_URL: "https://api.example",
  });

  assert.equal(next.includes("Environment=FLOWBOT_LLM_MODEL=\"old\""), false);
  assert.equal(next.includes("Environment=OTHER=\"keep\""), true);
  assert.equal(next.includes("# BEGIN FLOWBOT DASHBOARD CONFIG"), true);
  assert.equal(next.includes("Environment=FLOWBOT_LLM_MODEL=\"new\""), true);
});

test("manager reads launchagent local config and builds public config", () => {
  const { launchAgentPath, localConfigPath, manager } = createManager();
  fs.writeFileSync(launchAgentPath, "<plist></plist>", "utf8");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({
      FLOWBOT_TARGET_ROOM_IDS: "room-2 room-2",
      FLOWBOT_STORAGE_BACKEND: "mysql",
      FLOWBOT_DATA_DIR: "/data/flowbot",
      FLOWBOT_KNOWLEDGE_DIR: "/data/knowledge",
      FLOWBOT_MYSQL_HOST: "db.local",
      FLOWBOT_MYSQL_PORT: "3307",
      FLOWBOT_MYSQL_DATABASE: "flowbot_runtime",
      FLOWBOT_MYSQL_USER: "flowbot_app",
      FLOWBOT_MYSQL_PASSWORD: "mysql-secret-1234",
      FLOWBOT_LLM_API_KEY: "secret-key-1234",
      FLOWBOT_LLM_MODEL: "configured-model",
      FEISHU_APP_ID: "cli_configured",
      FEISHU_APP_SECRET: "feishu-secret-1234",
      FEISHU_VERIFICATION_TOKEN: "verify-token-1234",
      FEISHU_OAUTH_REDIRECT_URI: "https://example.com/feishu/oauth/callback",
    }),
    "utf8"
  );

  const config = manager.readServiceConfig({ includeSecrets: false });

  assert.equal(config.managerMode, "launchagent");
  assert.equal(config.config.targetRoomIds, "room-2");
  assert.equal(config.config.llmApiKey, "");
  assert.equal(config.config.llmApiKeyConfigured, true);
  assert.equal(config.config.llmModel, "configured-model");
  assert.equal(config.config.storageBackend, "mysql");
  assert.equal(config.config.dataDir, "/data/flowbot");
  assert.equal(config.config.knowledgeDir, "/data/knowledge");
  assert.equal(config.config.mysqlHost, "db.local");
  assert.equal(config.config.mysqlPort, 3307);
  assert.equal(config.config.mysqlDatabase, "flowbot_runtime");
  assert.equal(config.config.mysqlUser, "flowbot_app");
  assert.equal(config.config.mysqlPassword, "");
  assert.equal(config.config.mysqlPasswordConfigured, true);
  assert.equal(config.config.feishuAppId, "cli_configured");
  assert.equal(config.config.feishuAppSecret, "");
  assert.equal(config.config.feishuAppSecretConfigured, true);
  assert.equal(config.config.feishuVerificationTokenConfigured, true);
  assert.equal(config.config.feishuOauthRedirectUri, "https://example.com/feishu/oauth/callback");
});

test("mergeConfigInput normalizes values and validates required URLs", () => {
  const { manager } = createManager();
  const current = manager.buildFlowbotConfigFromEnv({}, { includeSecrets: true });
  const merged = manager.mergeConfigInput(current, {
    targetRoomIds: "a, b a",
    dataDir: "/new/data",
    knowledgeDir: "/new/knowledge",
    storageBackend: "mysql",
    mysqlDatabase: "flowbot_runtime",
    mysqlUser: "flowbot_app",
    feishuAppId: "cli_new",
    feishuAppSecret: "new-feishu-secret",
    llmApiKey: "new-secret",
    llmTimeoutMs: "9999999",
    knowledgeHarvestMaxPerScan: "100",
  });

  assert.equal(merged.targetRoomIds, "a,b");
  assert.equal(merged.storageBackend, "mysql");
  assert.equal(merged.dataDir, "/new/data");
  assert.equal(merged.knowledgeDir, "/new/knowledge");
  assert.equal(merged.feishuAppId, "cli_new");
  assert.equal(merged.feishuAppSecret, "new-feishu-secret");
  assert.equal(manager.configToManagedEnvironment(merged).FEISHU_APP_ID, "cli_new");
  assert.equal(merged.llmApiKey, "new-secret");
  assert.equal(merged.llmTimeoutMs, 300000);
  assert.equal(merged.knowledgeHarvestMaxPerScan, 20);
  assert.throws(
    () => manager.mergeConfigInput(current, {
      llmApiUrl: "not-a-url",
      mysqlDatabase: "flowbot_runtime",
      mysqlUser: "flowbot_app",
    }),
    /llm_api_url_invalid/
  );
});
