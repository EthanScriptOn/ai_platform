#!/usr/bin/env node

"use strict";

const http = require("http");
const https = require("https");
const { runLightAgent, NO_REPLY_SENTINEL, normalizeText } = require("./light_agent_runtime");

const fs = require("fs");
const path = require("path");

loadFlowbotConfigFile(
  process.env.FLOWBOT_CONFIG_PATH
  || path.resolve(__dirname, "..", "..", "..", "config", "flowbot.local.json")
);

function loadFlowbotConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const [key, rawValue] of Object.entries(config || {})) {
    if (!key || process.env[key] !== undefined || rawValue == null) continue;
    if (Array.isArray(rawValue)) {
      process.env[key] = rawValue.join(",");
    } else if (typeof rawValue === "object") {
      process.env[key] = JSON.stringify(rawValue);
    } else {
      process.env[key] = String(rawValue);
    }
  }
}

const AGENT_BASE_URL = String(process.env.FLOWBOT_AGENT_BASE_URL || "http://127.0.0.1:3010/flowbot/agent").replace(/\/$/, "");
const HANDLER = String(process.env.FLOWBOT_AGENT_HANDLER || "flowbot-agent-worker").trim();
const ROOM_ID = String(process.env.FLOWBOT_AGENT_ROOM_ID || "").trim();
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.FLOWBOT_AGENT_POLL_INTERVAL_MS || 1000));
const MAX_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.FLOWBOT_AGENT_MAX_CONCURRENCY || 4) || 4));
const RUN_ONCE = String(process.env.FLOWBOT_AGENT_WORKER_ONCE || "0") === "1";
const LLM_API_URL = String(process.env.FLOWBOT_LLM_API_URL || "").trim();
const LLM_API_KEY = String(process.env.FLOWBOT_LLM_API_KEY || "").trim();
const LLM_MODEL = String(process.env.FLOWBOT_LLM_MODEL || "").trim();
const LLM_TIMEOUT_MS = Math.max(1000, Number(process.env.FLOWBOT_LLM_TIMEOUT_MS || 90000));
const LLM_TIMEOUT_RETRY_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_ATTEMPTS || 5) || 5));
const LLM_TIMEOUT_RETRY_BASE_DELAY_MS = Math.max(100, Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS || 1000));
const LLM_TIMEOUT_RETRY_MAX_DELAY_MS = Math.max(1000, Number(process.env.FLOWBOT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS || 16000));
const LLM_SUPPORTS_VISION = process.env.FLOWBOT_LLM_SUPPORTS_VISION;
const LLM_IMAGE_TRANSPORT = String(process.env.FLOWBOT_LLM_IMAGE_TRANSPORT || "").trim();
const LLM_MAX_IMAGES = Math.max(0, Math.min(6, Number(process.env.FLOWBOT_LLM_MAX_IMAGES || 3) || 3));
const AGENT_NAME = String(process.env.FLOWBOT_AGENT_NAME || "小智").trim() || "小智";
const AGENT_ID = String(process.env.FLOWBOT_AGENT_ID || "flowbot").trim() || "flowbot";
const AGENT_TOOL_MAX_STEPS = Math.max(1, Math.min(8, Number(process.env.FLOWBOT_AGENT_TOOL_MAX_STEPS || 4) || 4));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
            reject(new Error(`http_${res.statusCode}:${raw.slice(0, 400)}`));
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

async function claimNextTask(options = {}) {
  const excludeRoomIds = Array.isArray(options.excludeRoomIds) ? options.excludeRoomIds : [];
  const response = await requestJson(
    "POST",
    `${AGENT_BASE_URL}/tasks/claim`,
    {
      handler: HANDLER,
      roomId: ROOM_ID,
      excludeRoomIds,
    },
    {},
    15000,
  );
  return response?.task || null;
}

async function fetchTaskContext(taskId) {
  const endpoint = `${AGENT_BASE_URL}/context?taskId=${encodeURIComponent(taskId)}&lean=1`;
  const response = await requestJson("GET", endpoint, null, {}, 15000);
  return response?.context || null;
}

async function ackTask(taskId, status, note, responseSummary = "", extra = {}) {
  return requestJson(
    "POST",
    `${AGENT_BASE_URL}/tasks/ack`,
    {
      taskId,
      status,
      handler: HANDLER,
      note: String(note || ""),
      responseSummary: String(responseSummary || ""),
      ...extra,
    },
    {},
    15000,
  );
}

async function sendTaskReply(taskId, content) {
  return requestJson(
    "POST",
    `${AGENT_BASE_URL}/reply`,
    {
      taskId,
      content,
    },
    {},
    30000,
  );
}

function isExplicitWakeTask(context = {}) {
  const task = context?.task || {};
  const reason = String(task.routeReason || "").trim();
  const matched = Array.isArray(task.matchedAgentNames) ? task.matchedAgentNames : [];
  return /mention|wake|name_detected|agent_review/i.test(reason) || matched.length > 0;
}

function buildEmptyWakeFallback(context = {}) {
  const current = context?.task?.llmReadyMessage || {};
  const matched = Array.isArray(context?.task?.matchedAgentNames) ? context.task.matchedAgentNames : [];
  const wakeNames = Array.from(new Set([AGENT_NAME, ...matched].map((item) => String(item || "").trim()).filter(Boolean)));
  const wakePattern = wakeNames.length > 0
    ? new RegExp(`^(${wakeNames.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[，。,.\\s]*`)
    : null;
  const trigger = normalizeText([
    current.content,
    current.transcript_text,
    current.title,
    current.desc,
    current.quote_content,
  ].filter(Boolean).join("\n"))
    .replace(/^[@＠]\S+\s*/, "")
    .replace(wakePattern || /^$/, "");
  return trigger
    ? `我查了一下，暂时没有找到“${trigger}”的明确资料。你可以补充一下具体是问登录线路、上游平台，还是发单/转链线路，我再继续查。`
    : "我查了一下，暂时没有找到明确资料。你补充一下具体问题，我再继续查。";
}

