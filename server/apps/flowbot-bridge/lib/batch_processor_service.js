"use strict";

const { createBatchPlannerService } = require("./batch_planner_service");

function createBatchProcessorService({
  ACTIVE_CASE_STATUSES,
  ARCHIVE_PYTHON,
  ARCHIVE_SCRIPT_PATH,
  BATCH_MAX_OPEN_CASES,
  BATCH_MAX_PENDING_PER_ROOM,
  BATCH_MEDIA_ONLY_HOLD_MS,
  BATCH_MODE_ENABLED,
  BATCH_OPEN_CASE_LOOKBACK_MS,
  BATCH_PROCESSING_STALE_MS,
  BATCH_READY_AGE_MS,
  CASE_ARCHIVE_NOTIFY_ENABLED,
  DATA_DIR,
  LLM_MAX_REPAIR_ATTEMPTS,
  appendArchiveDecision,
  appendBatchDecision,
  buildArchiveMessageContent,
  buildBatchPlannerOpenCase,
  buildBatchPlannerPendingMessage,
  buildCaseArchiveNotificationText,
  buildDashboardUrl,
  buildLlmImageParts,
  buildLlmReadyMessage,
  compareTimeDesc,
  detectPriority,
  extractKeywords,
  fs,
  loadNormalizedMessageMap,
  messageTimestampMs,
  mysqlRuntimeStore,
  normalizePriority,
  os,
  parseArchiveStdout,
  path,
  patchMessagePoolEntries,
  pickArchiveSummary,
  readCaseArtifacts,
  readJsonFile,
  readMessagePoolState,
  requestLlmClassify,
  sendAgentReplyMessage,
  shouldDelayMediaOnlyCase,
  spawnSync,
  tryParseClassifyJson,
}) {
  const {
    normalizeBatchPlannerCategory,
    planPendingGroupsByLlm,
    validateBatchPlannerPayload,
  } = createBatchPlannerService({
    LLM_MAX_REPAIR_ATTEMPTS,
    buildBatchPlannerOpenCase,
    buildBatchPlannerPendingMessage,
    buildLlmImageParts,
    normalizePriority,
    requestLlmClassify,
    tryParseClassifyJson,
  });
  const HISTORICAL_BACKFILL_MAX_LAG_MS = 60 * 60 * 1000;
  const BATCH_CASE_LOOKUP_PAGE_SIZE = 10;
  const BATCH_CASE_LOOKUP_MAX_PAGES = 3;

  function dayWindowForMessages(messages) {
    const timestamps = (Array.isArray(messages) ? messages : [])
      .map((item) => Date.parse(String(item?.sendTimeIso || item?.time || item?.receivedAt || "")))
      .filter((value) => Number.isFinite(value));
    const anchorMs = timestamps.length ? Math.max(...timestamps) : Date.now();
    const anchor = new Date(anchorMs);
    const start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime(), date: start.toISOString().slice(0, 10) };
  }

  function caseTimestampInDay(item, startMs, endMs) {
    return ["updated_at", "last_message_time", "created_at", "first_message_time"].some((field) => {
      const ts = Date.parse(String(item?.[field] || ""));
      return Number.isFinite(ts) && ts >= startMs && ts < endMs;
    });
  }

  function buildOpenCaseContext(roomId) {
    const caseIndex = readJsonFile(path.join(DATA_DIR, "index.json"), { version: 1, cases: [] });
    const nowMs = Date.now();
    const allCases = Array.isArray(caseIndex?.cases) ? caseIndex.cases : [];
    return allCases
      .filter((item) => String(item?.chat_id || "") === String(roomId || ""))
      .filter((item) => ACTIVE_CASE_STATUSES.has(String(item?.status || "open")))
      .filter((item) => {
        const updatedAt = Date.parse(String(item?.updated_at || ""));
        return Number.isFinite(updatedAt) ? nowMs - updatedAt <= BATCH_OPEN_CASE_LOOKBACK_MS : false;
      })
      .sort((left, right) => compareTimeDesc(left, right, ["updated_at", "last_message_time"]))
      .slice(0, BATCH_MAX_OPEN_CASES)
      .map((item) => {
        const detail = readCaseArtifacts(item);
        const timeline = detail?.conversationDetail?.timeline || detail?.caseDetail?.messages || [];
        return {
          ...item,
          lastMessages: Array.isArray(timeline)
            ? timeline.slice(-4).map((row) => ({
                time: row?.time || "",
                sender: row?.sender || "",
                type: row?.type || "",
                content: row?.content || "",
              }))
            : [],
        };
      });
  }

  function buildCaseLookupTool(roomId, pendingMessages) {
    const caseIndex = readJsonFile(path.join(DATA_DIR, "index.json"), { version: 1, cases: [] });
    const allCases = Array.isArray(caseIndex?.cases) ? caseIndex.cases : [];
    const { startMs, endMs, date } = dayWindowForMessages(pendingMessages);
    const scopedCases = allCases
      .filter((item) => String(item?.chat_id || "") === String(roomId || ""))
      .filter((item) => caseTimestampInDay(item, startMs, endMs))
      .sort((left, right) => compareTimeDesc(left, right, ["updated_at", "last_message_time", "created_at"]));

    return ({ query = "", page = 1, limit = BATCH_CASE_LOOKUP_PAGE_SIZE } = {}) => {
      const safePage = Math.max(1, Math.min(BATCH_CASE_LOOKUP_MAX_PAGES, Number.parseInt(String(page || 1), 10) || 1));
      const safeLimit = Math.max(1, Math.min(BATCH_CASE_LOOKUP_PAGE_SIZE, Number.parseInt(String(limit || BATCH_CASE_LOOKUP_PAGE_SIZE), 10) || BATCH_CASE_LOOKUP_PAGE_SIZE));
      const normalizedQuery = String(query || "").trim();
      const scored = scopedCases.map((item) => {
        const text = [
          item?.case_id,
          item?.summary,
          item?.category,
          item?.priority,
          ...(Array.isArray(item?.keywords) ? item.keywords : []),
          ...(Array.isArray(item?.reporters) ? item.reporters : []),
          ...(Array.isArray(item?.participants) ? item.participants : []),
        ].filter(Boolean).join("\n");
        const score = normalizedQuery ? computeSimpleCaseScore(normalizedQuery, text) : 1;
        return { item, score };
      }).filter((row) => !normalizedQuery || row.score > 0);
      scored.sort((left, right) => right.score - left.score || compareTimeDesc(left.item, right.item, ["updated_at", "last_message_time", "created_at"]));
      const total = scored.length;
      const offset = (safePage - 1) * safeLimit;
      const rows = scored.slice(offset, offset + safeLimit).map(({ item, score }) => {
        const detail = readCaseArtifacts(item);
        const timeline = detail?.conversationDetail?.timeline || detail?.caseDetail?.messages || [];
        return buildBatchPlannerOpenCase({
          ...item,
          score,
          lastMessages: Array.isArray(timeline)
            ? timeline.slice(-4).map((row) => ({
                time: row?.time || "",
                sender: row?.sender || "",
                type: row?.type || "",
                content: row?.content || "",
              }))
            : [],
        });
      });
      return {
        date,
        roomId,
        page: safePage,
        limit: safeLimit,
        total,
        hasMore: offset + safeLimit < total && safePage < BATCH_CASE_LOOKUP_MAX_PAGES,
        cases: rows,
      };
    };
  }

  function computeSimpleCaseScore(query, text) {
    const normalizedQuery = String(query || "").toLowerCase();
    const normalizedText = String(text || "").toLowerCase();
    if (!normalizedQuery || !normalizedText) {
      return 0;
    }
    const tokens = normalizedQuery
      .split(/[\s,，。；;:：、|/\\()[\]{}"'`]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!tokens.length) {
      return normalizedText.includes(normalizedQuery) ? 1 : 0;
    }
    let score = normalizedText.includes(normalizedQuery) ? 2 : 0;
    for (const token of tokens) {
      if (token && normalizedText.includes(token)) {
        score += 1;
      }
    }
    return score;
  }
  
  function buildArchivePayloadForGroup(groupMessages, groupPlan, roomId) {
    const sorted = groupMessages.slice().sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    const lastMessage = sorted[sorted.length - 1] || {};
    const llmReadyMessages = sorted.map((item) => buildLlmReadyMessage(item));
    return {
      chat_id: roomId,
      chat_name: lastMessage.roomName || roomId,
      sender: lastMessage.senderName || lastMessage.senderId || "unknown",
      message_time: lastMessage.sendTimeIso ? lastMessage.sendTimeIso.replace("T", " ").replace("Z", "") : lastMessage.receivedAt,
      category: groupPlan.category,
      thread_type: groupPlan.threadType || "case_feedback",
      message_role: groupPlan.messageRole || "problem_report",
      batch_action: groupPlan.action || "new_case",
      priority: normalizePriority(
        groupPlan.priority || detectPriority(groupMessages.map((item) => buildArchiveMessageContent(item)).join("\n")),
        "P2",
      ),
      summary: groupPlan.summary || pickArchiveSummary(
        llmReadyMessages,
        sorted.map((item) => buildArchiveMessageContent(item)).filter(Boolean).join("\n"),
      ),
      keywords: extractKeywords(sorted.map((item) => buildArchiveMessageContent(item)).filter(Boolean).join("\n")),
      messages: llmReadyMessages.map((item) => ({
        ...item,
        thread_type: groupPlan.threadType || "case_feedback",
        message_role: groupPlan.messageRole || "problem_report",
        batch_action: groupPlan.action || "new_case",
      })),
      disable_thread_matching: true,
      disable_case_matching: true,
      force_promote_case: groupPlan.action === "new_case" || groupPlan.action === "append_case" || groupPlan.action === "append_case_activity",
      force_case_id: (groupPlan.action === "append_case" || groupPlan.action === "append_case_activity") ? groupPlan.targetCaseId : "",
    };
  }
  
  function recordBatchGroupDecision(roomId, groupPlan, groupMessages, extra = {}) {
    const sorted = groupMessages.slice().sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    const representative = sorted[0] || {};
    const lastMessage = sorted[sorted.length - 1] || representative;
    appendArchiveDecision({
      receivedAt: new Date().toISOString(),
      traceId: representative.traceId || `batch:${roomId}:${Date.now()}:${groupPlan.groupId}`,
      traceIds: sorted.map((item) => item.traceId),
      roomId,
      roomName: representative.roomName || roomId,
      msgType: representative.msgType || 0,
      senderName: representative.senderName || representative.senderId || "",
      contentPreview: groupPlan.summary || String(representative.content || "").slice(0, 120),
      archived: Boolean(extra.archived),
      reason: extra.reason || groupPlan.action,
      category: groupPlan.category,
      priority: groupPlan.priority,
      summary: groupPlan.summary,
      classifierSource: "llm_batch",
      classifierReason: groupPlan.reason || groupPlan.action,
      classifierParseError: "",
      classifierRawOutput: "",
      llmRepaired: false,
      commandStatus: extra.commandStatus,
      caseAction: String(extra.caseAction || "").trim(),
      caseId: String(extra.caseId || "").trim(),
      dashboardUrl: extra.dashboardUrl || buildDashboardUrl(lastMessage),
      batchMode: true,
      batchAction: groupPlan.action,
      targetCaseId: groupPlan.targetCaseId || "",
      threadType: groupPlan.threadType || "",
      messageRole: groupPlan.messageRole || "",
      notifyEnabled: Boolean(extra.notifyEnabled),
      notifyAttempted: Boolean(extra.notifyAttempted),
      notifySent: Boolean(extra.notifySent),
      notifyReason: String(extra.notifyReason || ""),
      notifyError: String(extra.notifyError || ""),
      stdout: String(extra.stdout || ""),
      stderr: String(extra.stderr || ""),
    });
  }

  function messageDeliveryLagMs(message) {
    const sentAt = Date.parse(String(message?.sendTimeIso || message?.time || ""));
    const receivedAt = Date.parse(String(message?.receivedAt || ""));
    if (!Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) {
      return 0;
    }
    return receivedAt - sentAt;
  }

  function isHistoricalBackfillMessage(message) {
    const guid = String(message?.guid || "").trim();
    const looksLikeWecomRuntimeGuid = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(guid);
    return looksLikeWecomRuntimeGuid && messageDeliveryLagMs(message) > HISTORICAL_BACKFILL_MAX_LAG_MS;
  }

  function shouldIgnoreHistoricalBackfillNewCase(groupMessages) {
    const list = Array.isArray(groupMessages) ? groupMessages : [];
    return list.length > 0 && list.every(isHistoricalBackfillMessage);
  }
  
  function runArchiveScript(payload) {
    const archiveInput = JSON.stringify(payload, null, 2);
    if (mysqlRuntimeStore.isEnabled()) {
      const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-archive-mysql-"));
      let exportedArtifacts = 0;
      let importedArtifacts = 0;
      try {
        exportedArtifacts = mysqlRuntimeStore.exportArchiveArtifacts(DATA_DIR, archiveRoot);
        const result = spawnSync(ARCHIVE_PYTHON, [ARCHIVE_SCRIPT_PATH, "--root", archiveRoot], {
          input: archiveInput,
          encoding: "utf8",
          timeout: 15000,
        });
        const parsed = parseArchiveStdout(String(result.stdout || "").trim());
        const normalizedParsed = parsed
          ? mysqlRuntimeStore.replacePathPrefix(parsed, archiveRoot, DATA_DIR)
          : null;
        if (result.status === 0) {
          importedArtifacts = mysqlRuntimeStore.importArchiveArtifacts(archiveRoot, DATA_DIR);
        }
        return {
          status: result.status,
          stdout: normalizedParsed ? JSON.stringify(normalizedParsed, null, 2) : String(result.stdout || "").trim(),
          stderr: String(result.stderr || "").trim(),
          parsed: normalizedParsed,
          storageBackend: "mysql",
          archiveRoot,
          exportedArtifacts,
          importedArtifacts,
        };
      } finally {
        try {
          fs.rmSync(archiveRoot, { recursive: true, force: true });
        } catch {}
      }
    }
  
    const result = spawnSync(ARCHIVE_PYTHON, [ARCHIVE_SCRIPT_PATH, "--root", DATA_DIR], {
      input: archiveInput,
      encoding: "utf8",
      timeout: 15000,
    });
    return {
      status: result.status,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
      parsed: parseArchiveStdout(String(result.stdout || "").trim()),
      storageBackend: "file",
    };
  }
  
  async function archivePendingGroup(roomId, groupPlan, groupMessages) {
    const payload = buildArchivePayloadForGroup(groupMessages, groupPlan, roomId);
    const archiveExec = runArchiveScript(payload);
    const parsed = archiveExec.parsed;
    const caseInfo = parsed?.case || null;
    const lastMessage = groupMessages.slice().sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right)).slice(-1)[0] || {};
    const dashboardUrl = buildDashboardUrl(lastMessage);
    const notifyState = {
      notifyEnabled: CASE_ARCHIVE_NOTIFY_ENABLED,
      notifyAttempted: false,
      notifySent: false,
      notifyReason: "",
      notifyError: "",
    };
    if (archiveExec.status === 0 && CASE_ARCHIVE_NOTIFY_ENABLED) {
      const canNotifyCaseAction = groupPlan.action === "new_case";
      const conversationId = String(lastMessage.rawRoomId || lastMessage.roomId || "").trim();
      if (canNotifyCaseAction && caseInfo?.case_id && conversationId) {
        notifyState.notifyAttempted = true;
        try {
          await sendAgentReplyMessage({
            task: {
              traceId: lastMessage.traceId || "",
              rawRoomId: lastMessage.rawRoomId || lastMessage.roomId || "",
              roomId: lastMessage.roomId || "",
            },
            guid: lastMessage.guid,
            conversationId,
            content: await buildCaseArchiveNotificationText({
              message: lastMessage,
              classificationPayload: payload,
              archiveResult: parsed,
              dashboardUrl,
            }),
          });
          notifyState.notifySent = true;
          notifyState.notifyReason = "sent";
        } catch (error) {
          notifyState.notifyReason = "send_failed";
          notifyState.notifyError = String(error?.message || error);
        }
      } else {
        notifyState.notifyReason = groupPlan.action === "new_case"
          ? "case_action_not_create"
          : "case_action_not_new_case";
      }
    } else if (!CASE_ARCHIVE_NOTIFY_ENABLED) {
      notifyState.notifyReason = "notify_disabled";
    } else {
      notifyState.notifyReason = "archive_failed";
    }
  
    recordBatchGroupDecision(roomId, groupPlan, groupMessages, {
      archived: archiveExec.status === 0,
      reason: archiveExec.status === 0 ? "archived" : "archive_failed",
      commandStatus: archiveExec.status,
      caseAction: caseInfo?.action || "",
      caseId: caseInfo?.case_id || "",
      dashboardUrl,
      ...notifyState,
      stdout: archiveExec.stdout,
      stderr: archiveExec.stderr,
    });
    return {
      ok: archiveExec.status === 0,
      archiveExec,
      payload,
      notifyState,
    };
  }
  function listEligiblePendingMessages({ ignoreReadyAge = false } = {}) {
    const state = readMessagePoolState();
    const normalizedMap = loadNormalizedMessageMap();
    const now = Date.now();
    const pending = [];
    for (const [traceId, entry] of Object.entries(state.messages || {})) {
      if (String(entry?.status || "") !== "pending") {
        continue;
      }
      const message = normalizedMap.get(traceId);
      if (!message) {
        continue;
      }
      const receivedAt = Date.parse(String(entry?.receivedAt || message.receivedAt || ""));
      if (!Number.isFinite(receivedAt)) {
        continue;
      }
      if (!ignoreReadyAge && now - receivedAt < BATCH_READY_AGE_MS) {
        continue;
      }
      pending.push(message);
    }
    pending.sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    return pending;
  }
  
  function requeueStaleProcessingMessages({ nowMs = Date.now(), staleAfterMs = BATCH_PROCESSING_STALE_MS } = {}) {
    const state = readMessagePoolState();
    const staleUpdates = [];
    for (const [traceId, entry] of Object.entries(state.messages || {})) {
      if (String(entry?.status || "") !== "processing") {
        continue;
      }
      const startedAtMs = Date.parse(String(entry?.processingStartedAt || entry?.updatedAt || entry?.receivedAt || ""));
      if (Number.isFinite(startedAtMs) && nowMs - startedAtMs < staleAfterMs) {
        continue;
      }
      const ageSeconds = Number.isFinite(startedAtMs)
        ? Math.max(0, Math.round((nowMs - startedAtMs) / 1000))
        : -1;
      staleUpdates.push({
        traceId,
        status: "pending",
        lastError: "processing_stale_requeued",
        lastErrorDetail: ageSeconds >= 0
          ? `processing_stale_requeued:${ageSeconds}s`
          : "processing_stale_requeued:unknown_age",
        processingStartedAt: "",
        threadType: "",
        messageRole: "",
        batchAction: "",
        batchReason: "",
      });
    }
    if (staleUpdates.length) {
      patchMessagePoolEntries(staleUpdates);
    }
    return {
      changed: staleUpdates.length > 0,
      requeuedCount: staleUpdates.length,
      traceIds: staleUpdates.map((item) => item.traceId),
    };
  }
  
  let batchProcessorRunning = false;

  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || "operation"}_timeout`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }
  
  async function runPendingBatchProcessor({ manual = false } = {}) {
    if (!BATCH_MODE_ENABLED && !manual) {
      return { ok: true, skipped: true, reason: "batch_mode_disabled" };
    }
    if (batchProcessorRunning) {
      return { ok: true, skipped: true, reason: "batch_processor_busy" };
    }
    batchProcessorRunning = true;
    try {
      const staleRecovery = requeueStaleProcessingMessages();
      if (staleRecovery.changed) {
        console.warn(`[flowbot-bridge] requeued ${staleRecovery.requeuedCount} stale processing message(s)`);
      }
      const pendingMessages = listEligiblePendingMessages({ ignoreReadyAge: manual });
      if (!pendingMessages.length) {
        return { ok: true, skipped: true, reason: "no_pending_messages", pendingCount: 0 };
      }
      const byRoom = new Map();
      for (const message of pendingMessages) {
        const roomId = String(message.roomId || "").trim();
        if (!roomId) {
          continue;
        }
        const list = byRoom.get(roomId) || [];
        if (list.length < BATCH_MAX_PENDING_PER_ROOM) {
          list.push(message);
        }
        byRoom.set(roomId, list);
      }
  
      const batchSummary = [];
      for (const [roomId, roomMessages] of byRoom.entries()) {
        if (!roomMessages.length) {
          continue;
        }
        console.log(`[flowbot-bridge] batch processing room=${roomId} pending=${roomMessages.length}`);
        patchMessagePoolEntries(roomMessages.map((item) => ({
          traceId: item.traceId,
          status: "processing",
          attempts: Number(readMessagePoolState().messages?.[item.traceId]?.attempts || 0) + 1,
          processingStartedAt: new Date().toISOString(),
          threadType: "",
          messageRole: "",
          batchAction: "",
          batchReason: "",
        })));
        const openCases = [];
        const planResult = await withTimeout(
          planPendingGroupsByLlm(roomId, roomMessages, openCases, {
            lookupCases: buildCaseLookupTool(roomId, roomMessages),
          }),
          Math.max(30 * 1000, Math.min(BATCH_PROCESSING_STALE_MS, 2 * 60 * 1000)),
          "batch_plan",
        ).catch((error) => ({
          ok: false,
          reason: "llm_batch_timeout",
          parseError: String(error?.message || error),
          rawOutput: "",
        }));
        if (!planResult.ok) {
          const shouldStopRetrying = roomMessages.some((item) => {
            const attempts = Number(readMessagePoolState().messages?.[item.traceId]?.attempts || 0);
            return attempts >= 3;
          });
          patchMessagePoolEntries(roomMessages.map((item) => ({
            traceId: item.traceId,
            status: shouldStopRetrying ? "review_required" : "pending",
            processedAt: shouldStopRetrying ? new Date().toISOString() : "",
            lastError: planResult.reason || "llm_batch_failed",
            lastErrorDetail: planResult.parseError || "",
            batchAction: shouldStopRetrying ? "need_review" : "",
            batchReason: shouldStopRetrying ? (planResult.reason || "llm_batch_failed") : "",
          })));
          appendBatchDecision({
            processedAt: new Date().toISOString(),
            roomId,
            ok: false,
            reason: planResult.reason || "llm_batch_failed",
            parseError: planResult.parseError || "",
            rawOutput: planResult.rawOutput || "",
            traceIds: roomMessages.map((item) => item.traceId),
          });
          batchSummary.push({
            roomId,
            ok: false,
            reason: planResult.reason || "llm_batch_failed",
            pendingCount: roomMessages.length,
            stoppedRetrying: shouldStopRetrying,
          });
          continue;
        }
  
        const roomResult = {
          roomId,
          ok: true,
          groups: [],
        };
        let lastArchivedCaseId = "";
        for (const group of planResult.groups) {
          const groupMessages = group.traceIds.map((traceId) => roomMessages.find((item) => item.traceId === traceId)).filter(Boolean);
          if (!groupMessages.length) {
            continue;
          }
          if (group.action === "new_case" && shouldIgnoreHistoricalBackfillNewCase(groupMessages)) {
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "ignored",
              processedAt: new Date().toISOString(),
              batchAction: "ignore",
              batchReason: "historical_backfill_not_new_case",
              threadType: group.threadType || "",
              messageRole: group.messageRole || "",
              caseId: "",
              lastError: "",
              lastErrorDetail: "",
            })));
            recordBatchGroupDecision(roomId, { ...group, action: "ignore" }, groupMessages, {
              archived: false,
              reason: "historical_backfill_not_new_case",
            });
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: "ignore",
              reason: "historical_backfill_not_new_case",
              traceIds: group.traceIds,
            });
            continue;
          }
          if (group.action === "new_case" && shouldDelayMediaOnlyCase(groupMessages)) {
            const newestTs = Math.max(...groupMessages.map((item) => messageTimestampMs(item)));
            const ageMs = Math.max(0, Date.now() - newestTs);
            const stillWaitingContext = ageMs < BATCH_MEDIA_ONLY_HOLD_MS;
            if (stillWaitingContext) {
              patchMessagePoolEntries(groupMessages.map((item) => ({
                traceId: item.traceId,
                status: "pending",
                lastError: "awaiting_text_context",
                lastErrorDetail: `media_only_hold:${Math.round(ageMs / 1000)}s`,
                threadType: "",
                messageRole: "",
                batchAction: "",
                batchReason: "",
              })));
              recordBatchGroupDecision(roomId, group, groupMessages, {
                archived: false,
                reason: "awaiting_text_context",
              });
              roomResult.groups.push({
                groupId: group.groupId,
                threadType: group.threadType,
                messageRole: group.messageRole,
                action: "awaiting_text_context",
                traceIds: group.traceIds,
              });
              continue;
            }
  
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "review_required",
              processedAt: new Date().toISOString(),
              batchAction: "need_review",
            batchReason: "media_only_without_text_context",
            threadType: group.threadType || "",
            messageRole: group.messageRole || "",
            caseId: "",
            lastError: "",
            lastErrorDetail: "",
          })));
            recordBatchGroupDecision(roomId, group, groupMessages, {
              archived: false,
              reason: "media_only_without_text_context",
            });
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: "need_review",
              traceIds: group.traceIds,
            });
            continue;
          }
  
          if (group.action === "ignore") {
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "ignored",
              processedAt: new Date().toISOString(),
              batchAction: "ignore",
              batchReason: group.reason || "ignored_by_llm",
              threadType: group.threadType || "",
              messageRole: group.messageRole || "",
              caseId: "",
              lastError: "",
              lastErrorDetail: "",
            })));
            recordBatchGroupDecision(roomId, group, groupMessages, {
              archived: false,
              reason: "ignored_by_llm",
            });
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: "ignore",
              traceIds: group.traceIds,
            });
            continue;
          }
  
          if (group.action === "need_review") {
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "review_required",
              processedAt: new Date().toISOString(),
              batchAction: "need_review",
              batchReason: group.reason || "need_manual_review",
              threadType: group.threadType || "",
              messageRole: group.messageRole || "",
              caseId: group.targetCaseId || "",
              lastError: "",
              lastErrorDetail: "",
            })));
            recordBatchGroupDecision(roomId, group, groupMessages, {
              archived: false,
              reason: "review_required",
            });
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: "need_review",
              traceIds: group.traceIds,
            });
            continue;
          }
  
          if ((group.action === "append_case" || group.action === "append_case_activity") && !String(group.targetCaseId || "").trim()) {
            if (lastArchivedCaseId) {
              group.targetCaseId = lastArchivedCaseId;
            } else if (group.action === "append_case") {
              group.action = "new_case";
            } else {
              group.action = "ignore";
            }
          }

          if (group.action === "ignore") {
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "ignored",
              processedAt: new Date().toISOString(),
              batchAction: "ignore",
              batchReason: group.reason || "append_without_target_case",
              threadType: group.threadType || "",
              messageRole: group.messageRole || "",
              caseId: "",
              lastError: "",
              lastErrorDetail: "",
            })));
            recordBatchGroupDecision(roomId, group, groupMessages, {
              archived: false,
              reason: "ignored_by_llm",
            });
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: "ignore",
              traceIds: group.traceIds,
            });
            continue;
          }

          const archiveResult = await archivePendingGroup(roomId, group, groupMessages);
          if (!archiveResult.ok) {
            patchMessagePoolEntries(groupMessages.map((item) => ({
              traceId: item.traceId,
              status: "pending",
              lastError: "archive_failed",
              lastErrorDetail: archiveResult.archiveExec.stderr || archiveResult.archiveExec.stdout || "",
              threadType: group.threadType || "",
              messageRole: group.messageRole || "",
              batchAction: group.action || "",
              batchReason: group.reason || "",
            })));
            roomResult.groups.push({
              groupId: group.groupId,
              threadType: group.threadType,
              messageRole: group.messageRole,
              action: group.action,
              ok: false,
              traceIds: group.traceIds,
            });
            continue;
          }
  
          const archivedCaseId = String(archiveResult.archiveExec?.parsed?.case?.case_id || group.targetCaseId || "").trim();
          if (archivedCaseId) {
            lastArchivedCaseId = archivedCaseId;
          }
          patchMessagePoolEntries(groupMessages.map((item) => ({
            traceId: item.traceId,
            status: group.action === "append_case_activity"
              ? "case_activity_appended"
              : (group.action === "append_case" ? "case_appended" : "case_created"),
            processedAt: new Date().toISOString(),
            batchAction: group.action,
            batchReason: group.reason || "",
            threadType: group.threadType || "",
            messageRole: group.messageRole || "",
            caseId: archivedCaseId,
            lastError: "",
            lastErrorDetail: "",
          })));
          roomResult.groups.push({
            groupId: group.groupId,
            threadType: group.threadType,
            messageRole: group.messageRole,
            action: group.action,
            ok: true,
            caseId: archivedCaseId,
            traceIds: group.traceIds,
          });
        }
  
        appendBatchDecision({
          processedAt: new Date().toISOString(),
          roomId,
          ok: true,
          repaired: Boolean(planResult.repaired),
          rawOutput: planResult.rawOutput || "",
          groups: roomResult.groups,
        });
        batchSummary.push(roomResult);
      }
      return {
        ok: true,
        rooms: batchSummary,
        pendingCount: pendingMessages.length,
      };
    } finally {
      batchProcessorRunning = false;
    }
  }

  return {
    archivePendingGroup,
    buildArchivePayloadForGroup,
    buildOpenCaseContext,
    listEligiblePendingMessages,
    normalizeBatchPlannerCategory,
    planPendingGroupsByLlm,
    recordBatchGroupDecision,
    requeueStaleProcessingMessages,
    runArchiveScript,
    runPendingBatchProcessor,
    validateBatchPlannerPayload,
  };
}

module.exports = { createBatchProcessorService };
