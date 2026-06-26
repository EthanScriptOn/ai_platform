"use strict";

function createHashText(crypto) {
  return function hashText(text) {
    return crypto.createHash("sha1").update(String(text || "")).digest("hex");
  };
}

function createServerLocalHelpers({
  DATA_DIR,
  FEISHU_TARGET_CHAT_IDS,
  NORMALIZED_LOG_PATH,
  TARGET_ROOM_IDS,
  buildLlmReadyMessage,
  dedupeMessageEventsByTraceId,
  messageTimestampMs,
  normalizePriority,
  path,
  readJsonFile,
  readJsonlFile,
}) {
  function isRoomIdAllowed(roomId) {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) {
      return false;
    }
    if (!TARGET_ROOM_IDS.size) {
      return true;
    }
    return TARGET_ROOM_IDS.has(normalizedRoomId);
  }

  function isFeishuChatIdAllowed(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) {
      return false;
    }
    if (!FEISHU_TARGET_CHAT_IDS.size) {
      return true;
    }
    return FEISHU_TARGET_CHAT_IDS.has(normalizedChatId);
  }

  function loadAllCaseItems() {
    const caseIndex = readJsonFile(path.join(DATA_DIR, "index.json"), { version: 1, cases: [] });
    return Array.isArray(caseIndex?.cases) ? caseIndex.cases : [];
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

  return {
    isFeishuChatIdAllowed,
    isRoomIdAllowed,
    listRoomMessages,
    loadAllCaseItems,
    normalizePriorityItem,
  };
}

module.exports = { createHashText, createServerLocalHelpers };
