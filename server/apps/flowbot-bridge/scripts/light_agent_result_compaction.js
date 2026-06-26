"use strict";

const { DEFAULT_VISION_MAX_IMAGES, MODEL_KNOWLEDGE_SNIPPET_MAX, MODEL_MESSAGE_QUOTE_MAX, MODEL_MESSAGE_TEXT_MAX } = require("./light_agent_runtime_config");

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function limitText(text, maxLength) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(1, maxLength - 3))}...`
    : normalized;
}

function uniqueTextParts(parts) {
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const normalized = normalizeText(part);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function pruneEmpty(value) {
  if (Array.isArray(value)) {
    const nextItems = value
      .map((item) => pruneEmpty(item))
      .filter((item) => item !== undefined);
    return nextItems.length ? nextItems : undefined;
  }
  if (!value || typeof value !== "object") {
    if (value === "" || value == null) {
      return undefined;
    }
    return value;
  }
  const next = {};
  for (const [key, current] of Object.entries(value)) {
    const cleaned = pruneEmpty(current);
    if (cleaned === undefined) {
      continue;
    }
    next[key] = cleaned;
  }
  return Object.keys(next).length ? next : undefined;
}

function buildCompactVisionRefs(visionInputs, maxImages = DEFAULT_VISION_MAX_IMAGES) {
  const list = Array.isArray(visionInputs) ? visionInputs.slice(0, maxImages) : [];
  return list.map((item) => pruneEmpty({
    id: item.traceId || "",
    time: item.sendTimeIso || "",
    from: item.senderName || item.senderId || "",
    mime: item.mediaMimeType || "",
    note: limitText(item.note || "", 80),
  })).filter(Boolean);
}

function compactMessageRecord(item = {}, options = {}) {
  const score = Number(item?.score || 0) || 0;
  const text = uniqueTextParts([
    item.content,
    item.transcriptText,
    item.title,
    item.desc,
    item.snippet,
  ]).join("\n");
  return pruneEmpty({
    id: item.traceId || "",
    seq: item.seq || "",
    time: item.sendTimeIso || "",
    from: item.senderName || item.senderId || "",
    from_id: item.senderId || "",
    to: item.receiverId || "",
    type: item.msgTypeName || item.msgType || "",
    text: limitText(text, options.textMaxLength || MODEL_MESSAGE_TEXT_MAX),
    quote: limitText(item.quoteContent || "", options.quoteMaxLength || MODEL_MESSAGE_QUOTE_MAX),
    media: item.mediaKind || "",
    file: item.fileName || "",
    source: item.source || "",
    case_id: item.caseId || "",
    case_summary: limitText(item.caseSummary || "", 80),
    score: score > 0 && score !== 1 ? Number(score.toFixed(3)) : undefined,
  }) || {};
}

function compactKnowledgeDoc(item = {}) {
  const score = Number(item?.score || item?.similarity || 0) || 0;
  return pruneEmpty({
    title: item.title || "",
    snippet: limitText(item.snippet || item.content || item.summary || "", MODEL_KNOWLEDGE_SNIPPET_MAX),
    source: item.source || item.sourceLabel || item.knowledgeName || "",
    score: score > 0 ? Number(score.toFixed(3)) : undefined,
  }) || {};
}

function compactToolResult(toolName, result = {}, mediaOptions = {}) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const compactVisionRefs = buildCompactVisionRefs(result.visionInputs, mediaOptions.maxImages);
  switch (toolName) {
    case "get_recent_room_messages":
    case "search_room_messages":
      return pruneEmpty({
        total: Number(result.total || 0) || 0,
        hasMore: Boolean(result.hasMore),
        items: Array.isArray(result.items)
          ? result.items.map((item) => compactMessageRecord(item))
          : [],
        images: compactVisionRefs,
      }) || { total: Number(result.total || 0) || 0, hasMore: Boolean(result.hasMore), items: [] };
    case "get_anchor_context":
      return pruneEmpty({
        total: Number(result.total || 0) || 0,
        matches: Array.isArray(result.matches)
          ? result.matches.map((item) => pruneEmpty({
            hit: compactMessageRecord(item?.message || {}, { textMaxLength: 180 }),
            before: Array.isArray(item?.contextBefore)
              ? item.contextBefore.map((contextItem) => compactMessageRecord(contextItem, { textMaxLength: 140 }))
              : [],
            after: Array.isArray(item?.contextAfter)
              ? item.contextAfter.map((contextItem) => compactMessageRecord(contextItem, { textMaxLength: 140 }))
              : [],
          }))
          : [],
        images: compactVisionRefs,
      }) || { total: Number(result.total || 0) || 0, matches: [] };
    case "search_memory":
      return pruneEmpty({
        total: Number(result.total || 0) || 0,
        hasMore: Boolean(result.hasMore),
        items: Array.isArray(result.items)
          ? result.items.map((item) => compactMessageRecord(item, { textMaxLength: 180 }))
          : [],
        images: compactVisionRefs,
      }) || { total: Number(result.total || 0) || 0, hasMore: Boolean(result.hasMore), items: [] };
    case "search_knowledge":
      if (typeof result.answer === "string" && result.answer.trim()) {
        return pruneEmpty({
          provider: result.provider || "knowledge_bot",
          botId: result.botId || "",
          answer: limitText(result.answer, 1800),
          fallbackError: result.knowledgeBotError || "",
        }) || { answer: limitText(result.answer, 1800) };
      }
      return pruneEmpty({
        total: Array.isArray(result.docs) ? result.docs.length : 0,
        knowledgeBotError: result.knowledgeBotError || "",
        items: Array.isArray(result.docs)
          ? result.docs.map((item) => compactKnowledgeDoc(item))
          : [],
      }) || { total: Array.isArray(result.docs) ? result.docs.length : 0, items: [] };
    case "send_group_reply":
      return pruneEmpty({
        ok: Boolean(result.ok),
        taskId: result.taskId || "",
        sentAt: result.sentAt || "",
      }) || { ok: Boolean(result.ok) };
    default:
      return result;
  }
}

function buildVisionInputNote(item = {}) {
  return uniqueTextParts([
    item.content,
    item.transcriptText,
    item.quoteContent,
    item.snippet,
  ]).join(" | ");
}

function collectVisionInputsFromToolResult(toolName, result = {}, mediaOptions = {}) {
  if (!mediaOptions.supportsVision || mediaOptions.imageTransport !== "image_url") {
    return [];
  }
  if (Array.isArray(result?.visionInputs) && result.visionInputs.length) {
    return result.visionInputs.slice(0, mediaOptions.maxImages).map((item) => ({
      traceId: String(item?.traceId || "").trim(),
      senderName: String(item?.senderName || item?.sender || "").trim(),
      senderId: String(item?.senderId || "").trim(),
      sendTimeIso: String(item?.sendTimeIso || item?.time || "").trim(),
      mediaMimeType: String(item?.mediaMimeType || item?.mimeType || "").trim(),
      imageUrl: String(item?.imageUrl || item?.image_url || "").trim(),
      note: normalizeText(item?.note || ""),
      source: String(item?.source || "").trim(),
    })).filter((item) => item.imageUrl);
  }

  const collected = [];
  const seen = new Set();
  const pushItem = (item, source) => {
    const mediaKind = String(item?.mediaKind || item?.media_kind || "").trim().toLowerCase();
    const mediaMimeType = String(item?.mediaMimeType || item?.media_mime_type || "").trim();
    const typeName = String(item?.msgTypeName || item?.type || "").trim().toLowerCase();
    const imageUrl = String(item?.mediaPublicUrl || item?.media_public_url || item?.imageUrl || item?.image_url || "").trim();
    if (!imageUrl) {
      return;
    }
    const looksImage = mediaKind === "image" || /^image\//i.test(mediaMimeType) || typeName === "图片";
    if (!looksImage) {
      return;
    }
    const key = `${String(item?.traceId || item?.trace_id || "").trim()}:${imageUrl}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    collected.push({
      traceId: String(item?.traceId || item?.trace_id || "").trim(),
      senderName: String(item?.senderName || item?.sender || "").trim(),
      senderId: String(item?.senderId || item?.sender_id || "").trim(),
      sendTimeIso: String(item?.sendTimeIso || item?.time || "").trim(),
      mediaMimeType,
      imageUrl,
      note: buildVisionInputNote(item),
      source,
    });
  };

  if (toolName === "get_anchor_context") {
    for (const match of Array.isArray(result?.matches) ? result.matches : []) {
      pushItem(match?.message || {}, "anchor_hit");
      for (const item of Array.isArray(match?.contextBefore) ? match.contextBefore : []) {
        pushItem(item, "anchor_before");
      }
      for (const item of Array.isArray(match?.contextAfter) ? match.contextAfter : []) {
        pushItem(item, "anchor_after");
      }
    }
  } else {
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      pushItem(item, toolName);
    }
  }

  return collected.slice(0, mediaOptions.maxImages);
}

