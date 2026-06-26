"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFlowbotCandidatesService } = require("./flowbot_candidates_service");

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function createService(fetchImpl = async () => response({ ok: true })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-candidates-test-"));
  return {
    candidatesPath: path.join(dir, "candidates.jsonl"),
    dir,
    service: createFlowbotCandidatesService({
      DEFAULT_ROOM_ID: "room-1",
      FLOWBOT_BASE_URL: "http://flowbot.test",
      FLOWBOT_CANDIDATES_PATH: path.join(dir, "candidates.jsonl"),
      fetchImpl,
    }),
  };
}

test("buildCandidateProgress counts candidate statuses and accepts dashboard totals", () => {
  const { service } = createService();

  assert.deepEqual(
    service.buildCandidateProgress([
      { status: "pending_review" },
      { status: "approved" },
      { status: "rejected" },
    ]),
    { pending: 1, published: 1, rejected: 1 }
  );
  assert.deepEqual(
    service.buildCandidateProgress([], {
      knowledgePendingReviewTotal: 2,
      knowledgePublishedTotal: 3,
      knowledgeRejectedTotal: 4,
    }),
    { pending: 2, published: 3, rejected: 4 }
  );
});

test("proxyFlowbotKnowledgeCandidates returns historical candidates before live proxy", async () => {
  const { candidatesPath, service } = createService(async () => {
    throw new Error("fetch should not be called when historical candidates exist");
  });
  fs.writeFileSync(
    candidatesPath,
    [
      JSON.stringify({ candidateId: "old", roomId: "room-1", status: "published", updatedAt: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ candidateId: "new", roomId: "room-1", status: "pending_review", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ].join("\n"),
    "utf8"
  );

  const data = await service.proxyFlowbotKnowledgeCandidates("room-1", { page: 1, pageSize: 1 });

  assert.equal(data.historical, true);
  assert.equal(data.candidates[0].candidateId, "new");
  assert.deepEqual(data.progress, { pending: 1, published: 1, rejected: 0 });
  assert.deepEqual(data.pagination, { page: 1, pageSize: 1, total: 2, totalPages: 2 });
});

test("proxyFlowbotKnowledgeCandidates filters candidates by review status", async () => {
  const { candidatesPath, service } = createService(async () => {
    throw new Error("fetch should not be called when matched historical candidates exist");
  });
  fs.writeFileSync(
    candidatesPath,
    [
      JSON.stringify({ candidateId: "done", roomId: "room-1", status: "published", updatedAt: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ candidateId: "todo", roomId: "room-1", status: "pending_review", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ].join("\n"),
    "utf8"
  );

  const data = await service.proxyFlowbotKnowledgeCandidates(
    "room-1",
    { page: 1, pageSize: 20 },
    { status: "needs_review" }
  );

  assert.deepEqual(data.candidates.map((item) => item.candidateId), ["todo"]);
  assert.deepEqual(data.pagination, { page: 1, pageSize: 20, total: 1, totalPages: 1 });
});

test("live proxy returns an empty candidate page when no remote or historical data exists", async () => {
  const { service } = createService(async () =>
    response({
      ok: true,
      candidates: [],
    })
  );

  const data = await service.proxyFlowbotKnowledgeCandidates("room-1", { page: 1, pageSize: 20 }, { live: true });

  assert.equal(data.live, true);
  assert.deepEqual(data.candidates, []);
  assert.deepEqual(data.progress, { pending: 0, published: 0, rejected: 0 });
  assert.deepEqual(data.pagination, { page: 1, pageSize: 20, total: 0, totalPages: 1 });
});

test("live proxy uses flowbot candidate api and forwards remote actions", async () => {
  const calls = [];
  const { service } = createService(async (url, options = {}) => {
    calls.push({ url, options });
    if (!options.method && url.includes("/flowbot/agent/knowledge-candidates")) {
      return response({
        ok: true,
        candidates: [{ candidateId: "real-1", roomId: "room-2", status: "published" }],
      });
    }
    return response({ ok: true, candidateId: "real-1" });
  });

  const data = await service.proxyFlowbotKnowledgeCandidates(
    "room-2",
    { page: 1, pageSize: 80 },
    { live: true, status: "imported" }
  );
  const action = await service.proxyFlowbotCandidateAction({ candidateId: "real-1", action: "approve" });

  assert.equal(data.candidates[0].candidateId, "real-1");
  assert.deepEqual(data.progress, { pending: 0, published: 1, rejected: 0 });
  assert.equal(calls[0].url, "http://flowbot.test/flowbot/agent/knowledge-candidates?limit=80&roomId=room-2&status=published");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(action, { ok: true, candidateId: "real-1" });
});
