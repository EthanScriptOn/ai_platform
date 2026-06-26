function createMessageSearchService({
  DATA_DIR,
  MESSAGE_CONTEXT_MAX_NEIGHBORS,
  MESSAGE_SEARCH_DEFAULT_LIMIT,
  MESSAGE_SEARCH_INDEX_PATH,
  MESSAGE_SEARCH_MAX_LIMIT,
  NORMALIZED_LOG_PATH,
  buildMessageSearchRecord,
  collectAgentVisionInputs,
  collectAgentVisionInputsFromContext,
  computeTokenOverlapScore,
  dedupeMessageEventsByTraceId,
  fs,
  hashText,
  loadAllCaseItems,
  messageTimestampMs,
  mysqlRuntimeStore,
  normalizeMemorySourceInput,
  normalizePriority,
  normalizeBooleanInput,
  readCaseArtifacts,
  readJsonlFile,
  resolveAgentMediaRenderOptions,
  summarizeSnippet,
  toFiniteScore,
  tokenizeSearchText,
}) {
  function parseSearchTimeMs(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return null;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeOptionalSearchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function ensureMessageSearchIndex() {
    if (mysqlRuntimeStore.isEnabled()) {
      const existing = mysqlRuntimeStore.readJsonl(DATA_DIR, MESSAGE_SEARCH_INDEX_PATH, 1);
      if (existing.length) {
        return;
      }
      const normalizedEvents = dedupeMessageEventsByTraceId(
        readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER),
        { prefer: "last" },
      );
      const records = normalizedEvents
        .map((item) => buildMessageSearchRecord(item))
        .filter(Boolean);
      mysqlRuntimeStore.rewriteJsonl(DATA_DIR, MESSAGE_SEARCH_INDEX_PATH, records);
      return;
    }
    if (fs.existsSync(MESSAGE_SEARCH_INDEX_PATH)) {
      return;
    }
    const normalizedEvents = dedupeMessageEventsByTraceId(
      readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER),
      { prefer: "last" },
    );
    const lines = normalizedEvents
      .map((item) => buildMessageSearchRecord(item))
      .filter(Boolean)
      .map((item) => JSON.stringify(item));
    fs.writeFileSync(MESSAGE_SEARCH_INDEX_PATH, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  }

  function loadMessageSearchRecords() {
    ensureMessageSearchIndex();
    return dedupeMessageEventsByTraceId(
      readJsonlFile(MESSAGE_SEARCH_INDEX_PATH, Number.MAX_SAFE_INTEGER),
      { prefer: "last" },
    ).map((item) => ({
      ...item,
      searchTokens: Array.isArray(item?.searchTokens) ? item.searchTokens : tokenizeSearchText(item?.searchText || ""),
    }));
  }

  function buildMessageSearchSnippet(item, query = "") {
    return summarizeSnippet(
      [
        item?.content || "",
        item?.transcriptText || "",
        item?.quoteContent || "",
        item?.title || "",
        item?.desc || "",
      ].filter(Boolean).join("\n"),
      query,
    );
  }

  function buildCaseMessageSearchRecord(caseItem, timelineItem, index = 0) {
    const caseId = String(caseItem?.case_id || "").trim();
    if (!caseId || !timelineItem || typeof timelineItem !== "object") {
      return null;
    }
    const baseRecord = buildMessageSearchRecord({
      traceId: String(timelineItem?.trace_id || timelineItem?.traceId || "").trim() || `${caseId}:${timelineItem?.msg_id || index}`,
      roomId: caseItem?.chat_id || timelineItem?.chat_id || "",
      roomName: caseItem?.chat_name || timelineItem?.chat_name || caseItem?.chat_id || "",
      senderName: timelineItem?.sender || timelineItem?.senderName || "",
      senderId: timelineItem?.sender_id || timelineItem?.senderId || "",
      sendTimeIso: timelineItem?.time || timelineItem?.send_time || timelineItem?.sendTimeIso || "",
      content: timelineItem?.content || timelineItem?.text || "",
      transcriptText: timelineItem?.transcript_text || timelineItem?.transcriptText || "",
      quoteContent: timelineItem?.quote_content || timelineItem?.quoteContent || "",
      title: timelineItem?.title || "",
      desc: timelineItem?.desc || "",
      fileName: timelineItem?.file_name || timelineItem?.fileName || "",
      mediaKind: timelineItem?.media_kind || timelineItem?.mediaKind || "",
      msgTypeName: timelineItem?.type || timelineItem?.msgTypeName || "",
      msgType: timelineItem?.msg_type || timelineItem?.msgType || 0,
      hasMedia: Boolean(
        timelineItem?.media_kind
        || timelineItem?.mediaKind
        || timelineItem?.media_local_url
        || timelineItem?.media_remote_url
        || timelineItem?.mediaPublicUrl
        || timelineItem?.media_public_url
      ),
      mediaPublicUrl: timelineItem?.media_local_url
        || timelineItem?.mediaPublicUrl
        || timelineItem?.media_public_url
        || timelineItem?.media_remote_url
        || "",
    });
    if (!baseRecord) {
      return null;
    }
    const enrichedSearchText = [
      baseRecord.searchText,
      caseId,
      String(caseItem?.summary || "").trim(),
      String(caseItem?.category || "").trim(),
      String(caseItem?.priority || "").trim(),
      String(timelineItem?.message_role || "").trim(),
      String(timelineItem?.thread_type || "").trim(),
    ].filter(Boolean).join("\n");
    return {
      ...baseRecord,
      traceId: baseRecord.traceId,
      caseId,
      caseSummary: String(caseItem?.summary || "").trim(),
      caseCategory: String(caseItem?.category || "").trim(),
      casePriority: normalizePriority(caseItem?.priority || "P2", "P2"),
      caseStatus: String(caseItem?.status || "").trim(),
      caseUpdatedAt: String(caseItem?.updated_at || caseItem?.last_message_time || "").trim(),
      sourceThreadId: String(caseItem?.source_thread_id || "").trim(),
      messageRole: String(timelineItem?.message_role || "").trim(),
      threadType: String(timelineItem?.thread_type || "").trim(),
      searchText: enrichedSearchText,
      searchTokens: tokenizeSearchText(enrichedSearchText),
    };
  }

  function loadCaseMessageSearchRecords() {
    const result = [];
    const cases = loadAllCaseItems();
    for (const caseItem of cases) {
      const artifacts = readCaseArtifacts(caseItem);
      const conversationDetail = artifacts?.conversationDetail || null;
      const caseDetail = artifacts?.caseDetail || null;
      const timeline = Array.isArray(conversationDetail?.timeline)
        ? conversationDetail.timeline
        : (Array.isArray(caseDetail?.messages) ? caseDetail.messages : []);
      timeline.forEach((timelineItem, index) => {
        const record = buildCaseMessageSearchRecord(caseItem, timelineItem, index);
        if (record) {
          result.push(record);
        }
      });
    }
    return result;
  }

  function resolveStoredMessageSearch(options = {}) {
    const roomId = String(options.roomId || "").trim();
    const sender = normalizeOptionalSearchText(options.sender);
    const senderId = normalizeOptionalSearchText(options.senderId);
    const query = normalizeOptionalSearchText(options.query || options.q);
    const content = normalizeOptionalSearchText(options.content);
    const traceId = normalizeOptionalSearchText(options.traceId);
    const msgType = normalizeOptionalSearchText(options.msgType);
    const fromMs = parseSearchTimeMs(options.fromTime || options.from || options.startTime);
    const toMs = parseSearchTimeMs(options.toTime || options.to || options.endTime);
    const hasMediaFilter = options.hasMedia === "" || options.hasMedia == null
      ? null
      : normalizeBooleanInput(options.hasMedia, false);
    const limit = Math.max(1, Math.min(MESSAGE_SEARCH_MAX_LIMIT, Number(options.limit) || MESSAGE_SEARCH_DEFAULT_LIMIT));
    const offset = Math.max(0, Number(options.offset) || 0);
    const sort = String(options.sort || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
    const records = loadMessageSearchRecords();

    const filtered = records.filter((item) => {
      if (roomId && String(item?.roomId || "") !== roomId) {
        return false;
      }
      if (traceId && String(item?.traceId || "") !== traceId) {
        return false;
      }
      if (senderId && String(item?.senderId || "") !== senderId) {
        return false;
      }
      if (sender) {
        const senderText = `${item?.senderName || ""}\n${item?.senderId || ""}`.toLowerCase();
        if (!senderText.includes(sender.toLowerCase())) {
          return false;
        }
      }
      if (msgType) {
        const typeText = `${item?.msgType || ""}\n${item?.msgTypeName || ""}`.toLowerCase();
        if (!typeText.includes(msgType.toLowerCase())) {
          return false;
        }
      }
      if (hasMediaFilter !== null && Boolean(item?.hasMedia) !== hasMediaFilter) {
        return false;
      }
      const itemTs = parseSearchTimeMs(item?.sendTimeIso || item?.receivedAt || "");
      if (fromMs !== null && (itemTs === null || itemTs < fromMs)) {
        return false;
      }
      if (toMs !== null && (itemTs === null || itemTs > toMs)) {
        return false;
      }
      if (content) {
        const hay = `${item?.content || ""}\n${item?.transcriptText || ""}\n${item?.quoteContent || ""}`.toLowerCase();
        if (!hay.includes(content.toLowerCase())) {
          return false;
        }
      }
      if (query) {
        const score = computeTokenOverlapScore(query, item?.searchText || "");
        if (score <= 0 && !String(item?.searchText || "").toLowerCase().includes(query.toLowerCase())) {
          return false;
        }
      }
      return true;
    }).map((item) => ({
      ...item,
      score: query ? Number(computeTokenOverlapScore(query, item.searchText || "").toFixed(4)) : 1,
      snippet: buildMessageSearchSnippet(item, query || content),
    }));

    filtered.sort((left, right) => {
      const timeDiff = messageTimestampMs(sort === "asc" ? left : right) - messageTimestampMs(sort === "asc" ? right : left);
      if (query && left.score !== right.score) {
        return sort === "asc" ? left.score - right.score : right.score - left.score;
      }
      return timeDiff || String(left.traceId || "").localeCompare(String(right.traceId || ""));
    });

    return {
      roomId,
      sender,
      senderId,
      query,
      content,
      traceId,
      msgType,
      fromMs,
      toMs,
      hasMediaFilter,
      limit,
      offset,
      sort,
      filtered,
    };
  }

  function searchStoredMessages(options = {}) {
    const {
      filtered,
      limit,
      offset,
    } = resolveStoredMessageSearch(options);
    const renderOptions = resolveAgentMediaRenderOptions(options);

    const sliced = filtered.slice(offset, offset + limit);
    return {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
      items: sliced.map((item) => ({
        traceId: item.traceId,
        seq: item.seq || "",
        roomId: item.roomId,
        roomName: item.roomName || item.roomId,
        senderName: item.senderName,
        senderId: item.senderId,
        receiverId: item.receiverId || "",
        sendTimeIso: item.sendTimeIso,
        msgType: item.msgType,
        msgTypeName: item.msgTypeName,
        content: item.content,
        transcriptText: item.transcriptText,
        quoteContent: item.quoteContent,
        title: item.title,
        desc: item.desc,
        fileName: item.fileName,
        mediaKind: item.mediaKind,
        hasMedia: Boolean(item.hasMedia),
        mediaLocalPath: item.mediaLocalPath,
        mediaPublicUrl: item.mediaPublicUrl,
        mediaMimeType: item.mediaMimeType,
        mediaWidth: item.mediaWidth ?? null,
        mediaHeight: item.mediaHeight ?? null,
        mediaSizeBytes: item.mediaSizeBytes ?? null,
        score: item.score,
        snippet: item.snippet,
      })),
      visionInputs: collectAgentVisionInputs(sliced, renderOptions, "messages_search"),
    };
  }

  function formatStoredMessageItem(item, options = {}) {
    return {
      traceId: item.traceId,
      seq: item.seq || "",
      roomId: item.roomId,
      roomName: item.roomName || item.roomId,
      senderName: item.senderName,
      senderId: item.senderId,
      receiverId: item.receiverId || "",
      sendTimeIso: item.sendTimeIso,
      msgType: item.msgType,
      msgTypeName: item.msgTypeName,
      content: item.content,
      transcriptText: item.transcriptText,
      quoteContent: item.quoteContent,
      title: item.title,
      desc: item.desc,
      fileName: item.fileName,
      mediaKind: item.mediaKind,
      hasMedia: Boolean(item.hasMedia),
      mediaLocalPath: item.mediaLocalPath,
      mediaPublicUrl: item.mediaPublicUrl,
      mediaMimeType: item.mediaMimeType,
      mediaWidth: item.mediaWidth ?? null,
      mediaHeight: item.mediaHeight ?? null,
      mediaSizeBytes: item.mediaSizeBytes ?? null,
      score: item.score,
      snippet: item.snippet || buildMessageSearchSnippet(item, options.query || options.content || ""),
    };
  }

  function searchStoredMessagesWithContext(options = {}) {
    const resolved = resolveStoredMessageSearch(options);
    const renderOptions = resolveAgentMediaRenderOptions(options);
    const before = Math.max(0, Math.min(MESSAGE_CONTEXT_MAX_NEIGHBORS, Number(options.contextBefore) || 2));
    const after = Math.max(0, Math.min(MESSAGE_CONTEXT_MAX_NEIGHBORS, Number(options.contextAfter) || 2));
    const roomMessageMap = new Map();
    for (const item of loadMessageSearchRecords().slice().sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right))) {
      const roomId = String(item?.roomId || "").trim();
      if (!roomId) {
        continue;
      }
      if (!roomMessageMap.has(roomId)) {
        roomMessageMap.set(roomId, []);
      }
      roomMessageMap.get(roomId).push(item);
    }
    const sliced = resolved.filtered.slice(resolved.offset, resolved.offset + resolved.limit);
    const matches = sliced.map((item) => {
      const roomItems = roomMessageMap.get(String(item?.roomId || "")) || [];
      const currentIndex = roomItems.findIndex((candidate) => String(candidate?.traceId || "") === String(item?.traceId || ""));
      const beforeItems = currentIndex >= 0 ? roomItems.slice(Math.max(0, currentIndex - before), currentIndex) : [];
      const afterItems = currentIndex >= 0 ? roomItems.slice(currentIndex + 1, currentIndex + 1 + after) : [];
      return {
        message: formatStoredMessageItem(item, {
          query: resolved.query,
          content: resolved.content,
        }),
        contextBefore: beforeItems.map((contextItem) => formatStoredMessageItem(contextItem, {
          query: resolved.query,
          content: resolved.content,
        })),
        contextAfter: afterItems.map((contextItem) => formatStoredMessageItem(contextItem, {
          query: resolved.query,
          content: resolved.content,
        })),
      };
    });
    return {
      total: resolved.filtered.length,
      limit: resolved.limit,
      offset: resolved.offset,
      hasMore: resolved.offset + resolved.limit < resolved.filtered.length,
      contextBefore: before,
      contextAfter: after,
      matches,
      visionInputs: collectAgentVisionInputsFromContext(matches, renderOptions),
    };
  }

  function getStoredMessageByTraceId(traceId) {
    const target = String(traceId || "").trim();
    if (!target) {
      return null;
    }
    return loadMessageSearchRecords().find((item) => String(item?.traceId || "") === target) || null;
  }

  function resolveCaseMessageSearch(options = {}) {
    const caseId = String(options.caseId || "").trim();
    const roomId = String(options.roomId || "").trim();
    const sender = normalizeOptionalSearchText(options.sender);
    const senderId = normalizeOptionalSearchText(options.senderId);
    const query = normalizeOptionalSearchText(options.query || options.q);
    const content = normalizeOptionalSearchText(options.content);
    const traceId = normalizeOptionalSearchText(options.traceId);
    const msgType = normalizeOptionalSearchText(options.msgType);
    const fromMs = parseSearchTimeMs(options.fromTime || options.from || options.startTime);
    const toMs = parseSearchTimeMs(options.toTime || options.to || options.endTime);
    const hasMediaFilter = options.hasMedia === "" || options.hasMedia == null
      ? null
      : normalizeBooleanInput(options.hasMedia, false);
    const limit = Math.max(1, Math.min(MESSAGE_SEARCH_MAX_LIMIT, Number(options.limit) || MESSAGE_SEARCH_DEFAULT_LIMIT));
    const offset = Math.max(0, Number(options.offset) || 0);
    const sort = String(options.sort || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
    const records = loadCaseMessageSearchRecords();

    const filtered = records.filter((item) => {
      if (caseId && String(item?.caseId || "") !== caseId) {
        return false;
      }
      if (roomId && String(item?.roomId || "") !== roomId) {
        return false;
      }
      if (traceId && String(item?.traceId || "") !== traceId) {
        return false;
      }
      if (senderId && String(item?.senderId || "") !== senderId) {
        return false;
      }
      if (sender) {
        const senderText = `${item?.senderName || ""}\n${item?.senderId || ""}`.toLowerCase();
        if (!senderText.includes(sender.toLowerCase())) {
          return false;
        }
      }
      if (msgType) {
        const typeText = `${item?.msgType || ""}\n${item?.msgTypeName || ""}`.toLowerCase();
        if (!typeText.includes(msgType.toLowerCase())) {
          return false;
        }
      }
      if (hasMediaFilter !== null && Boolean(item?.hasMedia) !== hasMediaFilter) {
        return false;
      }
      const itemTs = parseSearchTimeMs(item?.sendTimeIso || item?.caseUpdatedAt || "");
      if (fromMs !== null && (itemTs === null || itemTs < fromMs)) {
        return false;
      }
      if (toMs !== null && (itemTs === null || itemTs > toMs)) {
        return false;
      }
      if (content) {
        const hay = `${item?.content || ""}\n${item?.transcriptText || ""}\n${item?.quoteContent || ""}`.toLowerCase();
        if (!hay.includes(content.toLowerCase())) {
          return false;
        }
      }
      if (query) {
        const score = computeTokenOverlapScore(query, item?.searchText || "");
        if (score <= 0 && !String(item?.searchText || "").toLowerCase().includes(query.toLowerCase())) {
          return false;
        }
      }
      return true;
    }).map((item) => ({
      ...item,
      score: query ? Number(computeTokenOverlapScore(query, item.searchText || "").toFixed(4)) : 1,
      snippet: buildMessageSearchSnippet(item, query || content),
    }));

    filtered.sort((left, right) => {
      const timeDiff = messageTimestampMs(sort === "asc" ? left : right) - messageTimestampMs(sort === "asc" ? right : left);
      if (query && left.score !== right.score) {
        return sort === "asc" ? left.score - right.score : right.score - left.score;
      }
      return timeDiff || String(left.traceId || "").localeCompare(String(right.traceId || ""));
    });

    return {
      caseId,
      roomId,
      sender,
      senderId,
      query,
      content,
      traceId,
      msgType,
      fromMs,
      toMs,
      hasMediaFilter,
      limit,
      offset,
      sort,
      filtered,
    };
  }

  function searchCaseMessages(options = {}) {
    const { filtered, limit, offset } = resolveCaseMessageSearch(options);
    const renderOptions = resolveAgentMediaRenderOptions(options);
    const sliced = filtered.slice(offset, offset + limit);
    return {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
      items: sliced.map((item) => ({
        traceId: item.traceId,
        caseId: item.caseId,
        caseSummary: item.caseSummary,
        caseCategory: item.caseCategory,
        casePriority: item.casePriority,
        caseStatus: item.caseStatus,
        caseUpdatedAt: item.caseUpdatedAt,
        sourceThreadId: item.sourceThreadId,
        roomId: item.roomId,
        roomName: item.roomName || item.roomId,
        senderName: item.senderName,
        senderId: item.senderId,
        sendTimeIso: item.sendTimeIso,
        msgType: item.msgType,
        msgTypeName: item.msgTypeName,
        content: item.content,
        transcriptText: item.transcriptText,
        quoteContent: item.quoteContent,
        title: item.title,
        desc: item.desc,
        fileName: item.fileName,
        mediaKind: item.mediaKind,
        hasMedia: Boolean(item.hasMedia),
        mediaLocalPath: item.mediaLocalPath,
        mediaPublicUrl: item.mediaPublicUrl,
        mediaMimeType: item.mediaMimeType,
        mediaWidth: item.mediaWidth ?? null,
        mediaHeight: item.mediaHeight ?? null,
        mediaSizeBytes: item.mediaSizeBytes ?? null,
        messageRole: item.messageRole,
        threadType: item.threadType,
        score: item.score,
        snippet: item.snippet,
      })),
      visionInputs: collectAgentVisionInputs(sliced, renderOptions, "case_messages_search"),
    };
  }

  function formatUnifiedMemoryMessageItem(item) {
    return {
      source: "message",
      sourceLabel: "群消息",
      traceId: item.traceId,
      roomId: item.roomId,
      roomName: item.roomName || item.roomId,
      senderName: item.senderName,
      senderId: item.senderId,
      sendTimeIso: item.sendTimeIso,
      msgType: item.msgType,
      msgTypeName: item.msgTypeName,
      content: item.content,
      transcriptText: item.transcriptText,
      quoteContent: item.quoteContent,
      title: item.title,
      desc: item.desc,
      fileName: item.fileName,
      mediaKind: item.mediaKind,
      hasMedia: Boolean(item.hasMedia),
      mediaLocalPath: item.mediaLocalPath,
      mediaPublicUrl: item.mediaPublicUrl,
      mediaMimeType: item.mediaMimeType,
      mediaWidth: item.mediaWidth ?? null,
      mediaHeight: item.mediaHeight ?? null,
      mediaSizeBytes: item.mediaSizeBytes ?? null,
      score: item.score,
      snippet: item.snippet,
    };
  }

  function formatUnifiedMemoryCaseItem(item) {
    return {
      source: "case",
      sourceLabel: "已归档Case消息",
      traceId: item.traceId,
      caseId: item.caseId,
      caseSummary: item.caseSummary,
      caseCategory: item.caseCategory,
      casePriority: item.casePriority,
      caseStatus: item.caseStatus,
      caseUpdatedAt: item.caseUpdatedAt,
      sourceThreadId: item.sourceThreadId,
      roomId: item.roomId,
      roomName: item.roomName || item.roomId,
      senderName: item.senderName,
      senderId: item.senderId,
      sendTimeIso: item.sendTimeIso,
      msgType: item.msgType,
      msgTypeName: item.msgTypeName,
      content: item.content,
      transcriptText: item.transcriptText,
      quoteContent: item.quoteContent,
      title: item.title,
      desc: item.desc,
      fileName: item.fileName,
      mediaKind: item.mediaKind,
      hasMedia: Boolean(item.hasMedia),
      mediaLocalPath: item.mediaLocalPath,
      mediaPublicUrl: item.mediaPublicUrl,
      mediaMimeType: item.mediaMimeType,
      mediaWidth: item.mediaWidth ?? null,
      mediaHeight: item.mediaHeight ?? null,
      mediaSizeBytes: item.mediaSizeBytes ?? null,
      messageRole: item.messageRole,
      threadType: item.threadType,
      score: item.score,
      snippet: item.snippet,
    };
  }

  function buildUnifiedMemoryDedupKey(item) {
    const traceId = String(item?.traceId || "").trim();
    if (traceId) {
      return `trace:${traceId}`;
    }
    const source = String(item?.source || "").trim() || "unknown";
    const roomId = String(item?.roomId || "").trim();
    const caseId = String(item?.caseId || "").trim();
    const senderId = String(item?.senderId || "").trim();
    const sendTimeIso = String(item?.sendTimeIso || "").trim();
    const content = String(item?.content || item?.snippet || "").trim();
    return `${source}:${roomId}:${caseId}:${senderId}:${sendTimeIso}:${hashText(content).slice(0, 10)}`;
  }

  function choosePreferredMemoryItem(left, right) {
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }
    if (left.source !== right.source) {
      return right.source === "case" ? right : left;
    }
    const leftScore = toFiniteScore(left.score, 0);
    const rightScore = toFiniteScore(right.score, 0);
    if (rightScore !== leftScore) {
      return rightScore > leftScore ? right : left;
    }
    return messageTimestampMs(right) >= messageTimestampMs(left) ? right : left;
  }

  function searchUnifiedMemory(options = {}) {
    const source = normalizeMemorySourceInput(options.source);
    const renderOptions = resolveAgentMediaRenderOptions(options);
    const limit = Math.max(1, Math.min(MESSAGE_SEARCH_MAX_LIMIT, Number(options.limit) || MESSAGE_SEARCH_DEFAULT_LIMIT));
    const offset = Math.max(0, Number(options.offset) || 0);
    const sort = String(options.sort || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
    const query = normalizeOptionalSearchText(options.query || options.q);
    const content = normalizeOptionalSearchText(options.content);
    const merged = [];
    const sourceStats = {
      messages: { enabled: source === "all" || source === "messages", count: 0 },
      cases: { enabled: source === "all" || source === "cases", count: 0 },
    };

    if (sourceStats.messages.enabled) {
      const messageResult = searchStoredMessages({
        ...options,
        limit: MESSAGE_SEARCH_MAX_LIMIT,
        offset: 0,
        sort,
      });
      sourceStats.messages.count = Array.isArray(messageResult?.items) ? messageResult.items.length : 0;
      merged.push(...(messageResult.items || []).map((item) => formatUnifiedMemoryMessageItem(item)));
    }

    if (sourceStats.cases.enabled) {
      const caseResult = searchCaseMessages({
        ...options,
        limit: MESSAGE_SEARCH_MAX_LIMIT,
        offset: 0,
        sort,
      });
      sourceStats.cases.count = Array.isArray(caseResult?.items) ? caseResult.items.length : 0;
      merged.push(...(caseResult.items || []).map((item) => formatUnifiedMemoryCaseItem(item)));
    }

    const dedupedMap = new Map();
    for (const item of merged) {
      const key = buildUnifiedMemoryDedupKey(item);
      const current = dedupedMap.get(key);
      dedupedMap.set(key, choosePreferredMemoryItem(current, item));
    }
    const deduped = Array.from(dedupedMap.values());
    deduped.sort((left, right) => {
      if (query || content) {
        const leftScore = toFiniteScore(left.score, 0);
        const rightScore = toFiniteScore(right.score, 0);
        if (leftScore !== rightScore) {
          return sort === "asc" ? leftScore - rightScore : rightScore - leftScore;
        }
      }
      const timeDiff = messageTimestampMs(sort === "asc" ? left : right) - messageTimestampMs(sort === "asc" ? right : left);
      return timeDiff || String(left.traceId || "").localeCompare(String(right.traceId || ""));
    });

    const items = deduped.slice(offset, offset + limit);
    return {
      source,
      query,
      content,
      limit,
      offset,
      total: deduped.length,
      hasMore: offset + limit < deduped.length,
      sources: sourceStats,
      items,
      visionInputs: collectAgentVisionInputs(items, renderOptions, "memory_search"),
    };
  }

  return {
    buildMessageSearchSnippet,
    getStoredMessageByTraceId,
    loadMessageSearchRecords,
    normalizeOptionalSearchText,
    parseSearchTimeMs,
    resolveStoredMessageSearch,
    searchCaseMessages,
    searchStoredMessages,
    searchStoredMessagesWithContext,
    searchUnifiedMemory,
  };
}

module.exports = { createMessageSearchService };
