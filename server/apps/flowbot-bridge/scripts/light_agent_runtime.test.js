const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const {
  NO_REPLY_SENTINEL,
  buildUserPrompt,
  executeFlowbotTool,
  extractMessageText,
  invokeChatCompletion,
  runLightAgent,
} = require("./light_agent_runtime");

function buildContext(overrides = {}) {
  return {
    task: {
      taskId: "AGENT-TEST-1",
      traceId: "trace-1",
      rawRoomId: "room-1",
      roomId: "room-1",
      roomName: "测试群",
      senderName: "张三",
      senderId: "user-1",
      sendTimeIso: "2026-04-30T10:00:00.000Z",
      routeReason: "explicit_mention",
      matchedAgentNames: ["小智"],
      llmReadyMessage: {
        trace_id: "trace-1",
        room_id: "room-1",
        room_name: "测试群",
        sender: "张三",
        sender_id: "user-1",
        time: "2026-04-30T10:00:00.000Z",
        type: "文本",
        content: "小智，云发单是干啥的？",
      },
    },
    agent: {},
    ...overrides,
  };
}

test("extractMessageText supports string and structured arrays", () => {
  assert.equal(extractMessageText("  hello   world "), "hello world");
  assert.equal(
    extractMessageText([{ text: "第一句" }, { content: "第二句" }, "第三句"]),
    "第一句 第二句 第三句",
  );
});

test("runLightAgent returns direct final reply without tools", async () => {
  const replies = [];
  const result = await runLightAgent({
    context: buildContext(),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "unused", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async ({ messages }) => {
      replies.push(messages);
      return { content: "云发单是帮你做发圈、发群和转链相关业务的工具。" };
    },
    executeTool: async () => {
      throw new Error("should_not_call_tool");
    },
  });

  assert.equal(result.text, "云发单是帮你做发圈、发群和转链相关业务的工具。");
  assert.equal(result.steps, 1);
  assert.equal(replies.length, 1);
});

test("runLightAgent keeps plain qwen models on text-only message content", async () => {
  let firstUserContent = null;
  await runLightAgent({
    context: buildContext(),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "qwen3.7-max", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async ({ messages }) => {
      firstUserContent = messages.find((item) => item.role === "user")?.content;
      return { content: "收到。" };
    },
    executeTool: async () => {
      throw new Error("should_not_call_tool");
    },
  });

  assert.equal(typeof firstUserContent, "string");
});

test("runLightAgent handles tool call loop then final answer", async () => {
  const toolCalls = [];
  let round = 0;
  const result = await runLightAgent({
    context: buildContext(),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "unused", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async () => {
      round += 1;
      if (round === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "search_knowledge",
                arguments: JSON.stringify({ query: "云发单", limit: 3 }),
              },
            },
          ],
        };
      }
      return {
        content: "云发单主要用于发圈、发群和转链，具体看你现在是要查哪个模块。",
      };
    },
    executeTool: async (name, args) => {
      toolCalls.push({ name, args });
      return {
        ok: true,
        docs: [
          {
            title: "云发单使用手册",
            snippet: "云发单支持发圈、发群和多渠道转链。",
          },
        ],
      };
    },
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "search_knowledge");
  assert.deepEqual(toolCalls[0].args, { query: "云发单", limit: 3 });
  assert.equal(result.text, "云发单主要用于发圈、发群和转链，具体看你现在是要查哪个模块。");
  assert.equal(result.steps, 2);
});

test("runLightAgent preserves explicit no-reply sentinel", async () => {
  const result = await runLightAgent({
    context: buildContext(),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "unused", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async () => ({ content: NO_REPLY_SENTINEL }),
    executeTool: async () => {
      throw new Error("should_not_call_tool");
    },
  });

  assert.equal(result.text, NO_REPLY_SENTINEL);
});

