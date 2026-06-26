#!/usr/bin/env node
const http = require("http");
const { URL } = require("url");
const { parseMysqlJson } = require("./lib/data_utils");
const { readJsonBody, readRawBody } = require("./lib/http_body");
const { createContentAssetClientManager } = require("./lib/content_asset_clients");
const { createMysqlCli, sqlDate, sqlString } = require("./lib/mysql_cli");
const { createWechatCollectorClientManager, wechatTokenFromRequest } = require("./lib/wechat_collector_clients");
const { createWechatCollectorService } = require("./lib/wechat_collector_service");
const { createInstallScriptRenderer } = require("./lib/install_scripts");
const { createContentAssetJobRepository } = require("./lib/content_asset_jobs_repo");
const { createPersonaProjectStore } = require("./lib/persona_project_store");
const { createGroupIntentModelService } = require("./lib/group_intent_model");
const { createGroupIntentAutoTrainService } = require("./lib/group_intent_auto_train");
const { createRagflowService } = require("./lib/ragflow_service");
const { createRagflowTokenStore } = require("./lib/ragflow_token_store");
const { createRagflowConfigManager } = require("./lib/ragflow_config_manager");
const { RAGFLOW_SETTING_KEYS, loadRuntimeSettings, saveRuntimeSettings } = require("./lib/ai_admin_settings_store");
const { createFlowbotCandidatesService } = require("./lib/flowbot_candidates_service");
const { createQwenChatClient } = require("./lib/qwen_chat_client");
const { createPersonaDistillService } = require("./lib/persona_distill_service");
const { createAiSearchService } = require("./lib/ai_search_service");
const { createPlatformProxyService } = require("./lib/platform_proxy_service");
const { createAiAdminSchemaManager } = require("./lib/ai_admin_schema");
const { createKnowledgeReviewService } = require("./lib/knowledge_review_service");
const { createKnowledgeGovernanceService } = require("./lib/knowledge_governance_service");
const { createStaticHttpService } = require("./lib/static_http_service");
const { createGroupIntentRoutes } = require("./lib/group_intent_routes");
const { createContentAssetRoutes } = require("./lib/content_asset_routes");
const { createPersonaDistillRoutes } = require("./lib/persona_distill_routes");
const { createWechatVideoRoutes } = require("./lib/wechat_video_routes");
const { createKnowledgeRoutes } = require("./lib/knowledge_routes");
const { createAiSearchRoutes } = require("./lib/ai_search_routes");
const { loadRuntimeConfig } = require("./lib/runtime_config");

