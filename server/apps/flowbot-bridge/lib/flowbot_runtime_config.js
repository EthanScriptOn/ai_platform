const { loadConfigObjectIntoEnv, loadEnvFile } = require("../../../lib/env_config");
const fs = require("fs");

function splitEnvList(value) {
  return String(value || "")
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createFlowbotRuntimeConfig({
  DEFAULT_AGENT_ID,
  DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
  DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
  DEFAULT_STRATEGY,
  baseDir,
  normalizeAgentWakeNamesInput,
  os,
  path,
}) {
  const sharedConfigPath = "/opt/yuebai-ai-platform/shared/flowbot.json";
  const defaultConfigPath = fs.existsSync(sharedConfigPath)
    ? sharedConfigPath
    : path.resolve(baseDir, "..", "..", "config", "flowbot.local.json");
  loadConfigObjectIntoEnv(
    process.env.FLOWBOT_CONFIG_PATH
    || defaultConfigPath,
  );
  loadEnvFile(
    process.env.FLOWBOT_LOCAL_MANAGED_ENV_PATH
    || path.resolve(baseDir, "..", "..", "config", "flowbot.local.env"),
  );
  try {
    const mysqlRuntimeStore = require("./mysql_runtime_store");
    const mysqlRuntimeSettings = mysqlRuntimeStore.readRuntimeSettings?.() || {};
    for (const [key, value] of Object.entries(mysqlRuntimeSettings)) {
      if (key && value != null) {
        process.env[key] = String(value);
      }
    }
  } catch {}

  const PORT = Number(process.env.PORT || 3010);
  const STORAGE_BACKEND = String(process.env.FLOWBOT_STORAGE_BACKEND || "file").trim().toLowerCase() === "mysql"
    ? "mysql"
    : "file";
  const DATA_DIR = process.env.FLOWBOT_DATA_DIR
    ? path.resolve(process.env.FLOWBOT_DATA_DIR)
    : path.resolve(baseDir, "..", "customer-bot-data");
  const KNOWLEDGE_DIR = process.env.FLOWBOT_KNOWLEDGE_DIR
    ? path.resolve(process.env.FLOWBOT_KNOWLEDGE_DIR)
    : path.resolve(baseDir, "..", "flowbot-knowledge");
  const MEDIA_DIR = path.join(DATA_DIR, "media");
  const MEDIA_INDEX_PATH = path.join(DATA_DIR, "media-index.json");
  const LOG_PATH = path.join(DATA_DIR, "flowbot-callbacks.jsonl");
  const NORMALIZED_LOG_PATH = path.join(DATA_DIR, "flowbot-room-messages.jsonl");
  const FILTER_LOG_PATH = path.join(DATA_DIR, "flowbot-filter-decisions.jsonl");
  const ARCHIVE_LOG_PATH = path.join(DATA_DIR, "flowbot-archive-results.jsonl");
  const ROUTING_LOG_PATH = path.join(DATA_DIR, "flowbot-routing-decisions.jsonl");
  const MESSAGE_SEARCH_INDEX_PATH = path.join(DATA_DIR, "flowbot-message-search-index.jsonl");
  const MESSAGE_POOL_STATE_PATH = path.join(DATA_DIR, "flowbot-message-pool-state.json");
  const AGENT_TASK_STATE_PATH = path.join(DATA_DIR, "flowbot-agent-task-state.json");
  const BATCH_LOG_PATH = path.join(DATA_DIR, "flowbot-batch-results.jsonl");
  const KNOWLEDGE_CANDIDATES_PATH = path.join(DATA_DIR, "flowbot-knowledge-candidates.jsonl");
  const KNOWLEDGE_HARVEST_STATE_PATH = path.join(DATA_DIR, "flowbot-knowledge-harvest-state.json");
  const KNOWLEDGE_PUBLISH_LOG_PATH = path.join(DATA_DIR, "flowbot-knowledge-publish-results.jsonl");
  const FEISHU_OAUTH_STATE_PATH = path.join(DATA_DIR, "feishu-oauth-state.json");
  const FEISHU_OAUTH_RESULT_PATH = path.join(DATA_DIR, "feishu-oauth-result.json");
  const ARCHIVE_SCRIPT_PATH = path.resolve(
    baseDir,
    "..",
    "flowbot-agent-skills",
    "customer-case-archiver",
    "scripts",
    "archive_issue.py",
  );
  const ARCHIVE_PYTHON = String(process.env.FLOWBOT_ARCHIVE_PYTHON || "python3").trim() || "python3";
  const TARGET_ROOM_IDS = new Set(
    String(process.env.FLOWBOT_TARGET_ROOM_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const FEISHU_TARGET_CHAT_IDS = new Set(
    String(process.env.FLOWBOT_FEISHU_TARGET_CHAT_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const ACCEPT_NOTIFY_TYPES = new Set([11010]);
  const SUPPORTED_MSG_TYPES = new Set([2, 4, 5, 6, 7, 8, 10, 12, 13, 14, 16]);
  const FEISHU_APP_ID = String(process.env.FEISHU_APP_ID || "").trim();
  const FEISHU_APP_SECRET = String(process.env.FEISHU_APP_SECRET || "").trim();
  const FEISHU_VERIFICATION_TOKEN = String(process.env.FEISHU_VERIFICATION_TOKEN || "").trim();
  const FEISHU_OAUTH_REDIRECT_URI = String(
    process.env.FEISHU_OAUTH_REDIRECT_URI || "",
  ).trim();
  const FEISHU_OAUTH_SCOPE = String(
    process.env.FEISHU_OAUTH_SCOPE || "wiki:space:retrieve wiki:node:read docx:document:readonly",
  ).trim();
  const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
  const FEISHU_USER_ACCESS_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/access_token";
  const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
  const FEISHU_APP_ACCESS_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
  const FEISHU_SEND_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages";
  const MAXKB_BASE_URL = String(process.env.FLOWBOT_MAXKB_BASE_URL || "http://47.104.81.250:8080").replace(/\/$/, "");
  const MAXKB_USERNAME = String(process.env.FLOWBOT_MAXKB_USERNAME || "admin").trim();
  const MAXKB_PASSWORD = String(process.env.FLOWBOT_MAXKB_PASSWORD || "").trim();
  const MAXKB_WORKSPACE_ID = String(process.env.FLOWBOT_MAXKB_WORKSPACE_ID || "default").trim() || "default";
  const MAXKB_SEARCH_MODE = String(process.env.FLOWBOT_MAXKB_SEARCH_MODE || "blend").trim().toLowerCase() || "blend";
  const MAXKB_SEARCH_SIMILARITY = Math.max(0, Math.min(2, Number(process.env.FLOWBOT_MAXKB_SEARCH_SIMILARITY || 0.1) || 0.1));
  const MAXKB_TIMEOUT_MS = Math.max(1000, Number(process.env.FLOWBOT_MAXKB_TIMEOUT_MS || 30000));
  const MAXKB_CACHE_TTL_MS = Math.max(1000, Number(process.env.FLOWBOT_MAXKB_CACHE_TTL_MS || 5 * 60 * 1000));
  const MAXKB_KNOWLEDGE_FILTER = Array.from(new Set(splitEnvList(process.env.FLOWBOT_MAXKB_KNOWLEDGES)));
  const MAXKB_KNOWLEDGE_PREFIX_FILTER = Array.from(new Set(splitEnvList(process.env.FLOWBOT_MAXKB_KNOWLEDGE_PREFIXES)));
  const MAXKB_ENABLED = Boolean(MAXKB_BASE_URL && MAXKB_USERNAME && MAXKB_PASSWORD);
  const RAGFLOW_BASE_URL = String(process.env.FLOWBOT_RAGFLOW_BASE_URL || "").trim().replace(/\/$/, "");
  const RAGFLOW_LOGIN_EMAIL = String(process.env.FLOWBOT_RAGFLOW_LOGIN_EMAIL || "").trim();
  const RAGFLOW_LOGIN_PASSWORD = String(process.env.FLOWBOT_RAGFLOW_LOGIN_PASSWORD || "").trim();
  const RAGFLOW_LOGIN_PUBLIC_KEY = String(process.env.FLOWBOT_RAGFLOW_LOGIN_PUBLIC_KEY || "").trim();
  const RAGFLOW_CHAT_ID = String(process.env.FLOWBOT_RAGFLOW_CHAT_ID || "").trim();
  const RAGFLOW_DATASET_IDS = Array.from(new Set(splitEnvList(process.env.FLOWBOT_RAGFLOW_DATASET_IDS)));
  const RAGFLOW_DATASET_NAMES = Array.from(new Set(splitEnvList(process.env.FLOWBOT_RAGFLOW_DATASET_NAMES)));
  const RAGFLOW_TIMEOUT_MS = Math.max(1000, Number(process.env.FLOWBOT_RAGFLOW_TIMEOUT_MS || 30000));
  const RAGFLOW_TOP_K = Math.max(1, Math.min(20, Number(process.env.FLOWBOT_RAGFLOW_TOP_K || 8) || 8));
  const RAGFLOW_SEARCH_SIMILARITY = Math.max(0, Math.min(1, Number(process.env.FLOWBOT_RAGFLOW_SEARCH_SIMILARITY || 0.2) || 0.2));
  const RAGFLOW_VECTOR_SIMILARITY_WEIGHT = Math.max(0, Math.min(1, Number(process.env.FLOWBOT_RAGFLOW_VECTOR_SIMILARITY_WEIGHT || 0.3) || 0.3));
  const RAGFLOW_ENABLED = Boolean(RAGFLOW_BASE_URL && RAGFLOW_LOGIN_EMAIL && RAGFLOW_LOGIN_PASSWORD && RAGFLOW_LOGIN_PUBLIC_KEY);
  const MSG_TYPE_NAMES = {
    2: "文本",
    4: "链接",
    5: "图片",
    6: "语音",
    7: "视频",
    8: "文件",
    10: "表情",
    12: "小程序",
    13: "混合消息",
    14: "频道消息",
    16: "合并转发",
  };
  const MSG_TYPE_NAME_ALIASES = {
    text: "文本",
    link: "链接",
    image: "图片",
    voice: "语音",
    video: "视频",
    file: "文件",
    emoji: "表情",
    miniapp: "小程序",
    mixed: "混合消息",
    channels: "频道消息",
    forwarded_bundle: "合并转发",
  };
  const MSG_TYPE_KEY_ALIASES = {
    文本: "text",
    text: "text",
    链接: "link",
    link: "link",
    图片: "image",
    image: "image",
    语音: "voice",
    voice: "voice",
    视频: "video",
    video: "video",
    文件: "file",
    file: "file",
    表情: "emoji",
    emoji: "emoji",
    小程序: "miniapp",
    miniapp: "miniapp",
    混合消息: "mixed",
    mixed: "mixed",
    频道消息: "channels",
    channels: "channels",
    合并转发: "forwarded_bundle",
    forwarded_bundle: "forwarded_bundle",
  };
  const FEISHU_MESSAGE_TYPE_TO_FLOWBOT = {
    text: 2,
    post: 2,
    interactive: 2,
    image: 5,
    audio: 6,
    media: 7,
    file: 8,
    sticker: 10,
  };
  const CATEGORY_LABELS = {
    feature_request: "需求新增",
    incident_handling: "线上问题处理",
    case_feedback: "问题反馈",
  };
  const THREAD_TYPE_LABELS = {
    case_feedback: "反馈 Case",
    feature_request: "功能诉求",
    question: "提问题",
    chat: "闲聊",
  };
  const MESSAGE_ROLE_LABELS = {
    problem_report: "问题反馈",
    feature_request: "功能诉求",
    question: "提问",
    chitchat: "闲聊",
    evidence: "补充证据",
    developer_question: "研发追问",
    user_reply: "用户补充",
    troubleshooting_update: "排查进展",
    diagnosis: "排查结论",
    workaround: "临时规避",
    resolution: "最终解决",
    waiting_upstream: "等待上游",
    waiting_user: "等待用户",
    other: "其他",
  };
  const BATCH_ACTION_LABELS = {
    ignore: "忽略",
    new_case: "新建 Case",
    append_case: "并入已有 Case",
    append_case_activity: "追加为 Case 活动",
    need_review: "待人工复核",
  };
  const CASE_STATUS_LABELS = {
    open: "待确认",
    investigating: "排查中",
    waiting_user: "等待用户补充",
    waiting_development: "等待研发处理",
    waiting_upstream: "等待上游处理",
    diagnosed: "已给结论",
    resolved: "已解决",
    closed: "已关闭",
  };
  const ACTIVE_CASE_STATUSES = new Set([
    "open",
    "investigating",
    "waiting_user",
    "waiting_development",
    "waiting_upstream",
    "diagnosed",
  ]);
  const ARCHIVE_ENABLED = String(process.env.FLOWBOT_ARCHIVE_ENABLED || "1") !== "0";
  const ARCHIVE_MODE = "batch_llm_scan";
  const CASE_ARCHIVE_NOTIFY_ENABLED = String(process.env.FLOWBOT_CASE_ARCHIVE_NOTIFY_ENABLED || "1") !== "0";
  const BATCH_MODE_ENABLED = String(process.env.FLOWBOT_BATCH_MODE_ENABLED || "1") !== "0";
  const BATCH_SCAN_INTERVAL_MS = Number(process.env.FLOWBOT_BATCH_SCAN_INTERVAL_MS || 30000);
  const BATCH_READY_AGE_MS = Number(process.env.FLOWBOT_BATCH_READY_AGE_MS || 45000);
  const BATCH_MEDIA_ONLY_HOLD_MS = Number(process.env.FLOWBOT_BATCH_MEDIA_ONLY_HOLD_MS || 3 * 60 * 1000);
  const BATCH_PROCESSING_STALE_MS = Number(process.env.FLOWBOT_BATCH_PROCESSING_STALE_MS || 15 * 60 * 1000);
  const BATCH_MAX_PENDING_PER_ROOM = Number(process.env.FLOWBOT_BATCH_MAX_PENDING_PER_ROOM || 20);
  const BATCH_MAX_OPEN_CASES = Number(process.env.FLOWBOT_BATCH_MAX_OPEN_CASES || 8);
  const BATCH_OPEN_CASE_LOOKBACK_MS = Number(process.env.FLOWBOT_BATCH_OPEN_CASE_LOOKBACK_MS || 24 * 60 * 60 * 1000);
  const AGENT_LANE_ENABLED = String(process.env.FLOWBOT_AGENT_LANE_ENABLED || "1") !== "0";
  const AGENT_WAKE_NAMES = Array.from(
    new Set(
      normalizeAgentWakeNamesInput(process.env.FLOWBOT_AGENT_WAKE_NAMES || "小智")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  const AGENT_PRIMARY_WAKE_NAME = String(AGENT_WAKE_NAMES[0] || "智能体").trim() || "智能体";
  const AGENT_TASK_FETCH_LIMIT = Number(process.env.FLOWBOT_AGENT_TASK_FETCH_LIMIT || 20);
  const AGENT_RUNTIME_ID = String(process.env.FLOWBOT_AGENT_ID || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  const AGENT_SESSION_KEY_STRATEGY = String(process.env.FLOWBOT_AGENT_SESSION_KEY_STRATEGY || DEFAULT_STRATEGY).trim() || DEFAULT_STRATEGY;
  const AGENT_TASK_CLAIM_TIMEOUT_MS = Math.max(30 * 1000, Number(process.env.FLOWBOT_AGENT_TASK_CLAIM_TIMEOUT_MS || (3 * 60 * 1000)) || (3 * 60 * 1000));
  const PRIORITY_KEYWORDS = {
    P0: ["紧急", "严重", "事故", "恢复", "全部", "大面积", "宕机", "不可用", "立即", "尽快", "线上故障"],
    P1: ["线上", "生产", "报错", "失败", "异常", "卡住", "进不去", "白屏", "502", "503", "504", "500"],
  };
  const PRIORITY_ALIASES = {
    p0: "P0",
    urgent: "P0",
    p1: "P1",
    high: "P1",
    p2: "P2",
    medium: "P2",
    normal: "P2",
    p3: "P3",
    low: "P3",
  };
  const KNOWLEDGE_SOURCE_VALUES = new Set(["all", "local", "maxkb", "ragflow"]);
  const MEMORY_SOURCE_VALUES = new Set(["all", "messages", "cases"]);
  const SUMMARY_STOPWORDS = new Set([
    "这个", "那个", "你们", "我们", "他们", "然后", "就是", "一下", "刚才", "现在", "昨天", "今天",
    "已经", "还有", "没有", "一个", "一种", "进行", "需要", "因为", "所以", "如果", "但是", "而且",
    "可以", "不能", "问题", "消息", "图片", "视频", "语音", "文件", "文本", "男人", "女人", "什么",
  ]);
  const FEATURE_KEYWORDS = [
    "需求",
    "新增",
    "增加",
    "支持",
    "希望",
    "建议",
    "优化",
    "改进",
    "导出",
    "功能",
    "能不能",
    "希望可以",
  ];
  const INCIDENT_KEYWORDS = [
    "线上",
    "事故",
    "故障",
    "恢复",
    "回滚",
    "紧急",
    "报警",
    "告警",
    "不可用",
    "服务异常",
    "生产",
    "处理中",
  ];
  const CASE_KEYWORDS = [
    "报错",
    "错误",
    "异常",
    "失败",
    "不行",
    "不能",
    "无法",
    "进不去",
    "卡住",
    "转圈",
    "白屏",
    "闪退",
    "登录",
    "没反应",
    "点不开",
    "有问题",
  ];
  const DASHBOARD_DEFAULT_LIMIT = 30;
  const DASHBOARD_MAX_LIMIT = 200;
  const MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
  const MESSAGE_SEARCH_MAX_LIMIT = 100;
  const MESSAGE_CONTEXT_MAX_NEIGHBORS = 10;
  const HISTORY_SUMMARY_MAX_BUCKETS = 120;
  const DASHBOARD_UI_VERSION = "2026.04.23-9";
  const DASHBOARD_PUBLIC_URL = String(process.env.FLOWBOT_DASHBOARD_PUBLIC_URL || "").trim().replace(/\/$/, "");
  const CDN_DOWNLOAD_ENDPOINT = String(
    process.env.FLOWBOT_CDN_DOWNLOAD_ENDPOINT || "http://47.105.83.171:23789/cloud/cdn_c2c_download",
  );
  const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(process.env.FLOWBOT_MEDIA_DOWNLOAD_TIMEOUT_MS || 15000);
  const UPSTREAM_WECOM_API_BASE = String(process.env.FLOWBOT_UPSTREAM_WECOM_API_BASE || "http://47.105.83.171:23789").replace(/\/$/, "");
  const PROXY_PROVIDER_BASE_URL = String(process.env.FLOWBOT_PROXY_PROVIDER_BASE_URL || "http://api.tianqiip.com/getip");
  const PROXY_PROVIDER_SECRET = String(process.env.FLOWBOT_PROXY_PROVIDER_SECRET || "2schw4v5");
  const PROXY_PROVIDER_SIGN = String(process.env.FLOWBOT_PROXY_PROVIDER_SIGN || "1ed82290cb7b764ac17f1b5104d90989");
  const PROXY_PROVIDER_ACCOUNT = String(process.env.FLOWBOT_PROXY_PROVIDER_ACCOUNT || "hhraxf");
  const PROXY_PROVIDER_PASSWORD = String(process.env.FLOWBOT_PROXY_PROVIDER_PASSWORD || "5p2d1vfu");
  const DEFAULT_LOGIN_REGION = String(process.env.FLOWBOT_DEFAULT_LOGIN_REGION || "370200");
  const DEFAULT_NOTIFY_URL = String(
    process.env.FLOWBOT_DEFAULT_NOTIFY_URL
    || (DASHBOARD_PUBLIC_URL ? `${DASHBOARD_PUBLIC_URL}/flowbot/callback` : ""),
  ).trim();
  const LOGIN_REGION_OPTIONS = [
    { value: "370200", label: "青岛" },
    { value: "370100", label: "济南" },
    { value: "110000", label: "北京" },
    { value: "310000", label: "上海" },
    { value: "440100", label: "广州" },
    { value: "440300", label: "深圳" },
    { value: "330100", label: "杭州" },
  ];
  const SERVICE_FILE_PATH = String(process.env.FLOWBOT_SERVICE_FILE_PATH || "/etc/systemd/system/wecom-flowbot.service");
  const SERVICE_NAME = String(process.env.FLOWBOT_SERVICE_NAME || "wecom-flowbot");
  const LOCAL_MANAGED_CONFIG_PATH = String(
    process.env.FLOWBOT_CONFIG_PATH
    || path.resolve(baseDir, "..", "..", "config", "flowbot.local.json"),
  ).trim();
  const LOCAL_LAUNCH_AGENT_LABEL = String(
    process.env.FLOWBOT_LOCAL_LAUNCH_AGENT_LABEL || "com.yuebai.flowbot",
  ).trim();
  const LOCAL_LAUNCH_AGENT_PLIST_PATH = String(
    process.env.FLOWBOT_LOCAL_LAUNCH_AGENT_PLIST
    || path.join(os.homedir(), "Library", "LaunchAgents", `${LOCAL_LAUNCH_AGENT_LABEL}.plist`),
  ).trim();
  const CONFIG_TEST_PATH = path.join(DATA_DIR, "flowbot-config-test.json");
  const LLM_CLASSIFY_ENABLED = String(process.env.FLOWBOT_LLM_CLASSIFY_ENABLED || "1") !== "0";
  const LLM_API_URL = String(process.env.FLOWBOT_LLM_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1");
  const LLM_API_KEY = String(process.env.FLOWBOT_LLM_API_KEY || "");
  const LLM_MODEL = String(process.env.FLOWBOT_LLM_MODEL || "qwen3.7-max");
  const LLM_TIMEOUT_MS = Number(process.env.FLOWBOT_LLM_TIMEOUT_MS || 90000);
  const LLM_TIMEOUT_RETRY_ATTEMPTS = Math.max(
    1,
    Math.min(
      5,
      Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_ATTEMPTS || DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS)
        || DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
    ),
  );
  const LLM_TIMEOUT_RETRY_BASE_DELAY_MS = Math.max(
    100,
    Math.min(
      10000,
      Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS || DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS)
        || DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
    ),
  );
  const LLM_TIMEOUT_RETRY_MAX_DELAY_MS = Math.max(
    1000,
    Math.min(
      60000,
      Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS || DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS)
        || DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
    ),
  );
  const LLM_MAX_REPAIR_ATTEMPTS = Math.max(0, Number(process.env.FLOWBOT_LLM_MAX_REPAIR_ATTEMPTS || 1));
  const IMAGE_SUMMARY_ENABLED = String(process.env.FLOWBOT_IMAGE_SUMMARY_ENABLED || "1") !== "0";
  const IMAGE_SUMMARY_MODEL = String(process.env.FLOWBOT_IMAGE_SUMMARY_MODEL || "qwen-vl-plus").trim();
  const IMAGE_SUMMARY_TIMEOUT_MS = Math.max(
    1000,
    Math.min(120000, Number(process.env.FLOWBOT_IMAGE_SUMMARY_TIMEOUT_MS || 30000) || 30000),
  );
  const IMAGE_SUMMARY_MAX_BYTES = Math.max(
    1024,
    Math.min(8 * 1024 * 1024, Number(process.env.FLOWBOT_IMAGE_SUMMARY_MAX_BYTES || 4 * 1024 * 1024) || 4 * 1024 * 1024),
  );
  const KNOWLEDGE_HARVEST_ENABLED = String(process.env.FLOWBOT_KNOWLEDGE_HARVEST_ENABLED || "1") !== "0";
  const KNOWLEDGE_HARVEST_ROOM_IDS = new Set(
    String(process.env.FLOWBOT_KNOWLEDGE_HARVEST_ROOM_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS = Math.max(
    10000,
    Number(process.env.FLOWBOT_KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS || 60000),
  );
  const KNOWLEDGE_HARVEST_READY_AGE_MS = Math.max(
    0,
    Number(process.env.FLOWBOT_KNOWLEDGE_HARVEST_READY_AGE_MS || 2 * 60 * 1000),
  );
  const KNOWLEDGE_HARVEST_MAX_PER_SCAN = Math.max(
    1,
    Math.min(20, Number(process.env.FLOWBOT_KNOWLEDGE_HARVEST_MAX_PER_SCAN || 5)),
  );
  const TRANSCRIBE_ENABLED = String(process.env.FLOWBOT_TRANSCRIBE_ENABLED || "1") !== "0";
  const TRANSCRIBE_PYTHON = String(process.env.FLOWBOT_TRANSCRIBE_PYTHON || "python3");
  const TRANSCRIBE_SCRIPT_PATH = path.resolve(baseDir, "scripts", "transcribe_audio.py");
  const TRANSCRIBE_MODEL = String(process.env.FLOWBOT_TRANSCRIBE_MODEL || "base");
  const TRANSCRIBE_LANGUAGE = String(process.env.FLOWBOT_TRANSCRIBE_LANGUAGE || "zh");
  const TRANSCRIBE_TIMEOUT_MS = Number(process.env.FLOWBOT_TRANSCRIBE_TIMEOUT_MS || 45000);
  const MEDIA_DOWNLOAD_TYPES = {
    image_original: 1,
    image_medium: 2,
    image_thumb: 3,
    video: 4,
    file_bundle: 5,
  };

  return {
    ACCEPT_NOTIFY_TYPES,
    ACTIVE_CASE_STATUSES,
    AGENT_LANE_ENABLED,
    AGENT_PRIMARY_WAKE_NAME,
    AGENT_RUNTIME_ID,
    AGENT_SESSION_KEY_STRATEGY,
    AGENT_TASK_CLAIM_TIMEOUT_MS,
    AGENT_TASK_FETCH_LIMIT,
    AGENT_TASK_STATE_PATH,
    AGENT_WAKE_NAMES,
    ARCHIVE_ENABLED,
    ARCHIVE_LOG_PATH,
    ARCHIVE_MODE,
    ARCHIVE_PYTHON,
    ARCHIVE_SCRIPT_PATH,
    BATCH_ACTION_LABELS,
    BATCH_LOG_PATH,
    BATCH_MAX_OPEN_CASES,
    BATCH_MAX_PENDING_PER_ROOM,
    BATCH_MEDIA_ONLY_HOLD_MS,
    BATCH_MODE_ENABLED,
    BATCH_OPEN_CASE_LOOKBACK_MS,
    BATCH_PROCESSING_STALE_MS,
    BATCH_READY_AGE_MS,
    BATCH_SCAN_INTERVAL_MS,
    CASE_ARCHIVE_NOTIFY_ENABLED,
    CASE_KEYWORDS,
    CASE_STATUS_LABELS,
    CATEGORY_LABELS,
    CDN_DOWNLOAD_ENDPOINT,
    CONFIG_TEST_PATH,
    DASHBOARD_DEFAULT_LIMIT,
    DASHBOARD_MAX_LIMIT,
    DASHBOARD_PUBLIC_URL,
    DASHBOARD_UI_VERSION,
    DATA_DIR,
    DEFAULT_LOGIN_REGION,
    DEFAULT_NOTIFY_URL,
    FEISHU_APP_ACCESS_TOKEN_URL,
    FEISHU_APP_ID,
    FEISHU_APP_SECRET,
    FEISHU_AUTHORIZE_URL,
    FEISHU_MESSAGE_TYPE_TO_FLOWBOT,
    FEISHU_OAUTH_REDIRECT_URI,
    FEISHU_OAUTH_RESULT_PATH,
    FEISHU_OAUTH_SCOPE,
    FEISHU_OAUTH_STATE_PATH,
    FEISHU_SEND_MESSAGE_URL,
    FEISHU_TARGET_CHAT_IDS,
    FEISHU_USER_ACCESS_TOKEN_URL,
    FEISHU_USER_INFO_URL,
    FEISHU_VERIFICATION_TOKEN,
    FEATURE_KEYWORDS,
    FILTER_LOG_PATH,
    FLOWBOT_STORAGE_BACKEND: STORAGE_BACKEND,
    HISTORY_SUMMARY_MAX_BUCKETS,
    IMAGE_SUMMARY_ENABLED,
    IMAGE_SUMMARY_MAX_BYTES,
    IMAGE_SUMMARY_MODEL,
    IMAGE_SUMMARY_TIMEOUT_MS,
    INCIDENT_KEYWORDS,
    KNOWLEDGE_CANDIDATES_PATH,
    KNOWLEDGE_DIR,
    KNOWLEDGE_HARVEST_ENABLED,
    KNOWLEDGE_HARVEST_MAX_PER_SCAN,
    KNOWLEDGE_HARVEST_READY_AGE_MS,
    KNOWLEDGE_HARVEST_ROOM_IDS,
    KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
    KNOWLEDGE_HARVEST_STATE_PATH,
    KNOWLEDGE_PUBLISH_LOG_PATH,
    KNOWLEDGE_SOURCE_VALUES,
    LLM_API_KEY,
    LLM_API_URL,
    LLM_CLASSIFY_ENABLED,
    LLM_MAX_REPAIR_ATTEMPTS,
    LLM_MODEL,
    LLM_TIMEOUT_MS,
    LLM_TIMEOUT_RETRY_ATTEMPTS,
    LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
    LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
    LOCAL_LAUNCH_AGENT_LABEL,
    LOCAL_LAUNCH_AGENT_PLIST_PATH,
    LOCAL_MANAGED_CONFIG_PATH,
    LOG_PATH,
    LOGIN_REGION_OPTIONS,
    MAXKB_BASE_URL,
    MAXKB_CACHE_TTL_MS,
    MAXKB_ENABLED,
    MAXKB_KNOWLEDGE_FILTER,
    MAXKB_KNOWLEDGE_PREFIX_FILTER,
    MAXKB_PASSWORD,
    MAXKB_SEARCH_MODE,
    MAXKB_SEARCH_SIMILARITY,
    MAXKB_TIMEOUT_MS,
    MAXKB_USERNAME,
    MAXKB_WORKSPACE_ID,
    MEDIA_DIR,
    MEDIA_DOWNLOAD_TIMEOUT_MS,
    MEDIA_DOWNLOAD_TYPES,
    MEDIA_INDEX_PATH,
    MEMORY_SOURCE_VALUES,
    MESSAGE_CONTEXT_MAX_NEIGHBORS,
    MESSAGE_POOL_STATE_PATH,
    MESSAGE_ROLE_LABELS,
    MESSAGE_SEARCH_DEFAULT_LIMIT,
    MESSAGE_SEARCH_INDEX_PATH,
    MESSAGE_SEARCH_MAX_LIMIT,
    MSG_TYPE_KEY_ALIASES,
    MSG_TYPE_NAMES,
    MSG_TYPE_NAME_ALIASES,
    NORMALIZED_LOG_PATH,
    PORT,
    PRIORITY_ALIASES,
    PRIORITY_KEYWORDS,
    PROXY_PROVIDER_ACCOUNT,
    PROXY_PROVIDER_BASE_URL,
    PROXY_PROVIDER_PASSWORD,
    PROXY_PROVIDER_SECRET,
    PROXY_PROVIDER_SIGN,
    RAGFLOW_BASE_URL,
    RAGFLOW_CHAT_ID,
    RAGFLOW_DATASET_IDS,
    RAGFLOW_DATASET_NAMES,
    RAGFLOW_ENABLED,
    RAGFLOW_LOGIN_EMAIL,
    RAGFLOW_LOGIN_PASSWORD,
    RAGFLOW_LOGIN_PUBLIC_KEY,
    RAGFLOW_SEARCH_SIMILARITY,
    RAGFLOW_TIMEOUT_MS,
    RAGFLOW_TOP_K,
    RAGFLOW_VECTOR_SIMILARITY_WEIGHT,
    ROUTING_LOG_PATH,
    SERVICE_FILE_PATH,
    SERVICE_NAME,
    SUMMARY_STOPWORDS,
    SUPPORTED_MSG_TYPES,
    TARGET_ROOM_IDS,
    THREAD_TYPE_LABELS,
    TRANSCRIBE_ENABLED,
    TRANSCRIBE_LANGUAGE,
    TRANSCRIBE_MODEL,
    TRANSCRIBE_PYTHON,
    TRANSCRIBE_SCRIPT_PATH,
    TRANSCRIBE_TIMEOUT_MS,
    UPSTREAM_WECOM_API_BASE,
  };
}

module.exports = {
  createFlowbotRuntimeConfig,
};
