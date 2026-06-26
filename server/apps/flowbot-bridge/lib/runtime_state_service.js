"use strict";

function createRuntimeStateService({
  AGENT_RUNTIME_ID,
  AGENT_SESSION_KEY_STRATEGY,
  AGENT_TASK_CLAIM_TIMEOUT_MS,
  AGENT_TASK_STATE_PATH,
  KNOWLEDGE_HARVEST_STATE_PATH,
  MESSAGE_POOL_STATE_PATH,
  buildAgentSessionBinding,
  buildLlmReadyMessage,
  compareTimeDesc,
  hashText,
  readJsonFile,
  requeueStaleClaimedTasks,
  writeJsonFile,
}) {
  function readMessagePoolState() {
    const state = readJsonFile(MESSAGE_POOL_STATE_PATH, { version: 1, messages: {} });
    if (!state || typeof state !== "object") {
      return { version: 1, messages: {} };
    }
    if (!state.messages || typeof state.messages !== "object") {
      state.messages = {};
    }
    return state;
  }
  
  function writeMessagePoolState(state) {
    writeJsonFile(MESSAGE_POOL_STATE_PATH, state);
  }
  
  function readAgentTaskState() {
    const state = readJsonFile(AGENT_TASK_STATE_PATH, { version: 1, tasks: {}, traceToTaskId: {} });
    if (!state || typeof state !== "object") {
      return { version: 1, tasks: {}, traceToTaskId: {} };
    }
    if (!state.tasks || typeof state.tasks !== "object") {
      state.tasks = {};
    }
    if (!state.traceToTaskId || typeof state.traceToTaskId !== "object") {
      state.traceToTaskId = {};
    }
    return state;
  }
  
  function writeAgentTaskState(state) {
    writeJsonFile(AGENT_TASK_STATE_PATH, state);
  }
  
  function readKnowledgeHarvestState() {
    const state = readJsonFile(KNOWLEDGE_HARVEST_STATE_PATH, { version: 1, messages: {}, candidates: {} });
    if (!state || typeof state !== "object") {
      return { version: 1, messages: {}, candidates: {} };
    }
    if (!state.messages || typeof state.messages !== "object") {
      state.messages = {};
    }
    if (!state.candidates || typeof state.candidates !== "object") {
      state.candidates = {};
    }
    return state;
  }
  
  function writeKnowledgeHarvestState(state) {
    writeJsonFile(KNOWLEDGE_HARVEST_STATE_PATH, state);
  }
  
  function patchKnowledgeHarvestMessages(updates) {
    if (!Array.isArray(updates) || !updates.length) {
      return;
    }
    const state = readKnowledgeHarvestState();
    const now = new Date().toISOString();
    for (const update of updates) {
      const traceId = String(update?.traceId || "").trim();
      if (!traceId) {
        continue;
      }
      const existing = state.messages[traceId] || { traceId, createdAt: now };
      state.messages[traceId] = {
        ...existing,
        ...update,
        updatedAt: now,
      };
    }
    writeKnowledgeHarvestState(state);
  }
  
  function upsertKnowledgeCandidateIndex(candidate) {
    const candidateId = String(candidate?.candidateId || candidate?.candidate_id || "").trim();
    if (!candidateId) {
      return;
    }
    const state = readKnowledgeHarvestState();
    state.candidates[candidateId] = {
      ...(state.candidates[candidateId] || {}),
      candidateId,
      status: String(candidate?.status || state.candidates[candidateId]?.status || "pending_review"),
      roomId: String(candidate?.roomId || candidate?.room_id || state.candidates[candidateId]?.roomId || "").trim(),
      traceIds: Array.isArray(candidate?.traceIds)
        ? candidate.traceIds
        : (Array.isArray(candidate?.trace_ids) ? candidate.trace_ids : (state.candidates[candidateId]?.traceIds || [])),
      title: String(candidate?.title || state.candidates[candidateId]?.title || "").trim(),
      updatedAt: new Date().toISOString(),
    };
    writeKnowledgeHarvestState(state);
  }
  
  function upsertMessagePoolEntry(message, extra = {}) {
    const traceId = String(message?.traceId || "").trim();
    if (!traceId) {
      return null;
    }
    const state = readMessagePoolState();
    const existing = state.messages[traceId] || {};
    const next = {
      traceId,
      roomId: String(message?.roomId || "").trim(),
      roomName: String(message?.roomName || message?.roomId || "").trim(),
      senderName: String(message?.senderName || message?.senderId || "").trim(),
      senderId: String(message?.senderId || "").trim(),
      msgType: Number(message?.msgType || 0),
      msgTypeName: String(message?.msgTypeName || "").trim(),
      contentPreview: String(message?.content || "").trim().slice(0, 160),
      receivedAt: String(message?.receivedAt || new Date().toISOString()).trim(),
      sendTimeIso: String(message?.sendTimeIso || message?.receivedAt || new Date().toISOString()).trim(),
      status: "pending",
      attempts: 0,
      createdAt: String(existing.createdAt || message?.receivedAt || new Date().toISOString()).trim(),
      updatedAt: new Date().toISOString(),
      ...existing,
      ...extra,
    };
    state.messages[traceId] = next;
    writeMessagePoolState(state);
    return next;
  }
  
  function buildAgentTaskId(message) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `AGENT-${stamp}-${hashText(String(message?.traceId || Math.random())).slice(0, 6)}`;
  }
  
  function upsertAgentTask(message, route, extra = {}) {
    const traceId = String(message?.traceId || "").trim();
    if (!traceId) {
      return null;
    }
    const state = readAgentTaskState();
    const existingTaskId = String(state.traceToTaskId?.[traceId] || "").trim();
    const llmReady = buildLlmReadyMessage(message);
    const sessionBinding = buildAgentSessionBinding(message, {
      agentId: AGENT_RUNTIME_ID,
      strategy: AGENT_SESSION_KEY_STRATEGY,
    });
    const taskId = existingTaskId || buildAgentTaskId(message);
    const existing = state.tasks[taskId] || {};
    const next = {
      taskId,
      traceId,
      guid: String(message?.guid || "").trim(),
      rawRoomId: String(message?.rawRoomId || message?.roomId || "").trim(),
      roomId: String(message?.roomId || "").trim(),
      roomName: String(message?.roomName || message?.roomId || "").trim(),
      senderName: String(message?.senderName || message?.senderId || "").trim(),
      senderId: String(message?.senderId || "").trim(),
      sendTimeIso: String(message?.sendTimeIso || message?.receivedAt || new Date().toISOString()).trim(),
      receivedAt: String(message?.receivedAt || new Date().toISOString()).trim(),
      status: "pending",
      routeMode: String(route?.routeMode || "archive_only"),
      routeReason: String(route?.routeReason || ""),
      matchedAgentNames: Array.isArray(route?.matchedAgentNames) ? route.matchedAgentNames : [],
      contentPreview: String(llmReady?.content || message?.content || "").trim().slice(0, 200),
      llmReadyMessage: llmReady,
      agentId: sessionBinding.agentId,
      agentSessionKey: sessionBinding.sessionKey,
      agentSessionStrategy: sessionBinding.strategy,
      agentSessionBinding: sessionBinding,
      createdAt: String(existing.createdAt || new Date().toISOString()).trim(),
      updatedAt: new Date().toISOString(),
      ...existing,
      ...extra,
    };
    state.tasks[taskId] = next;
    state.traceToTaskId[traceId] = taskId;
    writeAgentTaskState(state);
    return next;
  }
  
  function patchAgentTasks(updates) {
    if (!Array.isArray(updates) || !updates.length) {
      return;
    }
    const state = readAgentTaskState();
    const now = new Date().toISOString();
    for (const update of updates) {
      const taskId = String(update?.taskId || "").trim();
      if (!taskId) {
        continue;
      }
      const existing = state.tasks[taskId] || { taskId, createdAt: now };
      state.tasks[taskId] = {
        ...existing,
        ...update,
        updatedAt: now,
      };
    }
    writeAgentTaskState(state);
  }
  
  function claimAgentTask({ taskId = "", handler = "", roomId = "", excludeRoomIds = [] } = {}) {
    const state = readAgentTaskState();
    const targetTaskId = String(taskId || "").trim();
    const targetRoomId = String(roomId || "").trim();
    const excludedRooms = new Set(
      (Array.isArray(excludeRoomIds) ? excludeRoomIds : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    );
    const nowMs = Date.now();
    const reclaimResult = requeueStaleClaimedTasks(state.tasks, {
      nowMs,
      timeoutMs: AGENT_TASK_CLAIM_TIMEOUT_MS,
    });
    if (reclaimResult.changed) {
      state.tasks = reclaimResult.tasks;
      writeAgentTaskState(state);
    }
    let candidate = null;
  
    if (targetTaskId) {
      const task = state.tasks?.[targetTaskId];
      if (
        task
        && String(task.status || "") === "pending"
        && (!targetRoomId || String(task.roomId || "") === targetRoomId)
        && !excludedRooms.has(String(task.roomId || "").trim())
      ) {
        candidate = task;
      }
    } else {
      const tasks = Object.values(state.tasks || {})
        .filter((item) => item && typeof item === "object")
        .filter((item) => String(item.status || "") === "pending")
        .filter((item) => !targetRoomId || String(item.roomId || "") === targetRoomId)
        .filter((item) => !excludedRooms.has(String(item.roomId || "").trim()))
        .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "sendTimeIso"]));
      candidate = tasks[0] || null;
    }
  
    if (!candidate) {
      return null;
    }
  
    const now = new Date().toISOString();
    const next = {
      ...candidate,
      status: "claimed",
      handler: String(handler || candidate.handler || "").trim(),
      claimedAt: now,
      updatedAt: now,
    };
    state.tasks[next.taskId] = next;
    writeAgentTaskState(state);
    return next;
  }
  
  function patchMessagePoolEntries(updates) {
    if (!Array.isArray(updates) || !updates.length) {
      return;
    }
    const state = readMessagePoolState();
    const now = new Date().toISOString();
    for (const update of updates) {
      const traceId = String(update?.traceId || "").trim();
      if (!traceId) {
        continue;
      }
      const existing = state.messages[traceId] || { traceId, createdAt: now };
      state.messages[traceId] = {
        ...existing,
        ...update,
        updatedAt: now,
      };
    }
    writeMessagePoolState(state);
  }

  return {
    buildAgentTaskId,
    claimAgentTask,
    patchAgentTasks,
    patchKnowledgeHarvestMessages,
    patchMessagePoolEntries,
    readAgentTaskState,
    readKnowledgeHarvestState,
    readMessagePoolState,
    upsertAgentTask,
    upsertKnowledgeCandidateIndex,
    upsertMessagePoolEntry,
    writeAgentTaskState,
    writeKnowledgeHarvestState,
    writeMessagePoolState,
  };
}

module.exports = { createRuntimeStateService };
