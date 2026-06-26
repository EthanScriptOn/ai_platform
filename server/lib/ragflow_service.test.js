"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { createRagflowService } = require("./ragflow_service");

function response(payload, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || "";
      },
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function createService(fetchImpl, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragflow-service-test-"));
  return {
    dir,
    service: createRagflowService({
      RAGFLOW_AGENT_ID: "chat-1",
      RAGFLOW_BASE_URL: "http://ragflow.test",
      RAGFLOW_DATASET_ID: "dataset-1",
      RAGFLOW_LOGIN_EMAIL: "user@example.test",
      RAGFLOW_LOGIN_PASSWORD: "password",
      RAGFLOW_LOGIN_PUBLIC_KEY: "",
      RAGFLOW_SHARE_AUTH: "",
      REVIEW_RUN_DIR: dir,
      fetchImpl,
      loadRagflowToken: () => "token-123",
      loadDecisions: () => ({
        item1: { status: "approved", unit: { title: "标题", final_content: "内容" } },
      }),
      loadGovernedItems: () => [{ id: "item1", document_title: "文档" }],
      renderApprovedMarkdown: () => ({ markdown: "# 已审核\n", count: 1 }),
      ...overrides,
    }),
  };
}

test("ragflowJson sends bearer token and parses successful response", async () => {
  const calls = [];
  const { service } = createService(async (url, options) => {
    calls.push({ url, options });
    return response({ code: 0, data: { ok: true } });
  });

  const result = await service.ragflowJson("POST", "/api/v1/test", { hello: "world" });

  assert.deepEqual(result, { code: 0, data: { ok: true } });
  assert.equal(calls[0].url, "http://ragflow.test/api/v1/test");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-123");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.body, JSON.stringify({ hello: "world" }));
});

test("ragflowJson refreshes expired token into store instead of token file", async () => {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "pkcs1", format: "pem" });
  const savedTokens = [];
  const calls = [];
  const { service, dir } = createService(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/test") && calls.length === 1) {
      return response({ code: 100, message: "expired" }, { ok: false, status: 401 });
    }
    if (url.endsWith("/api/v1/auth/login")) {
      return response({ code: 0, data: { id: "user-1" } }, { headers: { authorization: "token-new" } });
    }
    return response({ code: 0, data: { ok: true } });
  }, {
    RAGFLOW_LOGIN_PUBLIC_KEY: publicKeyPem,
    loadRagflowToken: () => "token-old",
    saveRagflowToken: (token) => {
      savedTokens.push(token);
      return true;
    },
  });

  const result = await service.ragflowJson("POST", "/api/v1/test", { hello: "world" });

  assert.deepEqual(result, { code: 0, data: { ok: true } });
  assert.deepEqual(savedTokens, ["token-new"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-old");
  assert.equal(calls[2].options.headers.Authorization, "Bearer token-new");
});

test("createRagflowNativeSession returns share-auth target without login", async () => {
  const { service } = createService(
    async () => {
      throw new Error("fetch should not be called for share auth");
    },
    { RAGFLOW_SHARE_AUTH: "shared-token" }
  );

  const result = await service.createRagflowNativeSession();

  assert.equal(result.mode, "share_auth");
  assert.equal(result.loginUrl, "http://ragflow.test/login");
  assert.equal(result.targetUrl, "http://ragflow.test/chat/chat-1?isNew=&auth=shared-token");
});

test("chat helpers find chat info and create sessions", async () => {
  const calls = [];
  const { service } = createService(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/chats")) {
      return response({ code: 0, data: { chats: [{ id: "chat-1", name: "Chat" }] } });
    }
    return response({ code: 0, data: { id: "session-1" } });
  });

  assert.deepEqual(await service.getRagflowChatInfo("chat-1"), { id: "chat-1", name: "Chat" });
  assert.deepEqual(await service.createRagflowChatSession("chat-1", "测试会话"), { id: "session-1" });
  assert.equal(calls[1].options.body, JSON.stringify({ name: "测试会话" }));
});

test("importApprovedToRagflow uploads markdown and writes import state", async () => {
  const calls = [];
  const { dir, service } = createService(async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/documents?")) return response({ code: 0, data: { docs: [{ id: "old", name: "approved_knowledge.md" }] } });
    if (url.endsWith("/documents") && options.method === "DELETE") return response({ code: 0 });
    if (url.endsWith("/documents") && options.method === "POST") return response({ code: 0, data: [{ id: "new-doc" }] });
    if (url.endsWith("/chunks")) return response({ code: 0 });
    throw new Error(`unexpected url ${url}`);
  });

  const result = await service.importApprovedToRagflow();

  assert.equal(result.ok, true);
  assert.deepEqual(result.document_ids, ["new-doc"]);
  assert.deepEqual(result.replaced_document_ids, ["old"]);
  assert.ok(fs.existsSync(path.join(dir, "approved_ragflow_markdown", "approved_knowledge.md")));
  assert.ok(fs.existsSync(path.join(dir, "ragflow_import_state.json")));
  assert.equal(calls.length, 4);
});
