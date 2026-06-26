"use strict";

const fs = require("fs");

function defaultPlatformConfig() {
  return {
    modules: [
      {
        id: "flowbot",
        name: "群机器人后台",
        description: "",
        category: "客服机器人",
        url: "/flowbot/dashboard",
        status: "online",
        backend: {
          type: "reverse_proxy",
          baseUrlEnv: "FLOWBOT_BASE_URL",
          defaultBaseUrl: "http://127.0.0.1:3010",
          pathPrefix: "/flowbot",
        },
        deploy: {
          serviceName: "flowbot",
          mode: "managed",
          language: "node",
          workingDir: "apps/flowbot-bridge",
          startCommand: "node server.js",
          workerCommand: "node scripts/agent_task_worker.js",
          healthPath: "/flowbot/dashboard/data?limit=1",
        },
      },
      {
        id: "knowledge",
        name: "知识治理与问答",
        description: "",
        category: "知识库",
        kind: "external",
        url: "/ragflow-workbench-bridge.html",
        status: "online",
      },
      {
        id: "knowledge-governance",
        name: "知识候选审核",
        description: "人工处理歧义，确认后入 RAGFlow",
        category: "知识库",
        kind: "internal",
        hidden: true,
        url: "${RAGFLOW_CHAT_URL}",
        status: "online",
      },
      {
        id: "ai-search",
        name: "AI搜索",
        description: "",
        category: "智能体",
        kind: "internal",
        status: "beta",
      },
      {
        id: "persona-distill",
        name: "人物蒸馏",
        description: "",
        category: "智能体",
        kind: "internal",
        status: "draft",
      },
      {
        id: "content-assets",
        name: "抖音视频直播采集",
        description: "",
        category: "内容资产",
        url: "${CONTENT_ASSET_URL}",
        status: "online",
      },
      {
        id: "group-intent",
        name: "群聊介入决策",
        description: "",
        category: "客服机器人",
        kind: "internal",
        status: "draft",
      },
      {
        id: "wechat-video",
        name: "微信视频号采集",
        description: "边浏览视频号边捕获内容资产",
        category: "内容资产",
        kind: "internal",
        status: "draft",
      },
    ],
  };
}

