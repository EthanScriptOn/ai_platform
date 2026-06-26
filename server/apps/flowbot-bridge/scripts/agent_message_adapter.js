"use strict";

function normalizeAgentText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isLikelyImageMime(mimeType) {
  return /^image\//i.test(String(mimeType || "").trim());
}

function buildCanonicalMessage(input = {}) {
  return {
    traceId: String(input.traceId || input.trace_id || "").trim(),
    source: String(input.source || "").trim(),
    sourceLabel: String(input.sourceLabel || "").trim(),
    roomId: String(input.roomId || input.room_id || "").trim(),
    roomName: String(input.roomName || input.room_name || "").trim(),
    senderName: String(input.senderName || input.sender || "").trim(),
    senderId: String(input.senderId || input.sender_id || "").trim(),
    sendTimeIso: String(input.sendTimeIso || input.time || "").trim(),
    msgType: input.msgType ?? input.msg_type ?? null,
    msgTypeName: String(input.msgTypeName || input.type || "").trim(),
    content: String(input.content || "").trim(),
    transcriptText: String(input.transcriptText || input.transcript_text || "").trim(),
    quoteContent: String(input.quoteContent || input.quote_content || "").trim(),
    title: String(input.title || "").trim(),
    desc: String(input.desc || "").trim(),
    fileName: String(input.fileName || input.file_name || "").trim(),
    mediaKind: String(input.mediaKind || input.media_kind || "").trim(),
    hasMedia: Boolean(input.hasMedia || input.has_media || input.mediaKind || input.media_kind),
    mediaPublicUrl: String(input.mediaPublicUrl || input.media_public_url || "").trim(),
    mediaLocalUrl: String(input.mediaLocalUrl || input.media_local_url || "").trim(),
    mediaLocalPath: String(input.mediaLocalPath || input.media_local_path || "").trim(),
    mediaMimeType: String(input.mediaMimeType || input.media_mime_type || "").trim(),
    mediaWidth: input.mediaWidth ?? input.media_width ?? null,
    mediaHeight: input.mediaHeight ?? input.media_height ?? null,
    mediaSizeBytes: input.mediaSizeBytes ?? input.media_size_bytes ?? null,
    referId: String(input.referId || input.refer_id || "").trim(),
    caseId: String(input.caseId || "").trim(),
    caseSummary: String(input.caseSummary || "").trim(),
    caseCategory: String(input.caseCategory || "").trim(),
    casePriority: String(input.casePriority || "").trim(),
    caseStatus: String(input.caseStatus || "").trim(),
    messageRole: String(input.messageRole || "").trim(),
    threadType: String(input.threadType || "").trim(),
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : null,
    snippet: String(input.snippet || "").trim(),
  };
}

function looksLikeMessageRecord(input = {}) {
  const canonical = buildCanonicalMessage(input);
  return Boolean(
    canonical.traceId
    || canonical.msgTypeName
    || canonical.mediaKind
    || canonical.sendTimeIso
    || canonical.senderName
    || canonical.senderId
    || canonical.content
    || canonical.transcriptText
    || canonical.quoteContent
  );
}

function messageMentionsImageReference(message) {
  const canonical = buildCanonicalMessage(message);
  if (canonical.mediaKind) {
    return false;
  }
  const text = normalizeAgentText([
    canonical.content,
    canonical.quoteContent,
    canonical.title,
    canonical.desc,
  ].filter(Boolean).join(" "));
  if (!text) {
    return false;
  }
  return /(这个图|这张图|刚才.*图|上一张图|图片|截图|看图|识图|读图)/u.test(text);
}

