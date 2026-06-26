"use strict";

const http = require("http");
const https = require("https");
const { DEFAULT_LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS, DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS, DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS, DEFAULT_TOOL_MAX_STEPS, DEFAULT_VISION_MAX_IMAGES, MODEL_MESSAGE_QUOTE_MAX, MODEL_MESSAGE_TEXT_MAX } = require("./light_agent_runtime_config");
const { buildToolVisionFollowupContent, collectVisionInputsFromToolResult, compactToolResult, limitText, pruneEmpty, uniqueTextParts } = require("./light_agent_result_compaction");
const { createToolDefinitions } = require("./light_agent_tool_definitions");

const NO_REPLY_SENTINEL = "[[NO_REPLY]]";

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBooleanInput(value, fallback = false) {
  if (value === "" || value == null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function modelLooksVisionCapable(modelName) {
  const normalized = String(modelName || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(qwen[-_]?vl|vl|vision|gpt-4o|gpt-4\.1|claude-3|gemini)/i.test(normalized);
}

function resolveModelMediaOptions(llm = {}) {
  const model = String(llm?.model || "").trim();
  const supportsVision = normalizeBooleanInput(
    llm?.supportsVision,
    modelLooksVisionCapable(model),
  );
  const requestedTransport = String(
    llm?.imageTransport || (supportsVision ? "image_url" : "none"),
  ).trim().toLowerCase();
  const imageTransport = supportsVision
    ? (requestedTransport || "image_url")
    : "none";
  const maxImages = Math.max(
    0,
    Math.min(6, Number(llm?.maxImages) || DEFAULT_VISION_MAX_IMAGES),
  );
  return {
    model,
    supportsVision: supportsVision && imageTransport !== "none" && maxImages > 0,
    imageTransport: supportsVision ? imageTransport : "none",
    maxImages,
  };
}

function getHttpModule(targetUrl) {
  return targetUrl.protocol === "https:" ? https : http;
}

function requestJson(method, target, payload = null, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const body = payload == null ? "" : JSON.stringify(payload);
    const transport = getHttpModule(targetUrl);
    const req = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        timeout: timeoutMs,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`http_${res.statusCode}:${raw.slice(0, 1000)}`));
            return;
          }
          if (!raw.trim()) {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildUrlWithQuery(baseUrl, pathname, params) {
  const url = new URL(pathname, `${String(baseUrl || "").replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return normalizeText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return normalizeText(
    content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || part?.content || "";
      })
      .filter(Boolean)
      .join("\n"),
  );
}

function compactCurrentMessage(message = {}) {
  const text = uniqueTextParts([
    message.content,
    message.transcript_text,
    message.title,
    message.desc,
  ]).join("\n");
  return pruneEmpty({
    id: message.trace_id || "",
    seq: message.seq || "",
    type: message.type || "",
    text: limitText(text, MODEL_MESSAGE_TEXT_MAX),
    quote: limitText(message.quote_content || "", MODEL_MESSAGE_QUOTE_MAX),
    media: message.media_kind || "",
    file: message.file_name || "",
    mentions: Array.isArray(message.at_list) ? message.at_list : [],
  }) || {};
}

function buildTriggerVisionContent(context = {}, agentName, mediaOptions = {}) {
  const prompt = buildUserPrompt(context, agentName);
  if (!mediaOptions.supportsVision || mediaOptions.imageTransport !== "image_url") {
    return prompt;
  }
  const current = context?.task?.llmReadyMessage || {};
  const mediaKind = String(current?.media_kind || current?.mediaKind || "").trim().toLowerCase();
  const mediaMimeType = String(current?.media_mime_type || current?.mediaMimeType || "").trim();
  const imageUrl = String(current?.media_public_url || current?.mediaPublicUrl || "").trim();
  const looksImage = mediaKind === "image" || /^image\//i.test(mediaMimeType) || String(current?.type || "").trim() === "图片";
  if (!looksImage || !imageUrl) {
    return prompt;
  }
  return [
    {
      type: "text",
      text: `${prompt}\n当前这条触发消息本身带了一张图片，请一并查看。`,
    },
    {
      type: "image_url",
      image_url: {
        url: imageUrl,
      },
    },
  ];
}

function buildSystemPrompt(agentName) {
  return [
    `你是企业微信群助手“${agentName}”。`,
    `你的任务是判断当前触发消息是否需要你介入；若需要，给出简洁、有帮助、可执行的回复；若不需要，请只输出 ${NO_REPLY_SENTINEL}。`,
    "请遵守以下规则：",
    "1. 每次明确唤醒都视为一段新的独立会话；只解决这次唤醒要处理的问题，不要默认延续之前的话题。",
    "2. route_reason 只代表路由命中了你，不代表一定要回复；你仍然要自己判断这条消息是否真的在找你。",
    "3. 不要假设上下文。信息不足时，先用工具查最近群消息、锚点上下文、记忆或知识库。",
    "4. 优先最少工具、最少轮次。通常先查锚点附近上下文或最近群消息，再决定是否查知识库。",
    "5. 不要重复回答已经明确回复过的同一问题。",
    "6. 如果你决定回复，必须调用 send_group_reply，把最终发到群里的完整文本作为 content。",
    "7. 如果你已经调用了 send_group_reply，就不要再把同样的正文重复输出一次；结束即可。",
    "8. 如果值得介入但信息仍不够，先追问一个最关键的问题，不要无脑连问；追问本身也要通过 send_group_reply 发出。",
    "9. 如果消息虽然出现了你的名字，但结合语义并不是在叫你，请输出 [[NO_REPLY]]。",
    "10. 如果用户在很多轮之后回头问“前面/刚才/之前/上次那个问题”，不要只看最近消息；优先回查旧话题。",
    "11. 回查旧话题的推荐顺序是：先用 search_room_messages 搜 1 到 3 个最核心的主题词；如果命中旧消息，再用 get_anchor_context(traceId=命中消息id) 拉那条历史消息前后上下文；仍不够再用 search_memory 做更宽的召回。",
    "12. 做旧话题检索时，query 要短，先搜主题词或异常词，不要一口气把问题和影响全塞进 query；否则很容易搜不到。",
    "13. 如果 search_room_messages 已经命中旧消息，但你还没看那条旧消息周围的上下文，就不要急着下结论，先调用 get_anchor_context。",
    "14. 如果你是在回查旧话题，但仍然不能确定用户指的是哪一次问题，不要硬答。优先追问一句澄清，或者列出 2 到 3 个候选问题让用户选择。",
    "15. 当你列候选让用户选择时，每个候选只保留最短的主题描述，不要展开长篇分析；等用户确认后再继续回答。",
    "16. 如果这像是当前发言人在追问自己之前的问题，先尝试在 search_room_messages 里带上当前的 senderId 缩小范围；只有命中不足时再放宽到全群。",
    "17. 如果 search_room_messages 命中多条旧消息，不要默认拿第一条。优先挑最像问题起点、最接近用户描述、或包含关键异常词的那条，再调用 get_anchor_context。",
    "18. 如果当前消息是在直接和你打招呼、确认你在不在、想和你聊天，或明显是在征求你的看法，这也属于需要介入的场景。不要因为它不是业务问题就沉默。",
    "19. 绝对不要输出空白内容。最终要么给出正常回复，要么明确输出 [[NO_REPLY]]。",
  ].join("\n");
}

function isExplicitWakeContext(context = {}) {
  const task = context?.task || {};
  const matchedNames = Array.isArray(task?.matchedAgentNames) ? task.matchedAgentNames : [];
  if (matchedNames.length) {
    return true;
  }
  const reason = normalizeText(task?.routeReason || "").toLowerCase();
  return /(mention|wake|name_detected|agent_review)/i.test(reason);
}

function looksLikeOldTopicFollowUp(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  return [
    "前面",
    "刚才",
    "之前",
    "上次",
    "回到",
    "那个问题",
    "前一个问题",
    "之前那个",
  ].some((keyword) => normalized.includes(keyword));
}

function extractOldTopicKeywords(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  const stripped = normalized
    .replace(/[@＠]/g, " ")
    .replace(/小智/g, " ")
    .replace(/前面|刚才|之前|上次|回到|前一个问题|之前那个|那个问题/g, " ")
    .replace(/现在|目前|这个|这个问题|最核心|核心|异常|到底|到底是|到底是什么|是什么|怎么回事|怎么看|你觉得呢|帮我|总结一下|看一下/g, " ")
    .replace(/[，。！？、,.!?:：;；"'“”‘’（）()\[\]{}<>《》]/g, " ");
  const parts = stripped
    .split(/\s+/)
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 2 && item.length <= 12);
  return uniqueTextParts(parts).slice(0, 3);
}

function buildOldTopicHint(context = {}) {
  const task = context?.task || {};
  const current = task?.llmReadyMessage || {};
  const triggerText = normalizeText([
    current.content,
    current.transcript_text,
    current.title,
    current.desc,
    current.quote_content,
  ].filter(Boolean).join("\n"));
  if (!looksLikeOldTopicFollowUp(triggerText)) {
    return null;
  }
  return pruneEmpty({
    follow_up: true,
    prefer_sender_scope: current.sender_id || task.senderId || "",
    keywords: extractOldTopicKeywords(triggerText),
    fallback: "如果命中多个旧问题或证据不够，就先追问或列 2 到 3 个候选让用户确认。",
  }) || null;
}

function buildUserPrompt(context, agentName) {
  const task = context?.task || {};
  const current = task?.llmReadyMessage || {};
  const triggerText = normalizeText([
    current.content,
    current.transcript_text,
    current.title,
    current.desc,
    current.quote_content,
  ].filter(Boolean).join("\n"));
  const compact = pruneEmpty({
    trigger: {
      task: task.taskId || "",
      session: task.agentSessionKey || "",
      trace: task.traceId || current.trace_id || "",
      room: task.rawRoomId || task.roomId || current.room_id || "",
      room_name: task.roomName || current.room_name || "",
      time: task.sendTimeIso || current.time || "",
      from: task.senderName || current.sender || "",
      from_id: task.senderId || current.sender_id || "",
      to: current.receiver_id || "",
      reason: task.routeReason || "",
      wake: Array.isArray(task.matchedAgentNames) ? task.matchedAgentNames : [],
      explicit_wake: isExplicitWakeContext(context),
    },
    message: compactCurrentMessage(current),
  }) || {};
  const oldTopicHint = buildOldTopicHint(context);
  return [
    `现在有一条新消息可能在找你“${agentName}”，这次唤醒已经生成了一个新的独立会话。`,
    "你只需要围绕这次唤醒要解决的问题处理；如需上下文，请自己调用工具拉取。",
    looksLikeOldTopicFollowUp(triggerText)
      ? "这条消息像是在回问较早之前的旧话题。不要只看最近消息；优先先搜索旧消息，再按命中的 traceId 拉历史上下文。如果当前发言人像是在追问自己之前的问题，可以先按 trigger.from_id 缩小检索范围；如果仍不确定是哪一次旧问题，就先澄清或给用户列 2 到 3 个候选。"
      : "",
    oldTopicHint ? `old_topic_hint=${JSON.stringify(oldTopicHint)}` : "",
    JSON.stringify(compact),
  ].filter(Boolean).join("\n");
}

function buildEmptyResponseRecoveryPrompt(context = {}, agentName) {
  const task = context?.task || {};
  const current = task?.llmReadyMessage || {};
  const triggerText = normalizeText([
    current.content,
    current.transcript_text,
    current.title,
    current.desc,
    current.quote_content,
  ].filter(Boolean).join("\n"));
  const explicitWake = isExplicitWakeContext(context);
  return [
    `你刚才没有输出任何正文，也没有调用任何工具。现在必须立刻补一个明确结论。`,
    explicitWake
      ? `这条消息是一次明确唤醒或高置信唤醒，除非语义上明显不是在叫你，否则应该正常回复。`
      : `如果这条消息并不是在找你，就输出 ${NO_REPLY_SENTINEL}。`,
    triggerText ? `触发消息：${triggerText}` : "",
    `要求：不能留空；不要解释规则；如果回复，就直接给最终发群内容。`,
  ].filter(Boolean).join("\n");
}

function parseToolArguments(rawArguments) {
  if (!rawArguments) {
    return {};
  }
  if (typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  try {
    return JSON.parse(String(rawArguments));
  } catch {
    return {};
  }
}

function shouldRetryLlmTimeout(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("request_timeout")
    || message.includes("timeout")
    || message.includes("econnreset")
    || message.includes("socket hang up")
  );
}

function resolveLlmRetryOptions(llm = {}) {
  return {
    timeoutMs: Math.max(1000, Number(llm.timeoutMs || DEFAULT_LLM_TIMEOUT_MS)),
    maxAttempts: Math.max(1, Math.min(5, Number(llm.timeoutRetryAttempts || DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS) || DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS)),
    baseDelayMs: Math.max(100, Math.min(10000, Number(llm.timeoutRetryBaseDelayMs || DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS) || DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS)),
    maxDelayMs: Math.max(1000, Math.min(60000, Number(llm.timeoutRetryMaxDelayMs || DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS) || DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS)),
  };
}

function normalizeToolCallList(message) {
  const list = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (list.length) {
    return list;
  }
  const legacy = message?.function_call;
  if (!legacy?.name) {
    return [];
  }
  return [
    {
      id: `legacy-${Date.now()}`,
      type: "function",
      function: legacy,
    },
  ];
}

async function invokeChatCompletion(llm, messages, tools, toolChoice) {
  if (!llm?.apiUrl || !llm?.apiKey || !llm?.model) {
    throw new Error("llm_config_missing");
  }
  const retryOptions = resolveLlmRetryOptions(llm);
  const payload = {
    model: llm.model,
    temperature: 0,
    messages,
  };
  if (Array.isArray(tools) && tools.length) {
    payload.tools = tools;
    payload.parallel_tool_calls = false;
    payload.tool_choice = toolChoice || "auto";
  }
  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    try {
      const response = await requestJson(
        "POST",
        `${String(llm.apiUrl).replace(/\/$/, "")}/chat/completions`,
        payload,
        {
          Authorization: `Bearer ${llm.apiKey}`,
        },
        retryOptions.timeoutMs,
      );
      const message = response?.choices?.[0]?.message;
      if (!message) {
        throw new Error("llm_empty_choice");
      }
      return message;
    } catch (error) {
      if (!shouldRetryLlmTimeout(error) || attempt >= retryOptions.maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(
        retryOptions.maxDelayMs,
        retryOptions.baseDelayMs * (2 ** (attempt - 1)),
      );
      await sleep(delayMs);
    }
  }
  throw new Error("llm_retry_exhausted");
}

async function executeFlowbotTool(toolName, args, options, toolState) {
  const baseUrl = String(options?.flowbotBaseUrl || "").replace(/\/$/, "");
  const task = options?.context?.task || {};
  const current = task?.llmReadyMessage || {};
  const roomId = String(task.rawRoomId || task.roomId || current.room_id || "").trim();
  const traceId = String(task.traceId || current.trace_id || "").trim();
  const sendTimeIso = String(task.sendTimeIso || current.time || "").trim();
  const mediaOptions = resolveModelMediaOptions(options?.llm || {});
  const commonRenderQuery = {
    llmModel: mediaOptions.model,
    supportsVision: mediaOptions.supportsVision ? "1" : "0",
    imageTransport: mediaOptions.imageTransport,
    maxImages: mediaOptions.maxImages || "",
  };

  toolState.lastToolVisionInputs = [];
  toolState.lastToolName = toolName;

  switch (toolName) {
    case "get_recent_room_messages":
      {
        const rawResult = await requestJson(
        "GET",
        buildUrlWithQuery(baseUrl, "messages/search", {
          roomId,
          limit: Math.max(1, Math.min(30, Number(args.limit) || 12)),
          toTime: sendTimeIso,
          sort: "desc",
          ...commonRenderQuery,
        }),
        null,
        {},
        options.timeoutMs,
        );
        toolState.lastToolVisionInputs = collectVisionInputsFromToolResult(toolName, rawResult, mediaOptions);
        return compactToolResult(toolName, rawResult, mediaOptions);
      }
    case "get_anchor_context":
      {
        const anchorTraceId = String(args.traceId || traceId).trim();
        const rawResult = await requestJson(
        "GET",
        buildUrlWithQuery(baseUrl, "messages/context-search", {
          roomId,
          traceId: anchorTraceId,
          contextBefore: Math.max(0, Math.min(12, Number(args.before) || 4)),
          contextAfter: Math.max(0, Math.min(12, Number(args.after) || 2)),
          limit: 1,
          ...commonRenderQuery,
        }),
        null,
        {},
        options.timeoutMs,
        );
        toolState.lastToolVisionInputs = collectVisionInputsFromToolResult(toolName, rawResult, mediaOptions);
        return compactToolResult(toolName, rawResult, mediaOptions);
      }
    case "search_room_messages":
      {
        const rawResult = await requestJson(
        "GET",
        buildUrlWithQuery(baseUrl, "messages/search", {
          roomId,
          query: args.query,
          senderId: args.senderId,
          fromTime: args.fromTime,
          toTime: args.toTime || sendTimeIso,
          limit: Math.max(1, Math.min(30, Number(args.limit) || 10)),
          sort: "desc",
          ...commonRenderQuery,
        }),
        null,
        {},
        options.timeoutMs,
        );
        toolState.lastToolVisionInputs = collectVisionInputsFromToolResult(toolName, rawResult, mediaOptions);
        return compactToolResult(toolName, rawResult, mediaOptions);
      }
    case "search_memory":
      {
        const rawResult = await requestJson(
        "GET",
        buildUrlWithQuery(baseUrl, "memory/search", {
          roomId,
          query: args.query,
          source: args.source || "all",
          toTime: sendTimeIso,
          limit: Math.max(1, Math.min(20, Number(args.limit) || 8)),
          sort: "desc",
          ...commonRenderQuery,
        }),
        null,
        {},
        options.timeoutMs,
        );
        toolState.lastToolVisionInputs = collectVisionInputsFromToolResult(toolName, rawResult, mediaOptions);
        return compactToolResult(toolName, rawResult, mediaOptions);
      }
    case "search_knowledge":
      {
        try {
          const botResult = await requestJson(
            "GET",
            buildUrlWithQuery(baseUrl, "knowledge-bot/ask", {
              query: args.query,
              roomId,
              traceId,
            }),
            null,
            {},
            options.timeoutMs,
          );
          return compactToolResult(toolName, botResult);
        } catch (error) {
          const fallbackResult = await requestJson(
            "GET",
            buildUrlWithQuery(baseUrl, "knowledge", {
              query: args.query,
              source: args.source || "all",
              limit: Math.max(1, Math.min(10, Number(args.limit) || 5)),
            }),
            null,
            {},
            options.timeoutMs,
          );
          return compactToolResult(toolName, {
            ...fallbackResult,
            knowledgeBotError: String(error?.message || error),
          });
        }
      }
    case "send_group_reply": {
      const content = normalizeText(args.content || "");
      if (!content) {
        throw new Error("send_group_reply_content_required");
      }
      const replyResult = await requestJson(
        "POST",
        buildUrlWithQuery(baseUrl, "reply"),
        {
          taskId: String(task.taskId || "").trim(),
          content,
        },
        {},
        options.timeoutMs,
      );
      toolState.replySent = true;
      toolState.replyContent = content;
      toolState.replySentAt = String(replyResult?.sentAt || "").trim();
      return compactToolResult(toolName, replyResult);
    }
    default:
      throw new Error(`unknown_tool:${toolName}`);
  }
}

async function runLightAgent(options) {
  const agentName = String(options?.agentName || "小智").trim() || "小智";
  const tools = createToolDefinitions();
  const mediaOptions = resolveModelMediaOptions(options?.llm || {});
  const toolState = {
    calls: [],
    replySent: false,
    replyContent: "",
    replySentAt: "",
    lastToolVisionInputs: [],
    lastToolName: "",
  };
  const messages = [
    { role: "system", content: buildSystemPrompt(agentName) },
    { role: "user", content: buildTriggerVisionContent(options?.context || {}, agentName, mediaOptions) },
  ];
  const maxToolSteps = Math.max(1, Math.min(8, Number(options?.maxToolSteps) || DEFAULT_TOOL_MAX_STEPS));
  const invokeModel = options?.invokeModel || (async (payload) => invokeChatCompletion(options?.llm, payload.messages, payload.tools, payload.toolChoice));
  const executeTool = options?.executeTool || (async (name, args) => executeFlowbotTool(name, args, options, toolState));

  for (let step = 0; step < maxToolSteps; step += 1) {
    const assistantMessage = await invokeModel({
      messages,
      tools,
      toolChoice: "auto",
    });
    const toolCalls = normalizeToolCallList(assistantMessage);
    const assistantText = extractMessageText(assistantMessage?.content);

    if (!toolCalls.length) {
      if (!assistantText) {
        const repairMessage = await invokeModel({
          messages: [
            ...messages,
            {
              role: "system",
              content: buildEmptyResponseRecoveryPrompt(options?.context || {}, agentName),
            },
          ],
          tools: [],
          toolChoice: "none",
        });
        return {
          text: extractMessageText(repairMessage?.content),
          toolState,
          steps: step + 2,
        };
      }
      return {
        text: assistantText,
        toolState,
        steps: step + 1,
      };
    }

    messages.push({
      role: "assistant",
      content: assistantMessage?.content ?? "",
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: String(toolCall?.function?.name || ""),
          arguments: typeof toolCall?.function?.arguments === "string"
            ? toolCall.function.arguments
            : JSON.stringify(toolCall?.function?.arguments || {}),
        },
      })),
    });

    const stepVisionPayloads = [];
    for (const toolCall of toolCalls) {
      const name = String(toolCall?.function?.name || "").trim();
      const args = parseToolArguments(toolCall?.function?.arguments);
      const result = await executeTool(name, args);
      toolState.calls.push({ name, args });
      if (Array.isArray(toolState.lastToolVisionInputs) && toolState.lastToolVisionInputs.length) {
        stepVisionPayloads.push({
          toolName: name,
          visionInputs: toolState.lastToolVisionInputs,
        });
      }
      toolState.lastToolVisionInputs = [];
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
    const visionFollowup = buildToolVisionFollowupContent(stepVisionPayloads, mediaOptions);
    if (visionFollowup) {
      messages.push({
        role: "user",
        content: visionFollowup,
      });
    }
  }

  messages.push({
    role: "system",
    content: `禁止继续调用工具。现在请直接输出最终回复；如果不该回复，只输出 ${NO_REPLY_SENTINEL}。`,
  });
  const finalMessage = await invokeModel({
    messages,
    tools: [],
    toolChoice: "none",
  });
  return {
    text: extractMessageText(finalMessage?.content),
    toolState,
    steps: maxToolSteps + 1,
  };
}

module.exports = {
  NO_REPLY_SENTINEL,
  buildSystemPrompt,
  buildUserPrompt,
  createToolDefinitions,
  extractMessageText,
  executeFlowbotTool,
  invokeChatCompletion,
  normalizeText,
  runLightAgent,
};