const config = loadRuntimeConfig(__dirname);
const {
  AI_ADMIN_MYSQL_AUTO_MIGRATE,
  AI_ADMIN_MYSQL_BIN,
  AI_ADMIN_MYSQL_DATABASE,
  AI_ADMIN_MYSQL_HOST,
  AI_ADMIN_MYSQL_PASSWORD,
  AI_ADMIN_MYSQL_PORT,
  AI_ADMIN_MYSQL_USER,
  AI_ADMIN_STORAGE_BACKEND,
  CONTENT_ASSET_BASE_URL,
  CONTENT_ASSET_COMMAND_TIMEOUT_MS,
  CONTENT_ASSET_INSTALL_BASE_URL,
  CONTENT_ASSET_LOCAL_HOST,
  CONTENT_ASSET_LOCAL_HTTPS_PORT,
  CONTENT_ASSET_LOCAL_MEDIA_BASE_URL,
  CONTENT_ASSET_PUBLIC_BASE_URL,
  CONTENT_ASSET_REMOTE_TOKEN,
  CONTENT_ASSET_URL,
  DEFAULT_ROOM_ID,
  DIST,
  FLOWBOT_BASE_URL,
  FLOWBOT_CANDIDATES_PATH,
  GROUP_INTENT_AUTO_TRAIN_JOBS_PATH,
  GROUP_INTENT_DIR,
  GROUP_INTENT_DOMAIN_PRESETS,
  GROUP_INTENT_LEGACY_MODEL_PATH,
  GROUP_INTENT_MODEL_PATH,
  GROUP_INTENT_QWEN_MODEL,
  GROUP_INTENT_SAMPLES_PATH,
  HOST,
  INTEL_API_BASE_URL,
  PERSONA_DISTILL_FAST_MODEL,
  PERSONA_DISTILL_MODEL,
  PERSONA_DISTILL_PROJECTS_PATH,
  PERSONA_DISTILL_REVIEW_MODEL,
  PERSONA_DISTILL_SKILLS_DIR,
  PERSONA_NUWA_EXAMPLES_DIR,
  PLATFORM_CONFIG_PATH,
  PORT,
  PUBLIC_DIR,
  QWEN_API_KEY,
  QWEN_API_URL,
  RAGFLOW_AGENT_ID,
  RAGFLOW_BASE_URL,
  RAGFLOW_CHAT_URL,
  RAGFLOW_DATASET_ID,
  RAGFLOW_LOGIN_EMAIL,
  RAGFLOW_LOGIN_PASSWORD,
  RAGFLOW_LOGIN_PUBLIC_KEY,
  RAGFLOW_SHARE_AUTH,
  RAGFLOW_STATE_FILE,
  RAGFLOW_TOKEN_FILE,
  REVIEW_RUN_DIR,
  REVIEW_STATE_PATH,
  ROOT,
  WECHAT_COLLECTOR_BASE_URL,
  WECHAT_COLLECTOR_BIN,
  WECHAT_COLLECTOR_CLIENT_STATE_PATH,
  WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS,
  WECHAT_COLLECTOR_HOME,
  WECHAT_COLLECTOR_INSTALL_BASE_URL,
  WECHAT_COLLECTOR_LABEL,
  WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL,
  WECHAT_COLLECTOR_LOCAL_HOST,
  WECHAT_COLLECTOR_LOCAL_HTTPS_PORT,
  WECHAT_COLLECTOR_PAC_URL,
  WECHAT_COLLECTOR_PLIST,
  WECHAT_COLLECTOR_PUBLIC_BASE_URL,
} = config;
const { runMysql: runAiAdminMysql } = createMysqlCli({
  bin: AI_ADMIN_MYSQL_BIN,
  host: AI_ADMIN_MYSQL_HOST,
  port: AI_ADMIN_MYSQL_PORT,
  database: AI_ADMIN_MYSQL_DATABASE,
  user: AI_ADMIN_MYSQL_USER,
  password: AI_ADMIN_MYSQL_PASSWORD,
});

const {
  ensureContentAssetMysqlSchema,
  ensureGroupIntentMysqlSchema,
  ensurePersonaMysqlSchema,
  ensureRuntimeSettingsMysqlSchema,
  ensureRuntimeTokenMysqlSchema,
  isAiAdminMysqlEnabled,
} = createAiAdminSchemaManager({
  AI_ADMIN_MYSQL_AUTO_MIGRATE,
  AI_ADMIN_STORAGE_BACKEND,
  runAiAdminMysql,
});

const {
  completeContentAssetCommand,
  contentAssetRemoteStatus,
  createContentAssetToken,
  sendContentAssetCommand,
  sendContentAssetCommandForToken,
  updateContentAssetClient,
  updateLegacyContentAssetClient,
} = createContentAssetClientManager({
  commandTimeoutMs: CONTENT_ASSET_COMMAND_TIMEOUT_MS,
});
const {
  completeWechatCollectorCommand,
  createWechatCollectorToken,
  loadWechatCollectorClients,
  sendWechatCollectorCommand,
  updateWechatCollectorClient,
  wechatCollectorStatusForToken,
} = createWechatCollectorClientManager({
  statePath: WECHAT_COLLECTOR_CLIENT_STATE_PATH,
  commandTimeoutMs: WECHAT_COLLECTOR_COMMAND_TIMEOUT_MS,
});
loadWechatCollectorClients();

