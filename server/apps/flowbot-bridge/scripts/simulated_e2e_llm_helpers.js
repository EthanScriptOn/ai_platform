"use strict";

function extractTextParts(content) {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      return part?.text || part?.content || "";
    })
    .filter(Boolean);
}

function contentHasImageUrl(content) {
  return Array.isArray(content) && content.some((part) => part?.type === "image_url" && part?.image_url?.url);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTriggerPayload(messages) {
  const userMessages = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "user");
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const message = userMessages[index];
    const parts = extractTextParts(message?.content);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const lines = String(parts[partIndex] || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const line = lines[lineIndex];
        if (!line.startsWith("{") || !line.endsWith("}")) {
          continue;
        }
        const parsed = tryParseJson(line);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      }
    }
  }
  return null;
}

function extractLatestToolPayload(messages) {
  const toolMessages = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "tool");
  for (let index = toolMessages.length - 1; index >= 0; index -= 1) {
    const message = toolMessages[index];
    if (typeof message?.content !== "string") {
      continue;
    }
    const parsed = tryParseJson(message.content);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }
  return null;
}

function summarizeContextItems(payload) {
  if (Array.isArray(payload?.matches)) {
    return payload.matches.flatMap((match) => {
      const list = [];
      if (match?.hit) {
        list.push(match.hit);
      }
      if (Array.isArray(match?.before)) {
        list.push(...match.before);
      }
      if (Array.isArray(match?.after)) {
        list.push(...match.after);
      }
      return list.map((item) => ({
        sender: normalizeText(item?.sender || item?.sender_name || item?.senderName || item?.from || ""),
        type: normalizeText(item?.msgTypeName || item?.type || item?.msg_type || item?.msgType || ""),
        text: normalizeText([
          item?.text,
          item?.content,
          item?.transcript_text,
          item?.transcriptText,
          item?.quote,
          item?.quote_content,
          item?.title,
          item?.desc,
          item?.summary,
        ].filter(Boolean).join(" | ")),
      }));
    });
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map((item) => ({
    sender: normalizeText(item?.sender || item?.sender_name || item?.senderName || item?.from || ""),
    type: normalizeText(item?.msgTypeName || item?.type || item?.msg_type || item?.msgType || ""),
    text: normalizeText([
      item?.text,
      item?.content,
      item?.transcript_text,
      item?.transcriptText,
      item?.quote,
      item?.quote_content,
      item?.title,
      item?.desc,
      item?.summary,
    ].filter(Boolean).join(" | ")),
  }));
}

function contextContains(items, pattern) {
  const target = normalizeText(pattern);
  return items.some((item) => normalizeText([item.sender, item.type, item.text].join(" ")).includes(target));
}

function findObservation(observations, triggerText) {
  return (Array.isArray(observations) ? observations : []).find(
    (item) => item.triggerText === triggerText && Array.isArray(item.contextItems) && item.contextItems.length > 0,
  ) || null;
}

function findLatestObservation(observations, triggerText) {
  const list = (Array.isArray(observations) ? observations : []).filter(
    (item) => item.triggerText === triggerText && Array.isArray(item.contextItems) && item.contextItems.length > 0,
  );
  return list.length ? list[list.length - 1] : null;
}

function buildToolCallResponse(id, name, args) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "qwen3.6-plus",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `${id}-tool`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args || {}),
              },
            },
          ],
        },
      },
    ],
  };
}

function buildTextResponse(id, text) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "qwen3.6-plus",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

module.exports = {
  buildTextResponse,
  buildToolCallResponse,
  contentHasImageUrl,
  contextContains,
  extractLatestToolPayload,
  extractTriggerPayload,
  findLatestObservation,
  findObservation,
  normalizeText,
  summarizeContextItems,
};
