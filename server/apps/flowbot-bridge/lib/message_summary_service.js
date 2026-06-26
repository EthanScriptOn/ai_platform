function createMessageSummaryService({
  HISTORY_SUMMARY_MAX_BUCKETS,
  MESSAGE_SEARCH_MAX_LIMIT,
  SUMMARY_STOPWORDS,
  buildMessageSearchSnippet,
  messageTimestampMs,
  parseSearchTimeMs,
  resolveStoredMessageSearch,
}) {
  function summarizeTopKeywords(items, limit = 12) {
    const counts = new Map();
    for (const item of items) {
      const tokens = Array.isArray(item?.searchTokens) ? item.searchTokens : [];
      for (const token of tokens) {
        const normalized = String(token || "").trim().toLowerCase();
        if (!normalized || SUMMARY_STOPWORDS.has(normalized)) {
          continue;
        }
        if (/^\d+$/.test(normalized)) {
          continue;
        }
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([keyword, count]) => ({ keyword, count }));
  }

  function summarizeCounts(items, fieldName) {
    const counts = new Map();
    for (const item of items) {
      const key = String(item?.[fieldName] || "").trim() || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([value, count]) => ({ value, count }));
  }

  function buildMessageSummaryText(items, options = {}) {
    const roomName = String(options.roomName || options.roomId || "").trim();
    const participants = summarizeCounts(items, "senderName").slice(0, 5);
    const keywords = summarizeTopKeywords(items, 8);
    const latest = items.slice(-3).map((item) => {
      const who = String(item?.senderName || item?.senderId || "unknown").trim();
      const content = String(item?.content || item?.transcriptText || item?.snippet || "").replace(/\s+/g, " ").trim();
      return `${who}: ${content || "(空内容)"}`;
    });
    const lines = [];
    if (roomName) {
      lines.push(`群：${roomName}`);
    }
    lines.push(`消息数：${items.length}`);
    if (participants.length) {
      lines.push(`主要参与人：${participants.map((item) => `${item.value}(${item.count})`).join("，")}`);
    }
    if (keywords.length) {
      lines.push(`高频关键词：${keywords.map((item) => `${item.keyword}(${item.count})`).join("，")}`);
    }
    if (latest.length) {
      lines.push(`最近消息：${latest.join(" | ")}`);
    }
    return lines.join("\n");
  }

  function buildMessagesSummaryPayload(items, options = {}) {
    const sorted = items.slice().sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    const first = sorted[0] || null;
    const last = sorted[sorted.length - 1] || null;
    const participantCounts = summarizeCounts(sorted, "senderName");
    const typeCounts = summarizeCounts(sorted, "msgTypeName");
    const keywordCounts = summarizeTopKeywords(sorted);
    return {
      roomId: String(options.roomId || first?.roomId || "").trim(),
      roomName: String(options.roomName || first?.roomName || options.roomId || "").trim(),
      fromTime: first?.sendTimeIso || "",
      toTime: last?.sendTimeIso || "",
      messageCount: sorted.length,
      participants: participantCounts,
      messageTypes: typeCounts,
      keywords: keywordCounts,
      summaryText: buildMessageSummaryText(sorted, {
        roomId: options.roomId || first?.roomId || "",
        roomName: options.roomName || first?.roomName || "",
      }),
      highlights: sorted.slice(-5).map((item) => ({
        traceId: item.traceId,
        sendTimeIso: item.sendTimeIso,
        senderName: item.senderName,
        senderId: item.senderId,
        msgTypeName: item.msgTypeName,
        content: item.content,
        transcriptText: item.transcriptText,
        snippet: item.snippet || buildMessageSearchSnippet(item, options.query || options.content || ""),
      })),
    };
  }

  function getRoomSummary(options = {}) {
    const roomId = String(options.roomId || "").trim();
    if (!roomId) {
      throw new Error("room_id_required");
    }
    const resolved = resolveStoredMessageSearch({
      ...options,
      roomId,
      limit: MESSAGE_SEARCH_MAX_LIMIT,
      offset: 0,
    });
    return {
      filters: {
        roomId,
        sender: resolved.sender,
        senderId: resolved.senderId,
        query: resolved.query,
        content: resolved.content,
        msgType: resolved.msgType,
        fromTime: options.fromTime || options.from || "",
        toTime: options.toTime || options.to || "",
        hasMedia: options.hasMedia ?? "",
        sort: resolved.sort,
      },
      total: resolved.filtered.length,
      ...buildMessagesSummaryPayload(resolved.filtered, {
        roomId,
        query: resolved.query,
        content: resolved.content,
      }),
    };
  }

  function getDateSummary(options = {}) {
    const date = String(options.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("date_required_yyyy_mm_dd");
    }
    const span = String(options.span || "day").trim().toLowerCase() === "week" ? "week" : "day";
    const start = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) {
      throw new Error("date_invalid");
    }
    const end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + (span === "week" ? 7 : 1));
    const resolved = resolveStoredMessageSearch({
      ...options,
      fromTime: start.toISOString(),
      toTime: new Date(end.getTime() - 1).toISOString(),
      limit: MESSAGE_SEARCH_MAX_LIMIT,
      offset: 0,
    });
    return {
      filters: {
        date,
        span,
        roomId: resolved.roomId,
        sender: resolved.sender,
        senderId: resolved.senderId,
        query: resolved.query,
        content: resolved.content,
        msgType: resolved.msgType,
        hasMedia: options.hasMedia ?? "",
      },
      total: resolved.filtered.length,
      ...buildMessagesSummaryPayload(resolved.filtered, {
        roomId: resolved.roomId,
        roomName: resolved.roomId,
        query: resolved.query,
        content: resolved.content,
      }),
    };
  }

  function formatHistoryBucketLabel(timestampMs, bucket, timeZone = "Asia/Shanghai") {
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: bucket === "month" ? undefined : "2-digit",
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    const year = parts.year || "0000";
    const month = parts.month || "00";
    const day = parts.day || "00";
    return bucket === "month" ? `${year}-${month}` : `${year}-${month}-${day}`;
  }

  function resolveHistorySummaryRange(options = {}) {
    const timeZone = String(options.timeZone || "Asia/Shanghai").trim() || "Asia/Shanghai";
    const preset = String(options.preset || "").trim().toLowerCase();
    const month = String(options.month || "").trim();
    let fromMs = parseSearchTimeMs(options.fromTime || options.from || options.startTime);
    let toMs = parseSearchTimeMs(options.toTime || options.to || options.endTime);
    const now = new Date();

    if (!fromMs && !toMs && /^\d{4}-\d{2}$/.test(month)) {
      const start = new Date(`${month}-01T00:00:00+08:00`);
      if (!Number.isNaN(start.getTime())) {
        const end = new Date(start.getTime());
        end.setMonth(end.getMonth() + 1);
        fromMs = start.getTime();
        toMs = end.getTime() - 1;
      }
    }

    if (!fromMs && !toMs && preset) {
      const cursor = new Date(now.getTime());
      if (preset === "last_7_days") {
        fromMs = cursor.getTime() - (7 * 24 * 60 * 60 * 1000);
        toMs = cursor.getTime();
      } else if (preset === "last_30_days") {
        fromMs = cursor.getTime() - (30 * 24 * 60 * 60 * 1000);
        toMs = cursor.getTime();
      } else if (preset === "this_month") {
        const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        fromMs = start.getTime();
        toMs = cursor.getTime();
      } else if (preset === "last_month") {
        const start = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
        const end = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
        fromMs = start.getTime();
        toMs = end.getTime() - 1;
      }
    }

    return {
      timeZone,
      fromMs,
      toMs,
      month,
      preset,
    };
  }

  function getHistorySummary(options = {}) {
    const bucket = String(options.bucket || "day").trim().toLowerCase() === "month" ? "month" : "day";
    const range = resolveHistorySummaryRange(options);
    const resolved = resolveStoredMessageSearch({
      ...options,
      fromTime: range.fromMs != null ? new Date(range.fromMs).toISOString() : options.fromTime || options.from || "",
      toTime: range.toMs != null ? new Date(range.toMs).toISOString() : options.toTime || options.to || "",
      limit: MESSAGE_SEARCH_MAX_LIMIT,
      offset: 0,
    });
    const buckets = new Map();
    for (const item of resolved.filtered) {
      const timestampMs = parseSearchTimeMs(item?.sendTimeIso || item?.receivedAt || "");
      const key = formatHistoryBucketLabel(timestampMs, bucket, range.timeZone);
      if (!key) {
        continue;
      }
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key).push(item);
    }
    const orderedBuckets = Array.from(buckets.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(-HISTORY_SUMMARY_MAX_BUCKETS)
      .map(([label, items]) => ({
        label,
        ...buildMessagesSummaryPayload(items, {
          roomId: resolved.roomId,
          roomName: resolved.roomId,
          query: resolved.query,
          content: resolved.content,
        }),
      }));
    return {
      filters: {
        roomId: resolved.roomId,
        sender: resolved.sender,
        senderId: resolved.senderId,
        query: resolved.query,
        content: resolved.content,
        msgType: resolved.msgType,
        hasMedia: options.hasMedia ?? "",
        bucket,
        month: range.month,
        preset: range.preset,
        fromTime: range.fromMs != null ? new Date(range.fromMs).toISOString() : String(options.fromTime || options.from || "").trim(),
        toTime: range.toMs != null ? new Date(range.toMs).toISOString() : String(options.toTime || options.to || "").trim(),
        timeZone: range.timeZone,
      },
      total: resolved.filtered.length,
      bucketCount: orderedBuckets.length,
      buckets: orderedBuckets,
    };
  }

  return {
    getDateSummary,
    getHistorySummary,
    getRoomSummary,
  };
}

module.exports = { createMessageSummaryService };