const {
  renderDouyinCollectorMacInstallScript,
  renderDouyinCollectorWindowsInstallScript,
  renderWechatCollectorMacInstallScript,
  renderWechatCollectorWindowsInstallScript,
} = createInstallScriptRenderer({
  CONTENT_ASSET_LOCAL_HOST,
  CONTENT_ASSET_LOCAL_HTTPS_PORT,
  HOST,
  PORT,
  WECHAT_COLLECTOR_INSTALL_BASE_URL,
  WECHAT_COLLECTOR_LOCAL_HOST,
  WECHAT_COLLECTOR_LOCAL_HTTPS_PORT,
  createContentAssetToken,
  createWechatCollectorToken,
});

const {
  sendJson,
  sendJsonWithHeaders,
  serveStatic,
} = createStaticHttpService({
  DIST,
  HOST,
  PORT,
  PUBLIC_DIR,
  ROOT,
  renderDouyinCollectorMacInstallScript,
  renderDouyinCollectorWindowsInstallScript,
  renderWechatCollectorMacInstallScript,
  renderWechatCollectorWindowsInstallScript,
});

const {
  buildModules,
  isContentAssetsLegacyApiPath,
  isContentAssetsReferer,
  proxyConfiguredModule,
  proxyContentAssetsLegacyApi,
  publicModule,
} = createPlatformProxyService({
  CONTENT_ASSET_BASE_URL,
  CONTENT_ASSET_URL,
  DEFAULT_ROOM_ID,
  FLOWBOT_BASE_URL,
  HOST,
  PLATFORM_CONFIG_PATH,
  PORT,
  RAGFLOW_BASE_URL,
  RAGFLOW_CHAT_URL,
  readRawBody,
  sendJson,
});

const MODULES = buildModules();

const {
  loadRagflowToken,
  saveRagflowToken,
} = createRagflowTokenStore({
  ensureRuntimeTokenMysqlSchema,
  isAiAdminMysqlEnabled,
  runAiAdminMysql,
  sqlString,
});

function loadRagflowSettings() {
  ensureRuntimeSettingsMysqlSchema();
  return loadRuntimeSettings(RAGFLOW_SETTING_KEYS, { runMysql: runAiAdminMysql });
}

function saveRagflowSettings(settings) {
  if (!isAiAdminMysqlEnabled()) return false;
  ensureRuntimeSettingsMysqlSchema();
  saveRuntimeSettings(settings, { runMysql: runAiAdminMysql });
  return true;
}

const {
  createContentAssetJobInMysql,
  deleteContentAssetJobInMysql,
  getContentAssetJobFromMysql,
  loadContentAssetJobsFromMysql,
  updateContentAssetJobInMysql,
} = createContentAssetJobRepository({
  ensureContentAssetMysqlSchema,
  parseMysqlJson,
  runAiAdminMysql,
  sqlString,
});

const {
  deletePersonaProject,
  loadPersonaProjects,
  normalizePersonaProject,
  personaDepthConfig,
  savePersonaProject,
} = createPersonaProjectStore({
  PERSONA_DISTILL_PROJECTS_PATH,
  ensurePersonaMysqlSchema,
  isAiAdminMysqlEnabled,
  parseMysqlJson,
  runAiAdminMysql,
  sqlDate,
  sqlString,
});

const { callQwenChat } = createQwenChatClient({
  defaultModel: PERSONA_DISTILL_MODEL,
  errorContext: "人物蒸馏",
  qwenApiKey: QWEN_API_KEY,
  qwenApiUrl: QWEN_API_URL,
});

