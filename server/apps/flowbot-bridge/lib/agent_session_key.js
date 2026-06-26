"use strict";

const DEFAULT_AGENT_ID = "flowbot";
const DEFAULT_STRATEGY = "wake";

function sanitizeSegment(value, fallback = "unknown") {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function resolveSenderScope(message) {
  const senderId = String(message?.senderId || "").trim();
  const senderName = String(message?.senderName || "").trim();
  return {
    senderId,
    senderName,
    senderKey: sanitizeSegment(senderId || senderName, "unknown-sender"),
  };
}

function buildRoomSessionKey(agentId, message) {
  const roomId = sanitizeSegment(message?.roomId || message?.rawRoomId || "", "unknown-room");
  return `agent:${agentId}:wecom-room:${roomId}`;
}

function buildSenderSessionKey(agentId, message) {
  const roomId = sanitizeSegment(message?.roomId || message?.rawRoomId || "", "unknown-room");
  const senderScope = resolveSenderScope(message);
  return `agent:${agentId}:wecom-room:${roomId}:sender:${senderScope.senderKey}`;
}

function buildWakeSessionKey(agentId, message) {
  const traceId = sanitizeSegment(message?.traceId || message?.trace_id || "", "");
  if (traceId) {
    return `agent:${agentId}:wecom-wake:${traceId}`;
  }
  const roomId = sanitizeSegment(message?.roomId || message?.rawRoomId || "", "unknown-room");
  const senderScope = resolveSenderScope(message);
  const sendTime = sanitizeSegment(message?.sendTimeIso || message?.time || "", "unknown-time");
  return `agent:${agentId}:wecom-room:${roomId}:wake:${senderScope.senderKey}:${sendTime}`;
}

const SESSION_KEY_BUILDERS = {
  room: buildRoomSessionKey,
  sender: buildSenderSessionKey,
  wake: buildWakeSessionKey,
};

function resolveSessionKeyStrategy(rawStrategy) {
  const strategy = sanitizeSegment(rawStrategy || DEFAULT_STRATEGY, DEFAULT_STRATEGY);
  if (SESSION_KEY_BUILDERS[strategy]) {
    return strategy;
  }
  return DEFAULT_STRATEGY;
}

function buildAgentSessionBinding(message, options = {}) {
  const agentId = sanitizeSegment(options.agentId || DEFAULT_AGENT_ID, DEFAULT_AGENT_ID);
  const strategy = resolveSessionKeyStrategy(options.strategy);
  const builder = SESSION_KEY_BUILDERS[strategy] || SESSION_KEY_BUILDERS[DEFAULT_STRATEGY];
  const senderScope = resolveSenderScope(message);
  const roomId = String(message?.roomId || "").trim();
  const rawRoomId = String(message?.rawRoomId || message?.roomId || "").trim();
  return {
    agentId,
    strategy,
    sessionKey: builder(agentId, message),
    roomId,
    rawRoomId,
    senderId: senderScope.senderId,
    senderName: senderScope.senderName,
    senderKey: senderScope.senderKey,
  };
}

module.exports = {
  DEFAULT_AGENT_ID,
  DEFAULT_STRATEGY,
  resolveSessionKeyStrategy,
  buildAgentSessionBinding,
};
