function createAgentApiRoutes({
  AGENT_TASK_FETCH_LIMIT,
  MESSAGE_CONTEXT_MAX_NEIGHBORS,
  MESSAGE_SEARCH_INDEX_PATH,
  appendKnowledgeCandidate,
  appendKnowledgePublishResult,
  askKnowledgeBot,
  buildAckTaskPatch,
  buildAgentTaskContext,
  buildCaseProgressPayload,
  buildKnowledgeAnswer,
  buildKnowledgeAnswerFallbackText,
  claimAgentTask,
  collectBody,
  compareTimeDesc,
  findAgentTaskById,
  findCaseById,
  findKnowledgeCandidate,
  findRelatedCases,
  getCaseTimeline,
  getDateSummary,
  getHistorySummary,
  getRoomSummary,
  getStoredMessageByTraceId,
  listKnowledgeCandidates,
  listRoomMessages,
  isRagflowBotReady,
  normalizeBooleanInput,
  normalizeKnowledgeCandidatePatch,
  normalizeKnowledgeSourceInput,
  normalizeMemorySourceInput,
  patchAgentTasks,
  publishKnowledgeCandidateToLocal,
  readAgentTaskState,
  readCaseArtifacts,
  readKnowledgeHarvestState,
  buildKnowledgeCandidateId,
  patchKnowledgeHarvestMessages,
  rewriteKnowledgeCandidate,
  runKnowledgeHarvestProcessor,
  safeParseJson,
  searchCaseMessages,
  searchCases,
  searchKnowledgeDocuments,
  searchStoredMessages,
  searchStoredMessagesWithContext,
  searchUnifiedMemory,
  sendAgentReplyMessage,
  sendJson,
  summarizeAgentTaskStatus,
  updateExistingKnowledgeFromCandidate,
}) {
  async function handleAgentApiRoute(req, res, url) {
    if (req.method === "GET" && url.pathname === "/flowbot/agent/tasks") {
      const state = readAgentTaskState();
      const status = String(url.searchParams.get("status") || "pending").trim();
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || AGENT_TASK_FETCH_LIMIT));
      const tasks = Object.values(state.tasks || {})
        .filter((item) => item && typeof item === "object")
        .filter((item) => !status || String(item.status || "") === status)
        .filter((item) => !roomId || String(item.roomId || "") === roomId)
        .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "sendTimeIso"]))
        .slice(0, limit)
        .map((item) => ({
          ...item,
          statusLabel: summarizeAgentTaskStatus(item.status),
        }));
      sendJson(res, 200, {
        ok: true,
        status,
        roomId,
        limit,
        count: tasks.length,
        tasks,
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/agent/tasks/claim") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const taskId = String(body.taskId || "").trim();
      const handler = String(body.handler || "").trim();
      const roomId = String(body.roomId || "").trim();
      const excludeRoomIds = Array.isArray(body.excludeRoomIds) ? body.excludeRoomIds : [];
      const task = claimAgentTask({ taskId, handler, roomId, excludeRoomIds });
      sendJson(res, 200, {
        ok: true,
        taskId,
        handler,
        roomId,
        excludeRoomIds,
        claimed: Boolean(task),
        task: task ? {
          ...task,
          statusLabel: summarizeAgentTaskStatus(task.status),
        } : null,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/context") {
      const taskId = String(url.searchParams.get("taskId") || "").trim();
      if (!taskId) {
        sendJson(res, 400, { ok: false, error: "task_id_required" });
        return true;
      }
      const context = buildAgentTaskContext(taskId, {
        lean: url.searchParams.get("lean"),
        messageLimit: url.searchParams.get("messageLimit"),
        caseLimit: url.searchParams.get("caseLimit"),
        query: url.searchParams.get("query"),
      });
      if (!context) {
        sendJson(res, 404, { ok: false, error: "task_not_found", taskId });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        taskId,
        context,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/messages") {
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      if (!roomId) {
        sendJson(res, 400, { ok: false, error: "room_id_required" });
        return true;
      }
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 20));
      sendJson(res, 200, {
        ok: true,
        roomId,
        limit,
        messages: listRoomMessages(roomId, limit),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/message") {
      const traceId = String(url.searchParams.get("traceId") || "").trim();
      if (!traceId) {
        sendJson(res, 400, { ok: false, error: "trace_id_required" });
        return true;
      }
      const message = getStoredMessageByTraceId(traceId);
      if (!message) {
        sendJson(res, 404, { ok: false, error: "message_not_found", traceId });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        traceId,
        message,
      });
      return true;
    }

    if (req.method === "GET" && (url.pathname === "/flowbot/agent/messages/search" || url.pathname === "/flowbot/messages/search")) {
      const result = searchStoredMessages({
        roomId: url.searchParams.get("roomId"),
        sender: url.searchParams.get("sender"),
        senderId: url.searchParams.get("senderId"),
        query: url.searchParams.get("query") || url.searchParams.get("q"),
        content: url.searchParams.get("content"),
        traceId: url.searchParams.get("traceId"),
        msgType: url.searchParams.get("msgType"),
        fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
        toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
        hasMedia: url.searchParams.get("hasMedia"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        sort: url.searchParams.get("sort"),
        llmModel: url.searchParams.get("llmModel") || url.searchParams.get("model"),
        supportsVision: url.searchParams.get("supportsVision"),
        imageTransport: url.searchParams.get("imageTransport"),
        maxImages: url.searchParams.get("maxImages"),
      });
      sendJson(res, 200, {
        ok: true,
        filters: {
          roomId: String(url.searchParams.get("roomId") || "").trim(),
          sender: String(url.searchParams.get("sender") || "").trim(),
          senderId: String(url.searchParams.get("senderId") || "").trim(),
          query: String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim(),
          content: String(url.searchParams.get("content") || "").trim(),
          traceId: String(url.searchParams.get("traceId") || "").trim(),
          msgType: String(url.searchParams.get("msgType") || "").trim(),
          fromTime: String(url.searchParams.get("fromTime") || url.searchParams.get("from") || "").trim(),
          toTime: String(url.searchParams.get("toTime") || url.searchParams.get("to") || "").trim(),
          hasMedia: String(url.searchParams.get("hasMedia") || "").trim(),
          sort: String(url.searchParams.get("sort") || "desc").trim() || "desc",
        },
        ...result,
        indexPath: MESSAGE_SEARCH_INDEX_PATH,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/case-messages/search") {
      const result = searchCaseMessages({
        caseId: url.searchParams.get("caseId"),
        roomId: url.searchParams.get("roomId"),
        sender: url.searchParams.get("sender"),
        senderId: url.searchParams.get("senderId"),
        query: url.searchParams.get("query") || url.searchParams.get("q"),
        content: url.searchParams.get("content"),
        traceId: url.searchParams.get("traceId"),
        msgType: url.searchParams.get("msgType"),
        fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
        toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
        hasMedia: url.searchParams.get("hasMedia"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        sort: url.searchParams.get("sort"),
        llmModel: url.searchParams.get("llmModel") || url.searchParams.get("model"),
        supportsVision: url.searchParams.get("supportsVision"),
        imageTransport: url.searchParams.get("imageTransport"),
        maxImages: url.searchParams.get("maxImages"),
      });
      sendJson(res, 200, {
        ok: true,
        filters: {
          caseId: String(url.searchParams.get("caseId") || "").trim(),
          roomId: String(url.searchParams.get("roomId") || "").trim(),
          sender: String(url.searchParams.get("sender") || "").trim(),
          senderId: String(url.searchParams.get("senderId") || "").trim(),
          query: String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim(),
          content: String(url.searchParams.get("content") || "").trim(),
          traceId: String(url.searchParams.get("traceId") || "").trim(),
          msgType: String(url.searchParams.get("msgType") || "").trim(),
          fromTime: String(url.searchParams.get("fromTime") || url.searchParams.get("from") || "").trim(),
          toTime: String(url.searchParams.get("toTime") || url.searchParams.get("to") || "").trim(),
          hasMedia: String(url.searchParams.get("hasMedia") || "").trim(),
          sort: String(url.searchParams.get("sort") || "desc").trim() || "desc",
        },
        ...result,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/memory/search") {
      const result = searchUnifiedMemory({
        source: url.searchParams.get("source"),
        caseId: url.searchParams.get("caseId"),
        roomId: url.searchParams.get("roomId"),
        sender: url.searchParams.get("sender"),
        senderId: url.searchParams.get("senderId"),
        query: url.searchParams.get("query") || url.searchParams.get("q"),
        content: url.searchParams.get("content"),
        traceId: url.searchParams.get("traceId"),
        msgType: url.searchParams.get("msgType"),
        fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
        toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
        hasMedia: url.searchParams.get("hasMedia"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        sort: url.searchParams.get("sort"),
        llmModel: url.searchParams.get("llmModel") || url.searchParams.get("model"),
        supportsVision: url.searchParams.get("supportsVision"),
        imageTransport: url.searchParams.get("imageTransport"),
        maxImages: url.searchParams.get("maxImages"),
      });
      sendJson(res, 200, {
        ok: true,
        filters: {
          source: normalizeMemorySourceInput(url.searchParams.get("source")),
          caseId: String(url.searchParams.get("caseId") || "").trim(),
          roomId: String(url.searchParams.get("roomId") || "").trim(),
          sender: String(url.searchParams.get("sender") || "").trim(),
          senderId: String(url.searchParams.get("senderId") || "").trim(),
          query: String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim(),
          content: String(url.searchParams.get("content") || "").trim(),
          traceId: String(url.searchParams.get("traceId") || "").trim(),
          msgType: String(url.searchParams.get("msgType") || "").trim(),
          fromTime: String(url.searchParams.get("fromTime") || url.searchParams.get("from") || "").trim(),
          toTime: String(url.searchParams.get("toTime") || url.searchParams.get("to") || "").trim(),
          hasMedia: String(url.searchParams.get("hasMedia") || "").trim(),
          sort: String(url.searchParams.get("sort") || "desc").trim() || "desc",
        },
        ...result,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/messages/context-search") {
      const result = searchStoredMessagesWithContext({
        roomId: url.searchParams.get("roomId"),
        sender: url.searchParams.get("sender"),
        senderId: url.searchParams.get("senderId"),
        query: url.searchParams.get("query") || url.searchParams.get("q"),
        content: url.searchParams.get("content"),
        traceId: url.searchParams.get("traceId"),
        msgType: url.searchParams.get("msgType"),
        fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
        toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
        hasMedia: url.searchParams.get("hasMedia"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        sort: url.searchParams.get("sort"),
        contextBefore: url.searchParams.get("contextBefore"),
        contextAfter: url.searchParams.get("contextAfter"),
        llmModel: url.searchParams.get("llmModel") || url.searchParams.get("model"),
        supportsVision: url.searchParams.get("supportsVision"),
        imageTransport: url.searchParams.get("imageTransport"),
        maxImages: url.searchParams.get("maxImages"),
      });
      sendJson(res, 200, {
        ok: true,
        filters: {
          roomId: String(url.searchParams.get("roomId") || "").trim(),
          sender: String(url.searchParams.get("sender") || "").trim(),
          senderId: String(url.searchParams.get("senderId") || "").trim(),
          query: String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim(),
          content: String(url.searchParams.get("content") || "").trim(),
          traceId: String(url.searchParams.get("traceId") || "").trim(),
          msgType: String(url.searchParams.get("msgType") || "").trim(),
          fromTime: String(url.searchParams.get("fromTime") || url.searchParams.get("from") || "").trim(),
          toTime: String(url.searchParams.get("toTime") || url.searchParams.get("to") || "").trim(),
          hasMedia: String(url.searchParams.get("hasMedia") || "").trim(),
          sort: String(url.searchParams.get("sort") || "desc").trim() || "desc",
          contextBefore: Math.max(0, Math.min(MESSAGE_CONTEXT_MAX_NEIGHBORS, Number(url.searchParams.get("contextBefore")) || 2)),
          contextAfter: Math.max(0, Math.min(MESSAGE_CONTEXT_MAX_NEIGHBORS, Number(url.searchParams.get("contextAfter")) || 2)),
        },
        ...result,
        indexPath: MESSAGE_SEARCH_INDEX_PATH,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/room-summary") {
      try {
        const summary = getRoomSummary({
          roomId: url.searchParams.get("roomId"),
          sender: url.searchParams.get("sender"),
          senderId: url.searchParams.get("senderId"),
          query: url.searchParams.get("query") || url.searchParams.get("q"),
          content: url.searchParams.get("content"),
          msgType: url.searchParams.get("msgType"),
          fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
          toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
          hasMedia: url.searchParams.get("hasMedia"),
          sort: url.searchParams.get("sort"),
        });
        sendJson(res, 200, {
          ok: true,
          summary,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/date-summary") {
      try {
        const summary = getDateSummary({
          date: url.searchParams.get("date"),
          span: url.searchParams.get("span"),
          roomId: url.searchParams.get("roomId"),
          sender: url.searchParams.get("sender"),
          senderId: url.searchParams.get("senderId"),
          query: url.searchParams.get("query") || url.searchParams.get("q"),
          content: url.searchParams.get("content"),
          msgType: url.searchParams.get("msgType"),
          hasMedia: url.searchParams.get("hasMedia"),
        });
        sendJson(res, 200, {
          ok: true,
          summary,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/history-summary") {
      try {
        const summary = getHistorySummary({
          roomId: url.searchParams.get("roomId"),
          sender: url.searchParams.get("sender"),
          senderId: url.searchParams.get("senderId"),
          query: url.searchParams.get("query") || url.searchParams.get("q"),
          content: url.searchParams.get("content"),
          msgType: url.searchParams.get("msgType"),
          hasMedia: url.searchParams.get("hasMedia"),
          month: url.searchParams.get("month"),
          preset: url.searchParams.get("preset"),
          bucket: url.searchParams.get("bucket"),
          fromTime: url.searchParams.get("fromTime") || url.searchParams.get("from"),
          toTime: url.searchParams.get("toTime") || url.searchParams.get("to"),
          timeZone: url.searchParams.get("timeZone"),
        });
        sendJson(res, 200, {
          ok: true,
          summary,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/cases") {
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 10));
      sendJson(res, 200, {
        ok: true,
        roomId,
        query,
        limit,
        cases: searchCases({ roomId, query, limit }),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/case") {
      const caseId = String(url.searchParams.get("caseId") || "").trim();
      if (!caseId) {
        sendJson(res, 400, { ok: false, error: "case_id_required" });
        return true;
      }
      const caseItem = findCaseById(caseId);
      if (!caseItem) {
        sendJson(res, 404, { ok: false, error: "case_not_found", caseId });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        caseId,
        case: caseItem,
        progress: buildCaseProgressPayload(caseItem),
        artifacts: readCaseArtifacts(caseItem),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/cases/related") {
      sendJson(res, 200, {
        ok: true,
        result: findRelatedCases({
          caseId: url.searchParams.get("caseId"),
          roomId: url.searchParams.get("roomId"),
          query: url.searchParams.get("query") || url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        }),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/case-timeline") {
      const caseId = String(url.searchParams.get("caseId") || "").trim();
      if (!caseId) {
        sendJson(res, 400, { ok: false, error: "case_id_required" });
        return true;
      }
      const timeline = getCaseTimeline(caseId, {
        sort: url.searchParams.get("sort"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      if (!timeline) {
        sendJson(res, 404, { ok: false, error: "case_not_found", caseId });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        caseId,
        timeline,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/knowledge") {
      const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit")) || 5));
      const source = normalizeKnowledgeSourceInput(url.searchParams.get("source"));
      const knowledge = await searchKnowledgeDocuments(query, limit, { source });
      sendJson(res, 200, {
        ok: true,
        ...knowledge,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/knowledge-answer") {
      const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit")) || 5));
      const source = normalizeKnowledgeSourceInput(url.searchParams.get("source"));
      if (!query) {
        sendJson(res, 400, { ok: false, error: "query_required" });
        return true;
      }
      try {
        const result = await buildKnowledgeAnswer(query, limit, { source });
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
          answer: buildKnowledgeAnswerFallbackText(),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/knowledge-bot/ask") {
      const query = String(url.searchParams.get("query") || url.searchParams.get("q") || "").trim();
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      const traceId = String(url.searchParams.get("traceId") || "").trim();
      if (!query) {
        sendJson(res, 400, { ok: false, error: "query_required" });
        return true;
      }
      if (!askKnowledgeBot || !isRagflowBotReady?.()) {
        sendJson(res, 400, { ok: false, error: "knowledge_bot_not_configured" });
        return true;
      }
      try {
        const result = await askKnowledgeBot({ query, roomId, traceId });
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
          provider: "ragflow",
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/agent/knowledge-candidates") {
      const status = String(url.searchParams.get("status") || "").trim();
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
      sendJson(res, 200, {
        ok: true,
        status,
        roomId,
        limit,
        candidates: listKnowledgeCandidates({ status, roomId, limit }),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/knowledge-harvest/messages") {
      const status = String(url.searchParams.get("status") || "").trim();
      const roomId = String(url.searchParams.get("roomId") || "").trim();
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
      const state = readKnowledgeHarvestState ? readKnowledgeHarvestState() : { messages: {} };
      const messages = Object.values(state.messages || {})
        .filter((item) => item && typeof item === "object")
        .filter((item) => !status || String(item.status || "") === status)
        .filter((item) => !roomId || String(item.roomId || "") === roomId)
        .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "processingStartedAt", "receivedAt", "sendTimeIso", "createdAt"]))
        .slice(0, limit);
      sendJson(res, 200, {
        ok: true,
        status,
        roomId,
        limit,
        count: messages.length,
        messages,
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/knowledge-harvest/promote") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const traceId = String(body.traceId || "").trim();
      if (!traceId) {
        sendJson(res, 400, { ok: false, error: "trace_id_required" });
        return true;
      }
      const state = readKnowledgeHarvestState ? readKnowledgeHarvestState() : { messages: {} };
      const entry = state.messages?.[traceId];
      if (!entry) {
        sendJson(res, 404, { ok: false, error: "harvest_message_not_found", traceId });
        return true;
      }
      if (String(entry.status || "") === "candidate" && entry.candidateId) {
        sendJson(res, 200, {
          ok: true,
          alreadyPromoted: true,
          candidate: findKnowledgeCandidate(entry.candidateId),
        });
        return true;
      }
      const now = new Date().toISOString();
      const content = String(body.content || entry.contentPreview || "").trim();
      const title = String(body.title || content.slice(0, 48) || "人工转入审核的群消息").trim();
      const candidateId = buildKnowledgeCandidateId ? buildKnowledgeCandidateId([traceId, now]) : `KNOW-${Date.now()}`;
      const candidate = {
        candidateId,
        source: "group_message",
        status: "pending_review",
        roomId: String(entry.roomId || "").trim(),
        roomName: String(entry.roomName || entry.roomId || "").trim(),
        traceIds: [traceId],
        title,
        scope: String(body.scope || entry.roomName || entry.roomId || "").trim(),
        problem: String(body.problem || "这条群消息原本被模型忽略，人工认为可能需要沉淀。").trim(),
        solution: content,
        knowledgeStatus: "uncertain",
        recommendation: "needs_human_review",
        existingKnowledgeIds: [],
        existingKnowledgeSummary: "",
        delta: "人工从已忽略消息转入审核，需审核人判断是否入库或覆盖已有知识。",
        tags: [],
        evidence: [content].filter(Boolean),
        reason: String(body.reason || entry.reason || entry.lastError || "人工转入知识审核。").trim(),
        confidence: "-",
        createdAt: now,
        updatedAt: now,
        sourceMessage: {
          traceId,
          senderName: entry.senderName || entry.senderId || "",
          sendTimeIso: entry.sendTimeIso || entry.receivedAt || "",
          content,
        },
        contextMessages: [],
        relatedKnowledge: [],
        classifierRawOutput: "",
        manuallyPromotedFromHarvest: true,
        originalHarvestStatus: String(entry.status || ""),
      };
      appendKnowledgeCandidate(candidate);
      if (patchKnowledgeHarvestMessages) {
        patchKnowledgeHarvestMessages([{
          traceId,
          status: "candidate",
          candidateId,
          reason: "人工转入知识审核",
          promotedAt: now,
        }]);
      }
      sendJson(res, 200, {
        ok: true,
        candidate,
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/agent/knowledge-candidates/action") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const candidateId = String(body.candidateId || "").trim();
      const action = String(body.action || "").trim();
      if (!candidateId) {
        sendJson(res, 400, { ok: false, error: "candidate_id_required" });
        return true;
      }
      const candidate = findKnowledgeCandidate(candidateId);
      if (!candidate) {
        sendJson(res, 404, { ok: false, error: "candidate_not_found", candidateId });
        return true;
      }
      const editablePatch = normalizeKnowledgeCandidatePatch(body);
      if (action === "save" || action === "update" || action === "edit") {
        const now = new Date().toISOString();
        const updated = rewriteKnowledgeCandidate(candidateId, {
          ...editablePatch,
          editedAt: now,
          reviewedAt: editablePatch.reviewer || editablePatch.reviewNote ? now : candidate.reviewedAt,
        });
        appendKnowledgePublishResult({
          receivedAt: now,
          candidateId,
          status: "edited",
          target: "local",
          reviewer: editablePatch.reviewer || "",
          reviewNote: editablePatch.reviewNote || "",
        });
        sendJson(res, 200, {
          ok: true,
          action: "save",
          candidate: updated,
        });
        return true;
      }
      if (action === "approve" || action === "publish") {
        const now = new Date().toISOString();
        const published = publishKnowledgeCandidateToLocal(candidate, {
          ...editablePatch,
          reviewedAt: now,
        });
        const updated = rewriteKnowledgeCandidate(candidateId, published);
        sendJson(res, 200, {
          ok: true,
          action: "publish",
          candidate: updated,
        });
        return true;
      }
      if (action === "update_existing" || action === "merge_existing") {
        const now = new Date().toISOString();
        const updatedExisting = updateExistingKnowledgeFromCandidate(candidate, {
          ...editablePatch,
          reviewedAt: now,
        });
        const updated = rewriteKnowledgeCandidate(candidateId, updatedExisting);
        sendJson(res, 200, {
          ok: true,
          action: "update_existing",
          candidate: updated,
        });
        return true;
      }
      if (action === "reject") {
        const now = new Date().toISOString();
        const rejectReason = String(body.rejectReason || body.reviewNote || body.note || "").trim();
        const updated = rewriteKnowledgeCandidate(candidateId, {
          ...editablePatch,
          status: "rejected",
          reviewedAt: now,
          rejectedAt: now,
          rejectReason,
        });
        appendKnowledgePublishResult({
          receivedAt: now,
          candidateId,
          status: "rejected",
          target: "local",
          reason: rejectReason,
          reviewer: editablePatch.reviewer || "",
          reviewNote: editablePatch.reviewNote || "",
        });
        sendJson(res, 200, {
          ok: true,
          action: "reject",
          candidate: updated,
        });
        return true;
      }
      sendJson(res, 400, { ok: false, error: "invalid_action", action });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/knowledge-harvest/process") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      try {
        const result = await runKnowledgeHarvestProcessor({
          ignoreReadyAge: normalizeBooleanInput(body.ignoreReadyAge, false),
          roomId: String(body.roomId || "").trim(),
        });
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/agent/reply") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const taskId = String(body.taskId || "").trim();
      const content = String(body.content || "").trim();
      if (!content) {
        sendJson(res, 400, { ok: false, error: "content_required" });
        return true;
      }
      let guid = String(body.guid || "").trim();
      let conversationId = String(body.conversationId || body.roomId || "").trim();
      let task = null;
      if (taskId) {
        task = findAgentTaskById(taskId);
        if (!task) {
          sendJson(res, 404, { ok: false, error: "task_not_found", taskId });
          return true;
        }
        guid = guid || String(task.guid || "").trim();
        conversationId = conversationId || String(task.rawRoomId || task.roomId || "").trim();
      }
      if (!conversationId) {
        sendJson(res, 400, { ok: false, error: "conversation_id_required" });
        return true;
      }
      try {
        const sendResult = await sendAgentReplyMessage({
          task,
          guid,
          conversationId,
          content,
        });
        const sentAt = new Date().toISOString();
        if (taskId) {
          patchAgentTasks([
            {
              taskId,
              status: "replied",
              responseSummary: content.slice(0, 200),
              replySentAt: sentAt,
            },
          ]);
        }
        sendJson(res, 200, {
          ok: true,
          taskId,
          guid,
          conversationId,
          platform: sendResult.platform,
          sentAt,
          response: sendResult.response,
        });
      } catch (error) {
        if (taskId) {
          patchAgentTasks([
            {
              taskId,
              status: "failed",
              note: String(error?.message || error),
            },
          ]);
        }
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/agent/tasks/ack") {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const taskId = String(body.taskId || "").trim();
      const status = String(body.status || "").trim() || "completed";
      if (!taskId) {
        sendJson(res, 400, { ok: false, error: "task_id_required" });
        return true;
      }
      patchAgentTasks([
        buildAckTaskPatch(findAgentTaskById(taskId), {
          taskId,
          status,
          handler: body.handler,
          note: body.note,
          responseSummary: body.responseSummary,
          agentStartedAt: body.agentStartedAt,
          agentFinishedAt: body.agentFinishedAt,
          replySentAt: body.replySentAt,
          llmSteps: body.llmSteps,
          toolCallCount: body.toolCallCount,
          toolNames: body.toolNames,
          toolCalls: body.toolCalls,
          completedAt: body.completedAt,
        }),
      ]);
      sendJson(res, 200, { ok: true, taskId, status });
      return true;
    }

    return false;
  }

  return {
    handleAgentApiRoute,
  };
}

module.exports = {
  createAgentApiRoutes,
};
