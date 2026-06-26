"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKnowledgeRoutes } = require("./knowledge_routes");

function waitForPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createResponse() {
  return { body: null, headers: null, status: null };
}

function route(pathname) {
  return new URL(pathname, "http://localhost");
}

function createRoutes(overrides = {}) {
  const calls = [];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-routes-test-"));
  const service = createKnowledgeRoutes({
    DEFAULT_ROOM_ID: "room-default",
    RAGFLOW_AGENT_ID: "agent-default",
    RAGFLOW_CHAT_URL: "http://ragflow/chat",
    REVIEW_RUN_DIR: runDir,
    createRagflowChatSession: async (chatId, name) => ({ chatId, name }),
    createRagflowNativeSession: async () => ({ ok: true, setCookie: ["sid=1"], target: "native" }),
    getRagflowChatInfo: async (chatId) => ({ id: chatId }),
    getRagflowConfig: () => ({ ok: true, config: { baseUrl: "http://ragflow" } }),
    importApprovedToRagflow: async () => ({ ok: true, imported: 1 }),
    importRagflowEntries: async (entries, options) => ({ ok: true, document_ids: ["doc-1"], entries, options }),
    loadDecisions: () => ({ item2: { status: "approved" } }),
    loadGovernedItems: () => [{ id: "item1" }, { id: "item2" }],
    proxyFlowbotCandidateAction: async (payload) => ({ action: payload.action }),
    proxyFlowbotKnowledgeCandidates: async (roomId, pagination, options) => ({ roomId, pagination, options }),
    proxyRagflowChatCompletion: async (res, payload) => {
      res.body = JSON.stringify({ proxied: payload.message });
    },
    renderApprovedMarkdown: () => ({ markdown: "# approved", count: 1 }),
    saveRagflowConfig: (payload) => ({ ok: true, config: payload, needsRestartAfterSave: true }),
    saveDecisions(decisions) {
      calls.push({ type: "save", decisions });
    },
    sendJson(res, payload, status = 200) {
      calls.push({ type: "json", payload, status });
      res.status = status;
      res.body = JSON.stringify(payload);
    },
    sendJsonWithHeaders(res, payload, status = 200, headers = {}) {
      calls.push({ type: "jsonHeaders", payload, status, headers });
      res.status = status;
      res.headers = headers;
      res.body = JSON.stringify(payload);
    },
    ...overrides,
  });
  return { calls, runDir, service };
}

test("review items route attaches decisions and pagination metadata", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleKnowledgeRoute({}, res, route("/api/review/items?page=1&pageSize=1"), "GET", async () => ({}));

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    items: [{ id: "item1" }],
    pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
    runDir: JSON.parse(res.body).runDir,
    ragflowChatUrl: "http://ragflow/chat",
  });
});

test("review items route filters by normalized ingestion status before pagination", () => {
  const { service } = createRoutes({
    attachDecisions: (items) => items.map((item) => ({
      ...item,
      ingestion_status: item.id === "item1" ? "needs_review" : "imported",
    })),
  });
  const res = createResponse();

  const handled = service.handleKnowledgeRoute({}, res, route("/api/review/items?status=approved&page=1&pageSize=10"), "GET", async () => ({}));
  const payload = JSON.parse(res.body);

  assert.equal(handled, true);
  assert.deepEqual(payload.items, [{ id: "item2", ingestion_status: "imported" }]);
  assert.deepEqual(payload.pagination, { page: 1, pageSize: 10, total: 1, totalPages: 1 });
});

test("review decision route validates id and saves decision", async () => {
  const { calls, service } = createRoutes();
  const missing = createResponse();
  const saved = createResponse();

  service.handleKnowledgeRoute({}, missing, route("/api/review/decision"), "POST", async () => ({}));
  await waitForPromises();
  service.handleKnowledgeRoute(
    {},
    saved,
    route("/api/review/decision"),
    "POST",
    async () => ({ id: "item1", status: "approved", note: "ok", unit: { text: "u" } })
  );
  await waitForPromises();

  assert.equal(missing.status, 400);
  assert.deepEqual(JSON.parse(missing.body), { error: "missing id" });
  assert.equal(saved.status, 200);
  assert.equal(calls.find((call) => call.type === "save").decisions.item1.status, "approved");
});

test("ragflow native session forwards set-cookie headers separately", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleKnowledgeRoute({}, res, route("/api/ragflow-native-session"), "GET", async () => ({}));
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(res.headers, { "Set-Cookie": ["sid=1"] });
  assert.deepEqual(JSON.parse(res.body), { ok: true, target: "native" });
});

