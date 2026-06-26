function createFeishuMessageNormalizer({
  FEISHU_APP_ID,
  FEISHU_MESSAGE_TYPE_TO_FLOWBOT,
  FEISHU_VERIFICATION_TOKEN,
  MSG_TYPE_NAMES,
  isFeishuChatIdAllowed,
  toIsoTime,
}) {
  function decodeFeishuContent(rawContent) {
    if (!rawContent || typeof rawContent !== "string") {
      return rawContent || {};
    }
    try {
      return JSON.parse(rawContent);
    } catch {
      return { text: rawContent };
    }
  }

  function compactJson(value) {
    return JSON.stringify(value, null, 0);
  }

  function pickFirstString(input, keys) {
    if (!input || typeof input !== "object") {
      return "";
    }
    for (const key of keys) {
      const value = input[key];
      if (value != null && String(value).trim()) {
        return String(value).trim();
      }
    }
    return "";
  }

  function pickFeishuSenderId(sender) {
    const senderId = sender?.sender_id || {};
    return pickFirstString(senderId, ["open_id", "user_id", "union_id"]) || compactJson(senderId);
  }

  function normalizeFeishuMentionList(mentions) {
    const values = [];
    for (const item of Array.isArray(mentions) ? mentions : []) {
      const id = item?.id && typeof item.id === "object" ? item.id : {};
      for (const value of [
        id.open_id,
        id.user_id,
        id.union_id,
        item?.id,
        item?.key,
        item?.name,
      ]) {
        const text = typeof value === "string" ? value.trim() : "";
        if (text) {
          values.push(text);
        }
      }
      if (String(item?.mentioned_type || "").trim() === "bot") {
        values.push(FEISHU_APP_ID);
      }
    }
    return Array.from(new Set(values.filter(Boolean)));
  }

  function normalizeFeishuCreateTime(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return Math.floor(Date.now() / 1000);
    }
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  function buildFeishuTextContent(messageType, content) {
    if (messageType === "text" || messageType === "post") {
      return String(content?.text || content?.title || compactJson(content || {})).trim();
    }
    if (messageType === "image") {
      return "[图片]";
    }
    if (messageType === "media") {
      return "[视频]";
    }
    if (messageType === "file") {
      return "[文件]";
    }
    if (messageType === "audio") {
      return "[语音]";
    }
    if (messageType === "sticker") {
      return "[表情]";
    }
    return String(content?.text || compactJson(content || {})).trim();
  }

  function buildFeishuTraceId(payload) {
    const header = payload?.header || {};
    const message = payload?.event?.message || {};
    return [
      "feishu",
      header.event_id || "no-event",
      message.chat_id || "no-chat",
      message.message_id || "no-message",
    ].join(":");
  }

  function normalizeFeishuPayload(payload, requestMeta) {
    const header = payload?.header || {};
    const event = payload?.event || {};
    const message = event.message || {};
    const sender = event.sender || {};
    const messageType = String(message.message_type || "unknown").trim() || "unknown";
    const content = decodeFeishuContent(message.content);
    const contentObject = content && typeof content === "object" && !Array.isArray(content) ? content : {};
    const senderId = pickFeishuSenderId(sender);
    const msgType = FEISHU_MESSAGE_TYPE_TO_FLOWBOT[messageType] || 2;
    const sendTime = normalizeFeishuCreateTime(message.create_time || header.create_time);
    const messageId = String(message.message_id || header.event_id || "");
    const imageKey = String(contentObject.image_key || "").trim();
    const fileKey = String(contentObject.file_key || "").trim();
    const fileName = String(contentObject.file_name || "").trim();
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];

    return {
      traceId: buildFeishuTraceId(payload),
      receivedAt: requestMeta.receivedAt,
      sourceIp: requestMeta.headers["x-forwarded-for"] || requestMeta.headers["x-real-ip"] || "",
      requestHost: requestMeta.headers["x-forwarded-host"] || requestMeta.headers.host || "",
      requestProtocol: String(requestMeta.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "",
      guid: `feishu:${messageId}`,
      notifyType: 11010,
      seq: messageId,
      id: messageId,
      rawRoomId: String(message.chat_id || ""),
      roomId: String(message.chat_id || ""),
      roomName: String(message.chat_id || ""),
      senderId,
      senderName: senderId,
      receiverId: FEISHU_APP_ID,
      sendTime,
      sendTimeIso: toIsoTime(sendTime),
      contentType: null,
      msgType,
      msgTypeName: MSG_TYPE_NAMES[msgType] || messageType,
      content: buildFeishuTextContent(messageType, contentObject),
      quoteContent: "",
      quoteAppInfo: "",
      atList: normalizeFeishuMentionList(mentions),
      extraContent: compactJson(contentObject),
      referId: String(message.parent_id || message.root_id || ""),
      flag: null,
      sendFlag: 0,
      appInfo: "",
      url: fileKey,
      title: "",
      desc: "",
      fileName,
      imageUrl: imageKey,
      messageTitle: "",
      mediaKind: "",
      mediaFileType: null,
      mediaDownloadStatus: imageKey || fileKey ? "remote_key_only" : "",
      mediaDownloadError: "",
      mediaLocalPath: "",
      mediaLocalUrl: "",
      mediaRemoteUrl: fileKey || imageKey,
      mediaMimeType: "",
      mediaSizeBytes: null,
      mediaWidth: null,
      mediaHeight: null,
      transcriptStatus: "",
      transcriptText: "",
      transcriptLanguage: "",
      transcriptDurationSeconds: null,
      transcriptProvider: "",
      transcriptModel: "",
      transcriptError: "",
      nestedMessages: [],
      rawData: {
        source: "feishu",
        header,
        event,
        content: contentObject,
      },
    };
  }

  function evaluateFeishuPayload(payload) {
    if (payload?.encrypt) {
      return { accepted: false, reason: "feishu_encrypted_payload_not_supported" };
    }
    const token = String(payload?.header?.token || payload?.token || "").trim();
    if (FEISHU_VERIFICATION_TOKEN && token !== FEISHU_VERIFICATION_TOKEN) {
      return { accepted: false, reason: "feishu_token_mismatch" };
    }
    const eventType = String(payload?.header?.event_type || "").trim();
    if (eventType !== "im.message.receive_v1") {
      return { accepted: false, reason: `feishu_event_filtered:${eventType || "unknown"}` };
    }
    const message = payload?.event?.message || {};
    const roomId = String(message.chat_id || "").trim();
    if (!roomId) {
      return { accepted: false, reason: "feishu_chat_id_missing" };
    }
    if (!isFeishuChatIdAllowed(roomId)) {
      return { accepted: false, reason: `feishu_chat_id_filtered:${roomId}` };
    }
    return { accepted: true, reason: "accepted" };
  }

  return {
    buildFeishuTraceId,
    evaluateFeishuPayload,
    normalizeFeishuPayload,
    pickFeishuSenderId,
  };
}

module.exports = { createFeishuMessageNormalizer };