function buildToolVisionFollowupContent(stepVisionPayloads, mediaOptions = {}) {
  if (!mediaOptions.supportsVision || mediaOptions.imageTransport !== "image_url") {
    return null;
  }
  const flattened = [];
  const seen = new Set();
  for (const payload of Array.isArray(stepVisionPayloads) ? stepVisionPayloads : []) {
    for (const item of Array.isArray(payload?.visionInputs) ? payload.visionInputs : []) {
      const key = `${item.traceId || ""}:${item.imageUrl || ""}`;
      if (!item?.imageUrl || seen.has(key)) {
        continue;
      }
      seen.add(key);
      flattened.push({
        toolName: String(payload?.toolName || "").trim(),
        ...item,
      });
      if (flattened.length >= mediaOptions.maxImages) {
        break;
      }
    }
    if (flattened.length >= mediaOptions.maxImages) {
      break;
    }
  }
  if (!flattened.length) {
    return null;
  }
  const toolNameText = Array.from(new Set(flattened.map((item) => item.toolName).filter(Boolean))).join("、");
  const parts = [
    {
      type: "text",
      text: `下面这些图片来自你刚刚调用的工具${toolNameText ? `（${toolNameText}）` : ""}，它们属于工具结果的一部分。请结合这些图片和已有工具返回内容继续判断；如果图片与当前问题无关可以忽略。`,
    },
  ];
  flattened.forEach((item, index) => {
    parts.push({
      type: "text",
      text: [
        `图片${index + 1}`,
        item.traceId ? `trace_id=${item.traceId}` : "",
        item.senderName ? `sender=${item.senderName}` : "",
        item.sendTimeIso ? `time=${item.sendTimeIso}` : "",
        item.note ? `note=${limitText(item.note, 120)}` : "",
      ].filter(Boolean).join(" "),
    });
    parts.push({
      type: "image_url",
      image_url: {
        url: item.imageUrl,
      },
    });
  });
  return parts;
}

module.exports = {
  buildToolVisionFollowupContent,
  collectVisionInputsFromToolResult,
  compactToolResult,
  limitText,
  pruneEmpty,
  uniqueTextParts,
};