test("ragflow config route reads and saves settings", async () => {
  const { service } = createRoutes();
  const readRes = createResponse();
  const saveRes = createResponse();

  let handled = service.handleKnowledgeRoute({}, readRes, route("/api/ragflow/config"), "GET", async () => ({}));
  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(readRes.body), { ok: true, config: { baseUrl: "http://ragflow" } });

  handled = service.handleKnowledgeRoute(
    {},
    saveRes,
    route("/api/ragflow/config"),
    "POST",
    async () => ({ baseUrl: "http://ragflow-new" })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.equal(JSON.parse(saveRes.body).config.baseUrl, "http://ragflow-new");
});

test("review export writes approved markdown below run dir", () => {
  const { runDir, service } = createRoutes();
  const res = createResponse();

  const handled = service.handleKnowledgeRoute({}, res, route("/api/review/export"), "POST", async () => ({}));
  const payload = JSON.parse(res.body);

  assert.equal(handled, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.path, path.join(runDir, "approved_ragflow_markdown", "approved_knowledge.md"));
  assert.equal(fs.readFileSync(payload.path, "utf8"), "# approved");
});

test("flowbot candidates route uses all rooms by default and forwards live flag", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleKnowledgeRoute({}, res, route("/api/flowbot/knowledge-candidates?live=1"), "GET", async () => ({}));
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    roomId: "",
    pagination: { page: 1, pageSize: 20 },
    options: { live: true, status: "" },
  });
});

test("flowbot candidates route forwards room and status filters", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleKnowledgeRoute(
    {},
    res,
    route("/api/flowbot/knowledge-candidates?roomId=room-2&status=needs_review&page=2&pageSize=10"),
    "GET",
    async () => ({})
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    roomId: "room-2",
    pagination: { page: 2, pageSize: 10 },
    options: { live: false, status: "needs_review" },
  });
});

test("flowbot approve imports unified entry to RAGFlow and marks candidate published", async () => {
  const { calls, service } = createRoutes({
    proxyFlowbotCandidateAction: async (payload) => {
      calls.push({ type: "flowbotAction", payload });
      return { ok: true, action: payload.action, status: payload.status };
    },
    importRagflowEntries: async (entries, options) => {
      calls.push({ type: "importEntries", entries, options });
      return { ok: true, document_ids: ["doc-1"] };
    },
  });
  const res = createResponse();

  const handled = service.handleKnowledgeRoute(
    {},
    res,
    route("/api/flowbot/knowledge-candidates/action"),
    "POST",
    async () => ({
      candidateId: "cand-1",
      action: "approve",
      title: "群知识",
      scope: "客服群",
      user_questions: ["怎么处理"],
      solution: "最终答案",
      tags: ["登录", "后台"],
      evidence: ["原始证据"],
      roomName: "客服群",
    })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.equal(JSON.parse(res.body).ok, true);
  const importCall = calls.find((call) => call.type === "importEntries");
  assert.equal(importCall.entries[0].title, "群知识");
  assert.equal(importCall.entries[0].final_content, "最终答案");
  assert.equal(importCall.entries[0].source_kind, "flowbot");
  assert.deepEqual(importCall.entries[0].user_questions, ["怎么处理"]);
  assert.deepEqual(importCall.entries[0].tags, ["登录", "后台"]);
  const saveCall = calls.find((call) => call.type === "flowbotAction");
  assert.equal(saveCall.payload.action, "save");
  assert.equal(saveCall.payload.status, "published");
  assert.equal(saveCall.payload.publishedTarget, "ragflow");
});

test("flowbot approve does not mark published when RAGFlow import fails", async () => {
  const { calls, service } = createRoutes({
    proxyFlowbotCandidateAction: async (payload) => {
      calls.push({ type: "flowbotAction", payload });
      return { ok: true };
    },
    importRagflowEntries: async () => ({ ok: false, error: "缺少 RAGFlow dataset_id。" }),
  });
  const res = createResponse();

  const handled = service.handleKnowledgeRoute(
    {},
    res,
    route("/api/flowbot/knowledge-candidates/action"),
    "POST",
    async () => ({
      candidateId: "cand-1",
      action: "approve",
      title: "群知识",
      solution: "最终答案",
    })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body).error, /dataset_id/);
  assert.equal(calls.some((call) => call.type === "flowbotAction"), false);
});

test("unmatched route is not handled", () => {
  const { service } = createRoutes();

  assert.equal(
    service.handleKnowledgeRoute({}, createResponse(), route("/api/other"), "GET", async () => ({})),
    false
  );
});
