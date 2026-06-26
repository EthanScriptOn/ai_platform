function createArchiveNotificationService({
  CASE_KEYWORDS,
  CATEGORY_LABELS,
  DASHBOARD_PUBLIC_URL,
  FEISHU_SEND_MESSAGE_URL,
  FEATURE_KEYWORDS,
  INCIDENT_KEYWORDS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  PORT,
  UPSTREAM_WECOM_API_BASE,
  buildArchiveMessageContent,
  containsAny,
  getFeishuAppAccessToken,
  isWeakSummaryText,
  normalizeArchiveText,
  normalizeMsgTypeKey,
  normalizePriority,
  requestJson,
  requestJsonWithHeaders,
  searchKnowledgeDocuments,
}) {
  function pickArchiveSummary(contextMessages, combinedText) {
    const scored = contextMessages.map((item, index) => {
      const text = normalizeArchiveText(item.content);
      const typeKey = normalizeMsgTypeKey(item.type);
      let score = 0;
      if (!isWeakSummaryText(text)) {
        score += 5;
      }
      if (containsAny(text, FEATURE_KEYWORDS) || containsAny(text, INCIDENT_KEYWORDS) || containsAny(text, CASE_KEYWORDS)) {
        score += 10;
      }
      if (/[\u4e00-\u9fff]/.test(text)) {
        score += 3;
      }
      if (typeKey === "text" || typeKey === "link" || typeKey === "mixed" || typeKey === "forwarded_bundle") {
        score += 2;
      }
      if (text.startsWith("[图片]") || text.startsWith("[视频]") || text.startsWith("[文件]")) {
        score -= 2;
      }
      score += Math.min(text.length, 80) / 80;
      score += (index + 1) / Math.max(1, contextMessages.length);
      return { index, text, score };
    });
    scored.sort((left, right) => right.score - left.score || right.index - left.index);
    const selected = scored.find((item) => item.text && !isWeakSummaryText(item.text)) || scored[0];
    const summarySource = normalizeArchiveText(selected?.text || combinedText);
    return summarySource.length > 80 ? `${summarySource.slice(0, 80)}...` : summarySource;
  }

  function buildDashboardUrl(message) {
    const roomId = encodeURIComponent(String(message?.roomId || "").trim());
    const roomQuery = roomId ? `?roomId=${roomId}` : "";
    if (DASHBOARD_PUBLIC_URL) {
      return `${DASHBOARD_PUBLIC_URL}${roomQuery}`;
    }
    const host = String(message?.requestHost || "").trim();
    if (host) {
      const protocol = String(message?.requestProtocol || "").trim() || "http";
      return `${protocol}://${host}/flowbot/dashboard${roomQuery}`;
    }
    return `http://127.0.0.1:${PORT}/flowbot/dashboard${roomQuery}`;
  }

  function buildUpstreamConversationId(conversationId) {
    const raw = String(conversationId || "").trim();
    if (!raw) {
      return "";
    }
    if (/^R:/i.test(raw)) {
      return raw;
    }
    return `R:${raw}`;
  }

  function buildCaseSolutionFallbackText() {
    return "当前知识库暂无可直接复用方案，请产品和研发介入评估处理。";
  }

  function buildCaseSolutionSearchQuery({
    message,
    classificationPayload,
    archiveResult,
  }) {
    const summary = normalizeArchiveText(classificationPayload?.summary || "");
    const category = normalizeArchiveText(
      CATEGORY_LABELS[classificationPayload?.category] || classificationPayload?.category || "",
    );
    const caseTitle = normalizeArchiveText(archiveResult?.case?.title || archiveResult?.case?.summary || "");
    const messageText = normalizeArchiveText(buildArchiveMessageContent(message || {}));
    const parts = [summary, caseTitle, category, messageText].filter(Boolean);
    return parts.slice(0, 3).join(" ");
  }

  function formatCaseSolutionFromKnowledge(hit) {
    if (!hit) {
      return buildCaseSolutionFallbackText();
    }
    const title = normalizeArchiveText(hit.title || hit.fileName || "");
    const snippet = normalizeArchiveText(hit.snippet || "");
    const snippetText = snippet.length > 120 ? `${snippet.slice(0, 120)}...` : snippet;
    if (title && snippetText) {
      return `参考知识库《${title}》：${snippetText}`;
    }
    if (title) {
      return `参考知识库《${title}》处理。`;
    }
    if (snippetText) {
      return snippetText;
    }
    return buildCaseSolutionFallbackText();
  }

  async function buildCaseArchiveSolutionText({
    message,
    classificationPayload,
    archiveResult,
  }) {
    const query = buildCaseSolutionSearchQuery({
      message,
      classificationPayload,
      archiveResult,
    });
    if (!query) {
      return buildCaseSolutionFallbackText();
    }
    try {
      const knowledge = await searchKnowledgeDocuments(query, 1, { source: "all" });
      return formatCaseSolutionFromKnowledge(knowledge.docs[0] || null);
    } catch {
      return buildCaseSolutionFallbackText();
    }
  }

  async function buildCaseArchiveNotificationText({
    message,
    classificationPayload,
    archiveResult,
    dashboardUrl,
  }) {
    const caseId = String(archiveResult?.case?.case_id || "").trim() || "未知";
    const reporter = String(message?.senderName || message?.senderId || "未知反馈人").trim();
    const category = CATEGORY_LABELS[classificationPayload?.category] || String(classificationPayload?.category || "未分类");
    const priority = normalizePriority(classificationPayload?.priority || "P2", "P2");
    const summary = normalizeArchiveText(classificationPayload?.summary || message?.content || "收到新的 case 归档");
    return [
      `【问题已归档】`,
      `反馈人：${reporter}`,
      `问题：${summary || "无摘要"}`,
      `分类：${category}｜优先级：${priority}`,
      `Case ID：${caseId}`,
      `查看归档：${dashboardUrl}`,
    ].join("\n");
  }

  async function sendRoomArchiveNotification({ guid, conversationId, content }) {
    const upstreamConversationId = buildUpstreamConversationId(conversationId);
    const response = await requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/msg/send_text`,
      {
        guid,
        conversation_id: upstreamConversationId,
        content,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
    if (Object.prototype.hasOwnProperty.call(response || {}, "error_code") && Number(response?.error_code) !== 0) {
      throw new Error(`send_text_failed:${response?.error_code}:${response?.error_message || "unknown"}`);
    }
    return response;
  }

  function isFeishuAgentTask(task, conversationId = "") {
    const traceId = String(task?.traceId || task?.llmReadyMessage?.trace_id || "").trim();
    const roomId = String(conversationId || task?.rawRoomId || task?.roomId || "").trim();
    return traceId.startsWith("feishu:") || roomId.startsWith("oc_");
  }

  async function sendFeishuTextMessage({ chatId, content }) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) {
      throw new Error("feishu_chat_id_required");
    }
    const token = await getFeishuAppAccessToken();
    const response = await requestJsonWithHeaders(
      "POST",
      `${FEISHU_SEND_MESSAGE_URL}?receive_id_type=chat_id`,
      {
        receive_id: normalizedChatId,
        msg_type: "text",
        content: JSON.stringify({ text: String(content || "") }),
      },
      {
        Authorization: `Bearer ${token.token}`,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
    if (Number(response?.code || 0) !== 0) {
      throw new Error(`feishu_send_text_failed:${response?.code}:${response?.msg || response?.message || "unknown"}`);
    }
    return response;
  }

  async function sendAgentReplyMessage({ task = null, guid = "", conversationId = "", content = "" } = {}) {
    if (isFeishuAgentTask(task, conversationId)) {
      return {
        platform: "feishu",
        response: await sendFeishuTextMessage({
          chatId: conversationId || task?.rawRoomId || task?.roomId || "",
          content,
        }),
      };
    }
    if (!guid) {
      throw new Error("guid_required");
    }
    if (!conversationId) {
      throw new Error("conversation_id_required");
    }
    return {
      platform: "wecom",
      response: await sendRoomArchiveNotification({
        guid,
        conversationId,
        content,
      }),
    };
  }

  return {
    buildCaseArchiveNotificationText,
    buildCaseArchiveSolutionText,
    buildCaseSolutionFallbackText,
    buildCaseSolutionSearchQuery,
    buildDashboardUrl,
    buildUpstreamConversationId,
    formatCaseSolutionFromKnowledge,
    isFeishuAgentTask,
    pickArchiveSummary,
    sendAgentReplyMessage,
    sendFeishuTextMessage,
    sendRoomArchiveNotification,
  };
}

module.exports = {
  createArchiveNotificationService,
};
