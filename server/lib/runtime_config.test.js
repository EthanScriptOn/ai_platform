"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadRuntimeConfig } = require("./runtime_config");

const RUNTIME_ENV_KEYS = [
  "AI_ADMIN_CONFIG_PATH",
  "AI_ADMIN_ENV_FILE",
  "AI_ADMIN_HOST",
  "AI_ADMIN_PORT",
  "AI_ADMIN_STORAGE_BACKEND",
  "CONTENT_ASSET_BASE_URL",
  "CONTENT_ASSET_COMMAND_TIMEOUT_MS",
  "CONTENT_ASSET_LOCAL_HOST",
  "CONTENT_ASSET_LOCAL_HTTPS_PORT",
  "CONTENT_ASSET_PUBLIC_BASE_URL",
  "FLOWBOT_ROOM_ID",
  "FRONTEND_DIST",
  "GROUP_INTENT_DIR",
  "PERSONA_DISTILL_MODEL",
  "QWEN_MODEL",
  "RAGFLOW_AGENT_ID",
  "RAGFLOW_BASE_URL",
  "RAGFLOW_CHAT_URL",
  "WECHAT_COLLECTOR_CLIENT_STATE_PATH",
  "WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS",
];

async function withRuntimeEnv(overrides, fn) {
  const keys = Array.from(new Set([...RUNTIME_ENV_KEYS, ...Object.keys(overrides)]));
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadRuntimeConfig returns stable local defaults", async () => {
  await withRuntimeEnv({}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-defaults-"));
    const config = loadRuntimeConfig(root);

    assert.equal(config.ROOT, root);
    assert.equal(config.PORT, 8788);
    assert.equal(config.HOST, "127.0.0.1");
    assert.equal(config.DEFAULT_ROOM_ID, "154085252767863");
    assert.equal(config.RAGFLOW_CHAT_URL, "http://127.0.0.1:8080/yuebai-workbench/");
    assert.equal(config.RAGFLOW_NATIVE_CHAT_URL, "http://127.0.0.1:8080/chat/");
    assert.equal(config.CONTENT_ASSET_LOCAL_MEDIA_BASE_URL, "https://douyin.yuebai.localhost:8768");
    assert.equal(config.WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL, "https://collector.yuebai.localhost:18766");
    assert.equal(config.REVIEW_STATE_PATH, path.join(config.REVIEW_RUN_DIR, "review_decisions.json"));
    assert.equal(config.GROUP_INTENT_DIR, path.join(root, "data", "group-intent"));
    assert.equal(config.GROUP_INTENT_SAMPLES_PATH, path.join(root, "data", "group-intent", "training_samples.jsonl"));
    assert.equal(config.CONTENT_ASSET_COMMAND_TIMEOUT_MS, 30000);
    assert.equal(config.WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS, 30000);
  });
});

test("loadRuntimeConfig applies JSON config and env file without overriding existing env", async () => {
  await withRuntimeEnv({}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-files-"));
    const configPath = path.join(root, "ai-admin.local.json");
    const envPath = path.join(root, "local.env");
    fs.writeFileSync(configPath, JSON.stringify({
      AI_ADMIN_PORT: 9001,
      RAGFLOW_BASE_URL: "http://ragflow-from-json",
      FLOWBOT_ROOM_ID: "json-room",
    }), "utf8");
    fs.writeFileSync(envPath, [
      "AI_ADMIN_HOST=0.0.0.0",
      "CONTENT_ASSET_BASE_URL=http://content-from-env",
    ].join("\n"), "utf8");

    process.env.AI_ADMIN_CONFIG_PATH = configPath;
    process.env.AI_ADMIN_ENV_FILE = envPath;
    process.env.FLOWBOT_ROOM_ID = "existing-room";

    const config = loadRuntimeConfig(root);

    assert.equal(config.PORT, 9001);
    assert.equal(config.HOST, "0.0.0.0");
    assert.equal(config.RAGFLOW_BASE_URL, "http://ragflow-from-json");
    assert.equal(config.CONTENT_ASSET_BASE_URL, "http://content-from-env");
    assert.equal(config.DEFAULT_ROOM_ID, "existing-room");
  });
});

test("loadRuntimeConfig prefers explicit env values and derives dependent URLs", async () => {
  await withRuntimeEnv({
    CONTENT_ASSET_BASE_URL: "http://content-private",
    CONTENT_ASSET_LOCAL_HOST: "douyin.example.local",
    CONTENT_ASSET_LOCAL_HTTPS_PORT: "9443",
    CONTENT_ASSET_PUBLIC_BASE_URL: "https://content-public",
    FRONTEND_DIST: "/tmp/frontend-dist",
    PERSONA_DISTILL_MODEL: "persona-model",
    QWEN_MODEL: "fallback-model",
    RAGFLOW_AGENT_ID: "agent-1",
    RAGFLOW_BASE_URL: "https://ragflow.example",
    WECHAT_COLLECTOR_CLIENT_STATE_PATH: "/tmp/collector-clients.json",
    WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS: "45000",
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-env-"));
    const config = loadRuntimeConfig(root);

    assert.equal(config.DIST, "/tmp/frontend-dist");
    assert.equal(config.CONTENT_ASSET_PUBLIC_BASE_URL, "https://content-public");
    assert.equal(config.CONTENT_ASSET_LOCAL_MEDIA_BASE_URL, "https://douyin.example.local:9443");
    assert.equal(config.PERSONA_DISTILL_MODEL, "persona-model");
    assert.equal(config.RAGFLOW_NATIVE_CHAT_URL, "https://ragflow.example/chat/agent-1?isNew=");
    assert.equal(config.WECHAT_COLLECTOR_CLIENT_STATE_PATH, "/tmp/collector-clients.json");
    assert.equal(config.WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS, 45000);
  });
});

test("loadRuntimeConfig uses shared group intent path under opt deployment root", async () => {
  await withRuntimeEnv({}, () => {
    const config = loadRuntimeConfig("/opt/yuebai-ai-platform/current");
    assert.equal(config.GROUP_INTENT_DIR, "/opt/yuebai-ai-platform/shared/group-intent");
    assert.equal(
      config.GROUP_INTENT_MODEL_PATH,
      "/opt/yuebai-ai-platform/shared/group-intent/intent_model.json"
    );
  });
});
