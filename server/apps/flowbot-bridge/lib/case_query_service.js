function createCaseQueryService({
  compareTimeDesc,
  computeTokenOverlapScore,
  loadAllCaseItems,
  normalizePriority,
  normalizePriorityItem,
  parseSearchTimeMs,
  readCaseArtifacts,
  searchStoredMessages,
}) {
  function findCaseById(caseId) {
    const target = String(caseId || "").trim();
    if (!target) {
      return null;
    }
    return loadAllCaseItems().find((item) => String(item?.case_id || "").trim() === target) || null;
  }

  function buildCaseProgressPayload(caseItem) {
    if (!caseItem) {
      return null;
    }
    const artifacts = readCaseArtifacts(caseItem);
    const caseDetail = normalizePriorityItem(artifacts.caseDetail || caseItem);
    const conversationDetail = artifacts.conversationDetail || null;
    const timeline = Array.isArray(conversationDetail?.timeline)
      ? conversationDetail.timeline.slice(-12)
      : [];
    return {
      summary: caseDetail.summary || caseItem.summary || "",
      status: caseDetail.status || caseItem.status || "",
      priority: normalizePriority(caseDetail.priority || caseItem.priority || "P2", "P2"),
      category: caseDetail.category || caseItem.category || "",
      reporters: caseDetail.reporters || caseItem.reporters || [],
      participants: caseDetail.participants || caseItem.participants || [],
      firstMessageTime: caseDetail.first_message_time || caseItem.first_message_time || "",
      lastMessageTime: caseDetail.last_message_time || caseItem.last_message_time || "",
      updatedAt: caseDetail.updated_at || caseItem.updated_at || "",
      latestMessageRole: caseDetail.latest_message_role || "",
      latestBatchAction: caseDetail.latest_batch_action || "",
      sourceThreadId: caseDetail.source_thread_id || caseItem.source_thread_id || "",
      recentTimeline: timeline,
    };
  }

  function getCaseTimeline(caseId, options = {}) {
    const caseItem = findCaseById(caseId);
    if (!caseItem) {
      return null;
    }
    const artifacts = readCaseArtifacts(caseItem);
    const caseDetail = normalizePriorityItem(artifacts.caseDetail || caseItem);
    const conversationDetail = artifacts.conversationDetail || null;
    const timeline = Array.isArray(conversationDetail?.timeline)
      ? conversationDetail.timeline
      : (Array.isArray(caseDetail?.messages) ? caseDetail.messages : []);
    const activities = Array.isArray(caseDetail?.activities)
      ? caseDetail.activities
      : (Array.isArray(conversationDetail?.activities) ? conversationDetail.activities : []);
    const sort = String(options.sort || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const offset = Math.max(0, Number(options.offset) || 0);
    const orderedTimeline = timeline.slice().sort((left, right) => {
      const leftTs = parseSearchTimeMs(left?.time || left?.send_time || left?.sendTimeIso || "");
      const rightTs = parseSearchTimeMs(right?.time || right?.send_time || right?.sendTimeIso || "");
      return sort === "asc"
        ? (leftTs || 0) - (rightTs || 0)
        : (rightTs || 0) - (leftTs || 0);
    });
    const slicedTimeline = orderedTimeline.slice(offset, offset + limit);
    return {
      caseId: caseItem.case_id,
      summary: caseDetail.summary || caseItem.summary || "",
      status: caseDetail.status || caseItem.status || "",
      priority: normalizePriority(caseDetail.priority || caseItem.priority || "P2", "P2"),
      category: caseDetail.category || caseItem.category || "",
      sourceThreadId: caseDetail.source_thread_id || caseItem.source_thread_id || "",
      totalTimelineItems: orderedTimeline.length,
      totalActivities: activities.length,
      limit,
      offset,
      hasMore: offset + limit < orderedTimeline.length,
      timeline: slicedTimeline.map((item) => ({
        time: item?.time || item?.send_time || item?.sendTimeIso || "",
        sender: item?.sender || item?.senderName || "",
        type: item?.type || item?.msgTypeName || "",
        content: item?.content || item?.text || "",
        mediaKind: item?.media_kind || item?.mediaKind || "",
        mediaPublicUrl: item?.media_public_url || item?.mediaPublicUrl || "",
        transcriptText: item?.transcript_text || item?.transcriptText || "",
        traceId: item?.trace_id || item?.traceId || "",
      })),
      activities: activities.map((item) => ({
        time: item?.time || item?.created_at || "",
        role: item?.role || item?.message_role || "",
        summary: item?.summary || "",
        batchAction: item?.batch_action || "",
        status: item?.status || "",
      })),
    };
  }

  function searchCases({ roomId = "", query = "", limit = 10 } = {}) {
    const normalizedQuery = String(query || "").trim();
    const list = loadAllCaseItems()
      .filter((item) => !roomId || String(item?.chat_id || "") === String(roomId))
      .map((item) => {
        const text = [
          item.case_id,
          item.summary,
          ...(Array.isArray(item.keywords) ? item.keywords : []),
          ...(Array.isArray(item.reporters) ? item.reporters : []),
          ...(Array.isArray(item.participants) ? item.participants : []),
        ].filter(Boolean).join("\n");
        return {
          ...item,
          score: normalizedQuery ? computeTokenOverlapScore(normalizedQuery, text) : 1,
        };
      });
    return list
      .filter((item) => !normalizedQuery || item.score > 0)
      .sort((left, right) => right.score - left.score || compareTimeDesc(left, right, ["updated_at", "last_message_time"]))
      .slice(0, limit)
      .map((item) => ({
        caseId: item.case_id,
        roomId: item.chat_id,
        roomName: item.chat_name || item.chat_id,
        summary: item.summary,
        status: item.status || "",
        priority: normalizePriority(item.priority || "P2", "P2"),
        category: item.category || "",
        reporters: Array.isArray(item.reporters) ? item.reporters : [],
        participants: Array.isArray(item.participants) ? item.participants : [],
        updatedAt: item.updated_at || "",
        score: Number(item.score.toFixed(4)),
      }));
  }

  function buildCaseSearchText(item) {
    return [
      item?.case_id,
      item?.chat_id,
      item?.chat_name,
      item?.summary,
      item?.category,
      item?.priority,
      ...(Array.isArray(item?.keywords) ? item.keywords : []),
      ...(Array.isArray(item?.reporters) ? item.reporters : []),
      ...(Array.isArray(item?.participants) ? item.participants : []),
    ].filter(Boolean).join("\n");
  }

  function overlapValues(leftValues, rightValues) {
    const left = new Set((Array.isArray(leftValues) ? leftValues : []).map((value) => String(value || "").trim()).filter(Boolean));
    const right = new Set((Array.isArray(rightValues) ? rightValues : []).map((value) => String(value || "").trim()).filter(Boolean));
    return Array.from(left).filter((value) => right.has(value));
  }

  function findRelatedCases(options = {}) {
    const caseId = String(options.caseId || "").trim();
    const anchorCase = caseId ? findCaseById(caseId) : null;
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 8));
    const roomId = String(options.roomId || anchorCase?.chat_id || "").trim();
    const directQuery = String(options.query || "").trim();
    const baseQuery = directQuery || [
      anchorCase?.summary || "",
      ...(Array.isArray(anchorCase?.keywords) ? anchorCase.keywords : []),
      ...(Array.isArray(anchorCase?.reporters) ? anchorCase.reporters : []),
      ...(Array.isArray(anchorCase?.participants) ? anchorCase.participants : []),
    ].filter(Boolean).join("\n");
    if (!baseQuery) {
      return {
        anchorCase: anchorCase ? {
          caseId: anchorCase.case_id,
          summary: anchorCase.summary || "",
        } : null,
        relatedCases: [],
        supportingMessages: [],
        query: "",
      };
    }
    const relatedCases = loadAllCaseItems()
      .filter((item) => !roomId || String(item?.chat_id || "") === roomId)
      .filter((item) => !caseId || String(item?.case_id || "") !== caseId)
      .map((item) => {
        const score = computeTokenOverlapScore(baseQuery, buildCaseSearchText(item));
        const keywordOverlap = overlapValues(anchorCase?.keywords, item?.keywords);
        const participantOverlap = overlapValues(
          [...(Array.isArray(anchorCase?.reporters) ? anchorCase.reporters : []), ...(Array.isArray(anchorCase?.participants) ? anchorCase.participants : [])],
          [...(Array.isArray(item?.reporters) ? item.reporters : []), ...(Array.isArray(item?.participants) ? item.participants : [])],
        );
        const boostedScore = score
          + (keywordOverlap.length ? 0.2 : 0)
          + (participantOverlap.length ? 0.1 : 0)
          + (anchorCase?.category && item?.category === anchorCase.category ? 0.05 : 0);
        return {
          item,
          score: Number(boostedScore.toFixed(4)),
          keywordOverlap,
          participantOverlap,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || compareTimeDesc(left.item, right.item, ["updated_at", "last_message_time"]))
      .slice(0, limit)
      .map(({ item, score, keywordOverlap, participantOverlap }) => ({
        caseId: item.case_id,
        roomId: item.chat_id,
        roomName: item.chat_name || item.chat_id,
        summary: item.summary || "",
        status: item.status || "",
        priority: normalizePriority(item.priority || "P2", "P2"),
        category: item.category || "",
        updatedAt: item.updated_at || "",
        score,
        overlap: {
          keywords: keywordOverlap,
          participants: participantOverlap,
        },
      }));
    const supportingMessages = searchStoredMessages({
      roomId,
      query: baseQuery,
      limit: Math.max(limit, 5),
      sort: "desc",
    }).items;
    return {
      anchorCase: anchorCase ? {
        caseId: anchorCase.case_id,
        roomId: anchorCase.chat_id,
        roomName: anchorCase.chat_name || anchorCase.chat_id,
        summary: anchorCase.summary || "",
        category: anchorCase.category || "",
        priority: normalizePriority(anchorCase.priority || "P2", "P2"),
        keywords: Array.isArray(anchorCase.keywords) ? anchorCase.keywords : [],
        participants: Array.isArray(anchorCase.participants) ? anchorCase.participants : [],
        reporters: Array.isArray(anchorCase.reporters) ? anchorCase.reporters : [],
      } : null,
      query: baseQuery,
      relatedCases,
      supportingMessages,
    };
  }

  return {
    buildCaseProgressPayload,
    findCaseById,
    findRelatedCases,
    getCaseTimeline,
    searchCases,
  };
}

module.exports = { createCaseQueryService };