const {
  appendPersonaMaterials,
  chatWithPersonaProject,
  createPersonaProjectFromPayload,
  renderPersonaSkillDraft,
  startPersonaDistillJob,
  updatePersonaDepth,
} = createPersonaDistillService({
  PERSONA_DISTILL_FAST_MODEL,
  PERSONA_DISTILL_MODEL,
  PERSONA_DISTILL_SKILLS_DIR,
  PERSONA_NUWA_EXAMPLES_DIR,
  callQwenChat,
  loadPersonaProjects,
  normalizePersonaProject,
  personaDepthConfig,
  savePersonaProject,
});

const {
  fetchSearchConfig,
  generateDirections,
  searchAndDraftArticle,
} = createAiSearchService({
  callQwenChat,
  intelApiBaseUrl: INTEL_API_BASE_URL,
  model: PERSONA_DISTILL_REVIEW_MODEL,
});

const {
  clearWechatCaptures,
  collectorJson,
  downloadWechatCapture,
  getWechatCollectorStatus,
  openWechatCollectorBrowser,
  revealWechatCapture,
  startWechatCollector,
  startWechatCollectorPackage,
  stopWechatCollector,
  stopWechatCollectorPackage,
  streamWechatCapturePreview,
  trustWechatCollectorCert,
} = createWechatCollectorService({
  WECHAT_COLLECTOR_BASE_URL,
  WECHAT_COLLECTOR_BIN,
  WECHAT_COLLECTOR_HOME,
  WECHAT_COLLECTOR_LABEL,
  WECHAT_COLLECTOR_PAC_URL,
  WECHAT_COLLECTOR_PLIST,
  sendWechatCollectorCommand,
});

const {
  labelGroupIntentWithQwen,
  predictGroupIntent,
  trainGroupIntentFastText,
} = createGroupIntentModelService({
  GROUP_INTENT_DIR,
  GROUP_INTENT_LEGACY_MODEL_PATH,
  GROUP_INTENT_MODEL_PATH,
  GROUP_INTENT_QWEN_MODEL,
  GROUP_INTENT_SAMPLES_PATH,
  QWEN_API_KEY,
  QWEN_API_URL,
});

const {
  buildGroupIntentSampleInputWithQwen,
  createGroupIntentAutoTrainJob,
  listGroupIntentDomainTypes,
  loadGroupIntentAutoTrainJobs,
  resumeGroupIntentAutoTrainJobs,
  streamGroupIntentSampleInputWithQwen,
} = createGroupIntentAutoTrainService({
  GROUP_INTENT_AUTO_TRAIN_JOBS_PATH,
  GROUP_INTENT_DIR,
  GROUP_INTENT_DOMAIN_PRESETS,
  GROUP_INTENT_QWEN_MODEL,
  ROOT,
  callQwenChat,
  ensureGroupIntentMysqlSchema,
  isAiAdminMysqlEnabled,
  runAiAdminMysql,
  sqlDate,
  sqlString,
  trainGroupIntentFastText,
});

const {
  attachDecisions,
  loadDecisions,
  loadGovernedItems,
  renderApprovedMarkdown,
  saveDecisions,
} = createKnowledgeReviewService({
  REVIEW_RUN_DIR,
  REVIEW_STATE_PATH,
});

const { callQwenChat: callKnowledgeGovernanceQwen } = createQwenChatClient({
  defaultModel: PERSONA_DISTILL_REVIEW_MODEL,
  errorContext: "知识治理",
  qwenApiKey: QWEN_API_KEY,
  qwenApiUrl: QWEN_API_URL,
});

const {
  ingestUploadedDocument,
} = createKnowledgeGovernanceService({
  REVIEW_RUN_DIR,
  callQwenChat: callKnowledgeGovernanceQwen,
  model: PERSONA_DISTILL_REVIEW_MODEL,
});

