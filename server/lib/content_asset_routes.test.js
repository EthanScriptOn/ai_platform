"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createContentAssetRoutes } = require("./content_asset_routes");

function waitForPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

function createRequest(headers = {}) {
  return { headers: { host: "admin.test", ...headers } };
}

function route(pathname) {
  return new URL(pathname, "http://admin.test");
}

function createRoutes(overrides = {}) {
  const calls = [];
  const service = createContentAssetRoutes({
    CONTENT_ASSET_BASE_URL: "http://asset.internal",
    CONTENT_ASSET_INSTALL_BASE_URL: "",
    CONTENT_ASSET_LOCAL_MEDIA_BASE_URL: "https://asset.local",
    CONTENT_ASSET_PUBLIC_BASE_URL: "http://asset.public",
    CONTENT_ASSET_REMOTE_TOKEN: "remote-token",
    HOST: "127.0.0.1",
    PORT: 8788,
    completeContentAssetCommand(token, commandId, payload) {
      calls.push({ type: "complete", token, commandId, payload });
    },
    contentAssetRemoteStatus: (token) => ({ ok: true, token }),
    createContentAssetJobInMysql: (job, clientId) => ({ ...job, clientId }),
    createContentAssetToken: () => "client-token",
    deleteContentAssetJobInMysql: (id) => ({ id, deleted: true }),
    ensureContentAssetMysqlSchema() {
      calls.push({ type: "schema" });
    },
    getContentAssetJobFromMysql: (id) => ({ id }),
    isAiAdminMysqlEnabled: () => true,
    isContentAssetsLegacyApiPath: (pathname) => pathname === "/legacy-content-assets",
    isContentAssetsReferer: (req) => req.headers.referer === "content-assets",
    loadContentAssetJobsFromMysql: () => [
      { id: "job-1", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "job-2", updatedAt: "2026-01-02T00:00:00.000Z" },
    ],
    proxyContentAssetsLegacyApi(req, res, url) {
      calls.push({ type: "legacy", pathname: url.pathname });
      res.body = "proxied";
    },
    sendContentAssetCommand: async (path, options) => ({ ok: true, path, options }),
    sendContentAssetCommandForToken: async (token, path, options) => ({ ok: true, token, path, options }),
    sendJson(res, payload, status = 200) {
      calls.push({ type: "json", payload, status });
      res.status = status;
      res.body = JSON.stringify(payload);
    },
    updateContentAssetClient: (token, clientId, status) => ({ token, clientId, status, queue: [{ id: "cmd-1" }] }),
    updateContentAssetJobInMysql: (id, payload, clientId) => ({ id, ...payload, clientId }),
    updateLegacyContentAssetClient: (clientId, status) => ({ clientId, status, queue: [] }),
    ...overrides,
  });
  return { calls, service };
}

test("agent status uses bearer token client update", async () => {
  const seen = [];
  const { service } = createRoutes({
    updateContentAssetClient(token, clientId, status) {
      seen.push({ token, clientId, status });
      return { clientId };
    },
  });
  const res = createResponse();

  const handled = service.handleContentAssetRoute(
    createRequest({ authorization: "Bearer client-token", "x-yuebai-collector-client": "client-1" }),
    res,
    route("/api/content-assets/agent/status"),
    "POST",
    async () => ({ status: { ready: true } })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(seen, [{ token: "client-token", clientId: "client-1", status: { ready: true } }]);
  assert.deepEqual(JSON.parse(res.body), { ok: true, clientId: "client-1" });
});

test("remote jobs list enforces auth and paginates", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleContentAssetRoute(
    createRequest({ authorization: "Bearer remote-token" }),
    res,
    route("/api/content-assets/remote/jobs?page=1&pageSize=1"),
    "GET",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.equal(JSON.parse(res.body).jobs.length, 1);
  assert.deepEqual(JSON.parse(res.body).pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
});

test("content asset media route redirects to public media endpoint", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleContentAssetRoute(
    createRequest(),
    res,
    route("/api/content-assets/media?path=/video/a.mp4"),
    "GET",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.equal(res.status, 302);
  assert.equal(res.headers.Location, "http://asset.public/api/media?path=%2Fvideo%2Fa.mp4");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("legacy content assets proxy handles matching paths and referer health", () => {
  const { calls, service } = createRoutes();
  const byPath = createResponse();
  const byReferer = createResponse();

  assert.equal(
    service.handleContentAssetRoute(createRequest(), byPath, route("/legacy-content-assets"), "GET", async () => ({})),
    true
  );
  assert.equal(
    service.handleContentAssetRoute(createRequest({ referer: "content-assets" }), byReferer, route("/api/health"), "GET", async () => ({})),
    true
  );

  assert.deepEqual(calls.filter((call) => call.type === "legacy").map((call) => call.pathname), [
    "/legacy-content-assets",
    "/api/health",
  ]);
});

test("unmatched route is not handled", () => {
  const { service } = createRoutes();

  assert.equal(
    service.handleContentAssetRoute(createRequest(), createResponse(), route("/api/other"), "GET", async () => ({})),
    false
  );
});
