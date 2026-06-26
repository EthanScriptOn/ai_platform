"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAckTaskPatch,
  requeueStaleClaimedTasks,
} = require("./agent_task_state");

test("requeueStaleClaimedTasks only requeues stale claimed tasks", () => {
  const result = requeueStaleClaimedTasks(
    {
      stale: {
        taskId: "stale",
        status: "claimed",
        handler: "worker-a",
        claimedAt: "2026-04-30T10:00:00.000Z",
      },
      fresh: {
        taskId: "fresh",
        status: "claimed",
        handler: "worker-b",
        claimedAt: "2026-04-30T10:02:30.000Z",
      },
      pending: {
        taskId: "pending",
        status: "pending",
      },
    },
    {
      nowIso: "2026-04-30T10:04:00.000Z",
      nowMs: Date.parse("2026-04-30T10:04:00.000Z"),
      timeoutMs: 3 * 60 * 1000,
    },
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.reclaimedTaskIds, ["stale"]);
  assert.equal(result.tasks.stale.status, "pending");
  assert.equal(result.tasks.stale.handler, "");
  assert.equal(result.tasks.stale.claimedAt, "");
  assert.equal(result.tasks.stale.note, "claim_timeout_requeued");
  assert.equal(result.tasks.fresh.status, "claimed");
  assert.equal(result.tasks.pending.status, "pending");
});

test("buildAckTaskPatch preserves reply fields when ack omits them", () => {
  const patch = buildAckTaskPatch(
    {
      taskId: "AGENT-1",
      status: "replied",
      responseSummary: "旧回复摘要",
      replySentAt: "2026-04-30T10:00:10.000Z",
      toolNames: ["search_knowledge"],
      toolCalls: [{ name: "search_knowledge", args: { query: "云发单" } }],
      llmSteps: 2,
      toolCallCount: 1,
    },
    {
      taskId: "AGENT-1",
      status: "completed",
      note: "light_agent_sent_reply",
      agentStartedAt: "2026-04-30T10:00:01.000Z",
      agentFinishedAt: "2026-04-30T10:00:09.000Z",
    },
    "2026-04-30T10:00:12.000Z",
  );

  assert.equal(patch.taskId, "AGENT-1");
  assert.equal(patch.status, "completed");
  assert.equal(patch.responseSummary, "旧回复摘要");
  assert.equal(patch.replySentAt, "2026-04-30T10:00:10.000Z");
  assert.deepEqual(patch.toolNames, ["search_knowledge"]);
  assert.equal(patch.llmSteps, 2);
  assert.equal(patch.toolCallCount, 1);
  assert.equal(patch.completedAt, "2026-04-30T10:00:12.000Z");
});
