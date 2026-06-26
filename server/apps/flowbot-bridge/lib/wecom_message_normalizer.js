function createWecomMessageNormalizer({
  MSG_TYPE_NAMES,
}) {
  function buildTraceId(payload) {
    const data = payload?.data || {};
    return [
      payload?.guid || "no-guid",
      payload?.notify_type || "no-notify",
      data.roomid || "no-room",
      data.seq || "no-seq",
      data.id || "no-id",
    ].join(":");
  }

  function toIsoTime(seconds) {
    if (!seconds || !Number.isFinite(Number(seconds))) {
      return "";
    }
    return new Date(Number(seconds) * 1000).toISOString();
  }

  function simplifyNestedMessages(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => ({
      msgType: item?.msg_type ?? null,
      contentType: item?.content_type ?? null,
      senderId: item?.sender_id ?? "",
      senderName: item?.sender_name ?? "",
      sendTime: item?.sendtime ?? null,
      sendTimeIso: toIsoTime(item?.sendtime),
      content: item?.content ?? "",
      fileName: item?.file_name ?? "",
      url: item?.url ?? "",
      quoteContent: item?.quote_content ?? "",
    }));
  }

  function normalizePayload(payload, requestMeta) {
    const data = payload?.data || {};
    const msgType = Number(data.msg_type || 0);
    const rawRoomId = String(data.roomid || "");
    return {
      traceId: buildTraceId(payload),
      receivedAt: requestMeta.receivedAt,
      sourceIp: requestMeta.headers["x-forwarded-for"] || requestMeta.headers["x-real-ip"] || "",
      requestHost: requestMeta.headers["x-forwarded-host"] || requestMeta.headers.host || "",
      requestProtocol: String(requestMeta.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "",
      guid: payload?.guid || "",
      notifyType: Number(payload?.notify_type || 0),
      seq: data.seq || "",
      id: data.id || "",
      rawRoomId,
      roomId: rawRoomId,
      roomName: data.room_name || data.chat_name || data.roomid || "",
      senderId: data.sender || "",
      senderName: data.sender_name || "",
      receiverId: data.receiver || "",
      sendTime: data.sendtime || null,
      sendTimeIso: toIsoTime(data.sendtime),
      contentType: data.content_type ?? null,
      msgType,
      msgTypeName: MSG_TYPE_NAMES[msgType] || "unknown",
      content: data.content || "",
      quoteContent: data.quote_content || "",
      quoteAppInfo: data.quote_appinfo || "",
      atList: Array.isArray(data.at_list) ? data.at_list : [],
      extraContent: data.extra_content || "",
      referId: data.referid || "",
      flag: data.flag ?? null,
      sendFlag: data.send_flag ?? null,
      appInfo: data.appinfo || "",
      url: data.url || "",
      title: data.title || "",
      desc: data.desc || "",
      fileName: data.file_name || "",
      imageUrl: data.image_url || "",
      messageTitle: data.message_title || "",
      mediaKind: "",
      mediaFileType: null,
      mediaDownloadStatus: "",
      mediaDownloadError: "",
      mediaLocalPath: "",
      mediaLocalUrl: "",
      mediaRemoteUrl: "",
      mediaMimeType: "",
      mediaSizeBytes: data?.cdn?.size ?? null,
      mediaWidth: data?.cdn?.image_width ?? null,
      mediaHeight: data?.cdn?.image_height ?? null,
      transcriptStatus: data.transcript_status || "",
      transcriptText: data.transcript_text || "",
      transcriptLanguage: data.transcript_language || "",
      transcriptDurationSeconds: data.transcript_duration_seconds ?? null,
      transcriptProvider: data.transcript_provider || "",
      transcriptModel: data.transcript_model || "",
      transcriptError: data.transcript_error || "",
      nestedMessages: simplifyNestedMessages(data.msg_list || data.message_list),
      rawData: data,
    };
  }

  return {
    buildTraceId,
    normalizePayload,
    toIsoTime,
  };
}

module.exports = { createWecomMessageNormalizer };
