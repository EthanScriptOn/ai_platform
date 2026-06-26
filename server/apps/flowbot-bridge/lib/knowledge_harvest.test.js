"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeKnowledgeRoomIdsInput,
  parseKnowledgeRoomIds,
  isKnowledgeRoomAllowed,
  isCoreRoomAllowed,
  evaluateCallbackLanes,
} = require("./knowledge_harvest");

test("normalizeKnowledgeRoomIdsInput deduplicates comma and whitespace separated rooms", () => {
  assert.equal(normalizeKnowledgeRoomIdsInput("  room-a,room-b\nroom-a  room-c "), "room-a,room-b,room-c");
});

test("isKnowledgeRoomAllowed allows all rooms when enabled with empty room set", () => {
  assert.equal(isKnowledgeRoomAllowed("room-a", parseKnowledgeRoomIds("")), true);
});

test("isKnowledgeRoomAllowed filters rooms when configured", () => {
  const rooms = parseKnowledgeRoomIds("room-a,room-b");
  assert.equal(isKnowledgeRoomAllowed("room-a", rooms), true);
  assert.equal(isKnowledgeRoomAllowed("room-x", rooms), false);
});

test("isKnowledgeRoomAllowed rejects empty room id", () => {
  assert.equal(isKnowledgeRoomAllowed("", parseKnowledgeRoomIds("")), false);
});

test("isCoreRoomAllowed allows all rooms when core whitelist is empty", () => {
  assert.equal(isCoreRoomAllowed("room-a", parseKnowledgeRoomIds("")), true);
});

test("evaluateCallbackLanes routes core-only messages to question answering and case lanes", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "core-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("core-room"),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: true,
    coreAccepted: true,
    knowledgeAccepted: false,
    reason: "accepted",
  });
});

test("evaluateCallbackLanes routes knowledge-only messages without core acceptance", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "knowledge-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("core-room"),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: true,
    coreAccepted: false,
    knowledgeAccepted: true,
    reason: "knowledge_only",
  });
});

test("evaluateCallbackLanes routes shared rooms to both lanes", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "shared-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("shared-room"),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("shared-room"),
  }), {
    accepted: true,
    coreAccepted: true,
    knowledgeAccepted: true,
    reason: "accepted_with_knowledge",
  });
});

test("evaluateCallbackLanes keeps knowledge lane closed when harvesting is disabled", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "knowledge-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("core-room"),
    knowledgeHarvestEnabled: false,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: false,
    coreAccepted: false,
    knowledgeAccepted: false,
    reason: "roomid_filtered:knowledge-room",
  });
});

test("evaluateCallbackLanes treats empty core whitelist as all rooms without forcing knowledge lane", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "any-core-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds(""),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: true,
    coreAccepted: true,
    knowledgeAccepted: false,
    reason: "accepted",
  });
});

test("evaluateCallbackLanes rejects unsupported notify type before lane routing", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 99999,
    roomId: "shared-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("shared-room"),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("shared-room"),
  }), {
    accepted: false,
    coreAccepted: false,
    knowledgeAccepted: false,
    reason: "notify_type_not_supported:99999",
  });
});

test("evaluateCallbackLanes rejects non-whitelisted rooms when neither lane accepts", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "other-room",
    msgType: 2,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds("core-room"),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: false,
    coreAccepted: false,
    knowledgeAccepted: false,
    reason: "roomid_filtered:other-room",
  });
});

test("evaluateCallbackLanes never lets self-sent messages enter knowledge harvesting", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "knowledge-room",
    msgType: 2,
    sendFlag: 1,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds(""),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: false,
    coreAccepted: false,
    knowledgeAccepted: false,
    reason: "self_sent_message",
  });
});

test("evaluateCallbackLanes rejects unsupported message types before lane routing", () => {
  assert.deepEqual(evaluateCallbackLanes({
    notifyType: 11010,
    roomId: "knowledge-room",
    msgType: 999,
    sendFlag: 0,
    acceptNotifyTypes: new Set([11010]),
    supportedMsgTypes: new Set([2]),
    coreRoomIds: parseKnowledgeRoomIds(""),
    knowledgeHarvestEnabled: true,
    knowledgeRoomIds: parseKnowledgeRoomIds("knowledge-room"),
  }), {
    accepted: false,
    coreAccepted: false,
    knowledgeAccepted: false,
    reason: "msg_type_filtered:999",
  });
});
