function createMessageTextUtils({
  CASE_KEYWORDS,
  FEATURE_KEYWORDS,
  INCIDENT_KEYWORDS,
  PRIORITY_ALIASES,
  PRIORITY_KEYWORDS,
  buildPublicMediaUrl,
  normalizeMsgTypeKey,
}) {
  function containsAny(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword));
  }

  function normalizePriority(value, defaultValue = "P2") {
    const raw = String(value || "").trim();
    if (!raw) {
      return defaultValue;
    }
    return PRIORITY_ALIASES[raw.toLowerCase()] || raw.toUpperCase();
  }

  function detectPriority(text) {
    if (containsAny(text, PRIORITY_KEYWORDS.P0)) {
      return "P0";
    }
    if (containsAny(text, PRIORITY_KEYWORDS.P1)) {
      return "P1";
    }
    return "P2";
  }

  function extractKeywords(text) {
    const matches = text.match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9_]{3,}/g) || [];
    const seen = new Set();
    const result = [];
    for (const item of matches) {
      const cleaned = item.trim();
      if (!cleaned || seen.has(cleaned)) {
        continue;
      }
      seen.add(cleaned);
      result.push(cleaned);
      if (result.length >= 6) {
        break;
      }
    }
    return result;
  }

  function normalizeArchiveText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isWeakSummaryText(text) {
    const normalized = normalizeArchiveText(text);
    if (!normalized) {
      return true;
    }
    if (normalized.length < 6) {
      return true;
    }
    if (/^wxid[_-]/i.test(normalized)) {
      return true;
    }
    if (/^[A-Za-z0-9_:\-]{8,}$/.test(normalized) && !/[\u4e00-\u9fff]/.test(normalized)) {
      return true;
    }
    return false;
  }

  function buildArchiveMessageContent(item) {
    const directText = normalizeArchiveText(item.content);
    const quoteText = normalizeArchiveText(item.quoteContent);
    const title = normalizeArchiveText(item.title || item.messageTitle);
    const desc = normalizeArchiveText(item.desc);
    const url = normalizeArchiveText(item.url || item.imageUrl);
    const localMediaUrl = normalizeArchiveText(item.mediaLocalUrl);
    const fileName = normalizeArchiveText(item.fileName);
    const typeName = normalizeMsgTypeKey(item.msgTypeName, item.msgType);

    if (typeName === "text") {
      return directText || quoteText;
    }
    if (typeName === "link" || typeName === "miniapp" || typeName === "channels") {
      return normalizeArchiveText([directText, title, desc, url].filter(Boolean).join(" "));
    }
    if (typeName === "mixed" || typeName === "forwarded_bundle") {
      const nestedText = Array.isArray(item.nestedMessages)
        ? item.nestedMessages.map((nested) => normalizeArchiveText(nested.content || nested.quoteContent)).filter(Boolean).join(" ")
        : "";
      return normalizeArchiveText([directText, title, desc, quoteText, nestedText].filter(Boolean).join(" "));
    }
    if (typeName === "voice") {
      if (directText) {
        return directText;
      }
      return normalizeArchiveText(["[语音]", quoteText].filter(Boolean).join(" "));
    }
    if (typeName === "image") {
      return normalizeArchiveText(["[图片]", directText, title, desc, url, localMediaUrl, quoteText].filter(Boolean).join(" "));
    }
    if (typeName === "video") {
      return normalizeArchiveText(["[视频]", title, desc, url, localMediaUrl, quoteText].filter(Boolean).join(" "));
    }
    if (typeName === "file") {
      return normalizeArchiveText(["[文件]", fileName, url, localMediaUrl, quoteText].filter(Boolean).join(" "));
    }
    if (typeName === "emoji") {
      return "[表情]";
    }
    return normalizeArchiveText([directText, title, desc, url, fileName, quoteText].filter(Boolean).join(" "));
  }

  function normalizeWakeText(text) {
    return String(text || "").trim().toLowerCase();
  }

  function normalizeMentionIdList(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  function isAuxiliaryArchiveContent(text) {
    const normalized = normalizeArchiveText(text);
    if (!normalized) {
      return true;
    }
    if (/^\[(图片|视频|文件|语音|表情)\]/.test(normalized)) {
      return true;
    }
    return isWeakSummaryText(normalized);
  }

  function isAuxiliaryOnlyLlmContent(text) {
    const normalized = normalizeArchiveText(text);
    if (!normalized) {
      return true;
    }
    if (/^\[(图片|视频|文件|语音|表情)\](\s+\S+)?$/u.test(normalized)) {
      return true;
    }
    if (/^\/flowbot\/media\//.test(normalized)) {
      return true;
    }
    return isAuxiliaryArchiveContent(normalized);
  }

  function buildLlmReadyMessage(item) {
    const normalizedInput = {
      ...item,
      msgTypeName: item?.msgTypeName || item?.type || "",
      quoteContent: item?.quoteContent ?? item?.quote_content ?? "",
      mediaLocalUrl: item?.mediaLocalUrl ?? item?.media_local_url ?? "",
      mediaLocalPath: item?.mediaLocalPath ?? item?.media_local_path ?? "",
      mediaRemoteUrl: item?.mediaRemoteUrl ?? item?.media_remote_url ?? "",
      mediaMimeType: item?.mediaMimeType ?? item?.media_mime_type ?? "",
      mediaSizeBytes: item?.mediaSizeBytes ?? item?.media_size_bytes ?? null,
      mediaWidth: item?.mediaWidth ?? item?.media_width ?? null,
      mediaHeight: item?.mediaHeight ?? item?.media_height ?? null,
      mediaKind: item?.mediaKind ?? item?.media_kind ?? "",
      mediaFileType: item?.mediaFileType ?? item?.media_file_type ?? null,
      mediaDownloadStatus: item?.mediaDownloadStatus ?? item?.media_download_status ?? "",
      fileName: item?.fileName ?? item?.file_name ?? "",
      messageTitle: item?.messageTitle ?? item?.message_title ?? "",
      transcriptStatus: item?.transcriptStatus ?? item?.transcript_status ?? "",
      transcriptText: item?.transcriptText ?? item?.transcript_text ?? "",
      transcriptLanguage: item?.transcriptLanguage ?? item?.transcript_language ?? "",
      transcriptDurationSeconds: item?.transcriptDurationSeconds ?? item?.transcript_duration_seconds ?? null,
      transcriptProvider: item?.transcriptProvider ?? item?.transcript_provider ?? "",
      transcriptModel: item?.transcriptModel ?? item?.transcript_model ?? "",
      transcriptError: item?.transcriptError ?? item?.transcript_error ?? "",
    };
    const content = buildArchiveMessageContent(normalizedInput) || normalizeArchiveText(item?.content || "");
    const mediaLocalUrl = String(normalizedInput.mediaLocalUrl || "").trim();
    const publicMediaUrl = buildPublicMediaUrl(mediaLocalUrl, item);
    return {
      msg_id: item?.id || item?.msg_id || null,
      seq: item?.seq || "",
      trace_id: item?.traceId || item?.trace_id || "",
      room_id: item?.roomId || item?.room_id || "",
      room_name: item?.roomName || item?.room_name || "",
      time: item?.sendTimeIso || item?.time || item?.receivedAt || "",
      sender: item?.senderName || item?.sender || item?.senderId || item?.sender_id || "unknown",
      sender_id: item?.senderId || item?.sender_id || "",
      receiver_id: item?.receiverId || item?.receiver_id || "",
      type: normalizedInput.msgTypeName || item?.type || item?.msgType || "unknown",
      content,
      refer_id: item?.referId || item?.refer_id || "",
      quote_content: normalizedInput.quoteContent || "",
      at_list: Array.isArray(item?.atList) ? item.atList : (Array.isArray(item?.at_list) ? item.at_list : []),
      title: item?.title || "",
      desc: item?.desc || "",
      url: item?.url || item?.imageUrl || "",
      file_name: normalizedInput.fileName || "",
      has_media: Boolean(mediaLocalUrl || normalizedInput.mediaKind),
      media_kind: normalizedInput.mediaKind || "",
      media_file_type: normalizedInput.mediaFileType ?? null,
      media_download_status: normalizedInput.mediaDownloadStatus || "",
      media_local_path: normalizedInput.mediaLocalPath || "",
      media_local_url: mediaLocalUrl,
      media_public_url: publicMediaUrl,
      media_remote_url: normalizedInput.mediaRemoteUrl || "",
      media_mime_type: normalizedInput.mediaMimeType || "",
      media_size_bytes: normalizedInput.mediaSizeBytes ?? null,
      media_width: normalizedInput.mediaWidth ?? null,
      media_height: normalizedInput.mediaHeight ?? null,
      transcript_status: normalizedInput.transcriptStatus || "",
      transcript_text: normalizedInput.transcriptText || "",
      transcript_language: normalizedInput.transcriptLanguage || "",
      transcript_duration_seconds: normalizedInput.transcriptDurationSeconds ?? null,
      transcript_provider: normalizedInput.transcriptProvider || "",
      transcript_model: normalizedInput.transcriptModel || "",
      transcript_error: normalizedInput.transcriptError || "",
      nested_messages: Array.isArray(item?.nestedMessages) ? item.nestedMessages : (Array.isArray(item?.nested_messages) ? item.nested_messages : []),
    };
  }

  function groupHasSubstantiveEvidence(messages) {
    return (Array.isArray(messages) ? messages : []).some((item) => {
      const llmReady = buildLlmReadyMessage(item);
      const text = normalizeArchiveText(llmReady.content);
      if (llmReady.transcript_text) {
        return true;
      }
      if (llmReady.quote_content && !isAuxiliaryOnlyLlmContent(llmReady.quote_content)) {
        return true;
      }
      return !isAuxiliaryOnlyLlmContent(text);
    });
  }

  function shouldDelayMediaOnlyCase(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      return false;
    }
    if (groupHasSubstantiveEvidence(list)) {
      return false;
    }
    return list.every((item) => {
      const llmReady = buildLlmReadyMessage(item);
      return Boolean(llmReady.has_media || llmReady.media_kind);
    });
  }

  function limitBatchPlannerText(text, maxLength = 160) {
    const normalized = normalizeArchiveText(text);
    if (!normalized) {
      return "";
    }
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
  }

  function buildBatchPlannerPendingMessage(item) {
    const llmReady = buildLlmReadyMessage(item);
    const payload = {
      trace_id: llmReady.trace_id || "",
      time: llmReady.time || "",
      sender: llmReady.sender || "unknown",
      sender_id: llmReady.sender_id || "",
      type: llmReady.type || "unknown",
      content: limitBatchPlannerText(llmReady.content || "", 240),
      refer_id: llmReady.refer_id || "",
      quote_content: limitBatchPlannerText(llmReady.quote_content || "", 140),
      has_media: Boolean(llmReady.has_media),
      media_kind: llmReady.media_kind || "",
    };
    if (Array.isArray(llmReady.at_list) && llmReady.at_list.length) {
      payload.at_list = llmReady.at_list.slice(0, 8);
    }
    if (llmReady.transcript_text) {
      payload.transcript_text = limitBatchPlannerText(llmReady.transcript_text, 240);
    }
    return payload;
  }

  function buildBatchPlannerOpenCase(item) {
    const reporters = Array.isArray(item?.reporters) ? item.reporters.slice(0, 5) : [];
    const participants = Array.isArray(item?.participants) ? item.participants.slice(0, 5) : [];
    const keywords = Array.isArray(item?.keywords) ? item.keywords.slice(0, 6) : [];
    const lastMessages = Array.isArray(item?.lastMessages) ? item.lastMessages.slice(-2) : [];
    return {
      case_id: item.case_id,
      category: item.category,
      priority: item.priority,
      status: item.status || "",
      reporters,
      participants,
      source_thread_id: item.source_thread_id || "",
      first_message_time: item.first_message_time || "",
      last_message_time: item.last_message_time || "",
      summary: limitBatchPlannerText(item.summary || "", 160),
      keywords,
      updated_at: item.updated_at,
      last_messages: lastMessages.map((row) => ({
        time: row?.time || "",
        sender: row?.sender || "",
        type: row?.type || "",
        content: limitBatchPlannerText(row?.content || "", 180),
      })),
    };
  }

  return {
    buildArchiveMessageContent,
    buildBatchPlannerOpenCase,
    buildBatchPlannerPendingMessage,
    buildLlmReadyMessage,
    containsAny,
    detectPriority,
    extractKeywords,
    isAuxiliaryArchiveContent,
    isWeakSummaryText,
    normalizeArchiveText,
    normalizeMentionIdList,
    normalizePriority,
    normalizeWakeText,
    shouldDelayMediaOnlyCase,
  };
}

module.exports = { createMessageTextUtils };
