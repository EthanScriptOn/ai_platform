"use strict";

const path = require("path");
const { loadConfigObjectIntoEnv, loadEnvFile } = require("./env_config");
const { loadRuntimeSettings } = require("./ai_admin_settings_store");

function loadRuntimeConfig(root = path.resolve(__dirname, "..")) {
  loadConfigObjectIntoEnv(
    process.env.AI_ADMIN_CONFIG_PATH || path.join(root, "config", "ai-admin.local.json")
  );
  loadEnvFile(process.env.AI_ADMIN_ENV_FILE || "");

  const PORT = Number(process.env.AI_ADMIN_PORT || 8788);
  const HOST = process.env.AI_ADMIN_HOST || "127.0.0.1";
  const RAGFLOW_BASE_URL = process.env.RAGFLOW_BASE_URL || "http://127.0.0.1:8080";
  const RAGFLOW_AGENT_ID = process.env.RAGFLOW_AGENT_ID || "";
  const RAGFLOW_CHAT_URL =
    process.env.RAGFLOW_CHAT_URL || `${RAGFLOW_BASE_URL}/yuebai-workbench/`;
  const CONTENT_ASSET_BASE_URL = process.env.CONTENT_ASSET_BASE_URL || "http://127.0.0.1:8767";
  const INTEL_API_BASE_URL = process.env.INTEL_API_BASE_URL || "http://127.0.0.1:8010";
  const CONTENT_ASSET_LOCAL_HOST =
    process.env.CONTENT_ASSET_LOCAL_HOST || "douyin.yuebai.localhost";
  const CONTENT_ASSET_LOCAL_HTTPS_PORT =
    process.env.CONTENT_ASSET_LOCAL_HTTPS_PORT || "8768";
  const WECHAT_COLLECTOR_BASE_URL =
    process.env.WECHAT_COLLECTOR_BASE_URL || "http://127.0.0.1:18765";
  const WECHAT_COLLECTOR_LOCAL_HOST =
    process.env.WECHAT_COLLECTOR_LOCAL_HOST || "collector.yuebai.localhost";
  const WECHAT_COLLECTOR_LOCAL_HTTPS_PORT =
    process.env.WECHAT_COLLECTOR_LOCAL_HTTPS_PORT || "18766";
  const WECHAT_COLLECTOR_LABEL = "com.yuebai.wechat-collector";
  const FLOWBOT_DATA_DIR =
    process.env.FLOWBOT_DATA_DIR || path.join(root, "data", "customer-bot-data");
  const PERSONA_DISTILL_DIR =
    process.env.PERSONA_DISTILL_DIR || path.join(root, "data", "persona-distillation");
  const GROUP_INTENT_DIR =
    process.env.GROUP_INTENT_DIR ||
    (root.startsWith("/opt/yuebai-ai-platform/")
      ? "/opt/yuebai-ai-platform/shared/group-intent"
      : path.join(root, "data", "group-intent"));
  const PERSONA_DISTILL_MODEL = String(
    process.env.PERSONA_DISTILL_MODEL ||
      process.env.QWEN_TEXT_MODEL ||
      process.env.QWEN_MODEL ||
      "qwen3.7-max"
  ).trim();

  const REVIEW_RUN_DIR = path.resolve(
    process.env.REVIEW_RUN_DIR ||
      path.join(root, "data", "knowledge-governance", "review-runs", "current")
  );

  const mysqlSettings = loadRuntimeSettings();
  const mergedEnv = { ...process.env, ...mysqlSettings };
  const finalRagflowBaseUrl = mergedEnv.RAGFLOW_BASE_URL || RAGFLOW_BASE_URL;
  const finalRagflowAgentId = mergedEnv.RAGFLOW_AGENT_ID || "";
  const finalRagflowChatUrl =
    mergedEnv.RAGFLOW_CHAT_URL || `${finalRagflowBaseUrl}/yuebai-workbench/`;

  return {
    ROOT: root,
    PORT,
    HOST,
    DIST: path.resolve(
      process.env.FRONTEND_DIST ||
        path.join(root, "..", "yuebai-ai-tool-platform-web", "dist")
    ),
    PUBLIC_DIR: path.join(root, "public"),
    DEFAULT_ROOM_ID: process.env.FLOWBOT_ROOM_ID || "154085252767863",
    FLOWBOT_BASE_URL: process.env.FLOWBOT_BASE_URL || "http://127.0.0.1:3010",
    REVIEW_RUN_DIR,
    REVIEW_STATE_PATH: path.join(REVIEW_RUN_DIR, "review_decisions.json"),
    RAGFLOW_BASE_URL: finalRagflowBaseUrl,
    RAGFLOW_TOKEN_FILE:
      mergedEnv.RAGFLOW_TOKEN_FILE || path.join(root, "runtime", "ragflow", "api_token.txt"),
    RAGFLOW_AGENT_ID: finalRagflowAgentId,
    RAGFLOW_DATASET_ID: mergedEnv.RAGFLOW_DATASET_ID || "",
    RAGFLOW_SHARE_AUTH: mergedEnv.RAGFLOW_SHARE_AUTH || "",
    RAGFLOW_LOGIN_EMAIL: mergedEnv.RAGFLOW_LOGIN_EMAIL || "",
    RAGFLOW_LOGIN_PASSWORD: mergedEnv.RAGFLOW_LOGIN_PASSWORD || "",
    RAGFLOW_LOGIN_PUBLIC_KEY: mergedEnv.RAGFLOW_LOGIN_PUBLIC_KEY || "",
    RAGFLOW_NATIVE_CHAT_URL:
      mergedEnv.RAGFLOW_NATIVE_CHAT_URL ||
      (finalRagflowAgentId
        ? `${finalRagflowBaseUrl}/chat/${finalRagflowAgentId}?isNew=`
        : `${finalRagflowBaseUrl}/chat/`),
    RAGFLOW_CHAT_URL: finalRagflowChatUrl,
    CONTENT_ASSET_BASE_URL,
    INTEL_API_BASE_URL,
    CONTENT_ASSET_URL: process.env.CONTENT_ASSET_URL || "/content-assets-service/",
    CONTENT_ASSET_PUBLIC_BASE_URL:
      process.env.CONTENT_ASSET_PUBLIC_BASE_URL || CONTENT_ASSET_BASE_URL,
    CONTENT_ASSET_LOCAL_HOST,
    CONTENT_ASSET_LOCAL_HTTPS_PORT,
    CONTENT_ASSET_LOCAL_MEDIA_BASE_URL:
      process.env.CONTENT_ASSET_LOCAL_MEDIA_BASE_URL ||
      `https://${CONTENT_ASSET_LOCAL_HOST}:${CONTENT_ASSET_LOCAL_HTTPS_PORT}`,
    CONTENT_ASSET_INSTALL_BASE_URL: process.env.CONTENT_ASSET_INSTALL_BASE_URL || "",
    CONTENT_ASSET_REMOTE_TOKEN: String(process.env.CONTENT_ASSET_REMOTE_TOKEN || "").trim(),
    RAGFLOW_STATE_FILE:
      mergedEnv.RAGFLOW_STATE_FILE || path.join(root, "runtime", "ragflow", "clean_state.json"),
    WECHAT_COLLECTOR_BASE_URL,
    WECHAT_COLLECTOR_PUBLIC_BASE_URL:
      process.env.WECHAT_COLLECTOR_PUBLIC_BASE_URL || WECHAT_COLLECTOR_BASE_URL,
    WECHAT_COLLECTOR_LOCAL_HOST,
    WECHAT_COLLECTOR_LOCAL_HTTPS_PORT,
    WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL:
      process.env.WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL ||
      `https://${WECHAT_COLLECTOR_LOCAL_HOST}:${WECHAT_COLLECTOR_LOCAL_HTTPS_PORT}`,
    WECHAT_COLLECTOR_PAC_URL:
      process.env.WECHAT_COLLECTOR_PAC_URL || "http://127.0.0.1:18765/proxy.pac",
    WECHAT_COLLECTOR_INSTALL_BASE_URL: process.env.WECHAT_COLLECTOR_INSTALL_BASE_URL || "",
    PLATFORM_CONFIG_PATH:
      process.env.PLATFORM_CONFIG_PATH || path.join(root, "config", "platform.json"),
    WECHAT_COLLECTOR_LABEL,
    WECHAT_COLLECTOR_HOME: path.join(process.env.HOME || "", ".yuebai", "wechat-collector"),
    WECHAT_COLLECTOR_BIN: path.join(
      process.env.HOME || "",
      ".yuebai",
      "wechat-collector",
      "yuebai-wechat-collector"
    ),
    WECHAT_COLLECTOR_PLIST: path.join(
      process.env.HOME || "",
      "Library",
      "LaunchAgents",
      `${WECHAT_COLLECTOR_LABEL}.plist`
    ),
    WECHAT_COLLECTOR_CLIENT_STATE_PATH:
      process.env.WECHAT_COLLECTOR_CLIENT_STATE_PATH ||
      path.join(root, "data", "wechat-collector", "clients.json"),
    FLOWBOT_DATA_DIR,
    FLOWBOT_CANDIDATES_PATH:
      process.env.FLOWBOT_CANDIDATES_PATH ||
      path.join(FLOWBOT_DATA_DIR, "flowbot-knowledge-candidates.jsonl"),
    PERSONA_DISTILL_DIR,
    PERSONA_DISTILL_PROJECTS_PATH: path.join(PERSONA_DISTILL_DIR, "projects.json"),
    PERSONA_DISTILL_SKILLS_DIR:
      process.env.PERSONA_DISTILL_SKILLS_DIR || path.join(PERSONA_DISTILL_DIR, "skills"),
    PERSONA_NUWA_EXAMPLES_DIR:
      process.env.PERSONA_NUWA_EXAMPLES_DIR ||
      "/Users/yuebuy/Documents/New project/.agents/skills/huashu-nuwa/examples",
    PERSONA_DISTILL_MODEL,
    PERSONA_DISTILL_FAST_MODEL:
      String(mergedEnv.PERSONA_DISTILL_FAST_MODEL || PERSONA_DISTILL_MODEL).trim(),
    PERSONA_DISTILL_REVIEW_MODEL:
      String(mergedEnv.PERSONA_DISTILL_REVIEW_MODEL || PERSONA_DISTILL_MODEL).trim(),
    GROUP_INTENT_DIR,
    GROUP_INTENT_SAMPLES_PATH: path.join(GROUP_INTENT_DIR, "training_samples.jsonl"),
    GROUP_INTENT_MODEL_PATH: path.join(GROUP_INTENT_DIR, "intent_model.json"),
    GROUP_INTENT_LEGACY_MODEL_PATH: path.join(GROUP_INTENT_DIR, "naive_bayes_model.json"),
    GROUP_INTENT_AUTO_TRAIN_JOBS_PATH: path.join(GROUP_INTENT_DIR, "auto_train_jobs.json"),
    GROUP_INTENT_DOMAIN_PRESETS: {
      mother_baby: "母婴",
      shopping: "购物",
      pet: "宠物",
    },
    QWEN_API_URL: String(
      mergedEnv.QWEN_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    ).trim(),
    QWEN_API_KEY: String(mergedEnv.QWEN_API_KEY || mergedEnv.DASHSCOPE_API_KEY || "").trim(),
    GROUP_INTENT_QWEN_MODEL: String(
      process.env.GROUP_INTENT_QWEN_MODEL ||
        process.env.QWEN_TEXT_MODEL ||
        process.env.QWEN_MODEL ||
        "qwen3.7-max"
    ).trim(),
    AI_ADMIN_STORAGE_BACKEND: String(process.env.AI_ADMIN_STORAGE_BACKEND || "file").trim().toLowerCase(),
    AI_ADMIN_MYSQL_BIN: String(process.env.AI_ADMIN_MYSQL_BIN || process.env.FLOWBOT_MYSQL_BIN || "mysql").trim(),
    AI_ADMIN_MYSQL_HOST: String(process.env.AI_ADMIN_MYSQL_HOST || process.env.FLOWBOT_MYSQL_HOST || "127.0.0.1").trim(),
    AI_ADMIN_MYSQL_PORT: String(process.env.AI_ADMIN_MYSQL_PORT || process.env.FLOWBOT_MYSQL_PORT || "3306").trim(),
    AI_ADMIN_MYSQL_DATABASE: String(process.env.AI_ADMIN_MYSQL_DATABASE || process.env.FLOWBOT_MYSQL_DATABASE || "").trim(),
    AI_ADMIN_MYSQL_USER: String(process.env.AI_ADMIN_MYSQL_USER || process.env.FLOWBOT_MYSQL_USER || "").trim(),
    AI_ADMIN_MYSQL_PASSWORD: String(process.env.AI_ADMIN_MYSQL_PASSWORD || process.env.FLOWBOT_MYSQL_PASSWORD || "").trim(),
    AI_ADMIN_MYSQL_AUTO_MIGRATE: String(process.env.AI_ADMIN_MYSQL_AUTO_MIGRATE || "1") !== "0",
    CONTENT_ASSET_COMMAND_TIMEOUT_MS: Number(process.env.CONTENT_ASSET_COMMAND_TIMEOUT_MS || 30000),
    WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS: Number(process.env.WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS || 30000),
  };
}

module.exports = { loadRuntimeConfig };