const {
  createRagflowChatSession,
  createRagflowNativeSession,
  getRagflowChatInfo,
  getRagflowDatasetId,
  importApprovedToRagflow,
  importMarkdownToRagflow,
  importRagflowEntries,
  proxyRagflowChatCompletion,
  ragflowJson,
} = createRagflowService({
  RAGFLOW_AGENT_ID,
  RAGFLOW_BASE_URL,
  RAGFLOW_DATASET_ID,
  RAGFLOW_LOGIN_EMAIL,
  RAGFLOW_LOGIN_PASSWORD,
  RAGFLOW_LOGIN_PUBLIC_KEY,
  RAGFLOW_SHARE_AUTH,
  REVIEW_RUN_DIR,
  loadRagflowToken,
  loadDecisions,
  loadGovernedItems,
  renderApprovedMarkdown,
  saveRagflowToken,
});

const ragflowConfigManager = createRagflowConfigManager({
  current: {
    RAGFLOW_AGENT_ID,
    RAGFLOW_BASE_URL,
    RAGFLOW_CHAT_URL,
    RAGFLOW_DATASET_ID,
    RAGFLOW_LOGIN_EMAIL,
    RAGFLOW_LOGIN_PASSWORD,
    RAGFLOW_LOGIN_PUBLIC_KEY,
    RAGFLOW_SHARE_AUTH,
  },
  loadRagflowSettings,
  loadRagflowToken,
  saveRagflowSettings,
  saveRagflowToken,
});

const {
  proxyFlowbotCandidateAction,
  proxyFlowbotHarvestPromote,
  proxyFlowbotKnowledgeHarvestMessages,
  proxyFlowbotKnowledgeCandidates,
} = createFlowbotCandidatesService({
  DEFAULT_ROOM_ID,
  FLOWBOT_BASE_URL,
  FLOWBOT_CANDIDATES_PATH,
});

const { handleContentAssetRoute } = createContentAssetRoutes({
  CONTENT_ASSET_BASE_URL,
  CONTENT_ASSET_INSTALL_BASE_URL,
  CONTENT_ASSET_LOCAL_MEDIA_BASE_URL,
  CONTENT_ASSET_PUBLIC_BASE_URL,
  CONTENT_ASSET_REMOTE_TOKEN,
  HOST,
  PORT,
  completeContentAssetCommand,
  contentAssetRemoteStatus,
  createContentAssetJobInMysql,
  createContentAssetToken,
  deleteContentAssetJobInMysql,
  ensureContentAssetMysqlSchema,
  getContentAssetJobFromMysql,
  isAiAdminMysqlEnabled,
  isContentAssetsLegacyApiPath,
  isContentAssetsReferer,
  loadContentAssetJobsFromMysql,
  proxyContentAssetsLegacyApi,
  sendContentAssetCommand,
  sendContentAssetCommandForToken,
  sendJson,
  updateContentAssetClient,
  updateContentAssetJobInMysql,
  updateLegacyContentAssetClient,
});

const { handleGroupIntentRoute } = createGroupIntentRoutes({
  buildGroupIntentSampleInputWithQwen,
  createGroupIntentAutoTrainJob,
  labelGroupIntentWithQwen,
  listGroupIntentDomainTypes,
  loadGroupIntentAutoTrainJobs,
  predictGroupIntent,
  sendJson,
  streamGroupIntentSampleInputWithQwen,
  trainGroupIntentFastText,
});

const { handlePersonaDistillRoute } = createPersonaDistillRoutes({
  PERSONA_DISTILL_FAST_MODEL,
  PERSONA_DISTILL_MODEL,
  PERSONA_DISTILL_PROJECTS_PATH,
  PERSONA_DISTILL_REVIEW_MODEL,
  PERSONA_DISTILL_SKILLS_DIR,
  appendPersonaMaterials,
  chatWithPersonaProject,
  createPersonaProjectFromPayload,
  deletePersonaProject,
  isAiAdminMysqlEnabled,
  loadPersonaProjects,
  renderPersonaSkillDraft,
  sendJson,
  startPersonaDistillJob,
  updatePersonaDepth,
});

