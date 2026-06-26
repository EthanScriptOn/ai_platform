"use strict";

function parseTimeMs(value) {
  const timestamp = Date.parse(String(value || "").trim());
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeStringField(input, fallback = "") {
  const value = String(input || "").trim();
  return value || String(fallback || "").trim();
}

function normalizeArrayField(input, fallback = []) {
  if (Array.isArray(input)) {
    return input;
  }
  return Array.isArray(fallback) ? fallback : [];
}

function normalizeNumericField(body, key, fallback = 0) {
  if (!hasOwn(body, key)) {
    return Number(fallback || 0) || 0;
  }
  const numeric = Number(body[key] || 0);
  return Number.isFinite(numeric) ? numeric : Number(fallback || 0) || 0;
}

function requeueStaleClaimedTasks(tasks, options = {}) {
  const sourceTasks = tasks && typeof tasks === "object" ? tasks : {};
  const timeoutMs = Math.max(30 * 1000, Number(options.timeoutMs || 0) || 0);
  const nowMs = Number(options.nowMs || Date.now());
  const nowIso = String(options.nowIso || new Date(nowMs).toISOString()).trim();
  let changed = false;
  const reclaimedTaskIds = [];
  const nextTasks = {};

  for (const [taskId, task] of Object.entries(sourceTasks)) {
    if (!task || typeof task !== "object") {
      continue;
    }
    if (String(task.status || "").trim() !== "claimed") {
      nextTasks[taskId] = task;
      continue;
    }
    const claimedAtMs = parseTimeMs(task.claimedAt);
    if (!Number.isFinite(claimedAtMs) || (nowMs - claimedAtMs) < timeoutMs) {
      nextTasks[taskId] = task;
      continue;
    }
    changed = true;
    reclaimedTaskIds.push(taskId);
    nextTasks[taskId] = {
      ...task,
      status: "pending",
      handler: "",
      claimedAt: "",
      note: "claim_timeout_requeued",
      updatedAt: nowIso,
    };
  }

  return {
    changed,
    reclaimedTaskIds,
    tasks: changed ? nextTasks : sourceTasks,
  };
}

function buildAckTaskPatch(existingTask, body, nowIso = new Date().toISOString()) {
  const currentTask = existingTask && typeof existingTask === "object" ? existingTask : {};
  const payload = body && typeof body === "object" ? body : {};
  const status = normalizeStringField(payload.status, "completed") || "completed";
  const toolNames = Array.isArray(payload.toolNames)
    ? payload.toolNames.map((item) => String(item || "").trim()).filter(Boolean)
    : normalizeArrayField(currentTask.toolNames, []);
  const toolCalls = Array.isArray(payload.toolCalls)
    ? payload.toolCalls
    : normalizeArrayField(currentTask.toolCalls, []);

  const completedAt = ["completed", "ignored", "failed"].includes(status)
    ? normalizeStringField(payload.completedAt, currentTask.completedAt || nowIso)
    : "";

  return {
    taskId: normalizeStringField(payload.taskId, currentTask.taskId),
    status,
    handler: normalizeStringField(payload.handler, currentTask.handler),
    note: normalizeStringField(payload.note, currentTask.note),
    responseSummary: normalizeStringField(payload.responseSummary, currentTask.responseSummary),
    agentStartedAt: normalizeStringField(payload.agentStartedAt, currentTask.agentStartedAt),
    agentFinishedAt: normalizeStringField(payload.agentFinishedAt, currentTask.agentFinishedAt),
    replySentAt: normalizeStringField(payload.replySentAt, currentTask.replySentAt),
    llmSteps: normalizeNumericField(payload, "llmSteps", currentTask.llmSteps),
    toolCallCount: normalizeNumericField(payload, "toolCallCount", currentTask.toolCallCount),
    toolNames,
    toolCalls,
    completedAt,
  };
}

module.exports = {
  buildAckTaskPatch,
  parseTimeMs,
  requeueStaleClaimedTasks,
};
