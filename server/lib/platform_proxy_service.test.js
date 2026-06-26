"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createPlatformProxyService, defaultPlatformConfig } = require("./platform_proxy_service");

function createResponse() {
  return {
    body: null,
    headers: null,
    status: null,
    ended: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function createService(fetchImpl, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-proxy-test-"));
  const sentJson = [];
  const service = createPlatformProxyService({
    CONTENT_ASSET_BASE_URL: "http://content.test",
    CONTENT_ASSET_URL: "/content-assets-service/",
    DEFAULT_ROOM_ID: "room-1",
    FLOWBOT_BASE_URL: "http://flowbot.test",
    HOST: "127.0.0.1",
    PLATFORM_CONFIG_PATH: path.join(dir, "platform.json"),
    PORT: 8788,
    RAGFLOW_BASE_URL: "http://ragflow.test",
    RAGFLOW_CHAT_URL: "http://ragflow.test/workbench",
    fetchImpl,
    readRawBody: async (req) => Buffer.from(req.body || ""),
    sendJson(res, payload, status = 200) {
      sentJson.push({ payload, status });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    ...overrides,
  });
  return { dir, sentJson, service };
}

function proxyResponse(body, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: {
      forEach(callback) {
        for (const [key, value] of Object.entries(normalizedHeaders)) callback(value, key);
      },
      get(key) {
        return normalizedHeaders[String(key).toLowerCase()] || "";
      },
    },
    async arrayBuffer() {
      const buffer = Buffer.from(body);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

test("default platform config expands variables and hides backend fields", () => {
  const { service } = createService(async () => proxyResponse(""));
  const modules = service.buildModules();
  const publicFlowbot = service.publicModule(modules.find((item) => item.id === "flowbot"));

  assert.equal(defaultPlatformConfig().modules.length > 0, true);
  assert.equal(modules.find((item) => item.id === "flowbot").url, "/flowbot/dashboard");
  assert.equal(modules.find((item) => item.id === "content-assets").url, "/content-assets-service/");
  assert.equal(publicFlowbot.backend, undefined);
  assert.equal(publicFlowbot.deploy, undefined);
});

test("loadPlatformConfig reads custom config and recursively expands env vars", () => {
  const { dir, service } = createService(async () => proxyResponse(""));
  fs.writeFileSync(
    path.join(dir, "platform.json"),
    JSON.stringify({ modules: [{ id: "custom", url: "${RAGFLOW_CHAT_URL}", nested: ["${FLOWBOT_BASE_URL}"] }] }),
    "utf8"
  );

  assert.deepEqual(service.loadPlatformConfig(), {
    modules: [{ id: "custom", url: "http://ragflow.test/workbench", nested: ["http://flowbot.test"] }],
  });
});

test("reverseProxy strips prefix, forwards body, and rewrites html", async () => {
  const calls = [];
  const { service } = createService(async (target, options) => {
    calls.push({ target: String(target), options });
    return proxyResponse("<script>url: '/openapi.json'</script>", {
      headers: { "content-type": "text/html", "content-length": "34", connection: "close" },
    });
  });
  const req = {
    body: "payload",
    headers: { host: "localhost:8788", connection: "keep-alive", "content-length": "7", "x-test": "1" },
    method: "POST",
    url: "/prefix/page?q=1",
  };
  const res = createResponse();

  await service.reverseProxy(req, res, "http://target.test/base", {
    stripPrefix: "/prefix",
    targetPathPrefix: "/api",
    rewriteHtml: (html) => html.replace("/openapi.json", "/rewritten.json"),
  });

  assert.equal(calls[0].target, "http://target.test/api/page?q=1");
  assert.equal(calls[0].options.headers.host, undefined);
  assert.equal(calls[0].options.body.toString(), "payload");
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "<script>url: '/rewritten.json'</script>");
  assert.equal(res.headers.connection, undefined);
});

test("proxyConfiguredModule handles configured proxy and missing base url", async () => {
  const { dir, sentJson, service } = createService(async () => proxyResponse("ok"));
  fs.writeFileSync(
    path.join(dir, "platform.json"),
    JSON.stringify({
      modules: [
        {
          id: "demo",
          backend: { type: "reverse_proxy", pathPrefix: "/demo", defaultBaseUrl: "http://demo.test" },
        },
        {
          id: "missing",
          backend: { type: "reverse_proxy", pathPrefix: "/missing" },
        },
      ],
    }),
    "utf8"
  );

  const handled = await service.proxyConfiguredModule(
    { headers: { host: "localhost" }, method: "GET", url: "/demo/path" },
    createResponse(),
    new URL("http://localhost/demo/path")
  );
  const missingRes = createResponse();
  const missingHandled = await service.proxyConfiguredModule(
    { headers: { host: "localhost" }, method: "GET", url: "/missing/path" },
    missingRes,
    new URL("http://localhost/missing/path")
  );

  assert.equal(handled, true);
  assert.equal(missingHandled, true);
  assert.equal(sentJson[0].status, 500);
  assert.match(sentJson[0].payload.error, /missing backend/);
});

test("content asset legacy proxy rewrites tasks path and restores request url", async () => {
  const calls = [];
  const { service } = createService(async (target) => {
    calls.push(String(target));
    return proxyResponse("ok");
  });
  const req = {
    headers: { host: "localhost" },
    method: "GET",
    url: "/api/content-assets/tasks?page=1",
  };

  assert.equal(service.isContentAssetsLegacyApiPath("/api/jobs/1"), true);
  assert.equal(service.isContentAssetsReferer({ headers: { referer: "/content-assets-service/" } }), true);
  await service.proxyContentAssetsLegacyApi(req, createResponse(), new URL("http://localhost/api/content-assets/tasks?page=1"));

  assert.equal(calls[0], "http://content.test/api/jobs?page=1");
  assert.equal(req.url, "/api/content-assets/tasks?page=1");
});