const { handleAiSearchRoute } = createAiSearchRoutes({
  fetchSearchConfig,
  generateDirections,
  searchAndDraftArticle,
  sendJson,
});

const { handleWechatVideoRoute } = createWechatVideoRoutes({
  HOST,
  PORT,
  WECHAT_COLLECTOR_INSTALL_BASE_URL,
  WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL,
  WECHAT_COLLECTOR_PUBLIC_BASE_URL,
  clearWechatCaptures,
  collectorJson,
  completeWechatCollectorCommand,
  createWechatCollectorToken,
  downloadWechatCapture,
  getWechatCollectorStatus,
  openWechatCollectorBrowser,
  revealWechatCapture,
  sendJson,
  sendWechatCollectorCommand,
  startWechatCollector,
  startWechatCollectorPackage,
  stopWechatCollector,
  stopWechatCollectorPackage,
  streamWechatCapturePreview,
  trustWechatCollectorCert,
  updateWechatCollectorClient,
  wechatCollectorStatusForToken,
  wechatTokenFromRequest,
});

const { handleKnowledgeRoute } = createKnowledgeRoutes({
  DEFAULT_ROOM_ID,
  RAGFLOW_AGENT_ID,
  RAGFLOW_CHAT_URL,
  REVIEW_RUN_DIR,
  callKnowledgeRewrite: callKnowledgeGovernanceQwen,
  createRagflowChatSession,
  createRagflowNativeSession,
  getRagflowChatInfo,
  getRagflowDatasetId,
  ingestUploadedDocument,
  importApprovedToRagflow,
  importMarkdownToRagflow,
  importRagflowEntries,
  ragflowJson,
  attachDecisions,
  loadDecisions,
  loadGovernedItems,
  proxyFlowbotCandidateAction,
  proxyFlowbotHarvestPromote,
  proxyFlowbotKnowledgeHarvestMessages,
  proxyFlowbotKnowledgeCandidates,
  proxyRagflowChatCompletion,
  renderApprovedMarkdown,
  getRagflowConfig: ragflowConfigManager.getConfig,
  saveRagflowConfig: ragflowConfigManager.saveConfig,
  saveDecisions,
  sendJson,
  sendJsonWithHeaders,
});


const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const jsonpCallback = url.searchParams.get("_jsonp");
  if (jsonpCallback) {
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(jsonpCallback)) {
      sendJson(res, { ok: false, error: "invalid jsonp callback" }, 400);
      return;
    }
    res.jsonpCallback = jsonpCallback;
  }
  const method = (url.searchParams.get("_method") || req.method || "GET").toUpperCase();
  const readPayload = () => {
    if (url.searchParams.has("_body")) {
      try {
        return Promise.resolve(JSON.parse(url.searchParams.get("_body") || "{}"));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return readJsonBody(req);
  };

  if (handleWechatVideoRoute(req, res, url, method, readPayload)) {
    return;
  }
  if (handleContentAssetRoute(req, res, url, method, readPayload)) {
    return;
  }

  if (url.pathname === "/api/modules") {
    sendJson(res, { modules: MODULES.map(publicModule) });
    return;
  }
  if (handleKnowledgeRoute(req, res, url, method, readPayload)) {
    return;
  }
  if (handleGroupIntentRoute(req, res, url, method, readPayload)) {
    return;
  }
  if (handleAiSearchRoute(req, res, url, method, readPayload)) {
    return;
  }
  if (handlePersonaDistillRoute(req, res, url, method, readPayload)) {
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(res, {
      ok: true,
      name: "ai-admin-platform",
      modules: MODULES.length,
    });
    return;
  }
  proxyConfiguredModule(req, res, url).then((handled) => {
    if (!handled) serveStatic(req, res, url.pathname);
  });
  return;
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-admin-platform] listening on http://${HOST}:${PORT}`);
  resumeGroupIntentAutoTrainJobs();
});
