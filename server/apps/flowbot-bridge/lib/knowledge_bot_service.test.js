"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createKnowledgeBotService } = require("./knowledge_bot_service");

function createFakeStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    isEnabled: () => true,
    readJsonKey: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    writeJsonKey: (key, value) => data.set(key, value),
    deleteJsonKey: (key) => data.delete(key),
  };
}

function createService({ store = createFakeStore(), failSessionOnce = "" } = {}) {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const createdSessions = [];
  const completionCalls = [];
  let sessionIndex = 0;
  let failedOnce = false;

  const service = createKnowledgeBotService({
    RAGFLOW_BASE_URL: "http://ragflow.local",
    RAGFLOW_CHAT_ID: "chat-1",
    RAGFLOW_ENABLED: true,
    RAGFLOW_LOGIN_EMAIL: "bot@example.com",
    RAGFLOW_LOGIN_PASSWORD: "secret",
    RAGFLOW_LOGIN_PUBLIC_KEY: publicKey.export({ type: "pkcs1", format: "pem" }),
    RAGFLOW_TIMEOUT_MS: 1000,
    mysqlRuntimeStore: store,
    requestJsonWithHeaders: async (method, target, payload) => {
      const url = new URL(target);
      if (method === "POST" && url.pathname === "/api/v1/chats/chat-1/sessions") {
        sessionIndex += 1;
        const sessionId = `session-${sessionIndex}`;
        createdSessions.push({ sessionId, payload });
        return { code: 0, data: { id: sessionId } };
      }
      throw new Error(`unexpected_request:${method}:${url.pathname}`);
    },
    fetchImpl: async (target, options = {}) => {
      const url = new URL(target);
      if (url.pathname === "/api/v1/auth/login") {
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { authorization: "test-token" },
        });
      }
      if (url.pathname === "/api/v1/chat/completions") {
        const body = JSON.parse(options.body || "{}");
        completionCalls.push(body);
        if (failSessionOnce && body.session_id === failSessionOnce && !failedOnce) {
          failedOnce = true;
          return new Response('data: {"code":102,"message":"session does not exist"}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response('data: {"code":0,"data":{"answer":"张凯是前端开发。"}}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected_fetch:${url.pathname}`);
    },
  });

  return { service, store, createdSessions, completionCalls };
}

test("askKnowledgeBot reuses one RAGFlow session per chat and room", async () => {
  const { service, createdSessions, completionCalls } = createService();

  const first = await service.askKnowledgeBot({ query: "张凯是做什么的？", roomId: "room-a" });
  const second = await service.askKnowledgeBot({ query: "张凯是做什么的？", roomId: "room-a" });

  assert.equal(first.sessionId, "session-1");
  assert.equal(first.sessionReused, false);
  assert.equal(second.sessionId, "session-1");
  assert.equal(second.sessionReused, true);
  assert.equal(createdSessions.length, 1);
  assert.deepEqual(completionCalls.map((item) => item.session_id), ["session-1", "session-1"]);
});

test("askKnowledgeBot recreates stored session when RAGFlow says it is gone", async () => {
  const hash = crypto.createHash("sha1").update("room-a").digest("hex");
  const store = createFakeStore({
    [`ragflow_sessions/chat-1/${hash}.json`]: { sessionId: "old-session" },
  });
  const { service, createdSessions, completionCalls } = createService({
    store,
    failSessionOnce: "old-session",
  });

  const result = await service.askKnowledgeBot({ query: "张凯是做什么的？", roomId: "room-a" });

  assert.equal(result.sessionId, "session-1");
  assert.equal(result.sessionReused, false);
  assert.equal(createdSessions.length, 1);
  assert.deepEqual(completionCalls.map((item) => item.session_id), ["old-session", "session-1"]);
});
