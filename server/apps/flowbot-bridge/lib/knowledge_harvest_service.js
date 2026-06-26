"use strict";

function createKnowledgeHarvestService({
  DATA_DIR,
  KNOWLEDGE_CANDIDATES_PATH,
  KNOWLEDGE_DIR,
  KNOWLEDGE_HARVEST_ENABLED,
  KNOWLEDGE_HARVEST_MAX_PER_SCAN,
  KNOWLEDGE_HARVEST_READY_AGE_MS,
  KNOWLEDGE_HARVEST_ROOM_IDS,
  LLM_CLASSIFY_ENABLED,
  NORMALIZED_LOG_PATH,
  appendKnowledgePublishResult,
  assertSafeLocalKnowledgePath,
  compareTimeDesc,
  dedupeMessageEventsByTraceId,
  findLocalKnowledgeDocument,
  fs,
  hashText,
  loadNormalizedMessageMap,
  messageTimestampMs,
  mysqlRuntimeStore,
  patchKnowledgeHarvestMessages,
  path,
  readJsonlFile,
  readKnowledgeHarvestState,
  requestLlmClassify,
  searchKnowledgeDocuments,
  tryParseClassifyJson,
  upsertKnowledgeCandidateIndex,
  writeKnowledgeHarvestState,
}) {
  const KNOWLEDGE_HARVEST_GROUP_WINDOW_MS = 5 * 60 * 1000;
  const KNOWLEDGE_HARVEST_MAX_MESSAGES_PER_GROUP = 12;
  const KNOWLEDGE_HARVEST_CONCURRENCY = 3;

  function isKnowledgeHarvestRoomAllowed(message) {
    if (!KNOWLEDGE_HARVEST_ENABLED) {
      return false;
    }
    if (!KNOWLEDGE_HARVEST_ROOM_IDS.size) {
      return true;
    }
    const roomId = String(message?.roomId || "").trim();
    return Boolean(roomId && KNOWLEDGE_HARVEST_ROOM_IDS.has(roomId));
  }

  function normalizeKnowledgeHarvestText(message) {
    return [
      message?.content,
      message?.quoteContent,
      message?.title,
      message?.desc,
    ].filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
  }

  function shouldQueueKnowledgeHarvestMessage(message) {
    if (!isKnowledgeHarvestRoomAllowed(message)) {
      return false;
    }
    const traceId = String(message?.traceId || "").trim();
    if (!traceId) {
      return false;
    }
    const text = normalizeKnowledgeHarvestText(message);
    if (text.length < 8) {
      return false;
    }
    if (/^\[(图片|视频|文件|语音|表情)\]/.test(text)) {
      return false;
    }
    return true;
  }

  function enqueueKnowledgeHarvestMessage(message) {
    if (!shouldQueueKnowledgeHarvestMessage(message)) {
      return null;
    }
    const traceId = String(message?.traceId || "").trim();
    const state = readKnowledgeHarvestState();
    const existing = state.messages[traceId];
    if (existing && String(existing.status || "") !== "pending") {
      return existing;
    }
    const now = new Date().toISOString();
    state.messages[traceId] = {
      ...(existing || {}),
      traceId,
      roomId: String(message?.roomId || "").trim(),
      roomName: String(message?.roomName || message?.roomId || "").trim(),
      senderName: String(message?.senderName || message?.senderId || "").trim(),
      senderId: String(message?.senderId || "").trim(),
      contentPreview: normalizeKnowledgeHarvestText(message).slice(0, 200),
      sendTimeIso: String(message?.sendTimeIso || message?.receivedAt || now).trim(),
      receivedAt: String(message?.receivedAt || now).trim(),
      status: "pending",
      attempts: Number(existing?.attempts || 0),
      createdAt: String(existing?.createdAt || now),
      updatedAt: now,
    };
    writeKnowledgeHarvestState(state);
    return state.messages[traceId];
  }

  function appendKnowledgeCandidate(candidate) {
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.appendJsonl(DATA_DIR, KNOWLEDGE_CANDIDATES_PATH, candidate);
      upsertKnowledgeCandidateIndex(candidate);
      return;
    }
    fs.appendFileSync(KNOWLEDGE_CANDIDATES_PATH, `${JSON.stringify(candidate)}\n`, "utf8");
    upsertKnowledgeCandidateIndex(candidate);
  }

  function listKnowledgeCandidates({ status = "", roomId = "", limit = Number.MAX_SAFE_INTEGER } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Number(limit) || Number.MAX_SAFE_INTEGER));
    const selectedStatus = String(status || "").trim();
    const selectedRoomId = String(roomId || "").trim();
    return readJsonlFile(KNOWLEDGE_CANDIDATES_PATH, Number.MAX_SAFE_INTEGER)
      .filter((item) => item && typeof item === "object")
      .filter((item) => !selectedStatus || String(item.status || "") === selectedStatus)
      .filter((item) => !selectedRoomId || String(item.roomId || item.room_id || "") === selectedRoomId)
      .sort((left, right) => compareTimeDesc(left, right, ["updatedAt", "createdAt"]))
      .slice(0, safeLimit);
  }

  function findKnowledgeCandidate(candidateId) {
    const id = String(candidateId || "").trim();
    if (!id) {
      return null;
    }
    const items = readJsonlFile(KNOWLEDGE_CANDIDATES_PATH, Number.MAX_SAFE_INTEGER);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (String(item?.candidateId || "") === id) {
        return item;
      }
    }
    return null;
  }

  function rewriteKnowledgeCandidate(candidateId, patch) {
    const id = String(candidateId || "").trim();
    if (!id) {
      return null;
    }
    const items = readJsonlFile(KNOWLEDGE_CANDIDATES_PATH, Number.MAX_SAFE_INTEGER);
    let updated = null;
    const now = new Date().toISOString();
    const nextItems = items.map((item) => {
      if (String(item?.candidateId || "") !== id) {
        return item;
      }
      updated = {
        ...item,
        ...patch,
        candidateId: id,
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) {
      return null;
    }
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.rewriteJsonl(DATA_DIR, KNOWLEDGE_CANDIDATES_PATH, nextItems);
    } else {
      fs.writeFileSync(
        KNOWLEDGE_CANDIDATES_PATH,
        nextItems.length ? `${nextItems.map((item) => JSON.stringify(item)).join("\n")}\n` : "",
        "utf8",
      );
    }
    upsertKnowledgeCandidateIndex(updated);
    return updated;
  }

  function buildKnowledgeCandidateId(traceIds) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `KNOW-${stamp}-${hashText((traceIds || []).join("|") || String(Math.random())).slice(0, 6)}`;
  }

  function sanitizeKnowledgeFileName(title, candidateId) {
    const base = String(title || candidateId || "knowledge")
      .replace(/[\\/:*?"<>|#\r\n\t]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return `${base || candidateId || "knowledge"}.md`;
  }

  function formatKnowledgeCandidateMarkdown(candidate) {
    const tags = Array.isArray(candidate.tags) ? candidate.tags.filter(Boolean) : [];
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.filter(Boolean) : [];
    const traceIds = Array.isArray(candidate.traceIds) ? candidate.traceIds : [];
    const reviewer = String(candidate.reviewer || "").trim();
    const reviewNote = String(candidate.reviewNote || "").trim();
    const lines = [
      `# ${String(candidate.title || candidate.candidateId || "未命名知识").trim()}`,
      "",
      `来源：群消息`,
      `状态：已审核`,
      `适用范围：${String(candidate.scope || "待补充").trim()}`,
      `标签：${tags.join(", ") || "待补充"}`,
      `关联消息：${traceIds.join(", ") || "无"}`,
      `生成时间：${String(candidate.publishedAt || candidate.updatedAt || candidate.createdAt || new Date().toISOString()).trim()}`,
      ...(reviewer || reviewNote ? [
        `审核人：${reviewer || "未填写"}`,
        `审核备注：${reviewNote || "无"}`,
      ] : []),
      "",
      "## 问题或场景",
      "",
      String(candidate.problem || candidate.question || "待补充").trim(),
      "",
      "## 处理办法",
      "",
      String(candidate.solution || candidate.answer || "待补充").trim(),
      "",
      "## 判断依据",
      "",
      String(candidate.reason || "来自群消息沉淀，经人工审核后发布。").trim(),
      "",
      "## 原始证据",
      "",
      ...(evidence.length ? evidence.map((item) => `- ${String(item).replace(/\s+/g, " ").trim()}`) : ["- 无"]),
      "",
    ];
    return `${lines.join("\n")}\n`;
  }

  function formatKnowledgeCandidateUpdateMarkdown(candidate) {
    const tags = Array.isArray(candidate.tags) ? candidate.tags.filter(Boolean) : [];
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.filter(Boolean) : [];
    const traceIds = Array.isArray(candidate.traceIds) ? candidate.traceIds : [];
    const reviewer = String(candidate.reviewer || "").trim();
    const reviewNote = String(candidate.reviewNote || "").trim();
    const lines = [
      "",
      "---",
      "",
      `## 人工审核补充：${String(candidate.title || candidate.candidateId || "未命名补充").trim()}`,
      "",
      `补充时间：${String(candidate.updatedExistingAt || candidate.reviewedAt || new Date().toISOString()).trim()}`,
      `适用范围：${String(candidate.scope || "待补充").trim()}`,
      `标签：${tags.join(", ") || "待补充"}`,
      `关联消息：${traceIds.join(", ") || "无"}`,
      ...(reviewer || reviewNote ? [
        `审核人：${reviewer || "未填写"}`,
        `审核备注：${reviewNote || "无"}`,
      ] : []),
      "",
      "### 新增场景",
      "",
      String(candidate.problem || candidate.question || "待补充").trim(),
      "",
      "### 补充处理办法",
      "",
      String(candidate.solution || candidate.answer || "待补充").trim(),
      "",
      "### 补充依据",
      "",
      String(candidate.reason || candidate.delta || "来自群消息沉淀，经人工审核后追加到已有知识。").trim(),
      "",
      "### 原始证据",
      "",
      ...(evidence.length ? evidence.map((item) => `- ${String(item).replace(/\s+/g, " ").trim()}`) : ["- 无"]),
      "",
    ];
    return `${lines.join("\n")}\n`;
  }

  function publishKnowledgeCandidateToLocal(candidate, patch = {}) {
    const now = new Date().toISOString();
    const merged = {
      ...candidate,
      ...patch,
      status: "published",
      publishedAt: now,
      updatedAt: now,
    };
    const knowledgeDir = path.join(KNOWLEDGE_DIR, "generated");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const fileName = sanitizeKnowledgeFileName(merged.title, merged.candidateId);
    const filePath = path.join(knowledgeDir, fileName);
    fs.writeFileSync(filePath, formatKnowledgeCandidateMarkdown(merged), "utf8");
    appendKnowledgePublishResult({
      receivedAt: now,
      candidateId: merged.candidateId,
      status: "published",
      target: "local",
      filePath,
      title: merged.title,
      reviewer: merged.reviewer || "",
      reviewNote: merged.reviewNote || "",
      reviewedAt: merged.reviewedAt || "",
    });
    return {
      ...merged,
      publishedTarget: "local",
      publishedPath: filePath,
    };
  }

  function updateExistingKnowledgeFromCandidate(candidate, patch = {}) {
    const now = new Date().toISOString();
    const targetId = String(patch.targetKnowledgeId || patch.existingKnowledgeId || "").trim();
    const targetFileName = String(patch.targetKnowledgeFileName || patch.existingKnowledgeFileName || "").trim();
    const target = findLocalKnowledgeDocument({ id: targetId, fileName: targetFileName });
    if (!target) {
      throw new Error("target_knowledge_not_found");
    }
    const filePath = assertSafeLocalKnowledgePath(target.path);
    const merged = {
      ...candidate,
      ...patch,
      status: "updated_existing",
      updatedExistingAt: now,
      reviewedAt: patch.reviewedAt || now,
      updatedAt: now,
      targetKnowledge: {
        id: target.id,
        title: target.title,
        fileName: target.fileName,
        path: filePath,
      },
    };
    fs.appendFileSync(filePath, formatKnowledgeCandidateUpdateMarkdown(merged), "utf8");
    appendKnowledgePublishResult({
      receivedAt: now,
      candidateId: merged.candidateId,
      status: "updated_existing",
      target: "local",
      filePath,
      fileName: target.fileName,
      targetKnowledgeId: target.id,
      title: merged.title,
      reviewer: merged.reviewer || "",
      reviewNote: merged.reviewNote || "",
      reviewedAt: merged.reviewedAt || "",
    });
    return {
      ...merged,
      publishedTarget: "local",
      updatedExistingPath: filePath,
    };
  }

  function formatKnowledgeHarvestContextMessage(item) {
    return {
      trace_id: item.traceId,
      sender: item.senderName || item.senderId || "",
      time: item.sendTimeIso || item.receivedAt || "",
      type: item.msgTypeName || item.msgType || "",
      content: normalizeKnowledgeHarvestText(item).slice(0, 500),
    };
  }

  function buildKnowledgeHarvestContext(messageOrMessages) {
    const groupMessages = Array.isArray(messageOrMessages) ? messageOrMessages.filter(Boolean) : [messageOrMessages].filter(Boolean);
    const firstMessage = groupMessages[0] || {};
    const lastMessage = groupMessages[groupMessages.length - 1] || firstMessage;
    const roomId = String(firstMessage?.roomId || "").trim();
    const firstTraceId = String(firstMessage?.traceId || "").trim();
    const lastTraceId = String(lastMessage?.traceId || firstTraceId).trim();
    const events = dedupeMessageEventsByTraceId(
      readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER),
      { prefer: "last" },
    )
      .filter((item) => String(item?.roomId || "").trim() === roomId)
      .sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    const firstIndex = events.findIndex((item) => String(item?.traceId || "") === firstTraceId);
    const lastIndex = events.findIndex((item) => String(item?.traceId || "") === lastTraceId);
    const startIndex = firstIndex >= 0 ? firstIndex : lastIndex;
    const endIndex = lastIndex >= 0 ? lastIndex : firstIndex;
    const start = startIndex >= 0 ? Math.max(0, startIndex - 4) : 0;
    const end = endIndex >= 0 ? Math.min(events.length, endIndex + 5) : events.length;
    return events.slice(start, end).map(formatKnowledgeHarvestContextMessage);
  }

  function normalizeRelatedKnowledgeForHarvest(docs) {
    return (Array.isArray(docs) ? docs : []).slice(0, 5).map((item) => ({
      id: String(item?.id || "").trim(),
      source: String(item?.source || "").trim(),
      title: String(item?.title || "").trim(),
      fileName: String(item?.fileName || "").trim(),
      score: item?.score ?? null,
      snippet: String(item?.snippet || "").replace(/\s+/g, " ").trim().slice(0, 500),
    }));
  }

  function buildKnowledgeHarvestSearchQuery(messageOrMessages, contextMessages) {
    const groupMessages = Array.isArray(messageOrMessages) ? messageOrMessages.filter(Boolean) : [messageOrMessages].filter(Boolean);
    const targetText = groupMessages
      .map((message) => normalizeKnowledgeHarvestText(message))
      .filter(Boolean)
      .join("\n");
    const contextText = (Array.isArray(contextMessages) ? contextMessages : [])
      .map((item) => String(item?.content || "").trim())
      .filter(Boolean)
      .join("\n");
    return [
      targetText,
      contextText,
    ].filter(Boolean).join("\n").slice(0, 1200);
  }

  function buildKnowledgeHarvestMessages(messageOrMessages, contextMessages, relatedKnowledge = []) {
    const groupMessages = Array.isArray(messageOrMessages) ? messageOrMessages.filter(Boolean) : [messageOrMessages].filter(Boolean);
    const targetMessage = groupMessages[0] || {};
    const targetMessages = groupMessages.map((message) => ({
      trace_id: message.traceId,
      sender: message.senderName || message.senderId || "",
      time: message.sendTimeIso || message.receivedAt || "",
      type: message.msgTypeName || message.msgType || "",
      content: normalizeKnowledgeHarvestText(message),
    }));
    const schemaText = [
      "{",
      '  "action": "ignore|candidate",',
      '  "knowledge_status": "new|possibly_existing|already_exists|update_existing|uncertain",',
      '  "recommendation": "add_new|update_existing|do_not_add|needs_human_review",',
      '  "title": "适合进入知识库的标题，action=ignore 时可为空",',
      '  "scope": "适用系统/模块/场景",',
      '  "problem": "用户会遇到的问题或业务场景",',
      '  "solution": "可执行的处理办法、结论或注意事项",',
      '  "existing_knowledge_ids": ["你认为相关的已有知识 id"],',
      '  "existing_knowledge_summary": "如果已有相似知识，概括它们已经覆盖了什么；没有则为空",',
      '  "delta": "当前群消息相比已有知识新增/修正了什么；没有则为空",',
      '  "tags": ["关键词"],',
      '  "evidence": ["引用式概括原始消息，不要编造"],',
      '  "reason": "为什么值得或不值得沉淀",',
      '  "confidence": 0.0',
      "}",
    ].join("\n");
    return [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: [
              "你是客服群消息知识沉淀助手。",
              "你只从标准化群消息判断是否应该升级知识库，不能依赖 case 归档结果。",
              "你会看到一组同群、相近时间的消息。请把这组消息放在一起判断，不要只看单条。",
              "只有当消息包含可复用的处理结论、操作步骤、故障原因、规避办法、产品规则、配置说明、排查路径时，才输出 candidate。",
              "单纯报障、闲聊、追问、没有结论的现象描述、无法验证的猜测，一律 ignore。",
              "如果上下文中同时出现问题和明确解决办法，可以整理为 candidate。",
              "你还会看到当前知识库里检索到的 related_knowledge。请判断当前群消息是新增知识、已有知识重复，还是适合更新某条已有知识。",
              "即使你认为知识库里已经有了，只要这段群消息有明确结论，也可以输出 candidate，并把 knowledge_status 标为 already_exists 或 possibly_existing，recommendation 标为 do_not_add 或 needs_human_review。",
              "不要因为可能重复就丢弃；你的职责是初步筛选和列出依据，最终是否加入知识库由人工决定。",
              "不要编造没有出现在消息里的解决方案；信息不足时 ignore。",
              "必须只输出合法 JSON，不要输出 markdown 或解释。",
              "输出结构必须严格符合以下 schema：",
              schemaText,
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              target_trace_id: targetMessage.traceId,
              target_trace_ids: targetMessages.map((item) => item.trace_id).filter(Boolean),
              room_id: targetMessage.roomId,
              target_message: {
                sender: targetMessage.senderName || targetMessage.senderId || "",
                time: targetMessage.sendTimeIso || targetMessage.receivedAt || "",
                type: targetMessage.msgTypeName || targetMessage.msgType || "",
                content: normalizeKnowledgeHarvestText(targetMessage),
              },
              target_messages: targetMessages,
              nearby_messages: contextMessages,
              related_knowledge: relatedKnowledge,
            }, null, 2),
          },
        ],
      },
    ];
  }

  function validateKnowledgeHarvestPayload(value) {
    if (!value || typeof value !== "object") {
      throw new Error("schema_invalid:not_object");
    }
    const action = String(value.action || "").trim();
    if (!["ignore", "candidate"].includes(action)) {
      throw new Error(`schema_invalid:action:${action || "empty"}`);
    }
    const confidence = Math.max(0, Math.min(1, Number(value.confidence || 0)));
    const result = {
      action,
      knowledgeStatus: String(value.knowledge_status || value.knowledgeStatus || "uncertain").trim(),
      recommendation: String(value.recommendation || "needs_human_review").trim(),
      title: String(value.title || "").trim(),
      scope: String(value.scope || "").trim(),
      problem: String(value.problem || "").trim(),
      solution: String(value.solution || "").trim(),
      existingKnowledgeIds: Array.isArray(value.existing_knowledge_ids || value.existingKnowledgeIds)
        ? (value.existing_knowledge_ids || value.existingKnowledgeIds).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10)
        : [],
      existingKnowledgeSummary: String(value.existing_knowledge_summary || value.existingKnowledgeSummary || "").trim(),
      delta: String(value.delta || "").trim(),
      tags: Array.isArray(value.tags) ? value.tags.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [],
      evidence: Array.isArray(value.evidence) ? value.evidence.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [],
      reason: String(value.reason || "").trim(),
      confidence,
    };
    if (!["new", "possibly_existing", "already_exists", "update_existing", "uncertain"].includes(result.knowledgeStatus)) {
      result.knowledgeStatus = "uncertain";
    }
    if (!["add_new", "update_existing", "do_not_add", "needs_human_review"].includes(result.recommendation)) {
      result.recommendation = "needs_human_review";
    }
    if (action === "candidate") {
      if (!result.title || !result.problem || !result.solution) {
        throw new Error("schema_invalid:candidate_required_fields");
      }
      if (result.confidence < 0.55) {
        result.action = "ignore";
        result.reason = result.reason || "confidence_too_low";
      }
    }
    return result;
  }

  async function judgeKnowledgeCandidateByLlm(messageOrMessages) {
    const groupMessages = Array.isArray(messageOrMessages) ? messageOrMessages.filter(Boolean) : [messageOrMessages].filter(Boolean);
    const contextMessages = buildKnowledgeHarvestContext(groupMessages);
    const query = buildKnowledgeHarvestSearchQuery(groupMessages, contextMessages);
    let relatedKnowledge = [];
    if (query) {
      try {
        const result = await searchKnowledgeDocuments(query, 5, { source: "all" });
        relatedKnowledge = normalizeRelatedKnowledgeForHarvest(result.docs);
      } catch {
        relatedKnowledge = [];
      }
    }
    const rawOutput = await requestLlmClassify(buildKnowledgeHarvestMessages(groupMessages, contextMessages, relatedKnowledge));
    return {
      rawOutput,
      contextMessages,
      relatedKnowledge,
      ...validateKnowledgeHarvestPayload(tryParseClassifyJson(rawOutput)),
    };
  }

  function listEligibleKnowledgeHarvestMessages({ ignoreReadyAge = false, limit = KNOWLEDGE_HARVEST_MAX_PER_SCAN, roomId = "" } = {}) {
    const state = readKnowledgeHarvestState();
    const normalizedMap = loadNormalizedMessageMap();
    const now = Date.now();
    const selectedRoomId = String(roomId || "").trim();
    return Object.values(state.messages || {})
      .filter((entry) => String(entry?.status || "") === "pending")
      .filter((entry) => !selectedRoomId || String(entry?.roomId || "").trim() === selectedRoomId)
      .map((entry) => normalizedMap.get(String(entry.traceId || "")))
      .filter(Boolean)
      .filter((message) => {
        const receivedAt = Date.parse(String(message?.receivedAt || message?.sendTimeIso || ""));
        return ignoreReadyAge || !Number.isFinite(receivedAt) || now - receivedAt >= KNOWLEDGE_HARVEST_READY_AGE_MS;
      })
      .sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right))
      .slice(0, Math.max(1, Number(limit) || KNOWLEDGE_HARVEST_MAX_PER_SCAN));
  }

  function buildKnowledgeHarvestGroups(messages) {
    const byRoom = new Map();
    for (const message of Array.isArray(messages) ? messages : []) {
      const roomId = String(message?.roomId || "").trim();
      if (!roomId) {
        continue;
      }
      if (!byRoom.has(roomId)) {
        byRoom.set(roomId, []);
      }
      byRoom.get(roomId).push(message);
    }
    const groups = [];
    for (const [roomId, roomMessages] of byRoom.entries()) {
      const sorted = roomMessages
        .filter(Boolean)
        .sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
      let current = [];
      let groupStartedAt = 0;
      const flush = () => {
        if (!current.length) {
          return;
        }
        groups.push({
          roomId,
          traceIds: current.map((item) => String(item?.traceId || "").trim()).filter(Boolean),
          messages: current,
          firstTimeMs: groupStartedAt,
          lastTimeMs: messageTimestampMs(current[current.length - 1]),
        });
        current = [];
        groupStartedAt = 0;
      };
      for (const message of sorted) {
        const currentTime = messageTimestampMs(message);
        if (!current.length) {
          current = [message];
          groupStartedAt = currentTime;
          continue;
        }
        const windowExceeded = Number.isFinite(currentTime)
          && Number.isFinite(groupStartedAt)
          && currentTime - groupStartedAt > KNOWLEDGE_HARVEST_GROUP_WINDOW_MS;
        if (windowExceeded || current.length >= KNOWLEDGE_HARVEST_MAX_MESSAGES_PER_GROUP) {
          flush();
          current = [message];
          groupStartedAt = currentTime;
          continue;
        }
        current.push(message);
      }
      flush();
    }
    return groups.sort((left, right) => left.firstTimeMs - right.firstTimeMs);
  }

  function listEligibleKnowledgeHarvestGroups({ ignoreReadyAge = false, limit = KNOWLEDGE_HARVEST_MAX_PER_SCAN, roomId = "" } = {}) {
    const scanLimit = Math.max(1, Number(limit) || KNOWLEDGE_HARVEST_MAX_PER_SCAN);
    const messages = listEligibleKnowledgeHarvestMessages({
      ignoreReadyAge,
      limit: scanLimit * KNOWLEDGE_HARVEST_MAX_MESSAGES_PER_GROUP,
      roomId,
    });
    return buildKnowledgeHarvestGroups(messages).slice(0, scanLimit);
  }

  async function mapKnowledgeHarvestGroupsConcurrently(groups, worker) {
    const items = Array.isArray(groups) ? groups : [];
    const concurrency = Math.max(1, Math.min(KNOWLEDGE_HARVEST_CONCURRENCY, items.length || 1));
    let cursor = 0;
    const results = [];
    async function runNext() {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => runNext()));
    return results;
  }

  async function runKnowledgeHarvestProcessor({ ignoreReadyAge = false, roomId = "" } = {}) {
    if (!KNOWLEDGE_HARVEST_ENABLED) {
      return { ok: true, enabled: false, processed: 0, candidates: 0, ignored: 0, failed: 0 };
    }
    if (!LLM_CLASSIFY_ENABLED) {
      return { ok: false, enabled: true, error: "llm_classify_disabled", processed: 0, candidates: 0, ignored: 0, failed: 0 };
    }
    const groups = listEligibleKnowledgeHarvestGroups({ ignoreReadyAge, roomId });
    let candidates = 0;
    let ignored = 0;
    let failed = 0;
    let processed = 0;
    await mapKnowledgeHarvestGroupsConcurrently(groups, async (group) => {
      const groupMessages = Array.isArray(group?.messages) ? group.messages : [];
      const traceIds = groupMessages.map((message) => String(message?.traceId || "").trim()).filter(Boolean);
      if (!traceIds.length) {
        return;
      }
      const state = readKnowledgeHarvestState();
      const now = new Date().toISOString();
      patchKnowledgeHarvestMessages(traceIds.map((traceId) => ({
        traceId,
        status: "processing",
        attempts: Number(state.messages?.[traceId]?.attempts || 0) + 1,
        processingStartedAt: now,
        groupTraceIds: traceIds,
      })));
      try {
        const judgement = await judgeKnowledgeCandidateByLlm(groupMessages);
        if (judgement.action === "candidate") {
          const candidateTraceIds = Array.from(new Set(
            [
              ...traceIds,
              ...(judgement.contextMessages || [])
                .map((item) => String(item?.trace_id || "").trim())
                .filter(Boolean),
            ],
          ));
          const sourceMessage = groupMessages[0] || {};
          const candidate = {
            candidateId: buildKnowledgeCandidateId(traceIds),
            source: "group_message",
            status: "pending_review",
            roomId: String(sourceMessage.roomId || "").trim(),
            roomName: String(sourceMessage.roomName || sourceMessage.roomId || "").trim(),
            traceIds: candidateTraceIds,
            title: judgement.title,
            scope: judgement.scope,
            problem: judgement.problem,
            solution: judgement.solution,
            knowledgeStatus: judgement.knowledgeStatus,
            recommendation: judgement.recommendation,
            existingKnowledgeIds: judgement.existingKnowledgeIds,
            existingKnowledgeSummary: judgement.existingKnowledgeSummary,
            delta: judgement.delta,
            tags: judgement.tags,
            evidence: judgement.evidence,
            reason: judgement.reason,
            confidence: judgement.confidence,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sourceMessage: {
              traceId: String(sourceMessage.traceId || "").trim(),
              senderName: sourceMessage.senderName || sourceMessage.senderId || "",
              sendTimeIso: sourceMessage.sendTimeIso || sourceMessage.receivedAt || "",
              content: groupMessages.map((message) => normalizeKnowledgeHarvestText(message)).filter(Boolean).join("\n"),
            },
            contextMessages: judgement.contextMessages,
            relatedKnowledge: judgement.relatedKnowledge,
            classifierRawOutput: judgement.rawOutput,
          };
          appendKnowledgeCandidate(candidate);
          patchKnowledgeHarvestMessages(traceIds.map((traceId) => ({
            traceId,
            status: "candidate",
            candidateId: candidate.candidateId,
            reason: judgement.reason,
            groupTraceIds: traceIds,
          })));
          candidates += 1;
        } else {
          patchKnowledgeHarvestMessages(traceIds.map((traceId) => ({
            traceId,
            status: "ignored",
            reason: judgement.reason || "not_knowledge",
            groupTraceIds: traceIds,
          })));
          ignored += traceIds.length;
        }
      } catch (error) {
        patchKnowledgeHarvestMessages(traceIds.map((traceId) => ({
          traceId,
          status: "failed",
          lastError: String(error?.message || error),
          groupTraceIds: traceIds,
        })));
        failed += traceIds.length;
      }
      processed += traceIds.length;
    });
    return {
      ok: failed === 0,
      enabled: true,
      processed,
      groups: groups.length,
      candidates,
      ignored,
      failed,
    };
  }

  return {
    appendKnowledgeCandidate,
    buildKnowledgeCandidateId,
    buildKnowledgeHarvestContext,
    buildKnowledgeHarvestMessages,
    buildKnowledgeHarvestSearchQuery,
    buildKnowledgeHarvestGroups,
    enqueueKnowledgeHarvestMessage,
    findKnowledgeCandidate,
    formatKnowledgeCandidateMarkdown,
    formatKnowledgeCandidateUpdateMarkdown,
    isKnowledgeHarvestRoomAllowed,
    judgeKnowledgeCandidateByLlm,
    listEligibleKnowledgeHarvestMessages,
    listEligibleKnowledgeHarvestGroups,
    listKnowledgeCandidates,
    normalizeKnowledgeHarvestText,
    normalizeRelatedKnowledgeForHarvest,
    publishKnowledgeCandidateToLocal,
    rewriteKnowledgeCandidate,
    runKnowledgeHarvestProcessor,
    sanitizeKnowledgeFileName,
    shouldQueueKnowledgeHarvestMessage,
    updateExistingKnowledgeFromCandidate,
    validateKnowledgeHarvestPayload,
  };
}

module.exports = { createKnowledgeHarvestService };
