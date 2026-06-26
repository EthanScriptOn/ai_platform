"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWechatVideoRoutes } = require("./wechat_video_routes");

function waitForPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRequest(headers = {}) {
  return { headers: { host: "admin.test", ...headers } };
}

function createResponse() {
  return { body: null, status: null };
}

function route(pathname) {
  return new URL(pathname, "http://admin.test");
}

function createRoutes(overrides = {}) {
  const calls = [];
  const service = createWechatVideoRoutes({
    HOST: "127.0.0.1",
    PORT: 8788,
    WECHAT_COLLECTOR_INSTALL_BASE_URL: "",
    WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL: "https://wechat.local:18766",
    WECHAT_COLLECTOR_PUBLIC_BASE_URL: "http://wechat.public",
    clearWechatCaptures: async () => ({ ok: true, cleared: true }),
    collectorJson: async (path, options) => ({ ok: true, path, options }),
    completeWechatCollectorCommand(token, commandId, payload) {
      calls.push({ type: "complete", token, commandId, payload });
    },
    createWechatCollectorToken: () => "client-token",
    downloadWechatCapture: async (payload) => ({ ok: true, downloaded: payload.id }),
    getWechatCollectorStatus: async () => ({ ok: true, connected: true }),
    openWechatCollectorBrowser: async () => ({ ok: true, opened: true }),
    revealWechatCapture: async (payload) => ({ ok: true, revealed: payload.id }),
    sendJson(res, payload, status = 200) {
      calls.push({ type: "json", payload, status });
      res.status = status;
      res.body = JSON.stringify(payload);
    },
    sendWechatCollectorCommand: async (token, path, options) => ({ ok: true, token, path, options }),
    startWechatCollector: async (payload) => ({ ok: true, started: payload.type }),
    startWechatCollectorPackage: async () => ({ ok: false, error: "not local" }),
    stopWechatCollector: async () => ({ ok: true, stopped: true }),
    stopWechatCollectorPackage: async () => ({ ok: true, stopped: true }),
    streamWechatCapturePreview: async (req, res, id, token) => {
      calls.push({ type: "preview", id, token });
      res.body = "preview";
    },
    trustWechatCollectorCert: async () => ({ ok: true, trusted: true }),
    updateWechatCollectorClient: (token, clientId, status) => ({
      token,
      clientId,
      status,
      queue: [{ id: "cmd-1", path: "/api/status", options: {} }],
    }),
    wechatCollectorStatusForToken: (token) => ({ ok: true, token }),
    wechatTokenFromRequest: (req, payload, url) =>
      String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() ||
      String(payload.token || url.searchParams.get("token") || "").trim(),
    ...overrides,
  });
  return { calls, service };
}

test("agent command uses collector token and shifts queued command", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleWechatVideoRoute(
    createRequest({ authorization: "Bearer token-1", "x-yuebai-collector-client": "client-1" }),
    res,
    route("/api/wechat-video/agent/command"),
    "GET",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    command: { id: "cmd-1", path: "/api/status", options: {} },
  });
});

test("config route returns public collector endpoints and package control flag", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleWechatVideoRoute(
    createRequest(),
    res,
    route("/api/wechat-video/config"),
    "GET",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    collectorBaseUrl: "http://wechat.public",
    installBaseUrl: "http://admin.test",
    localDirectBaseUrl: "https://wechat.local:18766",
    remoteMode: true,
    packageControlEnabled: true,
  });
});

test("set type forwards JSON body to collector service", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleWechatVideoRoute(
    createRequest(),
    res,
    route("/api/wechat-video/set-type"),
    "POST",
    async () => ({ type: "video" })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    path: "/api/set-type",
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "video" }),
    },
  });
});

test("preview route passes id and token to preview streamer", async () => {
  const { calls, service } = createRoutes();
  const res = createResponse();

  const handled = service.handleWechatVideoRoute(
    createRequest(),
    res,
    route("/api/wechat-video/preview?id=capture-1&token=token-1"),
    "GET",
    async () => ({})
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(calls.find((call) => call.type === "preview"), {
    type: "preview",
    id: "capture-1",
    token: "token-1",
  });
  assert.equal(res.body, "preview");
});

test("package start preserves service-driven status code", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleWechatVideoRoute(
    createRequest(),
    res,
    route("/api/wechat-video/package-start"),
    "POST",
    async () => ({})
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "not local" });
});

test("unmatched route is not handled", () => {
  const { service } = createRoutes();

  assert.equal(
    service.handleWechatVideoRoute(createRequest(), createResponse(), route("/api/other"), "GET", async () => ({})),
    false
  );
});
