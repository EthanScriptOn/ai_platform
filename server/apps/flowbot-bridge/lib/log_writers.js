"use strict";

const fs = require("fs");

function appendJsonlLine(filePath, item) {
  fs.appendFileSync(filePath, `${JSON.stringify(item)}\n`, "utf8");
}

function createFlowbotLogWriters({
  ARCHIVE_LOG_PATH,
  BATCH_LOG_PATH,
  DATA_DIR,
  FILTER_LOG_PATH,
  KNOWLEDGE_PUBLISH_LOG_PATH,
  LOG_PATH,
  MESSAGE_SEARCH_INDEX_PATH,
  NORMALIZED_LOG_PATH,
  ROUTING_LOG_PATH,
  buildPublicMediaUrl,
  enqueueKnowledgeHarvestMessage,
  mysqlRuntimeStore,
  tokenizeSearchText,
}) {
  function appendRuntimeJsonl(filePath, event) {
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.appendJsonl(DATA_DIR, filePath, event);
      return;
    }
    appendJsonlLine(filePath, event);
  }

  function appendEvent(event) {
    appendRuntimeJsonl(LOG_PATH, event);
  }

  function buildMessageSearchRecord(event) {
    const traceId = String(event?.traceId || event?.trace_id || "").trim();
    if (!traceId) {
      return null;
    }
    const seq = String(event?.seq || "").trim();
    const roomId = String(event?.roomId || event?.room_id || "").trim();
    const senderName = String(event?.senderName || event?.sender_name || event?.sender || "").trim();
    const senderId = String(event?.senderId || event?.sender_id || "").trim();
    const receiverId = String(event?.receiverId || event?.receiver_id || "").trim();
    const sendTimeIso = String(event?.sendTimeIso || event?.time || event?.receivedAt || "").trim();
    const content = String(event?.content || "").trim();
    const transcriptText = String(event?.transcriptText || event?.transcript_text || "").trim();
    const quoteContent = String(event?.quoteContent || event?.quote_content || "").trim();
    const title = String(event?.title || "").trim();
    const desc = String(event?.desc || "").trim();
    const fileName = String(event?.fileName || event?.file_name || "").trim();
    const mediaKind = String(event?.mediaKind || event?.media_kind || "").trim();
    const mediaLocalUrl = String(event?.mediaLocalUrl || event?.media_local_url || "").trim();
    const mediaLocalPath = String(event?.mediaLocalPath || event?.media_local_path || "").trim();
    const mediaMimeType = String(event?.mediaMimeType || event?.media_mime_type || "").trim();
    const mediaPublicUrl = String(
      event?.mediaPublicUrl
      || event?.media_public_url
      || buildPublicMediaUrl(mediaLocalUrl, event),
    ).trim();
    const type = String(event?.msgTypeName || event?.type || event?.msgType || "").trim();
    const searchText = [
      content,
      transcriptText,
      quoteContent,
      title,
      desc,
      fileName,
      senderName,
      senderId,
      mediaKind,
      mediaMimeType,
      type,
    ].filter(Boolean).join("\n");
    return {
      traceId,
      seq,
      roomId,
      roomName: String(event?.roomName || event?.room_id || roomId).trim(),
      senderName,
      senderId,
      receiverId,
      sendTimeIso,
      msgType: Number(event?.msgType || 0) || 0,
      msgTypeName: type,
      content,
      transcriptText,
      quoteContent,
      title,
      desc,
      fileName,
      mediaKind,
      hasMedia: Boolean(event?.hasMedia || event?.has_media || mediaKind),
      mediaLocalPath,
      mediaLocalUrl,
      mediaPublicUrl,
      mediaMimeType,
      mediaWidth: event?.mediaWidth ?? event?.media_width ?? null,
      mediaHeight: event?.mediaHeight ?? event?.media_height ?? null,
      mediaSizeBytes: event?.mediaSizeBytes ?? event?.media_size_bytes ?? null,
      receivedAt: String(event?.receivedAt || "").trim(),
      searchText,
      searchTokens: tokenizeSearchText(searchText),
    };
  }

  function appendMessageSearchRecord(event) {
    const record = buildMessageSearchRecord(event);
    if (!record) {
      return;
    }
    appendRuntimeJsonl(MESSAGE_SEARCH_INDEX_PATH, record);
  }

  function appendNormalizedEvent(event) {
    appendRuntimeJsonl(NORMALIZED_LOG_PATH, event);
    appendMessageSearchRecord(event);
    enqueueKnowledgeHarvestMessage(event);
  }

  function appendFilterDecision(event) {
    appendRuntimeJsonl(FILTER_LOG_PATH, event);
  }

  function appendArchiveDecision(event) {
    appendRuntimeJsonl(ARCHIVE_LOG_PATH, event);
  }

  function appendRoutingDecision(event) {
    appendRuntimeJsonl(ROUTING_LOG_PATH, event);
  }

  function appendBatchDecision(event) {
    appendRuntimeJsonl(BATCH_LOG_PATH, event);
  }

  function appendKnowledgePublishResult(event) {
    appendRuntimeJsonl(KNOWLEDGE_PUBLISH_LOG_PATH, event);
  }

  return {
    appendArchiveDecision,
    appendBatchDecision,
    appendEvent,
    appendFilterDecision,
    appendKnowledgePublishResult,
    appendMessageSearchRecord,
    appendNormalizedEvent,
    appendRoutingDecision,
    buildMessageSearchRecord,
  };
}

module.exports = { createFlowbotLogWriters };
