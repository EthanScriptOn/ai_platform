#!/usr/bin/env node

"use strict";

const http = require("http");
const https = require("https");
const { adaptPayloadForAgent } = require("./agent_message_adapter");

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "wecom-flowbot-mcp";
const SERVER_VERSION = "0.1.0";
const FLOWBOT_BASE_URL = String(process.env.FLOWBOT_MCP_BASE_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.FLOWBOT_MCP_TIMEOUT_MS || 30000));

const TOOLS = [
  {
    name: "get_message",
    description: "Get one processed WeCom message by trace id.",
    inputSchema: {
      type: "object",
      properties: {
        traceId: { type: "string", description: "Exact trace id." },
      },
      required: ["traceId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_messages",
    description: "Search processed WeCom messages by room, sender, keywords, content, time range, media flag, or message type.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender name fuzzy match." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query across processed message text." },
        content: { type: "string", description: "Optional direct content substring filter." },
        traceId: { type: "string", description: "Optional exact trace id filter." },
        msgType: { type: "string", description: "Optional message type filter, such as 文本, 图片, 语音." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max result count, default 20." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset, default 0." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort by send time. Default desc." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_case_messages",
    description: "Search archived case conversation messages by case, room, sender, keyword, content, time range, media flag, or message type.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Optional case id filter." },
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender name fuzzy match." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query across archived case message text." },
        content: { type: "string", description: "Optional direct content substring filter." },
        traceId: { type: "string", description: "Optional exact trace id filter." },
        msgType: { type: "string", description: "Optional message type filter, such as 文本, 图片, 语音." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max result count, default 20." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset, default 0." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort by send time. Default desc." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_message_context",
    description: "Search processed messages and return nearby context before and after each match.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender name fuzzy match." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query across processed message text." },
        content: { type: "string", description: "Optional direct content substring filter." },
        traceId: { type: "string", description: "Optional exact trace id filter." },
        msgType: { type: "string", description: "Optional message type filter." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max match count, default 20." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset, default 0." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort by send time. Default desc." },
        contextBefore: { type: "integer", minimum: 0, maximum: 10, description: "How many previous messages to include. Default 2." },
        contextAfter: { type: "integer", minimum: 0, maximum: 10, description: "How many following messages to include. Default 2." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_memory",
    description: "Search unified memory across processed room messages and archived case messages.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["all", "messages", "cases"], description: "Memory source, default all." },
        caseId: { type: "string", description: "Optional case id filter." },
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender name fuzzy match." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query across memory text." },
        content: { type: "string", description: "Optional direct content substring filter." },
        traceId: { type: "string", description: "Optional exact trace id filter." },
        msgType: { type: "string", description: "Optional message type filter, such as 文本, 图片, 语音." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max result count, default 20." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset, default 0." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort by send time. Default desc." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_room_messages",
    description: "List the latest processed messages for a room.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Room id to read." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max message count, default 20." },
      },
      required: ["roomId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_room_summary",
    description: "Build a room summary over filtered processed messages.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Room id to summarize." },
        sender: { type: "string", description: "Optional sender fuzzy filter." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query filter." },
        content: { type: "string", description: "Optional direct content substring filter." },
        msgType: { type: "string", description: "Optional message type filter." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort direction before building highlights." },
      },
      required: ["roomId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_date_summary",
    description: "Build a day or week summary over processed messages.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Anchor date in YYYY-MM-DD." },
        span: { type: "string", enum: ["day", "week"], description: "Summary span. Default day." },
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender fuzzy filter." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query filter." },
        content: { type: "string", description: "Optional direct content substring filter." },
        msgType: { type: "string", description: "Optional message type filter." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_history_summary",
    description: "Build a historical summary by day or month, with optional preset or month range.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Optional room id filter." },
        sender: { type: "string", description: "Optional sender fuzzy filter." },
        senderId: { type: "string", description: "Optional exact sender id filter." },
        query: { type: "string", description: "Optional keyword query filter." },
        content: { type: "string", description: "Optional direct content substring filter." },
        msgType: { type: "string", description: "Optional message type filter." },
        hasMedia: { type: "boolean", description: "Optional media presence filter." },
        month: { type: "string", description: "Optional target month in YYYY-MM." },
        preset: { type: "string", enum: ["last_7_days", "last_30_days", "this_month", "last_month"], description: "Optional relative period preset." },
        bucket: { type: "string", enum: ["day", "month"], description: "Bucket granularity. Default day." },
        fromTime: { type: "string", description: "Optional ISO time or millisecond timestamp lower bound." },
        toTime: { type: "string", description: "Optional ISO time or millisecond timestamp upper bound." },
        timeZone: { type: "string", description: "Optional IANA time zone. Default Asia/Shanghai." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_cases",
    description: "Search archived cases by room and query text.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "Optional room id filter." },
        query: { type: "string", description: "Optional keyword query over case summaries and participants." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max result count, default 10." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "find_related_cases",
    description: "Find related cases and supporting messages for one case or one issue query.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Optional anchor case id." },
        roomId: { type: "string", description: "Optional room id filter." },
        query: { type: "string", description: "Optional direct issue query when no case id is provided." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max related case count, default 8." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_case_timeline",
    description: "Get one case timeline and activity list.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Case id." },
        sort: { type: "string", enum: ["asc", "desc"], description: "Timeline sort direction. Default asc." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Max timeline item count, default 100." },
        offset: { type: "integer", minimum: 0, description: "Timeline offset, default 0." },
      },
      required: ["caseId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_case",
    description: "Get one archived case with progress and artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "Case id, such as CASE-20260423-090813-1151." },
      },
      required: ["caseId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_knowledge",
    description: "Search unified knowledge across local flowbot docs and RAGFlow knowledge bases by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword query to search." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max result count, default 5." },
        source: { type: "string", enum: ["all", "local", "ragflow", "maxkb"], description: "Search source, default all." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_from_knowledge",
    description: "Search knowledge first, then let the server-side LLM judge whether the retrieved evidence is truly sufficient. Returns either a final group-safe answer or a unified fallback.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "User question to answer from knowledge." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max retrieval count before judging, default 5." },
        source: { type: "string", enum: ["all", "local", "ragflow", "maxkb"], description: "Knowledge source, default all." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "send_group_reply",
    description: "Reserved fallback tool to send a message back to a WeCom room through wecom-flowbot. For normal auto-replies, prefer returning final text and let the caller send it.",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "Upstream instance guid." },
        conversationId: { type: "string", description: "Raw conversation id / room id for upstream send." },
        content: { type: "string", description: "Reply text content." },
        taskId: { type: "string", description: "Optional existing agent task id, if replying from a claimed task." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

function log(message) {
  process.stderr.write(`[flowbot-mcp] ${message}\n`);
}

function getHttpModule(targetUrl) {
  return targetUrl.protocol === "https:" ? https : http;
}

function requestJson(method, target, payload = null, timeoutMs = REQUEST_TIMEOUT_MS) {
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

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResponse(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function writeError(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function toolTextResult(payload) {
  const adapted = adaptPayloadForAgent(payload);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(adapted, null, 2),
      },
    ],
    isError: false,
  };
}

function toolErrorResult(message, extra = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: message,
          ...extra,
        }, null, 2),
      },
    ],
    isError: true,
  };
}

function buildUrl(pathname, query = {}) {
  const url = new URL(`${FLOWBOT_BASE_URL}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function requireString(value, field) {
  const next = String(value || "").trim();
  if (!next) {
    throw new Error(`${field}_required`);
  }
  return next;
}

async function callTool(name, args) {
  switch (name) {
    case "get_message": {
      const traceId = requireString(args.traceId, "traceId");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/message", { traceId }),
      );
      return toolTextResult(response);
    }
    case "search_messages": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/messages/search", {
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          traceId: args.traceId,
          msgType: args.msgType,
          fromTime: args.fromTime,
          toTime: args.toTime,
          hasMedia: args.hasMedia,
          limit: args.limit,
          offset: args.offset,
          sort: args.sort,
        }),
      );
      return toolTextResult(response);
    }
    case "search_case_messages": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/case-messages/search", {
          caseId: args.caseId,
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          traceId: args.traceId,
          msgType: args.msgType,
          fromTime: args.fromTime,
          toTime: args.toTime,
          hasMedia: args.hasMedia,
          limit: args.limit,
          offset: args.offset,
          sort: args.sort,
        }),
      );
      return toolTextResult(response);
    }
    case "search_message_context": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/messages/context-search", {
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          traceId: args.traceId,
          msgType: args.msgType,
          fromTime: args.fromTime,
          toTime: args.toTime,
          hasMedia: args.hasMedia,
          limit: args.limit,
          offset: args.offset,
          sort: args.sort,
          contextBefore: args.contextBefore,
          contextAfter: args.contextAfter,
        }),
      );
      return toolTextResult(response);
    }
    case "search_memory": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/memory/search", {
          source: args.source,
          caseId: args.caseId,
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          traceId: args.traceId,
          msgType: args.msgType,
          fromTime: args.fromTime,
          toTime: args.toTime,
          hasMedia: args.hasMedia,
          limit: args.limit,
          offset: args.offset,
          sort: args.sort,
        }),
      );
      return toolTextResult(response);
    }
    case "list_room_messages": {
      const roomId = requireString(args.roomId, "roomId");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/messages", {
          roomId,
          limit: args.limit,
        }),
      );
      return toolTextResult(response);
    }
    case "get_room_summary": {
      const roomId = requireString(args.roomId, "roomId");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/room-summary", {
          roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          msgType: args.msgType,
          fromTime: args.fromTime,
          toTime: args.toTime,
          hasMedia: args.hasMedia,
          sort: args.sort,
        }),
      );
      return toolTextResult(response);
    }
    case "get_date_summary": {
      const date = requireString(args.date, "date");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/date-summary", {
          date,
          span: args.span,
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          msgType: args.msgType,
          hasMedia: args.hasMedia,
        }),
      );
      return toolTextResult(response);
    }
    case "get_history_summary": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/history-summary", {
          roomId: args.roomId,
          sender: args.sender,
          senderId: args.senderId,
          query: args.query,
          content: args.content,
          msgType: args.msgType,
          hasMedia: args.hasMedia,
          month: args.month,
          preset: args.preset,
          bucket: args.bucket,
          fromTime: args.fromTime,
          toTime: args.toTime,
          timeZone: args.timeZone,
        }),
      );
      return toolTextResult(response);
    }
    case "search_cases": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/cases", {
          roomId: args.roomId,
          query: args.query,
          limit: args.limit,
        }),
      );
      return toolTextResult(response);
    }
    case "find_related_cases": {
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/cases/related", {
          caseId: args.caseId,
          roomId: args.roomId,
          query: args.query,
          limit: args.limit,
        }),
      );
      return toolTextResult(response);
    }
    case "get_case_timeline": {
      const caseId = requireString(args.caseId, "caseId");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/case-timeline", {
          caseId,
          sort: args.sort,
          limit: args.limit,
          offset: args.offset,
        }),
      );
      return toolTextResult(response);
    }
    case "get_case": {
      const caseId = requireString(args.caseId, "caseId");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/case", { caseId }),
      );
      return toolTextResult(response);
    }
    case "search_knowledge": {
      const query = requireString(args.query, "query");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/knowledge", {
          query,
          limit: args.limit,
          source: args.source,
        }),
      );
      return toolTextResult(response);
    }
    case "answer_from_knowledge": {
      const query = requireString(args.query, "query");
      const response = await requestJson(
        "GET",
        buildUrl("/flowbot/agent/knowledge-answer", {
          query,
          limit: args.limit,
          source: args.source,
        }),
      );
      return toolTextResult(response);
    }
    case "send_group_reply": {
      const content = requireString(args.content, "content");
      const payload = {
        content,
      };
      if (args.taskId) {
        payload.taskId = String(args.taskId).trim();
      }
      if (args.guid) {
        payload.guid = String(args.guid).trim();
      }
      if (args.conversationId) {
        payload.conversationId = String(args.conversationId).trim();
      }
      const response = await requestJson(
        "POST",
        buildUrl("/flowbot/agent/reply"),
        payload,
      );
      return toolTextResult(response);
    }
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return writeResponse(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions: "Primary tools: search_memory for room and case memory, search_knowledge for product and solution docs. send_group_reply is a reserved fallback tool; for normal auto-replies, return final text and let the caller send it. Additional case and message tools are available when you need more precise retrieval.",
    });
  }
  if (method === "ping") {
    return writeResponse(id, {});
  }
  if (method === "tools/list") {
    return writeResponse(id, {
      tools: TOOLS,
    });
  }
  if (method === "tools/call") {
    const toolName = String(params?.name || "").trim();
    if (!toolName) {
      return writeError(id, -32602, "tool_name_required");
    }
    try {
      const result = await callTool(toolName, params?.arguments || {});
      return writeResponse(id, result);
    } catch (error) {
      const messageText = String(error?.message || error);
      if (/^unknown_tool:/.test(messageText)) {
        return writeError(id, -32602, messageText);
      }
      return writeResponse(id, toolErrorResult(messageText, {
        tool: toolName,
      }));
    }
  }
  return writeError(id, -32601, `method_not_found:${method}`);
}

let buffer = "";
let initialized = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const messages = buffer.split(/\r?\n/g);
  buffer = messages.pop() || "";
  for (const line of messages) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let message = null;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      log(`invalid input: ${error.message}`);
      continue;
    }
    const batch = Array.isArray(message) ? message : [message];
    for (const item of batch) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (item.method === "notifications/initialized") {
        initialized = true;
        continue;
      }
      if (item.id === undefined || item.id === null) {
        continue;
      }
      if (!initialized && item.method !== "initialize") {
        writeError(item.id, -32002, "server_not_initialized");
        continue;
      }
      Promise.resolve(handleRequest(item)).catch((error) => {
        writeError(item.id, -32603, String(error?.message || error));
      });
    }
  }
});

process.stdin.on("end", () => {
  log("stdin closed");
});

process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${String(error?.stack || error)}`);
});

process.on("unhandledRejection", (error) => {
  log(`unhandledRejection: ${String(error?.stack || error)}`);
});

log(`started base=${FLOWBOT_BASE_URL}`);