function createPlatformProxyService({
  CONTENT_ASSET_BASE_URL,
  CONTENT_ASSET_URL,
  DEFAULT_ROOM_ID,
  FLOWBOT_BASE_URL,
  HOST,
  PLATFORM_CONFIG_PATH,
  PORT,
  RAGFLOW_BASE_URL,
  RAGFLOW_CHAT_URL,
  fetchImpl = fetch,
  readRawBody,
  sendJson,
}) {
  function platformVars() {
    return {
      FLOWBOT_ROOM_ID: DEFAULT_ROOM_ID,
      FLOWBOT_BASE_URL,
      RAGFLOW_BASE_URL,
      RAGFLOW_CHAT_URL,
      CONTENT_ASSET_URL,
    };
  }

  function expandConfigValue(value) {
    if (typeof value === "string") {
      const vars = platformVars();
      return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || vars[key] || "");
    }
    if (Array.isArray(value)) return value.map(expandConfigValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, next]) => [key, expandConfigValue(next)]));
    }
    return value;
  }

  function loadPlatformConfig() {
    const config = fs.existsSync(PLATFORM_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(PLATFORM_CONFIG_PATH, "utf-8"))
      : defaultPlatformConfig();
    return expandConfigValue(config);
  }

  function buildModules() {
    return loadPlatformConfig().modules || [];
  }

  function publicModule(module) {
    const { backend, deploy, ...rest } = module;
    return rest;
  }

  async function reverseProxy(req, res, targetBaseUrl, options = {}) {
    const incomingUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const stripPrefix = options.stripPrefix || "";
    const targetPathPrefix = options.targetPathPrefix || "";
    let pathname = incomingUrl.pathname;
    if (stripPrefix && pathname.startsWith(stripPrefix)) {
      pathname = pathname.slice(stripPrefix.length) || "/";
    }
    pathname = `${targetPathPrefix}${pathname}`.replace(/\/{2,}/g, "/");
    const target = new URL(`${pathname}${incomingUrl.search}`, targetBaseUrl);
    const requestBody = ["GET", "HEAD"].includes(req.method || "GET") ? undefined : await readRawBody(req);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    const response = await fetchImpl(target, {
      method: req.method,
      headers,
      body: requestBody,
      redirect: "manual",
    });
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (!["content-encoding", "transfer-encoding", "connection"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = String(response.headers.get("content-type") || "");
    let responseBody = buffer;
    if (options.rewriteHtml && req.method !== "HEAD" && contentType.includes("text/html")) {
      responseBody = Buffer.from(options.rewriteHtml(buffer.toString("utf-8")), "utf-8");
      responseHeaders["content-length"] = Buffer.byteLength(responseBody);
    } else if (responseHeaders["content-length"]) {
      responseHeaders["content-length"] = Buffer.byteLength(responseBody);
    }
    res.writeHead(response.status, responseHeaders);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(responseBody);
  }

  async function proxyConfiguredModule(req, res, url) {
    const config = loadPlatformConfig();
    const proxyModule = (config.modules || []).find((module) => {
      const backend = module.backend || {};
      return backend.type === "reverse_proxy" && backend.pathPrefix && url.pathname.startsWith(backend.pathPrefix);
    });
    if (!proxyModule) return false;
    const backend = proxyModule.backend;
    const baseUrl = backend.baseUrl || process.env[backend.baseUrlEnv || ""] || backend.defaultBaseUrl;
    if (!baseUrl) {
      sendJson(res, { ok: false, error: `missing backend baseUrl for ${proxyModule.id}` }, 500);
      return true;
    }
    try {
      await reverseProxy(req, res, baseUrl, {
        stripPrefix: backend.stripPrefix ? backend.pathPrefix : "",
        targetPathPrefix: backend.targetPathPrefix || "",
        rewriteHtml:
          proxyModule.id === "content-assets"
            ? (html) =>
                html
                  .replace(/(["'`])\/api\//g, "$1/content-assets-service/api/")
                  .replace("url: '/openapi.json'", "url: '/content-assets-service/openapi.json'")
                  .replace(
                    "window.location.origin + '/docs/oauth2-redirect'",
                    "window.location.origin + '/content-assets-service/docs/oauth2-redirect'"
                  )
            : null,
      });
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 502);
    }
    return true;
  }

  function isContentAssetsLegacyApiPath(pathname) {
    return (
      pathname === "/api/content-assets/tasks" ||
      pathname === "/api/jobs" ||
      pathname.startsWith("/api/jobs/") ||
      pathname === "/api/library" ||
      pathname.startsWith("/api/library/") ||
      pathname === "/api/media" ||
      pathname.startsWith("/api/auth/") ||
      pathname.startsWith("/api/video/") ||
      pathname.startsWith("/api/live/") ||
      pathname.startsWith("/api/products/")
    );
  }

  function isContentAssetsReferer(req) {
    const referer = String(req.headers.referer || req.headers.referrer || "");
    return referer.includes("/content-assets-service");
  }

  async function proxyContentAssetsLegacyApi(req, res, url) {
    const targetBaseUrl = CONTENT_ASSET_BASE_URL;
    if (!targetBaseUrl) {
      sendJson(res, { ok: false, error: "content asset service is not configured" }, 500);
      return;
    }

    const originalUrl = req.url;
    if (url.pathname === "/api/content-assets/tasks") {
      const nextUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      nextUrl.pathname = "/api/jobs";
      req.url = `${nextUrl.pathname}${nextUrl.search}`;
    }

    try {
      await reverseProxy(req, res, targetBaseUrl);
    } catch (error) {
      sendJson(res, { ok: false, error: error.message }, 502);
    } finally {
      req.url = originalUrl;
    }
  }

  return {
    buildModules,
    expandConfigValue,
    isContentAssetsLegacyApiPath,
    isContentAssetsReferer,
    loadPlatformConfig,
    platformVars,
    proxyConfiguredModule,
    proxyContentAssetsLegacyApi,
    publicModule,
    reverseProxy,
  };
}

module.exports = {
  createPlatformProxyService,
  defaultPlatformConfig,
};
