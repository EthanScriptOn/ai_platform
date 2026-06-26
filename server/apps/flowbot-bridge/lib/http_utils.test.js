"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

const {
  collectBody,
  escapeHtml,
  pruneEmpty,
  safeParseJson,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
} = require("./http_utils");

function createResponse() {
  return {
    body: null,
    headers: null,
    status: null,
    end(body) {
      this.body = body;
    },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
  };
}

test("sendJson, sendHtml, and sendRedirect preserve cache headers", () => {
  const json = createResponse();
  sendJson(json, 201, { ok: true });
  assert.equal(json.status, 201);
  assert.equal(json.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(json.headers["Cache-Control"], "no-store, no-cache, must-revalidate, proxy-revalidate");
  assert.equal(json.body, JSON.stringify({ ok: true }, null, 2));

  const html = createResponse();
  sendHtml(html, 200, "<h1>Hi</h1>");
  assert.equal(html.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(html.body, "<h1>Hi</h1>");

  const redirect = createResponse();
  sendRedirect(redirect, 302, "/next");
  assert.equal(redirect.headers.Location, "/next");
  assert.equal(redirect.body, undefined);
});

test("sendFile serves bytes with immutable cache header", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-http-utils-test-"));
  const filePath = path.join(dir, "asset.txt");
  fs.writeFileSync(filePath, "asset", "utf8");
  const res = createResponse();

  sendFile(res, 200, filePath, "text/plain");

  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/plain");
  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.toString("utf8"), "asset");
});

test("collectBody and safeParseJson handle normal and invalid bodies", async () => {
  const req = Readable.from([Buffer.from("{\"ok\":"), Buffer.from("true}")]);
  const raw = await collectBody(req);

  assert.equal(raw, "{\"ok\":true}");
  assert.deepEqual(safeParseJson(raw), { ok: true });
  assert.equal(safeParseJson("not-json"), null);
  assert.equal(safeParseJson(""), null);
});

test("pruneEmpty and escapeHtml keep useful values", () => {
  assert.deepEqual(
    pruneEmpty({ a: "", b: null, c: 0, d: false, e: ["", "x"], f: { g: "" } }),
    { c: 0, d: false, e: ["x"] }
  );
  assert.equal(escapeHtml(`<a b="c">'&</a>`), "&lt;a b=&quot;c&quot;&gt;&#39;&amp;&lt;/a&gt;");
});
