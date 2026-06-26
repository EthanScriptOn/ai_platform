"use strict";

function createDashboardDataService({
  ACCEPT_NOTIFY_TYPES,
  AGENT_LANE_ENABLED,
  AGENT_SESSION_KEY_STRATEGY,
  AGENT_TASK_STATE_PATH,
  AGENT_WAKE_NAMES,
  ARCHIVE_ENABLED,
  ARCHIVE_LOG_PATH,
  ARCHIVE_MODE,
  BATCH_LOG_PATH,
  BATCH_MAX_PENDING_PER_ROOM,
  BATCH_MODE_ENABLED,
  BATCH_READY_AGE_MS,
  BATCH_SCAN_INTERVAL_MS,
  CASE_ARCHIVE_NOTIFY_ENABLED,
  DATA_DIR,
  DASHBOARD_DEFAULT_LIMIT,
  DASHBOARD_MAX_LIMIT,
  FEISHU_TARGET_CHAT_IDS,
  FILTER_LOG_PATH,
  KNOWLEDGE_CANDIDATES_PATH,
  KNOWLEDGE_HARVEST_ENABLED,
  KNOWLEDGE_HARVEST_MAX_PER_SCAN,
  KNOWLEDGE_HARVEST_READY_AGE_MS,
  KNOWLEDGE_HARVEST_ROOM_IDS,
  KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
  KNOWLEDGE_HARVEST_STATE_PATH,
  KNOWLEDGE_PUBLISH_LOG_PATH,
  LLM_CLASSIFY_ENABLED,
  LLM_MODEL,
  LOG_PATH,
  MESSAGE_POOL_STATE_PATH,
  MSG_TYPE_NAMES,
  NORMALIZED_LOG_PATH,
  ROUTING_LOG_PATH,
  SUPPORTED_MSG_TYPES,
  TARGET_ROOM_IDS,
  TRANSCRIBE_ENABLED,
  TRANSCRIBE_MODEL,
  buildAttentionItem,
  buildAvailableRooms,
  buildCountBreakdown,
  buildSimpleCountBreakdown,
  buildTraceId,
  compareTimeDesc,
  computeDashboardAgeMs,
  computeLatencyPartMs,
  computeTaskDurationMs,
  dashboardDataCache,
  dedupeMessageEventsByTraceId,
  filterItemsByRoom,
  getItemRoomId,
  getItemRoomName,
  getLocalFileVersion,
  mysqlRuntimeStore,
  normalizeMsgTypeLabel,
  normalizePriority,
  parseArchiveStdout,
  path,
  readAgentTaskState,
  readCaseArtifacts,
  readJsonFile,
  readJsonlFile,
  readKnowledgeHarvestState,
  readMessagePoolState,
  summarizeAgentTaskForDashboard,
  summarizeAgentTaskStatus,
  summarizePoolStatus,
  summarizeReason,
  summarizeThreadReason,
  toIsoTime,
}) {
  function normalizeDashboardMessageItem(item) {
    if (!item || typeof item !== "object") {
      return item;
    }
    const mediaLocalPath = String(item.mediaLocalPath || item.media_local_path || "").trim();
    const mediaLocalUrl = String(item.mediaLocalUrl || item.media_local_url || "").trim();
    const inferredMediaLocalUrl = mediaLocalPath
      ? `/flowbot/media/${encodeURIComponent(path.basename(mediaLocalPath))}`
      : "";
    return {
      ...item,
      msgTypeName: normalizeMsgTypeLabel(item.msgTypeName, item.msgType),
      mediaLocalUrl: mediaLocalUrl || inferredMediaLocalUrl,
    };
  }
  
  function normalizePriorityItem(item) {
    if (!item || typeof item !== "object") {
      return item;
    }
    const result = { ...item };
    if (Object.prototype.hasOwnProperty.call(result, "priority")) {
      const raw = String(result.priority || "").trim();
      if (raw) {
        result.priority = normalizePriority(raw, "P2");
      }
    }
    return result;
  }
  
  const DASHBOARD_REPORT_TIMEZONE_OFFSET_MINUTES = 8 * 60;
  
  function getDashboardLocalDateKey(value, offsetMinutes = DASHBOARD_REPORT_TIMEZONE_OFFSET_MINUTES) {
    const ts = value == null ? Date.now() : Date.parse(String(value || ""));
    if (!Number.isFinite(ts)) {
      return "";
    }
    return new Date(ts + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
  }
  
  function getDashboardRelativeDateKey(dayOffset = -1, nowMs = Date.now()) {
    const shifted = nowMs + (DASHBOARD_REPORT_TIMEZONE_OFFSET_MINUTES * 60 * 1000) + (dayOffset * 24 * 60 * 60 * 1000);
    return new Date(shifted).toISOString().slice(0, 10);
  }
  
  function itemMatchesDashboardDate(item, dateKey, fields) {
    return fields.some((field) => getDashboardLocalDateKey(item?.[field]) === dateKey);
  }
  
  function countItemsOnDashboardDate(items, dateKey, fields, predicate = null) {
    return (Array.isArray(items) ? items : []).filter((item) => {
      if (predicate && !predicate(item)) {
        return false;
      }
      return itemMatchesDashboardDate(item, dateKey, fields);
    }).length;
  }
  
  function buildDailySummary({
    dateKey = getDashboardRelativeDateKey(-1),
    scope,
    callbackEvents = [],
    filterEvents = [],
    normalizedEvents = [],
    archiveEvents = [],
    cases = [],
    knowledgeCandidates = [],
    knowledgePublishEvents = [],
    agentTasks = [],
  } = {}) {
    const acceptedMessages = countItemsOnDashboardDate(filterEvents, dateKey, ["receivedAt", "sendTimeIso"], (item) => item.accepted);
    const rejectedMessages = countItemsOnDashboardDate(filterEvents, dateKey, ["receivedAt", "sendTimeIso"], (item) => !item.accepted);
    const normalizedMessages = countItemsOnDashboardDate(normalizedEvents, dateKey, ["receivedAt", "sendTimeIso"]);
    const callbackMessages = countItemsOnDashboardDate(callbackEvents, dateKey, ["receivedAt"], (item) => {
      const payload = item?.jsonBody || {};
      const data = payload?.data || {};
      return Boolean(data?.roomid || data?.chat_id || data?.id || payload?.event);
    });
    const newCases = countItemsOnDashboardDate(cases, dateKey, ["created_at", "updated_at"]);
    const archivedEvents = countItemsOnDashboardDate(archiveEvents, dateKey, ["receivedAt", "processedAt", "updatedAt"], (item) => Boolean(item.archived));
    const nonCaseEvents = countItemsOnDashboardDate(archiveEvents, dateKey, ["receivedAt", "processedAt", "updatedAt"], (item) => !item.archived);
    const candidateCreated = countItemsOnDashboardDate(knowledgeCandidates, dateKey, ["createdAt", "updatedAt"]);
    const candidatePendingNow = knowledgeCandidates.filter((item) => String(item?.status || "") === "pending_review").length;
    const knowledgePublished = countItemsOnDashboardDate(knowledgePublishEvents, dateKey, ["receivedAt"], (item) => String(item?.status || "") === "published");
    const knowledgeUpdated = countItemsOnDashboardDate(knowledgePublishEvents, dateKey, ["receivedAt"], (item) => String(item?.status || "") === "updated_existing");
    const knowledgeRejected = countItemsOnDashboardDate(knowledgePublishEvents, dateKey, ["receivedAt"], (item) => String(item?.status || "") === "rejected");
    const agentCompleted = countItemsOnDashboardDate(agentTasks, dateKey, ["completedAt", "updatedAt"], (item) => String(item?.status || "") === "completed");
    const agentReplied = countItemsOnDashboardDate(agentTasks, dateKey, ["replySentAt", "updatedAt"], (item) => String(item?.status || "") === "replied");
    const agentFailed = countItemsOnDashboardDate(agentTasks, dateKey, ["completedAt", "updatedAt"], (item) => String(item?.status || "") === "failed");
    const agentIgnored = countItemsOnDashboardDate(agentTasks, dateKey, ["completedAt", "updatedAt"], (item) => String(item?.status || "") === "ignored");
    const agentOpened = countItemsOnDashboardDate(agentTasks, dateKey, ["sendTimeIso", "createdAt", "updatedAt"]);
    const knowledgeDecisions = knowledgePublished + knowledgeUpdated + knowledgeRejected;
    const agentFinished = agentCompleted + agentReplied + agentFailed + agentIgnored;
    const healthNotes = [];
    if (acceptedMessages && !newCases && !candidateCreated && !knowledgeDecisions) {
      healthNotes.push("有群消息进入，但昨天没有形成 Case 或知识动作");
    }
    if (candidatePendingNow) {
      healthNotes.push(`当前还有 ${candidatePendingNow} 条知识候选待审核`);
    }
    if (agentFailed) {
      healthNotes.push(`昨天有 ${agentFailed} 条 Agent 失败`);
    }
    if (!healthNotes.length) {
      healthNotes.push("昨天没有明显待处理异常");
    }
    return {
      date: dateKey,
      timezone: "Asia/Shanghai",
      scopeLabel: scope?.selectedRoomLabel || "全部群",
      messages: {
        callbacks: callbackMessages,
        accepted: acceptedMessages,
        rejected: rejectedMessages,
        normalized: normalizedMessages,
      },
      cases: {
        created: newCases,
        archivedEvents,
        nonCaseEvents,
      },
      knowledge: {
        candidatesCreated: candidateCreated,
        pendingNow: candidatePendingNow,
        published: knowledgePublished,
        updatedExisting: knowledgeUpdated,
        rejected: knowledgeRejected,
        decisions: knowledgeDecisions,
      },
      agent: {
        opened: agentOpened,
        completed: agentCompleted,
        replied: agentReplied,
        failed: agentFailed,
        ignored: agentIgnored,
        finished: agentFinished,
      },
      healthNotes,
    };
  }
  
  function buildDashboardData(limit, roomId = "") {
    const safeLimit = Math.max(1, Math.min(DASHBOARD_MAX_LIMIT, Number(limit) || DASHBOARD_DEFAULT_LIMIT));
    const selectedRoomId = String(roomId || "").trim();
    const dashboardCacheKey = `${safeLimit}:${selectedRoomId || "__all__"}`;
    let dependencyVersion = "";
    if (!mysqlRuntimeStore.isEnabled()) {
      const dashboardDependencies = [
        LOG_PATH,
        FILTER_LOG_PATH,
        ARCHIVE_LOG_PATH,
        ROUTING_LOG_PATH,
        BATCH_LOG_PATH,
        KNOWLEDGE_CANDIDATES_PATH,
        KNOWLEDGE_PUBLISH_LOG_PATH,
        NORMALIZED_LOG_PATH,
        MESSAGE_POOL_STATE_PATH,
        AGENT_TASK_STATE_PATH,
        KNOWLEDGE_HARVEST_STATE_PATH,
        path.join(DATA_DIR, "thread_index.json"),
        path.join(DATA_DIR, "index.json"),
      ];
      dependencyVersion = dashboardDependencies
        .map((filePath) => `${filePath}:${getLocalFileVersion(filePath)}`)
        .join("|");
      const cachedDashboard = dashboardDataCache.get(dashboardCacheKey);
      if (cachedDashboard && cachedDashboard.version === dependencyVersion) {
        return cachedDashboard.value;
      }
    }
    const callbackEventsAll = readJsonlFile(LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const filterEventsAll = readJsonlFile(FILTER_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const archiveEventsAll = readJsonlFile(ARCHIVE_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const routingEventsAll = readJsonlFile(ROUTING_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const batchEventsAll = readJsonlFile(BATCH_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const knowledgeCandidatesAll = readJsonlFile(KNOWLEDGE_CANDIDATES_PATH, Number.MAX_SAFE_INTEGER)
      .reverse()
      .filter((item) => item && typeof item === "object");
    const knowledgePublishEventsAll = readJsonlFile(KNOWLEDGE_PUBLISH_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse();
    const knowledgeHarvestState = readKnowledgeHarvestState();
    const poolState = readMessagePoolState();
    const agentTaskState = readAgentTaskState();
    const poolEntriesAll = Object.values(poolState.messages || {}).filter((item) => item && typeof item === "object");
    const knowledgeHarvestEntriesAll = Object.values(knowledgeHarvestState.messages || {}).filter((item) => item && typeof item === "object");
    const agentTasksAll = Object.values(agentTaskState.tasks || {}).filter((item) => item && typeof item === "object");
    const normalizedEventsAll = dedupeMessageEventsByTraceId(
      readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER).reverse().map(normalizeDashboardMessageItem),
      { prefer: "first" },
    );
    const threadIndex = readJsonFile(path.join(DATA_DIR, "thread_index.json"), { version: 1, threads: [] });
    const caseIndex = readJsonFile(path.join(DATA_DIR, "index.json"), { version: 1, cases: [] });
    const threadsAll = Array.isArray(threadIndex.threads) ? threadIndex.threads.slice().sort((a, b) => compareTimeDesc(a, b, ["updated_at", "last_message_time"])) : [];
    const casesAll = Array.isArray(caseIndex.cases) ? caseIndex.cases.slice().sort((a, b) => compareTimeDesc(a, b, ["updated_at", "last_message_time"])) : [];
    const currentWecomGuid = String(
      callbackEventsAll.find((item) => String(item?.jsonBody?.guid || "").trim())?.jsonBody?.guid
        || normalizedEventsAll.find((item) => String(item?.guid || "").trim())?.guid
        || "",
    ).trim();
    const availableRooms = buildAvailableRooms({
      callbackEvents: callbackEventsAll.map((item) => {
        const payload = item.jsonBody || {};
        const data = payload.data || {};
        return {
          guid: payload.guid || "",
          roomId: data.roomid || "",
          roomName: data.room_name || data.chat_name || data.roomid || "",
        };
      }),
      filterEvents: filterEventsAll,
      normalizedEvents: normalizedEventsAll,
      archiveEvents: archiveEventsAll,
      cases: casesAll,
      threads: threadsAll,
    });
    const availableRoomMap = new Map(availableRooms.map((item) => [item.id, item]));
    for (const item of filterEventsAll) {
      const roomId = String(item?.roomId || "").trim();
      if (!roomId || availableRoomMap.has(roomId)) {
        continue;
      }
      availableRoomMap.set(roomId, {
        id: roomId,
        name: getItemRoomName(item) || roomId,
        platform: String(item?.source || item?.platform || "").trim() || (roomId.startsWith("oc_") ? "feishu" : "wecom"),
        messageCount: 1,
        caseCount: 0,
        threadCount: 0,
      });
    }
    const roomKnowledgeCounts = new Map();
    for (const item of knowledgeCandidatesAll) {
      const roomId = String(getItemRoomId(item) || item.roomId || item.sourceMessage?.roomId || "").trim();
      if (!roomId) continue;
      const current = roomKnowledgeCounts.get(roomId) || {
        knowledgeCount: 0,
        knowledgePendingReviewTotal: 0,
      };
      current.knowledgeCount += 1;
      if (String(item.status || "") === "pending_review") {
        current.knowledgePendingReviewTotal += 1;
      }
      roomKnowledgeCounts.set(roomId, current);
    }
    const roomAttentionCounts = new Map();
    for (const task of agentTasksAll) {
      const roomId = String(getItemRoomId(task) || task.roomId || task.session?.roomId || "").trim();
      if (!roomId) continue;
      if (String(task.status || "") === "failed" || task.lastError) {
        roomAttentionCounts.set(roomId, (roomAttentionCounts.get(roomId) || 0) + 1);
      }
    }
    const availableRoomsFinal = Array.from(availableRoomMap.values()).map((room) => {
      const knowledge = roomKnowledgeCounts.get(room.id) || {};
      return {
        ...room,
        knowledgeCount: knowledge.knowledgeCount || 0,
        knowledgePendingReviewTotal: knowledge.knowledgePendingReviewTotal || 0,
        attentionCount: roomAttentionCounts.get(room.id) || 0,
      };
    }).sort((left, right) => {
      return Number(right.messageCount || 0) - Number(left.messageCount || 0)
        || Number(right.caseCount || 0) - Number(left.caseCount || 0)
        || Number(right.threadCount || 0) - Number(left.threadCount || 0)
        || left.id.localeCompare(right.id);
    });
    const scopedRoomId = selectedRoomId && availableRoomsFinal.some((item) => item.id === selectedRoomId) ? selectedRoomId : "";
    const selectedRoomLabel = scopedRoomId
      ? (availableRoomsFinal.find((item) => item.id === scopedRoomId)?.name || scopedRoomId)
      : "全部群";
  
    const callbackEvents = filterItemsByRoom(callbackEventsAll, scopedRoomId, (item) => {
      const payload = item.jsonBody || {};
      return payload?.data?.roomid || "";
    });
    const filterEvents = filterItemsByRoom(filterEventsAll, scopedRoomId);
    const archiveEvents = filterItemsByRoom(archiveEventsAll, scopedRoomId);
    const routingEvents = filterItemsByRoom(routingEventsAll, scopedRoomId);
    const batchEvents = filterItemsByRoom(batchEventsAll, scopedRoomId);
    const knowledgeCandidates = filterItemsByRoom(knowledgeCandidatesAll, scopedRoomId);
    const knowledgePublishEvents = filterItemsByRoom(knowledgePublishEventsAll, scopedRoomId);
    const normalizedEvents = filterItemsByRoom(normalizedEventsAll, scopedRoomId);
    const threads = filterItemsByRoom(threadsAll, scopedRoomId);
    const cases = filterItemsByRoom(casesAll, scopedRoomId);
    const poolEntries = filterItemsByRoom(poolEntriesAll, scopedRoomId);
    const knowledgeHarvestEntries = filterItemsByRoom(knowledgeHarvestEntriesAll, scopedRoomId);
    const agentTasks = filterItemsByRoom(agentTasksAll, scopedRoomId);
  
    const normalizedByTrace = new Map(normalizedEvents.map((item) => [item.traceId, item]));
    const archiveByTrace = new Map(archiveEvents.map((item) => [item.traceId, item]));
    const pendingItems = poolEntries
      .filter((item) => String(item.status || "") === "pending")
      .map((item) => ({
        ...item,
        statusLabel: summarizePoolStatus(item.status),
        normalized: normalizedByTrace.get(item.traceId) || null,
      }))
      .sort((left, right) => String(right.sendTimeIso || right.receivedAt || "").localeCompare(String(left.sendTimeIso || left.receivedAt || "")));
    const processingItems = poolEntries
      .filter((item) => String(item.status || "") === "processing")
      .map((item) => ({
        ...item,
        statusLabel: summarizePoolStatus(item.status),
        normalized: normalizedByTrace.get(item.traceId) || null,
      }))
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  
    const acceptedRecent = filterEvents.filter((item) => item.accepted);
    const ignoredRecent = filterEvents.filter((item) => !item.accepted);
    const agentTriggeredTotal = routingEvents.filter((item) => item.agentTriggered).length;
    const agentPendingTasks = agentTasks
      .filter((item) => String(item.status || "") === "pending")
      .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "sendTimeIso"]));
    const agentClaimedTasks = agentTasks
      .filter((item) => String(item.status || "") === "claimed")
      .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "sendTimeIso"]));
    const agentRepliedTasks = agentTasks
      .filter((item) => String(item.status || "") === "replied")
      .sort((left, right) => compareTimeDesc(left, right, ["replySentAt", "updatedAt", "sendTimeIso"]));
    const agentCompletedTasks = agentTasks
      .filter((item) => String(item.status || "") === "completed")
      .sort((left, right) => compareTimeDesc(left, right, ["completedAt", "updatedAt", "sendTimeIso"]));
    const agentIgnoredTasks = agentTasks
      .filter((item) => String(item.status || "") === "ignored")
      .sort((left, right) => compareTimeDesc(left, right, ["completedAt", "updatedAt", "sendTimeIso"]));
    const agentFailedTasks = agentTasks
      .filter((item) => String(item.status || "") === "failed")
      .sort((left, right) => compareTimeDesc(left, right, ["completedAt", "updatedAt", "sendTimeIso"]));
    const finalizedAgentTasks = [
      ...agentCompletedTasks,
      ...agentIgnoredTasks,
      ...agentFailedTasks,
    ].sort((left, right) => compareTimeDesc(left, right, ["completedAt", "updatedAt", "sendTimeIso"]));
    const durationSamples = finalizedAgentTasks
      .map((item) => computeTaskDurationMs(item))
      .filter((value) => Number.isFinite(value));
    const avgDurationMs = durationSamples.length
      ? Math.round(durationSamples.reduce((sum, value) => sum + value, 0) / durationSamples.length)
      : null;
    const maxDurationMs = durationSamples.length ? Math.max(...durationSamples) : null;
    const minDurationMs = durationSamples.length ? Math.min(...durationSamples) : null;
    const latestAgentOutcome = finalizedAgentTasks.length ? summarizeAgentTaskForDashboard(finalizedAgentTasks[0]) : null;
    const recentAgentFailures = agentFailedTasks.slice(0, 5).map((item) => summarizeAgentTaskForDashboard(item));
    const toolUsageBreakdown = buildSimpleCountBreakdown(
      agentTasks.flatMap((item) => (Array.isArray(item.toolNames) ? item.toolNames : [])),
    );
    const queueWaitSamples = finalizedAgentTasks
      .map((item) => computeLatencyPartMs(item?.sendTimeIso, item?.claimedAt))
      .filter((value) => Number.isFinite(value));
    const processingSamples = finalizedAgentTasks
      .map((item) => computeLatencyPartMs(item?.agentStartedAt || item?.claimedAt, item?.agentFinishedAt || item?.completedAt))
      .filter((value) => Number.isFinite(value));
    const replySendSamples = finalizedAgentTasks
      .map((item) => computeLatencyPartMs(item?.agentFinishedAt, item?.replySentAt || item?.completedAt))
      .filter((value) => Number.isFinite(value));
    const totalLatencySamples = finalizedAgentTasks
      .map((item) => computeLatencyPartMs(item?.sendTimeIso, item?.replySentAt || item?.completedAt))
      .filter((value) => Number.isFinite(value));
    const averageOrNull = (items) => (items.length
      ? Math.round(items.reduce((sum, value) => sum + value, 0) / items.length)
      : null);
    const acceptedCallbacks = callbackEvents.slice(0, safeLimit).map((item) => {
      const payload = item.jsonBody || {};
      const data = payload.data || {};
      const traceId = buildTraceId(payload);
      return {
        ...item,
        traceId,
        roomId: data.roomid || "",
        roomName: data.room_name || data.chat_name || data.roomid || "",
        senderId: data.sender || "",
        senderName: data.sender_name || "",
        seq: data.seq || "",
        id: data.id || "",
        sendTime: data.sendtime || null,
        sendTimeIso: toIsoTime(data.sendtime),
        msgType: Number(data.msg_type || 0),
        msgTypeName: normalizeMsgTypeLabel(null, Number(data.msg_type || 0)),
        content: data.content || "",
        contentType: data.content_type ?? null,
        quoteContent: data.quote_content || "",
        normalized: normalizedByTrace.get(traceId) || null,
        processed: normalizePriorityItem(archiveByTrace.get(traceId) || null),
      };
    });
    const processedRecent = archiveEvents.map((item) => {
      const execution = parseArchiveStdout(item.stdout);
      const thread = execution?.thread || null;
      const caseInfo = execution?.case || null;
      return {
        ...item,
        priority: item.priority ? normalizePriority(item.priority, "P2") : item.priority,
        reasonLabel: summarizeReason(item.reason),
        thread,
        caseInfo,
        normalized: normalizedByTrace.get(item.traceId) || null,
      };
    });
  
    const pendingOrSkipped = processedRecent.filter((item) => !item.caseInfo || !item.caseInfo.case_id);
    const callbackTotal = callbackEvents.length;
    const filterTotal = filterEvents.length;
    const normalizedTotal = normalizedEvents.length;
    const archiveTotal = archiveEvents.length;
    const acceptedTotal = acceptedRecent.length;
    const ignoredTotal = ignoredRecent.length;
    const archivedTotal = archiveEvents.filter((item) => item.archived).length;
    const nonCaseTotal = archiveEvents.filter((item) => !item.archived).length;
    const knowledgePendingReviewTotal = knowledgeCandidates.filter((item) => String(item.status || "") === "pending_review").length;
    const knowledgePublishedTotal = knowledgeCandidates.filter((item) => String(item.status || "") === "published").length;
    const knowledgeRejectedTotal = knowledgeCandidates.filter((item) => String(item.status || "") === "rejected").length;
    const knowledgeAlreadyExistsTotal = knowledgeCandidates.filter((item) => String(item.knowledgeStatus || "") === "already_exists").length;
    const knowledgeUpdateExistingTotal = knowledgeCandidates.filter((item) => String(item.knowledgeStatus || "") === "update_existing").length;
    const knowledgeReviewQueue = knowledgeCandidates
      .filter((item) => String(item.status || "") === "pending_review")
      .sort((left, right) => {
        const leftRank = String(left.recommendation || "") === "add_new" ? 2 : 1;
        const rightRank = String(right.recommendation || "") === "add_new" ? 2 : 1;
        return rightRank - leftRank || compareTimeDesc(left, right, ["updatedAt", "createdAt"]);
      });
    const knowledgeIgnoredTotal = knowledgeHarvestEntries.filter((item) => String(item.status || "") === "ignored").length;
    const knowledgeFailedTotal = knowledgeHarvestEntries.filter((item) => String(item.status || "") === "failed").length;
    const nowMs = Date.now();
    const batchStuckMs = Math.max(10 * 60 * 1000, BATCH_READY_AGE_MS * 4);
    const agentStuckMs = 10 * 60 * 1000;
    const pendingOldItems = pendingItems
      .map((item) => ({
        ...item,
        ageMs: computeDashboardAgeMs(item.sendTimeIso || item.receivedAt, nowMs),
      }))
      .filter((item) => Number.isFinite(item.ageMs) && item.ageMs >= batchStuckMs)
      .slice(0, 5);
    const processingStuckItems = processingItems
      .map((item) => ({
        ...item,
        ageMs: computeDashboardAgeMs(item.updatedAt || item.sendTimeIso || item.receivedAt, nowMs),
      }))
      .filter((item) => Number.isFinite(item.ageMs) && item.ageMs >= batchStuckMs)
      .slice(0, 5);
    const agentStuckTasks = [...agentClaimedTasks, ...agentRepliedTasks]
      .map((item) => ({
        ...summarizeAgentTaskForDashboard(item),
        ageMs: computeDashboardAgeMs(item.updatedAt || item.claimedAt || item.replySentAt || item.sendTimeIso, nowMs),
      }))
      .filter((item) => Number.isFinite(item.ageMs) && item.ageMs >= agentStuckMs)
      .slice(0, 5);
    const knowledgeFailedItems = knowledgeHarvestEntries
      .filter((item) => String(item.status || "") === "failed")
      .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "processedAt", "receivedAt", "sendTimeIso"]))
      .slice(0, 5);
    const attentionItems = [
      pendingItems.length ? buildAttentionItem({
        kind: "batch_pending",
        severity: pendingOldItems.length ? "warn" : "info",
        title: "待批处理消息",
        count: pendingItems.length,
        summary: pendingOldItems.length
          ? `有 ${pendingOldItems.length} 条等待超过 ${Math.round(batchStuckMs / 60000)} 分钟`
          : "消息正在等待批处理扫描",
        action: "点击“立即处理待处理”或等待扫描器自动处理",
        items: pendingOldItems.length ? pendingOldItems : pendingItems.slice(0, 3),
      }) : null,
      processingStuckItems.length ? buildAttentionItem({
        kind: "batch_stuck",
        severity: "danger",
        title: "批处理疑似卡住",
        count: processingStuckItems.length,
        summary: `processing 状态超过 ${Math.round(batchStuckMs / 60000)} 分钟`,
        action: "优先看消息池记录里的 lastError，再手动触发一次批处理",
        items: processingStuckItems,
      }) : null,
      (agentPendingTasks.length || agentClaimedTasks.length || agentRepliedTasks.length) ? buildAttentionItem({
        kind: "agent_open",
        severity: agentStuckTasks.length ? "warn" : "info",
        title: "Agent 未完成任务",
        count: agentPendingTasks.length + agentClaimedTasks.length + agentRepliedTasks.length,
        summary: agentStuckTasks.length ? "有任务长时间未完成" : "还有待回复或待确认任务",
        action: "查看 Agent 运行状态和最近任务明细",
        items: agentStuckTasks.length ? agentStuckTasks : [...agentPendingTasks, ...agentClaimedTasks, ...agentRepliedTasks].slice(0, 3).map(summarizeAgentTaskForDashboard),
      }) : null,
      agentFailedTasks.length ? buildAttentionItem({
        kind: "agent_failed",
        severity: "danger",
        title: "Agent 失败任务",
        count: agentFailedTasks.length,
        summary: "",
        action: "",
        items: recentAgentFailures,
      }) : null,
      knowledgePendingReviewTotal ? buildAttentionItem({
        kind: "knowledge_review",
        severity: "warn",
        title: "知识候选待审核",
        count: knowledgePendingReviewTotal,
        summary: "",
        action: "",
        items: knowledgeReviewQueue.slice(0, 5),
      }) : null,
      knowledgeFailedTotal ? buildAttentionItem({
        kind: "knowledge_failed",
        severity: "danger",
        title: "知识扫描失败",
        count: knowledgeFailedTotal,
        summary: "",
        action: "",
        items: knowledgeFailedItems,
      }) : null,
    ].filter(Boolean);
    const candidateThreads = threads.filter((item) => !item.case_id).map(normalizePriorityItem);
    const promotedThreads = threads.filter((item) => !!item.case_id).map(normalizePriorityItem);
    const threadReasonItems = candidateThreads.map((item) => ({
      ...item,
      reasonLabel: summarizeThreadReason(item.promotion_reason || item.status),
    }));
    const combinedNonCase = [
      ...pendingOrSkipped,
      ...threadReasonItems.filter((item) => !pendingOrSkipped.find((row) => row.thread?.thread_id === item.thread_id)),
    ];
    const dailySummary = buildDailySummary({
      scope: {
        selectedRoomLabel,
      },
      callbackEvents,
      filterEvents,
      normalizedEvents,
      archiveEvents,
      cases,
      knowledgeCandidates,
      knowledgePublishEvents,
      agentTasks,
    });
  
    const result = {
      generatedAt: new Date().toISOString(),
      scope: {
        selectedRoomId: scopedRoomId,
        selectedRoomLabel,
        isAllRooms: !scopedRoomId,
      },
      filters: {
        archiveMode: ARCHIVE_MODE,
        legacySingleMessageArchiveActive: false,
        detectedRoomIds: availableRoomsFinal.map((item) => item.id),
        targetRoomIds: Array.from(TARGET_ROOM_IDS),
        feishuTargetChatIds: Array.from(FEISHU_TARGET_CHAT_IDS),
        roomWhitelistEnabled: TARGET_ROOM_IDS.size > 0,
        feishuChatWhitelistEnabled: FEISHU_TARGET_CHAT_IDS.size > 0,
        currentWecomGuid,
        availableRooms: availableRoomsFinal,
        notifyTypes: Array.from(ACCEPT_NOTIFY_TYPES),
        supportedMsgTypes: Array.from(SUPPORTED_MSG_TYPES).map((msgType) => ({
          name: MSG_TYPE_NAMES[msgType] || "未知类型",
        })),
        archiveEnabled: ARCHIVE_ENABLED,
        batchModeEnabled: BATCH_MODE_ENABLED,
        batchScanIntervalSeconds: Math.round(BATCH_SCAN_INTERVAL_MS / 1000),
        batchReadyAgeSeconds: Math.round(BATCH_READY_AGE_MS / 1000),
        batchMaxPendingPerRoom: BATCH_MAX_PENDING_PER_ROOM,
        caseArchiveNotifyEnabled: CASE_ARCHIVE_NOTIFY_ENABLED,
        agentLaneEnabled: AGENT_LANE_ENABLED,
        agentWakeNames: AGENT_WAKE_NAMES,
        transcriptionEnabled: TRANSCRIBE_ENABLED,
        transcriptionModel: TRANSCRIBE_MODEL,
        llmClassifyEnabled: LLM_CLASSIFY_ENABLED,
        llmModel: LLM_MODEL,
        knowledgeHarvestEnabled: KNOWLEDGE_HARVEST_ENABLED,
        knowledgeHarvestRoomIds: Array.from(KNOWLEDGE_HARVEST_ROOM_IDS),
        knowledgeHarvestScanIntervalSeconds: Math.round(KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS / 1000),
        knowledgeHarvestReadyAgeSeconds: Math.round(KNOWLEDGE_HARVEST_READY_AGE_MS / 1000),
        knowledgeHarvestMaxPerScan: KNOWLEDGE_HARVEST_MAX_PER_SCAN,
      },
      progress: {
        callbackTotal,
        filterTotal,
        acceptedTotal,
        ignoredTotal,
        pendingTotal: pendingItems.length,
        processingTotal: processingItems.length,
        agentTriggeredTotal,
        agentPendingTaskTotal: agentPendingTasks.length,
        agentClaimedTaskTotal: agentClaimedTasks.length,
        agentRepliedTaskTotal: agentRepliedTasks.length,
        agentCompletedTaskTotal: agentCompletedTasks.length,
        agentIgnoredTaskTotal: agentIgnoredTasks.length,
        agentFailedTaskTotal: agentFailedTasks.length,
        normalizedTotal,
        archiveTotal,
        archivedTotal,
        nonCaseTotal,
        caseTotal: cases.length,
        candidateThreadTotal: candidateThreads.length,
        promotedThreadTotal: promotedThreads.length,
        knowledgePendingTotal: knowledgeHarvestEntries.filter((item) => String(item.status || "") === "pending").length,
        knowledgeProcessingTotal: knowledgeHarvestEntries.filter((item) => String(item.status || "") === "processing").length,
        knowledgePendingReviewTotal,
        knowledgePublishedTotal,
        knowledgeRejectedTotal,
        knowledgeAlreadyExistsTotal,
        knowledgeUpdateExistingTotal,
        knowledgeIgnoredTotal,
        knowledgeFailedTotal,
      },
      breakdowns: {
        stages: [
          { label: "收到回调", count: callbackTotal },
          { label: "过滤通过", count: acceptedTotal },
          { label: "标准化", count: normalizedTotal },
          { label: "命中机器人", count: agentTriggeredTotal },
          { label: "待批处理", count: pendingItems.length },
          { label: "批处理中", count: processingItems.length },
          { label: "进入处理", count: archiveTotal },
          { label: "候选 Thread", count: candidateThreads.length },
          { label: "正式 Case", count: cases.length },
          { label: "知识候选", count: knowledgePendingReviewTotal },
          { label: "已入知识库", count: knowledgePublishedTotal },
        ],
        ignoredReasons: buildCountBreakdown(ignoredRecent, (item) => summarizeReason(item.reason)),
        routingReasons: buildCountBreakdown(routingEvents, (item) => String(item.routeReason || "archive_only")),
        processedReasons: buildCountBreakdown(processedRecent, (item) => item.reasonLabel || summarizeReason(item.reason)),
        messageTypes: buildCountBreakdown(normalizedEvents, (item) => item.msgTypeName || `type:${item.msgType}`),
        threadReasons: buildCountBreakdown(threadReasonItems, (item) => item.reasonLabel),
        knowledgeCandidateStatuses: buildCountBreakdown(knowledgeCandidates, (item) => String(item.status || "unknown")),
        knowledgeRecommendations: buildCountBreakdown(knowledgeCandidates, (item) => String(item.recommendation || "unknown")),
        knowledgeStatuses: buildCountBreakdown(knowledgeCandidates, (item) => String(item.knowledgeStatus || "unknown")),
      },
      agentOverview: {
        tasks: {
          pending: agentPendingTasks.length,
          claimed: agentClaimedTasks.length,
          replied: agentRepliedTasks.length,
          completed: agentCompletedTasks.length,
          ignored: agentIgnoredTasks.length,
          failed: agentFailedTasks.length,
        },
        session: {
          strategy: AGENT_SESSION_KEY_STRATEGY,
          wakeOnly: true,
          activationEnabled: false,
        },
        latency: {
          sampleCount: durationSamples.length,
          avgMs: avgDurationMs,
          minMs: minDurationMs,
          maxMs: maxDurationMs,
        },
        routingReasons: buildCountBreakdown(routingEvents, (item) => String(item.routeReason || "archive_only")),
        tools: {
          breakdown: toolUsageBreakdown,
          totalCalls: toolUsageBreakdown.reduce((sum, item) => sum + Number(item.count || 0), 0),
        },
        latencyBreakdown: {
          queueWaitAvgMs: averageOrNull(queueWaitSamples),
          processingAvgMs: averageOrNull(processingSamples),
          replySendAvgMs: averageOrNull(replySendSamples),
          totalAvgMs: averageOrNull(totalLatencySamples),
        },
        latestOutcome: latestAgentOutcome,
        recentFailures: recentAgentFailures,
      },
      dailySummary,
      needsAttention: {
        total: attentionItems.reduce((sum, item) => sum + Number(item.count || 0), 0),
        dangerTotal: attentionItems.filter((item) => item.severity === "danger").reduce((sum, item) => sum + Number(item.count || 0), 0),
        warnTotal: attentionItems.filter((item) => item.severity === "warn").reduce((sum, item) => sum + Number(item.count || 0), 0),
        items: attentionItems,
      },
      latest: {
        callbacks: acceptedCallbacks,
        accepted: acceptedRecent.slice(0, safeLimit),
        ignored: ignoredRecent.slice(0, safeLimit),
        normalized: normalizedEvents.slice(0, safeLimit),
        pending: pendingItems.slice(0, safeLimit),
        processing: processingItems.slice(0, safeLimit),
        routing: routingEvents.slice(0, safeLimit),
        agentTasks: agentTasks.slice(0, safeLimit).map((item) => ({
          ...item,
          statusLabel: summarizeAgentTaskStatus(item.status),
          durationMs: computeTaskDurationMs(item),
        })),
        processed: processedRecent.slice(0, safeLimit),
        pendingOrSkipped: pendingOrSkipped.slice(0, safeLimit),
        nonCase: combinedNonCase.slice(0, safeLimit),
        cases: cases.slice(0, safeLimit).map((item) => {
          const merged = {
            ...normalizePriorityItem(item),
            ...readCaseArtifacts(item),
          };
          if (merged.caseDetail) {
            merged.caseDetail = normalizePriorityItem(merged.caseDetail);
          }
          return normalizePriorityItem(merged);
        }),
        candidateThreads: threadReasonItems.slice(0, safeLimit),
        promotedThreads: promotedThreads.slice(0, safeLimit),
        batches: batchEvents.slice(0, safeLimit),
        knowledgeCandidates: knowledgeReviewQueue.slice(0, safeLimit),
        knowledgeCandidateActivity: knowledgeCandidates.slice(0, safeLimit),
        knowledgePublishEvents: knowledgePublishEvents.slice(0, safeLimit),
      },
    };
    if (!mysqlRuntimeStore.isEnabled()) {
      dashboardDataCache.set(dashboardCacheKey, {
        version: dependencyVersion,
        value: result,
      });
    }
    return result;
  }

  return {
    buildDailySummary,
    buildDashboardData,
    countItemsOnDashboardDate,
    getDashboardLocalDateKey,
    getDashboardRelativeDateKey,
    itemMatchesDashboardDate,
    normalizeDashboardMessageItem,
  };
}

module.exports = { createDashboardDataService };