function buildAgentReadableMessage(message) {
  const canonical = buildCanonicalMessage(message);
  const lines = [];
  if (canonical.sourceLabel) {
    lines.push(`source=${canonical.sourceLabel}`);
  } else if (canonical.source) {
    lines.push(`source=${canonical.source}`);
  }
  if (canonical.caseId) {
    lines.push(`case_id=${canonical.caseId}`);
  }
  if (canonical.caseSummary) {
    lines.push(`case_summary=${canonical.caseSummary}`);
  }
  if (canonical.roomId) {
    lines.push(`room_id=${canonical.roomId}`);
  }
  if (canonical.roomName) {
    lines.push(`room_name=${canonical.roomName}`);
  }
  if (canonical.traceId) {
    lines.push(`trace_id=${canonical.traceId}`);
  }
  if (canonical.sendTimeIso) {
    lines.push(`time=${canonical.sendTimeIso}`);
  }
  if (canonical.senderName || canonical.senderId) {
    lines.push(`sender=${canonical.senderName || canonical.senderId}`);
  }
  if (canonical.msgTypeName) {
    lines.push(`type=${canonical.msgTypeName}`);
  }
  if (canonical.content) {
    lines.push(`content=${canonical.content}`);
  }
  if (canonical.quoteContent) {
    lines.push(`quote=${canonical.quoteContent}`);
  }
  if (canonical.transcriptText) {
    lines.push(`transcript=${canonical.transcriptText}`);
  }
  if (canonical.mediaKind || canonical.hasMedia) {
    const mediaParts = [];
    if (canonical.mediaKind) {
      mediaParts.push(`kind=${canonical.mediaKind}`);
    }
    if (canonical.fileName) {
      mediaParts.push(`file=${canonical.fileName}`);
    }
    if (canonical.mediaMimeType) {
      mediaParts.push(`mime=${canonical.mediaMimeType}`);
    }
    if (canonical.mediaWidth && canonical.mediaHeight) {
      mediaParts.push(`size=${canonical.mediaWidth}x${canonical.mediaHeight}`);
    }
    if (canonical.mediaSizeBytes) {
      mediaParts.push(`bytes=${canonical.mediaSizeBytes}`);
    }
    if (canonical.mediaPublicUrl) {
      mediaParts.push(`public_url=${canonical.mediaPublicUrl}`);
    }
    if (canonical.mediaLocalUrl) {
      mediaParts.push(`local_url=${canonical.mediaLocalUrl}`);
    }
    if (canonical.mediaLocalPath) {
      mediaParts.push("local_file=present");
    }
    lines.push(`media=${mediaParts.join(" | ") || "present"}`);
  }
  if (canonical.messageRole) {
    lines.push(`message_role=${canonical.messageRole}`);
  }
  if (canonical.threadType) {
    lines.push(`thread_type=${canonical.threadType}`);
  }
  if (canonical.snippet && canonical.snippet !== canonical.content) {
    lines.push(`snippet=${canonical.snippet}`);
  }
  return lines.join("\n");
}

function adaptMessageForAgent(message) {
  if (!looksLikeMessageRecord(message)) {
    return message;
  }
  const canonical = buildCanonicalMessage(message);
  return {
    ...message,
    agentView: canonical,
    agentText: buildAgentReadableMessage(canonical),
  };
}

function summarizeAgentItems(items, label) {
  const list = Array.isArray(items) ? items : [];
  const readableItems = list
    .map((item) => ({
      item,
      text: item?.agentText || (looksLikeMessageRecord(item) ? buildAgentReadableMessage(item) : ""),
    }))
    .filter((entry) => entry.text);
  if (!readableItems.length) {
    return "";
  }
  return [
    `${label}（${readableItems.length}）:`,
    ...readableItems.map((entry, index) => `${index + 1}.\n${entry.text}`),
  ].join("\n");
}

function adaptPayloadForAgent(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const next = { ...payload };
  const summaries = [];

  if (payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)) {
    next.message = adaptMessageForAgent(payload.message);
    if (next.message?.agentText) {
      summaries.push(`message:\n${next.message.agentText}`);
    }
  }

  if (Array.isArray(payload.messages)) {
    next.messages = payload.messages.map((item) => adaptMessageForAgent(item));
    const summary = summarizeAgentItems(next.messages, "messages");
    if (summary) {
      summaries.push(summary);
    }
  }

  if (Array.isArray(payload.items)) {
    next.items = payload.items.map((item) => adaptMessageForAgent(item));
    const summary = summarizeAgentItems(next.items, "items");
    if (summary) {
      summaries.push(summary);
    }
  }

  if (Array.isArray(payload.matches)) {
    next.matches = payload.matches.map((match, index) => {
      const adapted = {
        ...match,
        message: adaptMessageForAgent(match?.message || {}),
        contextBefore: Array.isArray(match?.contextBefore) ? match.contextBefore.map((item) => adaptMessageForAgent(item)) : [],
        contextAfter: Array.isArray(match?.contextAfter) ? match.contextAfter.map((item) => adaptMessageForAgent(item)) : [],
      };
      const parts = [`match ${index + 1}:`, adapted.message.agentText];
      if (adapted.contextBefore.length) {
        parts.push(summarizeAgentItems(adapted.contextBefore, "context_before"));
      }
      if (adapted.contextAfter.length) {
        parts.push(summarizeAgentItems(adapted.contextAfter, "context_after"));
      }
      summaries.push(parts.join("\n"));
      return adapted;
    });
  }

  if (summaries.length) {
    next.agentReadable = summaries.join("\n\n");
  }

  return next;
}

module.exports = {
  adaptMessageForAgent,
  adaptPayloadForAgent,
  buildAgentReadableMessage,
  buildCanonicalMessage,
  isLikelyImageMime,
  looksLikeMessageRecord,
  messageMentionsImageReference,
  normalizeAgentText,
};
