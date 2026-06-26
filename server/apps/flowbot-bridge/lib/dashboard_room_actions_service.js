"use strict";

function createDashboardRoomActionsService({
  ARCHIVE_LOG_PATH,
  BATCH_LOG_PATH,
  BATCH_READY_AGE_MS,
  DATA_DIR,
  MESSAGE_POOL_STATE_PATH,
  MESSAGE_SEARCH_INDEX_PATH,
  NORMALIZED_LOG_PATH,
  computeDashboardAgeMs,
  path,
  readAgentTaskState,
  readJsonFile,
  readKnowledgeHarvestState,
  readMessagePoolState,
  rewriteJsonlFile,
  unlinkIfExists,
  writeAgentTaskState,
  writeJsonFile,
  writeKnowledgeHarvestState,
  writeMessagePoolState,
}) {
  function compactRoomAgentState(roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) {
      throw new Error("room_id_required");
    }
    const taskState = readAgentTaskState();
    const keptTasks = {};
    const removedTaskIds = [];
    const keptTraceToTaskId = {};
    for (const [taskId, task] of Object.entries(taskState.tasks || {})) {
      const taskRoomId = String(task?.roomId || task?.rawRoomId || "").trim();
      const taskStatus = String(task?.status || "").trim();
      const shouldDrop = taskRoomId === normalizedRoomId && ["completed", "ignored", "failed"].includes(taskStatus);
      if (shouldDrop) {
        removedTaskIds.push(taskId);
        continue;
      }
      keptTasks[taskId] = task;
    }
    const removedTaskIdSet = new Set(removedTaskIds);
    for (const [traceId, mappedTaskId] of Object.entries(taskState.traceToTaskId || {})) {
      if (removedTaskIdSet.has(String(mappedTaskId || "").trim())) {
        continue;
      }
      keptTraceToTaskId[traceId] = mappedTaskId;
    }
    writeAgentTaskState({
      ...taskState,
      tasks: keptTasks,
      traceToTaskId: keptTraceToTaskId,
    });
  
    return {
      roomId: normalizedRoomId,
      removedTaskCount: removedTaskIds.length,
      removedTaskIds,
      mode: "stateless_agent_cleanup",
    };
  }
  
  function clearRoomSession(roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) {
      throw new Error("room_id_required");
    }
    const taskState = readAgentTaskState();
    const keptTasks = {};
    const removedTaskIds = [];
    const keptTraceToTaskId = {};
    for (const [taskId, task] of Object.entries(taskState.tasks || {})) {
      const taskRoomId = String(task?.roomId || task?.rawRoomId || "").trim();
      if (taskRoomId === normalizedRoomId) {
        removedTaskIds.push(taskId);
        continue;
      }
      keptTasks[taskId] = task;
    }
    const removedTaskIdSet = new Set(removedTaskIds);
    for (const [traceId, mappedTaskId] of Object.entries(taskState.traceToTaskId || {})) {
      if (removedTaskIdSet.has(String(mappedTaskId || "").trim())) {
        continue;
      }
      keptTraceToTaskId[traceId] = mappedTaskId;
    }
    writeAgentTaskState({
      ...taskState,
      tasks: keptTasks,
      traceToTaskId: keptTraceToTaskId,
    });
  
    return {
      roomId: normalizedRoomId,
      removedTaskCount: removedTaskIds.length,
      removedTaskIds,
      mode: "stateless_agent_reset",
    };
  }
  
  function clearRoomMemory(roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) {
      throw new Error("room_id_required");
    }
    const normalized = rewriteJsonlFile(
      NORMALIZED_LOG_PATH,
      (item) => String(item?.roomId || "") !== normalizedRoomId,
    );
    const searchIndex = rewriteJsonlFile(
      MESSAGE_SEARCH_INDEX_PATH,
      (item) => String(item?.roomId || "") !== normalizedRoomId,
    );
    const poolState = readJsonFile(MESSAGE_POOL_STATE_PATH, { version: 1, messages: {} });
    let poolRemoved = 0;
    const nextMessages = {};
    for (const [traceId, entry] of Object.entries(poolState.messages || {})) {
      if (String(entry?.roomId || "") === normalizedRoomId) {
        poolRemoved += 1;
        continue;
      }
      nextMessages[traceId] = entry;
    }
    writeJsonFile(MESSAGE_POOL_STATE_PATH, {
      ...poolState,
      messages: nextMessages,
    });
    return {
      roomId: normalizedRoomId,
      normalizedRemoved: normalized.removedCount,
      searchIndexRemoved: searchIndex.removedCount,
      messagePoolRemoved: poolRemoved,
    };
  }
  
  function clearRoomArchive(roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) {
      throw new Error("room_id_required");
    }
    const archiveLogs = rewriteJsonlFile(
      ARCHIVE_LOG_PATH,
      (item) => String(item?.roomId || "") !== normalizedRoomId,
    );
    const batchLogs = rewriteJsonlFile(
      BATCH_LOG_PATH,
      (item) => String(item?.roomId || "") !== normalizedRoomId,
    );
  
    const caseIndexPath = path.join(DATA_DIR, "index.json");
    const caseIndex = readJsonFile(caseIndexPath, { version: 1, cases: [] });
    const keptCases = [];
    const removedCases = [];
    for (const item of Array.isArray(caseIndex.cases) ? caseIndex.cases : []) {
      if (String(item?.chat_id || "") === normalizedRoomId) {
        removedCases.push(item);
        continue;
      }
      keptCases.push(item);
    }
    writeJsonFile(caseIndexPath, {
      ...caseIndex,
      cases: keptCases,
    });
  
    const threadIndexPath = path.join(DATA_DIR, "thread_index.json");
    const threadIndex = readJsonFile(threadIndexPath, { version: 1, threads: [] });
    const keptThreads = [];
    let removedThreadCount = 0;
    for (const item of Array.isArray(threadIndex.threads) ? threadIndex.threads : []) {
      if (String(item?.chat_id || item?.roomId || "") === normalizedRoomId) {
        removedThreadCount += 1;
        continue;
      }
      keptThreads.push(item);
    }
    writeJsonFile(threadIndexPath, {
      ...threadIndex,
      threads: keptThreads,
    });
  
    let removedArtifactCount = 0;
    for (const item of removedCases) {
      const paths = item?.paths || {};
      if (unlinkIfExists(paths.json)) {
        removedArtifactCount += 1;
      }
      if (unlinkIfExists(paths.conversation_json)) {
        removedArtifactCount += 1;
      }
    }
  
    return {
      roomId: normalizedRoomId,
      archiveLogRemoved: archiveLogs.removedCount,
      batchLogRemoved: batchLogs.removedCount,
      caseRemoved: removedCases.length,
      threadRemoved: removedThreadCount,
      artifactRemoved: removedArtifactCount,
    };
  }
  
  function cleanupDashboardNoise(roomId = "") {
    const normalizedRoomId = String(roomId || "").trim();
    const scopeAll = !normalizedRoomId || normalizedRoomId === "__all__";
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const staleAgentMs = 10 * 60 * 1000;
    const stalePoolMs = Math.max(10 * 60 * 1000, BATCH_READY_AGE_MS * 4);
  
    const taskState = readAgentTaskState();
    const keptTasks = {};
    const removedTaskIds = [];
    const keptTraceToTaskId = {};
    for (const [taskId, task] of Object.entries(taskState.tasks || {})) {
      const taskRoomId = String(task?.roomId || task?.rawRoomId || "").trim();
      const taskStatus = String(task?.status || "").trim();
      const taskAgeMs = computeDashboardAgeMs(task?.updatedAt || task?.completedAt || task?.replySentAt || task?.claimedAt || task?.sendTimeIso, nowMs);
      const inScope = scopeAll || taskRoomId === normalizedRoomId;
      const shouldRemove = inScope && (
        ["completed", "ignored", "failed"].includes(taskStatus)
        || (["pending", "claimed", "replied"].includes(taskStatus) && Number.isFinite(taskAgeMs) && taskAgeMs >= staleAgentMs)
      );
      if (shouldRemove) {
        removedTaskIds.push(taskId);
        continue;
      }
      keptTasks[taskId] = task;
    }
    const removedTaskIdSet = new Set(removedTaskIds);
    for (const [traceId, mappedTaskId] of Object.entries(taskState.traceToTaskId || {})) {
      if (removedTaskIdSet.has(String(mappedTaskId || "").trim())) {
        continue;
      }
      keptTraceToTaskId[traceId] = mappedTaskId;
    }
    writeAgentTaskState({
      ...taskState,
      tasks: keptTasks,
      traceToTaskId: keptTraceToTaskId,
    });
  
    const poolState = readMessagePoolState();
    let poolClosed = 0;
    const nextMessages = {};
    for (const [traceId, entry] of Object.entries(poolState.messages || {})) {
      const entryRoomId = String(entry?.roomId || "").trim();
      const entryStatus = String(entry?.status || "").trim();
      const entryAgeMs = computeDashboardAgeMs(entry?.updatedAt || entry?.sendTimeIso || entry?.receivedAt, nowMs);
      const inScope = scopeAll || entryRoomId === normalizedRoomId;
      if (inScope && ["pending", "processing"].includes(entryStatus) && Number.isFinite(entryAgeMs) && entryAgeMs >= stalePoolMs) {
        poolClosed += 1;
        nextMessages[traceId] = {
          ...entry,
          status: "ignored",
          lastError: "",
          lastErrorDetail: "",
          cleanupReason: "dashboard_noise_cleanup",
          cleanedAt: now,
          updatedAt: now,
        };
        continue;
      }
      nextMessages[traceId] = entry;
    }
    writeMessagePoolState({
      ...poolState,
      messages: nextMessages,
    });
  
    const harvestState = readKnowledgeHarvestState();
    let harvestClosed = 0;
    const nextHarvestMessages = {};
    for (const [traceId, entry] of Object.entries(harvestState.messages || {})) {
      const entryRoomId = String(entry?.roomId || "").trim();
      const entryStatus = String(entry?.status || "").trim();
      const inScope = scopeAll || entryRoomId === normalizedRoomId;
      if (inScope && entryStatus === "failed") {
        harvestClosed += 1;
        nextHarvestMessages[traceId] = {
          ...entry,
          status: "ignored",
          cleanupReason: "dashboard_noise_cleanup",
          cleanedAt: now,
          updatedAt: now,
        };
        continue;
      }
      nextHarvestMessages[traceId] = entry;
    }
    writeKnowledgeHarvestState({
      ...harvestState,
      messages: nextHarvestMessages,
    });
  
    return {
      roomId: scopeAll ? "__all__" : normalizedRoomId,
      scope: scopeAll ? "all" : "room",
      removedAgentTaskCount: removedTaskIds.length,
      removedAgentTaskIds: removedTaskIds,
      closedMessagePoolCount: poolClosed,
      closedKnowledgeHarvestFailureCount: harvestClosed,
      mode: "dashboard_noise_cleanup",
    };
  }

  return {
    cleanupDashboardNoise,
    clearRoomArchive,
    clearRoomMemory,
    clearRoomSession,
    compactRoomAgentState,
  };
}

module.exports = { createDashboardRoomActionsService };