async function handleOneTask(task) {
  const taskId = String(task?.taskId || "").trim();
  if (!taskId) {
    return false;
  }
  try {
    const context = await fetchTaskContext(taskId);
    if (!context) {
      throw new Error("task_context_missing");
    }
    const agentStartedAt = new Date().toISOString();

    const result = await runLightAgent({
      context,
      llm: {
        apiUrl: LLM_API_URL,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        timeoutMs: LLM_TIMEOUT_MS,
        timeoutRetryAttempts: LLM_TIMEOUT_RETRY_ATTEMPTS,
        timeoutRetryBaseDelayMs: LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
        timeoutRetryMaxDelayMs: LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
        supportsVision: LLM_SUPPORTS_VISION,
        imageTransport: LLM_IMAGE_TRANSPORT,
        maxImages: LLM_MAX_IMAGES,
      },
      flowbotBaseUrl: AGENT_BASE_URL,
      agentName: AGENT_NAME,
      agentId: AGENT_ID,
      maxToolSteps: AGENT_TOOL_MAX_STEPS,
      timeoutMs: 15000,
    });
    const agentFinishedAt = new Date().toISOString();
    const toolCalls = Array.isArray(result?.toolState?.calls) ? result.toolState.calls : [];
    const toolNames = toolCalls.map((item) => String(item?.name || "").trim()).filter(Boolean);
    const runtimeMeta = {
      agentStartedAt,
      agentFinishedAt,
      toolCalls,
      toolNames,
      toolCallCount: toolNames.length,
      llmSteps: Number(result?.steps || 0) || 0,
    };
    const replySent = Boolean(result?.toolState?.replySent);
    const replyContent = normalizeText(result?.toolState?.replyContent || "");
    const replySentAt = String(result?.toolState?.replySentAt || "").trim();

    const text = normalizeText(result?.text || "");
    if (replySent) {
      await ackTask(taskId, "completed", "light_agent_reply_sent_via_tool", replyContent || text, {
        ...runtimeMeta,
        replySentAt,
      });
      console.log(`[agent-worker] tool-sent ${taskId} steps=${Number(result?.steps || 0)}`);
      return true;
    }

    if (text === NO_REPLY_SENTINEL) {
      await ackTask(taskId, "ignored", "light_agent_no_reply", text, runtimeMeta);
      console.log(`[agent-worker] ignored ${taskId}`);
      return true;
    }

    if (text) {
      const replyResult = await sendTaskReply(taskId, text);
      await ackTask(taskId, "completed", "light_agent_fallback_text_reply", text, {
        ...runtimeMeta,
        replySentAt: String(replyResult?.sentAt || "").trim(),
      });
      console.log(`[agent-worker] fallback-sent ${taskId} steps=${Number(result?.steps || 0)}`);
      return true;
    }

    if (isExplicitWakeTask(context)) {
      const fallback = buildEmptyWakeFallback(context);
      const replyResult = await sendTaskReply(taskId, fallback);
      await ackTask(taskId, "completed", "light_agent_empty_response_fallback_reply", fallback, {
        ...runtimeMeta,
        replySentAt: String(replyResult?.sentAt || "").trim(),
      });
      console.log(`[agent-worker] empty-fallback-sent ${taskId}`);
      return true;
    }

    await ackTask(taskId, "ignored", "light_agent_empty_response", "", runtimeMeta);
    console.log(`[agent-worker] empty-ignore ${taskId}`);
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    await ackTask(taskId, "failed", message, "", {
      agentFinishedAt: new Date().toISOString(),
    });
    console.error(`[agent-worker] failed ${taskId}: ${message}`);
    return false;
  }
}

function getTaskRoomKey(task) {
  return String(task?.roomId || task?.rawRoomId || "unknown-room").trim() || "unknown-room";
}

async function main() {
  console.log(
    `[agent-worker] start base=${AGENT_BASE_URL} model=${LLM_MODEL} concurrency=${MAX_CONCURRENCY} pollMs=${POLL_INTERVAL_MS} toolSteps=${AGENT_TOOL_MAX_STEPS}`,
  );
  const inflight = new Map();

  do {
    try {
      let claimedCount = 0;

      while (inflight.size < MAX_CONCURRENCY) {
        const task = await claimNextTask({
          excludeRoomIds: [...inflight.keys()],
        });
        if (!task) {
          break;
        }
        claimedCount += 1;
        const roomKey = getTaskRoomKey(task);
        const running = handleOneTask(task)
          .catch((error) => {
            console.error(`[agent-worker] slot error ${task.taskId}: ${String(error?.message || error)}`);
            return false;
          })
          .finally(() => {
            inflight.delete(roomKey);
          });
        inflight.set(roomKey, running);
      }

      if (RUN_ONCE) {
        if (!inflight.size && claimedCount === 0) {
          break;
        }
        if (inflight.size) {
          await Promise.race(inflight.values());
        }
        continue;
      }

      if (inflight.size) {
        if (claimedCount === 0) {
          await Promise.race(inflight.values());
        }
        continue;
      }

      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      console.error(`[agent-worker] loop error: ${String(error?.message || error)}`);
      if (RUN_ONCE) {
        process.exitCode = 1;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } while (!RUN_ONCE);
}

main().catch((error) => {
  console.error(`[agent-worker] fatal: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
