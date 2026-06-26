"use strict";

function normalizeKnowledgeRoomIdsInput(value, fallback = "") {
  const items = String(value ?? fallback)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(items)).join(",");
}

function parseKnowledgeRoomIds(value) {
  return new Set(
    normalizeKnowledgeRoomIdsInput(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function isKnowledgeRoomAllowed(roomId, roomIds) {
  const normalizedRoomId = String(roomId || "").trim();
  if (!normalizedRoomId) {
    return false;
  }
  const roomSet = roomIds instanceof Set ? roomIds : parseKnowledgeRoomIds(roomIds);
  if (!roomSet.size) {
    return true;
  }
  return roomSet.has(normalizedRoomId);
}

function isCoreRoomAllowed(roomId, roomIds) {
  const normalizedRoomId = String(roomId || "").trim();
  if (!normalizedRoomId) {
    return false;
  }
  const roomSet = roomIds instanceof Set ? roomIds : parseKnowledgeRoomIds(roomIds);
  if (!roomSet.size) {
    return true;
  }
  return roomSet.has(normalizedRoomId);
}

function evaluateCallbackLanes({
  notifyType,
  roomId,
  msgType,
  sendFlag = 0,
  acceptNotifyTypes,
  supportedMsgTypes,
  coreRoomIds,
  knowledgeHarvestEnabled = false,
  knowledgeRoomIds,
} = {}) {
  const normalizedNotifyType = Number(notifyType || 0);
  const normalizedMsgType = Number(msgType || 0);
  const normalizedRoomId = String(roomId || "").trim();
  const notifySet = acceptNotifyTypes instanceof Set ? acceptNotifyTypes : new Set(acceptNotifyTypes || []);
  const msgTypeSet = supportedMsgTypes instanceof Set ? supportedMsgTypes : new Set(supportedMsgTypes || []);

  if (!notifySet.has(normalizedNotifyType)) {
    return {
      accepted: false,
      coreAccepted: false,
      knowledgeAccepted: false,
      reason: `notify_type_not_supported:${normalizedNotifyType}`,
    };
  }

  if (Number(sendFlag || 0) === 1) {
    return {
      accepted: false,
      coreAccepted: false,
      knowledgeAccepted: false,
      reason: "self_sent_message",
    };
  }

  if (!normalizedRoomId) {
    return {
      accepted: false,
      coreAccepted: false,
      knowledgeAccepted: false,
      reason: "roomid_missing",
    };
  }

  if (!msgTypeSet.has(normalizedMsgType)) {
    return {
      accepted: false,
      coreAccepted: false,
      knowledgeAccepted: false,
      reason: `msg_type_filtered:${normalizedMsgType}`,
    };
  }

  const coreAccepted = isCoreRoomAllowed(normalizedRoomId, coreRoomIds);
  const knowledgeAccepted = Boolean(knowledgeHarvestEnabled)
    && isKnowledgeRoomAllowed(normalizedRoomId, knowledgeRoomIds);

  if (!coreAccepted && !knowledgeAccepted) {
    return {
      accepted: false,
      coreAccepted,
      knowledgeAccepted,
      reason: `roomid_filtered:${normalizedRoomId}`,
    };
  }

  if (!coreAccepted && knowledgeAccepted) {
    return {
      accepted: true,
      coreAccepted,
      knowledgeAccepted,
      reason: "knowledge_only",
    };
  }

  return {
    accepted: true,
    coreAccepted,
    knowledgeAccepted,
    reason: knowledgeAccepted ? "accepted_with_knowledge" : "accepted",
  };
}

module.exports = {
  normalizeKnowledgeRoomIdsInput,
  parseKnowledgeRoomIds,
  isKnowledgeRoomAllowed,
  isCoreRoomAllowed,
  evaluateCallbackLanes,
};