test("runLightAgent retries once when the model returns an empty message", async () => {
  const rounds = [];
  const result = await runLightAgent({
    context: buildContext({
      task: {
        ...buildContext().task,
        routeReason: "name_detected_agent_review",
        matchedAgentNames: ["小智"],
        llmReadyMessage: {
          ...buildContext().task.llmReadyMessage,
          content: "小智 我们不能聊聊天吗？",
        },
      },
    }),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "unused", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async ({ messages, tools }) => {
      rounds.push({
        roles: messages.map((item) => item.role),
        toolCount: Array.isArray(tools) ? tools.length : 0,
      });
      if (rounds.length === 1) {
        return { content: "" };
      }
      return { content: "当然可以，我在呢。你想聊点什么？" };
    },
    executeTool: async () => {
      throw new Error("should_not_call_tool");
    },
  });

  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].toolCount > 0, true);
  assert.equal(rounds[1].toolCount, 0);
  assert.equal(result.text, "当然可以，我在呢。你想聊点什么？");
  assert.equal(result.steps, 2);
});

test("invokeChatCompletion retries timed out model requests with exponential backoff", async (t) => {
  let requestCount = 0;
  const requestTimes = [];
  const server = http.createServer((req, res) => {
    requestCount += 1;
    requestTimes.push(Date.now());
    if (requestCount < 3) {
      // Keep the request hanging long enough to force a client-side timeout.
      setTimeout(() => {
        try {
          req.socket.destroy();
        } catch {}
      }, 80);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "重试后成功",
          },
        },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const message = await invokeChatCompletion(
    {
      apiUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 20,
      timeoutRetryAttempts: 5,
      timeoutRetryBaseDelayMs: 10,
      timeoutRetryMaxDelayMs: 40,
    },
    [{ role: "user", content: "你好" }],
    [],
    "none",
  );

  assert.equal(message.content, "重试后成功");
  assert.equal(requestCount, 3);
  assert.equal(requestTimes[1] - requestTimes[0] >= 10, true);
  assert.equal(requestTimes[2] - requestTimes[1] >= 20, true);
});

test("runLightAgent can go through send reply tool then finish", async () => {
  let round = 0;
  const toolCalls = [];
  const result = await runLightAgent({
    context: buildContext(),
    agentName: "小智",
    llm: { apiUrl: "unused", apiKey: "unused", model: "unused", timeoutMs: 1000 },
    flowbotBaseUrl: "http://127.0.0.1:3010/flowbot/agent",
    invokeModel: async () => {
      round += 1;
      if (round === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call-send-1",
              type: "function",
              function: {
                name: "send_group_reply",
                arguments: JSON.stringify({ content: "这是最终回复" }),
              },
            },
          ],
        };
      }
      return {
        content: NO_REPLY_SENTINEL,
      };
    },
    executeTool: async (name, args) => {
      toolCalls.push({ name, args });
      return {
        ok: true,
        sentAt: "2026-04-30T10:00:05.000Z",
      };
    },
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "send_group_reply");
  assert.deepEqual(toolCalls[0].args, { content: "这是最终回复" });
  assert.equal(result.text, NO_REPLY_SENTINEL);
});

test("buildUserPrompt includes old-topic recall hint with sender scope and keywords", () => {
  const prompt = buildUserPrompt(buildContext({
    task: {
      ...buildContext().task,
      senderId: "user-2",
      llmReadyMessage: {
        ...buildContext().task.llmReadyMessage,
        sender_id: "user-2",
        content: "小智，回到前面支付回调那个问题，现在最核心的异常到底是什么？",
      },
    },
  }), "小智");

  assert.match(prompt, /old_topic_hint=/);
  assert.match(prompt, /"prefer_sender_scope":"user-2"/);
  assert.match(prompt, /"keywords":\["支付回调"\]/);
});

test("buildUserPrompt marks explicit wake in compact trigger info", () => {
  const prompt = buildUserPrompt(buildContext({
    task: {
      ...buildContext().task,
      routeReason: "name_detected_agent_review",
      matchedAgentNames: ["小智"],
    },
  }), "小智");

  assert.match(prompt, /"explicit_wake":true/);
});

