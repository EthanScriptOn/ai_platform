"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createQwenChatClient } = require("./qwen_chat_client");

test("callQwenChat sends chat completion request and returns content", async () => {
  const calls = [];
  const { callQwenChat } = createQwenChatClient({
    defaultModel: "default-model",
    qwenApiKey: "key",
    qwenApiUrl: "https://qwen.test/chat",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "hello" } }] });
        },
      };
    },
  });

  const content = await callQwenChat({
    messages: [{ role: "user", content: "hi" }],
    responseFormat: { type: "json_object" },
  });

  assert.equal(content, "hello");
  assert.equal(calls[0].url, "https://qwen.test/chat");
  assert.equal(calls[0].options.headers.Authorization, "Bearer key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "default-model",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
});

test("callQwenChat reports missing key and upstream errors", async () => {
  const missing = createQwenChatClient({
    defaultModel: "m",
    errorContext: "测试任务",
    qwenApiKey: "",
    qwenApiUrl: "https://qwen.test/chat",
  });
  await assert.rejects(() => missing.callQwenChat({ messages: [] }), /无法执行测试任务/);

  const failing = createQwenChatClient({
    defaultModel: "m",
    qwenApiKey: "key",
    qwenApiUrl: "https://qwen.test/chat",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return JSON.stringify({ error: { message: "bad upstream" } });
      },
    }),
  });
  await assert.rejects(() => failing.callQwenChat({ messages: [] }), /bad upstream/);
});
