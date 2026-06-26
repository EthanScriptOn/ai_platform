"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MIME, createStaticHttpService } = require("./static_http_service");

async function waitForResponse(res, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (res.status == null && res.body == null) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("response_timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createResponse() {
  return {
    body: null,
    headers: null,
    headersSent: false,
    status: null,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    },
  };
}

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "static-http-service-test-"));
  const dist = path.join(dir, "dist");
  const pub = path.join(dir, "public");
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(pub, { recursive: true });
  const service = createStaticHttpService({
    DIST: dist,
    HOST: "127.0.0.1",
    PORT: 8788,
    PUBLIC_DIR: pub,
    ROOT: dir,
    renderDouyinCollectorMacInstallScript: (token) => `douyin mac ${token}`,
    renderDouyinCollectorWindowsInstallScript: (token) => `douyin win ${token}`,
    renderWechatCollectorMacInstallScript: (token) => `wechat mac ${token}`,
    renderWechatCollectorWindowsInstallScript: (token) => `wechat win ${token}`,
    ...overrides,
  });
  return { dir, dist, pub, service };
}

test("sendJson supports JSON and JSONP responses", () => {
  const { service } = createService();
  const json = createResponse();
  service.sendJson(json, { ok: true });

  assert.equal(json.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(json.body, JSON.stringify({ ok: true }));

  const jsonp = createResponse();
  jsonp.jsonpCallback = "cb";
  service.sendJsonWithHeaders(jsonp, { ok: true }, 201, { "X-Test": "1" });

  assert.equal(jsonp.status, 201);
  assert.equal(jsonp.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(jsonp.headers["X-Test"], "1");
  assert.equal(jsonp.body, `cb(${JSON.stringify({ ok: true })});`);
});

test("sendFile serves existing files with MIME and missing files as JSON 404", async () => {
  const { dist, service } = createService();
  const filePath = path.join(dist, "app.js");
  fs.writeFileSync(filePath, "console.log(1);", "utf8");

  const found = createResponse();
  service.sendFile(found, filePath);
  await waitForResponse(found);

  assert.equal(found.status, 200);
  assert.equal(found.headers["Content-Type"], MIME[".js"]);
  assert.equal(found.body, "console.log(1);");

  const missing = createResponse();
  service.sendFile(missing, path.join(dist, "missing.js"));
  await waitForResponse(missing);
  assert.equal(missing.status, 404);
  assert.equal(missing.body, JSON.stringify({ error: "not found" }));
});

test("serveStatic returns install scripts and dist files", async () => {
  const { dist, service } = createService();
  fs.writeFileSync(path.join(dist, "index.html"), "<html>index</html>", "utf8");
  fs.writeFileSync(path.join(dist, "main.css"), "body{}", "utf8");

  const install = createResponse();
  service.serveStatic(
    { headers: { host: "localhost" }, url: "/install/yuebai-wechat-collector-macos.sh?token=t1" },
    install,
    "/install/yuebai-wechat-collector-macos.sh"
  );
  assert.equal(install.body, "wechat mac t1");
  assert.equal(install.headers["Content-Type"], "text/x-shellscript; charset=utf-8");

  const file = createResponse();
  service.serveStatic({ headers: { host: "localhost" }, url: "/main.css" }, file, "/main.css");
  await waitForResponse(file);
  assert.equal(file.body, "body{}");
  assert.equal(file.headers["Content-Type"], MIME[".css"]);

  const fallback = createResponse();
  service.serveStatic({ headers: { host: "localhost" }, url: "/missing-route" }, fallback, "/missing-route");
  await waitForResponse(fallback);
  assert.equal(fallback.body, "<html>index</html>");
});

test("streamDouyinCollectorArchive reports missing app and starts tar when present", () => {
  const missing = createResponse();
  const missingHarness = createService();
  missingHarness.service.streamDouyinCollectorArchive(missing);
  assert.equal(missing.status, 404);
  assert.match(missing.body, /content assets app missing/);

  const calls = [];
  const { dir, service } = createService({
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return {
        stdout: { pipe(target) { target.piped = true; } },
        stderr: { on() {} },
        on() {},
      };
    },
  });
  fs.mkdirSync(path.join(dir, "apps", "content-assets-console"), { recursive: true });
  const res = createResponse();
  service.streamDouyinCollectorArchive(res);

  assert.equal(res.status, 200);
  assert.equal(res.piped, true);
  assert.equal(calls[0].command, "tar");
  assert.equal(calls[0].options.cwd, path.join(dir, "apps", "content-assets-console"));
});