test("executeFlowbotTool anchors room and memory queries to trigger time", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: new URL(req.url, "http://127.0.0.1"),
        body: Buffer.concat(bodyChunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/flowbot/agent`;
  const context = buildContext();

  await executeFlowbotTool(
    "get_recent_room_messages",
    { limit: 9 },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    { calls: [] },
  );
  await executeFlowbotTool(
    "search_memory",
    { query: "云发单" },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    { calls: [] },
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, "/flowbot/agent/messages/search");
  assert.equal(requests[0].url.searchParams.get("roomId"), "room-1");
  assert.equal(requests[0].url.searchParams.get("toTime"), context.task.sendTimeIso);
  assert.equal(requests[0].url.searchParams.get("llmModel"), null);
  assert.equal(requests[0].url.searchParams.get("supportsVision"), "0");
  assert.equal(requests[1].url.pathname, "/flowbot/agent/memory/search");
  assert.equal(requests[1].url.searchParams.get("toTime"), context.task.sendTimeIso);
  assert.equal(requests[1].url.searchParams.get("query"), "云发单");
});

test("executeFlowbotTool can inspect historical context by explicit trace id", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      requests.push(new URL(req.url, "http://127.0.0.1"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total: 0, matches: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/flowbot/agent`;
  const context = buildContext();

  await executeFlowbotTool(
    "get_anchor_context",
    { traceId: "trace-old-123", before: 5, after: 1 },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    { calls: [] },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/flowbot/agent/messages/context-search");
  assert.equal(requests[0].searchParams.get("traceId"), "trace-old-123");
  assert.equal(requests[0].searchParams.get("contextBefore"), "5");
  assert.equal(requests[0].searchParams.get("contextAfter"), "1");
});

test("executeFlowbotTool forwards model media capabilities to flowbot search endpoints", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      requests.push(new URL(req.url, "http://127.0.0.1"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total: 0, items: [], visionInputs: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/flowbot/agent`;
  const context = buildContext();

  await executeFlowbotTool(
    "get_recent_room_messages",
    { limit: 5 },
    {
      flowbotBaseUrl: baseUrl,
      context,
      timeoutMs: 1000,
      llm: {
        model: "qwen3.6-plus",
        supportsVision: true,
        imageTransport: "image_url",
        maxImages: 2,
      },
    },
    { calls: [] },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("llmModel"), "qwen3.6-plus");
  assert.equal(requests[0].searchParams.get("supportsVision"), "1");
  assert.equal(requests[0].searchParams.get("imageTransport"), "image_url");
  assert.equal(requests[0].searchParams.get("maxImages"), "2");
});

test("executeFlowbotTool compacts message and knowledge payloads before returning to model", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: new URL(req.url, "http://127.0.0.1"),
        body: bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) : null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/flowbot/agent/messages/search")) {
        res.end(JSON.stringify({
          total: 1,
          items: [{
            traceId: "trace-a",
            seq: "1001",
            sendTimeIso: "2026-04-30T10:00:00.000Z",
            senderName: "张三",
            senderId: "user-1",
            receiverId: "room-1",
            msgTypeName: "文本",
            content: "第一句",
            transcriptText: "第二句",
            quoteContent: "引用内容",
            title: "",
            desc: "",
            fileName: "",
            mediaKind: "",
            score: 1,
            snippet: "第一句 第二句",
          }],
        }));
        return;
      }
      res.end(JSON.stringify({
        docs: [{
          title: "云发单使用手册",
          snippet: "云发单支持发圈、发群、多渠道转链以及数据追踪。",
          source: "maxkb",
          score: 0.91,
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/flowbot/agent`;
  const context = buildContext();

  const messageResult = await executeFlowbotTool(
    "get_recent_room_messages",
    { limit: 5 },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    { calls: [] },
  );
  const knowledgeResult = await executeFlowbotTool(
    "search_knowledge",
    { query: "云发单" },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    { calls: [] },
  );

  assert.equal(requests.length, 2);
  assert.equal(messageResult.total, 1);
  assert.deepEqual(messageResult.items[0], {
    id: "trace-a",
    seq: "1001",
    time: "2026-04-30T10:00:00.000Z",
    from: "张三",
    from_id: "user-1",
    to: "room-1",
    type: "文本",
    text: "第一句 第二句 第一句 第二句",
    quote: "引用内容",
  });
  assert.deepEqual(knowledgeResult, {
    total: 1,
    items: [{
      title: "云发单使用手册",
      snippet: "云发单支持发圈、发群、多渠道转链以及数据追踪。",
      source: "maxkb",
      score: 0.91,
    }],
  });
});

test("executeFlowbotTool sends reply through flowbot reply endpoint", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: new URL(req.url, "http://127.0.0.1"),
        body: bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) : null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        taskId: "AGENT-TEST-1",
        sentAt: "2026-04-30T10:00:06.000Z",
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/flowbot/agent`;
  const context = buildContext();
  const toolState = { calls: [], replySent: false, replyContent: "", replySentAt: "" };
  const result = await executeFlowbotTool(
    "send_group_reply",
    { content: "请看这个答复" },
    { flowbotBaseUrl: baseUrl, context, timeoutMs: 1000 },
    toolState,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url.pathname, "/flowbot/agent/reply");
  assert.deepEqual(requests[0].body, {
    taskId: "AGENT-TEST-1",
    content: "请看这个答复",
  });
  assert.equal(toolState.replySent, true);
  assert.equal(toolState.replyContent, "请看这个答复");
  assert.equal(toolState.replySentAt, "2026-04-30T10:00:06.000Z");
  assert.deepEqual(result, {
    ok: true,
    taskId: "AGENT-TEST-1",
    sentAt: "2026-04-30T10:00:06.000Z",
  });
});

test("runLightAgent injects trigger image and tool images as multimodal content", async (t) => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        total: 1,
        items: [],
        visionInputs: [
          {
            traceId: "trace-img-2",
            senderName: "李四",
            sendTimeIso: "2026-04-30T10:00:02.000Z",
            imageUrl: "https://example.com/history-image.png",
            mediaMimeType: "image/png",
            note: "历史图片",
          },
        ],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  const capturedMessages = [];
  let round = 0;
  const result = await runLightAgent({
    context: buildContext({
      task: {
        ...buildContext().task,
        llmReadyMessage: {
          trace_id: "trace-1",
          room_id: "room-1",
          room_name: "测试群",
          sender: "张三",
          sender_id: "user-1",
          time: "2026-04-30T10:00:00.000Z",
          type: "图片",
          content: "小智，看看这个图",
          media_kind: "image",
          media_public_url: "https://example.com/trigger-image.png",
        },
      },
    }),
    agentName: "小智",
    llm: {
      apiUrl: "unused",
      apiKey: "unused",
      model: "qwen3.6-plus",
      timeoutMs: 1000,
      supportsVision: true,
      imageTransport: "image_url",
      maxImages: 2,
    },
    flowbotBaseUrl: `http://127.0.0.1:${address.port}/flowbot/agent`,
    invokeModel: async ({ messages }) => {
      capturedMessages.push(JSON.parse(JSON.stringify(messages)));
      round += 1;
      if (round === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call-vision-1",
              type: "function",
              function: {
                name: "get_recent_room_messages",
                arguments: JSON.stringify({ limit: 3 }),
              },
            },
          ],
        };
      }
      return {
        content: "我看到了图片里的内容。",
      };
    },
  });

  assert.equal(result.text, "我看到了图片里的内容。");
  assert.equal(capturedMessages.length, 2);
  assert.ok(Array.isArray(capturedMessages[0][1].content));
  assert.equal(capturedMessages[0][1].content[1].type, "image_url");
  assert.equal(capturedMessages[0][1].content[1].image_url.url, "https://example.com/trigger-image.png");
  const secondRoundMessages = capturedMessages[1];
  const lastMessage = secondRoundMessages[secondRoundMessages.length - 1];
  assert.equal(lastMessage.role, "user");
  assert.ok(Array.isArray(lastMessage.content));
  assert.equal(lastMessage.content[1].type, "text");
  assert.equal(lastMessage.content[2].type, "image_url");
  assert.equal(lastMessage.content[2].image_url.url, "https://example.com/history-image.png");
});
