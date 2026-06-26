"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGroupIntentRoutes } = require("./group_intent_routes");

function waitForPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createResponse() {
  return {
    body: null,
    destroyed: false,
    headersSent: false,
    status: null,
    chunks: [],
    end(body) {
      this.body = body;
      this.ended = true;
    },
    write(chunk) {
      this.chunks.push(chunk);
    },
  };
}

function createRoutes(overrides = {}) {
  const calls = [];
  const service = createGroupIntentRoutes({
    buildGroupIntentSampleInputWithQwen: async () => ({ samples: [] }),
    createGroupIntentAutoTrainJob: async (payload) => ({ id: "job-new", ...payload }),
    labelGroupIntentWithQwen: async (input) => ({ label: `label:${input}` }),
    listGroupIntentDomainTypes: () => ["shopping"],
    loadGroupIntentAutoTrainJobs: () => [
      { id: "old", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "new", createdAt: "2026-01-02T00:00:00.000Z" },
    ],
    predictGroupIntent: async (input) => ({ label: `predict:${input}` }),
    sendJson(res, payload, status = 200) {
      calls.push({ payload, status });
      res.status = status;
      res.body = JSON.stringify(payload);
    },
    streamGroupIntentSampleInputWithQwen: async () => {},
    trainGroupIntentFastText: async () => ({ ok: true }),
    ...overrides,
  });
  return { calls, service };
}

function route(pathname) {
  return new URL(pathname, "http://localhost");
}

test("domain types route responds synchronously", () => {
  const { service } = createRoutes({ listGroupIntentDomainTypes: () => ["pet", "shopping"] });
  const res = createResponse();

  const handled = service.handleGroupIntentRoute({}, res, route("/api/group-intent/domain-types"), "GET", async () => ({}));

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), { ok: true, items: ["pet", "shopping"] });
});

test("qwen label route reads payload and wraps service data", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handleGroupIntentRoute(
    {},
    res,
    route("/api/group-intent/qwen-label"),
    "POST",
    async () => ({ input: "hello" })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), { ok: true, label: "label:hello" });
});

test("auto train job detail returns 404 when missing", () => {
  const { service } = createRoutes({ loadGroupIntentAutoTrainJobs: () => [] });
  const res = createResponse();

  const handled = service.handleGroupIntentRoute(
    {},
    res,
    route("/api/group-intent/auto-train-jobs/missing"),
    "GET",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "任务不存在" });
});

test("stream route writes SSE error after headers are sent", async () => {
  const { service } = createRoutes({
    streamGroupIntentSampleInputWithQwen: async () => {
      throw new Error("stream failed");
    },
  });
  const res = createResponse();
  res.headersSent = true;

  const handled = service.handleGroupIntentRoute(
    {},
    res,
    route("/api/group-intent/qwen-samples/stream"),
    "POST",
    async () => ({ count: 1 })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.equal(res.chunks[0], `data: ${JSON.stringify({ type: "error", error: "stream failed" })}\n\n`);
  assert.equal(res.ended, true);
});

test("unmatched path is not handled", () => {
  const { service } = createRoutes();

  assert.equal(
    service.handleGroupIntentRoute({}, createResponse(), route("/api/other"), "GET", async () => ({})),
    false
  );
});
