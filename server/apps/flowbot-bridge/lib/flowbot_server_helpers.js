function createFlowbotServerHelpers({
  DASHBOARD_PUBLIC_URL,
  LLM_API_KEY,
  LLM_API_URL,
  LLM_MAX_REPAIR_ATTEMPTS,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  LLM_TIMEOUT_RETRY_ATTEMPTS,
  LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
  LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
  NORMALIZED_LOG_PATH,
  buildLlmReadyMessage,
  compareTimeDesc,
  dedupeMessageEventsByTraceId,
  invokeWithLlmTimeoutRetry,
  normalizePriority,
  readJsonlFile,
  requestJsonWithHeaders,
  requestStreamingChatText,
}) {
  function normalizeKnowledgeCandidatePatch(body = {}) {
    const patch = {};
    for (const key of ["title", "scope", "problem", "solution", "reason"]) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        patch[key] = String(body[key] || "").trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "reviewer")) {
      patch.reviewer = String(body.reviewer || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      patch.status = String(body.status || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "publishedTarget")) {
      patch.publishedTarget = String(body.publishedTarget || "").trim();
    }
    if (Array.isArray(body.ragflowDocumentIds)) {
      patch.ragflowDocumentIds = body.ragflowDocumentIds.map((item) => String(item || "").trim()).filter(Boolean);
    }
    if (Object.prototype.hasOwnProperty.call(body, "reviewNote")) {
      patch.reviewNote = String(body.reviewNote || "").trim();
    } else if (Object.prototype.hasOwnProperty.call(body, "note")) {
      patch.reviewNote = String(body.note || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "targetKnowledgeId")) {
      patch.targetKnowledgeId = String(body.targetKnowledgeId || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "targetKnowledgeFileName")) {
      patch.targetKnowledgeFileName = String(body.targetKnowledgeFileName || "").trim();
    }
    if (Array.isArray(body.tags)) {
      patch.tags = body.tags.map((item) => String(item || "").trim()).filter(Boolean);
    } else if (Object.prototype.hasOwnProperty.call(body, "tags")) {
      patch.tags = String(body.tags || "")
        .split(/[\n,，]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return patch;
  }

  function loadNormalizedMessageMap() {
    const events = dedupeMessageEventsByTraceId(
      readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER),
      { prefer: "last" },
    );
    return new Map(events.map((item) => [item.traceId, item]));
  }

  function loadNormalizedEvents() {
    const result = readJsonlFile(NORMALIZED_LOG_PATH, 200);
    return dedupeMessageEventsByTraceId(result);
  }

  function messageTimestampMs(message) {
    const iso = message.sendTimeIso || message.receivedAt;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : Date.now();
  }

  function parseArchiveStdout(stdout) {
    if (!stdout || !String(stdout).trim()) {
      return null;
    }
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  function buildPublicMediaUrl(mediaUrl, message = null) {
    const raw = String(mediaUrl || "").trim();
    if (!raw) {
      return "";
    }
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    if (!raw.startsWith("/")) {
      return "";
    }
    if (DASHBOARD_PUBLIC_URL) {
      return `${DASHBOARD_PUBLIC_URL}${raw}`;
    }
    const host = String(message?.requestHost || "").trim();
    if (host) {
      const protocol = String(message?.requestProtocol || "").trim() || "http";
      return `${protocol}://${host}${raw}`;
    }
    return "";
  }

  function extractLlmResponseText(response) {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content.map((item) => item?.text || item?.content || "").join("").trim();
    }
    return "";
  }

  function tryParseClassifyJson(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      throw new Error("empty_response");
    }
    const withoutFence = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    const candidate = start >= 0 && end >= start ? withoutFence.slice(start, end + 1) : withoutFence;
    return JSON.parse(candidate);
  }

  async function requestLlmClassify(messages) {
    if (!LLM_API_KEY || !LLM_API_URL) {
      throw new Error("llm_config_missing");
    }
    const endpoint = LLM_API_URL.replace(/\/$/, "") + "/chat/completions";
    const payload = {
      model: LLM_MODEL,
      temperature: 0,
      enable_thinking: false,
      response_format: { type: "json_object" },
      messages,
    };
    const headers = {
      Authorization: `Bearer ${LLM_API_KEY}`,
    };
    return invokeWithLlmTimeoutRetry(
      async () => {
        const streamedText = await requestStreamingChatText(
          endpoint,
          payload,
          headers,
          LLM_TIMEOUT_MS,
        );
        if (streamedText) {
          return streamedText;
        }
        const response = await requestJsonWithHeaders(
          "POST",
          endpoint,
          payload,
          headers,
          LLM_TIMEOUT_MS,
        );
        const text = extractLlmResponseText(response);
        if (text) {
          return text;
        }
        throw new Error("empty_response");
      },
      {
        maxAttempts: LLM_TIMEOUT_RETRY_ATTEMPTS,
        baseDelayMs: LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
        maxDelayMs: LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
      },
    );
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

  function listRoomMessages(roomId, limit = 20) {
    const normalizedEvents = dedupeMessageEventsByTraceId(
      readJsonlFile(NORMALIZED_LOG_PATH, Number.MAX_SAFE_INTEGER),
      { prefer: "last" },
    )
      .filter((item) => String(item?.roomId || "") === String(roomId || ""))
      .sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right))
      .slice(-limit);
    return normalizedEvents.map((item) => buildLlmReadyMessage(item));
  }

  return {
    buildPublicMediaUrl,
    extractLlmResponseText,
    listRoomMessages,
    loadNormalizedEvents,
    loadNormalizedMessageMap,
    messageTimestampMs,
    normalizeKnowledgeCandidatePatch,
    normalizePriorityItem,
    parseArchiveStdout,
    requestLlmClassify,
    tryParseClassifyJson,
  };
}

module.exports = {
  createFlowbotServerHelpers,
};
