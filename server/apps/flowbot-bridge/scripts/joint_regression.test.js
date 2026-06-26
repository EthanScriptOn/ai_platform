"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(Number(address.port)));
    });
  });
}

function requestJson(method, target, payload = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const body = payload == null ? "" : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
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
          try {
            resolve({
              statusCode: res.statusCode,
              body: raw.trim() ? JSON.parse(raw) : {},
              raw,
            });
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}:${raw.slice(0, 500)}`));
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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/g)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function terminateProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function extractLastJsonText(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const last = messages[messages.length - 1] || {};
  const parts = Array.isArray(last.content) ? last.content : [];
  const textPart = parts.find((item) => item && item.type === "text");
  return String(textPart?.text || "");
}

function safeParseJson(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function collectTraceIdsFromPending(input) {
  const pending = Array.isArray(input?.pending_messages) ? input.pending_messages : [];
  return pending.map((item) => String(item?.trace_id || "").trim()).filter(Boolean);
}

function buildBatchPlannerResponse(input) {
  const pendingText = JSON.stringify(input?.pending_messages || []);
  const traceIds = collectTraceIdsFromPending(input);
  const toolResults = Array.isArray(input?.case_tool_results) ? input.case_tool_results : [];
  const toolCases = toolResults.flatMap((item) => Array.isArray(item?.result?.cases) ? item.result.cases : []);
  const openCaseId = String(toolCases[0]?.case_id || "").trim();
  if (/支付回调失败|支付回调报错/.test(pendingText) && /后续排查|上游 timeout|已恢复/.test(pendingText) && !openCaseId) {
    return {
      tool_calls: [
        {
          name: "search_cases_by_day",
          arguments: {
            query: "支付回调失败 页面报错500 上游 timeout",
            page: 1,
            limit: 10,
          },
        },
      ],
    };
  }
  if (/支付回调失败|支付回调报错/.test(pendingText) && /后续排查|上游 timeout|已恢复/.test(pendingText) && openCaseId) {
    return {
      groups: [
        {
          group_id: "append_activity_group",
          thread_type: "case_feedback",
          message_role: "troubleshooting_update",
          action: "append_case_activity",
          target_case_id: openCaseId,
          category: "case_feedback",
          priority: "P1",
          summary: "回归测试：支付回调失败后续排查进展",
          reason: "消息明确是在跟进已有支付回调失败 Case，应追加为 Case 活动。",
          trace_ids: traceIds,
        },
      ],
    };
  }
  if (/支付回调失败|支付回调报错/.test(pendingText)) {
    return {
      groups: [
        {
          group_id: "payment_case_group",
          thread_type: "case_feedback",
          message_role: "problem_report",
          action: "new_case",
          target_case_id: "",
          category: "bug",
          priority: "P1",
          summary: "回归测试：支付回调失败",
          reason: "明确用户故障，应进入客服 Case 管道；category 使用 bug 以覆盖枚举归一化。",
          trace_ids: traceIds,
        },
      ],
    };
  }
  if (/希望.*导出.*字段|增加.*导出字段/.test(pendingText)) {
    return {
      groups: [
        {
          group_id: "feature_case_group",
          thread_type: "feature_request",
          message_role: "feature_request",
          action: "new_case",
          target_case_id: "",
          category: "feature_request",
          priority: "P2",
          summary: "回归测试：订单导出增加渠道字段",
          reason: "明确产品需求，应作为需求类 Case 归档。",
          trace_ids: traceIds,
        },
      ],
    };
  }
  if (/收到谢谢|今天天气|辛苦了/.test(pendingText)) {
    return {
      groups: traceIds.map((traceId, index) => ({
        group_id: `chat_${index + 1}`,
        thread_type: "chat",
        message_role: "chitchat",
        action: "ignore",
        target_case_id: "",
        category: "none",
        priority: "P3",
        summary: "回归测试：闲聊忽略",
        reason: "闲聊不进入 Case。",
        trace_ids: [traceId],
      })),
    };
  }
  if (/登录报错500|登录失败/.test(pendingText)) {
    return {
      groups: [
        {
          group_id: "case_group",
          thread_type: "case_feedback",
          message_role: "problem_report",
          action: "new_case",
          target_case_id: "",
          category: "technical_issue",
          priority: "P1",
          summary: "回归测试：登录报错500",
          reason: "明确用户故障，应进入客服 Case 管道；category 使用同义词以覆盖枚举归一化。",
          trace_ids: traceIds,
        },
      ],
    };
  }
  if (/CSV中文乱码|CSV 中文乱码/.test(pendingText)) {
    return {
      groups: [
        {
          group_id: "knowledge_group",
          thread_type: "question",
          message_role: "resolution",
          action: "ignore",
          target_case_id: "",
          category: "none",
          priority: "P3",
          summary: "回归测试：CSV 中文乱码处理办法已闭环",
          reason: "这是已闭环的问答知识，不应误建 Case。",
          trace_ids: traceIds,
        },
      ],
    };
  }
  return {
    groups: traceIds.map((traceId, index) => ({
      group_id: `ignore_${index + 1}`,
      thread_type: "chat",
      message_role: "chitchat",
      action: "ignore",
      target_case_id: "",
      category: "none",
      priority: "P3",
      summary: "回归测试默认忽略",
      reason: "默认忽略",
      trace_ids: [traceId],
    })),
  };
}

function buildKnowledgeHarvestResponse(input) {
  const text = JSON.stringify(input);
  const targetText = JSON.stringify(input?.target_message || {});
  const related = Array.isArray(input?.related_knowledge) ? input.related_knowledge : [];
  const hasRelatedLocal = related.some((item) => String(item?.source || "") === "local");
  if (/只有现象没有结论|还没定位原因|待排查/.test(targetText)) {
    return {
      action: "ignore",
      knowledge_status: "uncertain",
      recommendation: "do_not_add",
      title: "",
      scope: "",
      problem: "",
      solution: "",
      existing_knowledge_ids: [],
      existing_knowledge_summary: "",
      delta: "",
      tags: [],
      evidence: [],
      reason: "只有现象没有明确结论或操作步骤，暂不沉淀。",
      confidence: 0.24,
    };
  }
  if (/库存同步失败|sku_code_missing/.test(targetText)) {
    return {
      action: "candidate",
      knowledge_status: hasRelatedLocal ? "already_exists" : "new",
      recommendation: hasRelatedLocal ? "needs_human_review" : "add_new",
      title: "回归测试 库存同步 sku_code_missing 处理方案",
      scope: "回归测试/库存同步/导入模板",
      problem: "库存同步导入失败并提示 sku_code_missing。",
      solution: "使用标准模板补齐 sku_code 列后重新上传；旧任务卡住时刷新页面后重试。",
      existing_knowledge_ids: hasRelatedLocal ? related.map((item) => item.id).filter(Boolean).slice(0, 3) : [],
      existing_knowledge_summary: hasRelatedLocal ? "已有本地知识覆盖 sku_code_missing 处理。" : "",
      delta: hasRelatedLocal ? "无明显新增步骤，交由人工决定是否补充。" : "新增模板列缺失导致导入失败的处理步骤。",
      tags: ["库存同步", "sku_code_missing", "导入模板"],
      evidence: ["群消息明确说明缺少 sku_code 列并给出重新上传处理。"],
      reason: "包含可复用的排查原因和处理步骤。",
      confidence: 0.94,
    };
  }
  if (/CSV中文乱码|CSV 中文乱码/.test(text)) {
    return {
      action: "candidate",
      knowledge_status: hasRelatedLocal ? "already_exists" : "new",
      recommendation: hasRelatedLocal ? "needs_human_review" : "add_new",
      title: "回归测试 CSV 中文乱码处理方案",
      scope: "回归测试/报表导出/CSV",
      problem: "报表导出 CSV 后，Windows Excel 直接双击打开出现中文乱码。",
      solution: "在 Excel 中通过“数据 -> 自文本/CSV”导入并选择 UTF-8；或另存为带 BOM 的 UTF-8 后再打开。",
      existing_knowledge_ids: hasRelatedLocal ? related.map((item) => item.id).filter(Boolean).slice(0, 3) : [],
      existing_knowledge_summary: hasRelatedLocal ? "已有本地知识覆盖 CSV 中文乱码的 UTF-8 导入处理。" : "",
      delta: hasRelatedLocal ? "本轮群消息没有明显新增处理步骤，建议人工确认是否需要更新。" : "新增了 Excel 导入 UTF-8 和 BOM 两种处理方式。",
      tags: ["CSV", "中文乱码", "UTF-8", "Excel"],
      evidence: ["群消息给出 UTF-8 导入和 BOM 另存为两种处理办法。"],
      reason: "包含可复用的客服处理步骤。",
      confidence: 0.96,
    };
  }
  return {
    action: "ignore",
    knowledge_status: "uncertain",
    recommendation: "do_not_add",
    title: "",
    scope: "",
    problem: "",
    solution: "",
    existing_knowledge_ids: [],
    existing_knowledge_summary: "",
    delta: "",
    tags: [],
    evidence: [],
    reason: "没有完整可复用结论。",
    confidence: 0.2,
  };
}

function chooseMockLlmResponse(payload) {
  const text = extractLastJsonText(payload);
  const parsed = safeParseJson(text, {});
  if (Object.prototype.hasOwnProperty.call(parsed, "pending_messages")) {
    return buildBatchPlannerResponse(parsed);
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "target_message")) {
    return buildKnowledgeHarvestResponse(parsed);
  }
  return { ok: true };
}

function writeSseJson(res, value) {
  const content = JSON.stringify(value);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
}

async function startMockServices() {
  const port = await findFreePort();
  const calls = {
    llm: [],
    maxkb: [],
    wecomSends: [],
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = safeParseJson(raw, {});
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.endsWith("/chat/completions")) {
        calls.llm.push(body);
        writeSseJson(res, chooseMockLlmResponse(body));
        return;
      }
      if (url.pathname === "/msg/send_text") {
        calls.wecomSends.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_code: 0, error_message: "ok", data: { message_id: `mock-send-${calls.wecomSends.length}` } }));
        return;
      }
      if (url.pathname === "/admin/api/user/login") {
        calls.maxkb.push({ path: url.pathname, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { token: "mock-token" } }));
        return;
      }
      if (/\/admin\/api\/workspace\/[^/]+\/knowledge$/.test(url.pathname)) {
        calls.maxkb.push({ path: url.pathname, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "kb-existing", name: "模拟已有知识库" }] }));
        return;
      }
      if (/\/hit_test$/.test(url.pathname)) {
        calls.maxkb.push({ path: url.pathname, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startFlowbot(mock, env = {}) {
  const port = await findFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-joint-regression-"));
  const dataDir = path.join(root, "data");
  const knowledgeDir = path.join(root, "knowledge");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const logs = [];
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      FLOWBOT_DATA_DIR: dataDir,
      FLOWBOT_KNOWLEDGE_DIR: knowledgeDir,
      FLOWBOT_DASHBOARD_PUBLIC_URL: "http://127.0.0.1",
      FLOWBOT_ARCHIVE_ENABLED: "1",
      FLOWBOT_CASE_ARCHIVE_NOTIFY_ENABLED: "0",
      FLOWBOT_BATCH_MODE_ENABLED: "1",
      FLOWBOT_BATCH_SCAN_INTERVAL_MS: "3600000",
      FLOWBOT_BATCH_READY_AGE_MS: "0",
      FLOWBOT_AGENT_LANE_ENABLED: "1",
      FLOWBOT_AGENT_WAKE_NAMES: "小智",
      FLOWBOT_LLM_CLASSIFY_ENABLED: "1",
      FLOWBOT_LLM_API_URL: `${mock.baseUrl}/compatible-mode/v1`,
      FLOWBOT_LLM_API_KEY: "mock-key",
      FLOWBOT_LLM_MODEL: "mock-model",
      FLOWBOT_LLM_TIMEOUT_MS: "30000",
      FLOWBOT_LLM_MAX_REPAIR_ATTEMPTS: "1",
      FLOWBOT_KNOWLEDGE_HARVEST_ENABLED: "1",
      FLOWBOT_KNOWLEDGE_HARVEST_READY_AGE_MS: "0",
      FLOWBOT_KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS: "3600000",
      FLOWBOT_KNOWLEDGE_HARVEST_MAX_PER_SCAN: "20",
      FLOWBOT_MAXKB_BASE_URL: mock.baseUrl,
      FLOWBOT_UPSTREAM_WECOM_API_BASE: mock.baseUrl,
      FLOWBOT_MAXKB_USERNAME: "mock-user",
      FLOWBOT_MAXKB_PASSWORD: "mock-pass",
      FEISHU_APP_ID: "cli_test_app",
      ...env,
    },
  });
  const collect = (streamName) => (chunk) => {
    for (const line of String(chunk || "").split(/\r?\n/g)) {
      if (line.trim()) {
        logs.push(`[${streamName}] ${line}`);
      }
    }
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));

  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    try {
      const response = await requestJson("GET", `${baseUrl}/health`);
      if (response.statusCode === 200) {
        return { child, root, dataDir, knowledgeDir, baseUrl, logs };
      }
    } catch {
      // Keep polling until ready.
    }
    await sleep(100);
  }
  await terminateProcess(child);
  throw new Error(`server_start_timeout\n${logs.slice(-30).join("\n")}`);
}

function buildFeishuMessage({ eventId, messageId, chatId, text, senderOpenId = "ou_joint" }) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      create_time: "1778233313173",
      token: "test-token",
      app_id: "cli_test_app",
    },
    event: {
      sender: {
        sender_id: {
          open_id: senderOpenId,
        },
        sender_type: "user",
      },
      message: {
        chat_id: chatId,
        chat_type: "group",
        content: JSON.stringify({ text }),
        create_time: "1778233312906",
        message_id: messageId,
        message_type: "text",
      },
    },
  };
}

function buildWecomMessage({ guid = "guid_joint", roomId, seq, id, text, sender = "user_joint" }) {
  return {
    guid,
    notify_type: 11010,
    data: {
      roomid: roomId,
      room_name: roomId,
      seq,
      id,
      sender,
      sender_name: sender,
      receiver: "bot_joint",
      sendtime: 1778233313,
      msg_type: 2,
      content: text,
    },
  };
}

async function postWecom(app, { roomId, seq, id, text, sender = "user_joint", guid = "guid_joint" }) {
  const response = await requestJson("POST", `${app.baseUrl}/flowbot/callback`, buildWecomMessage({
    guid,
    roomId,
    seq,
    id,
    text,
    sender,
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.accepted, true);
  return response;
}

async function postFeishu(app, { chatId, index, text, senderOpenId = "" }) {
  const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
    eventId: `evt_${chatId}_${index}`,
    messageId: `om_${chatId}_${index}`,
    chatId,
    text,
    senderOpenId: senderOpenId || `ou_${index}`,
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.accepted, true);
  return response;
}

test("joint regression: customer-service Case flow and group-message knowledge flow form a closed loop", async () => {
  const mock = await startMockServices();
  const app = await startFlowbot(mock);
  try {
    const caseRoomId = "wecom_joint_case_room";
    const knowledgeRoomId = "oc_joint_knowledge_room";

    const caseCallback = await requestJson("POST", `${app.baseUrl}/flowbot/callback`, buildWecomMessage({
      roomId: caseRoomId,
      seq: "case_seq_1",
      id: "case_msg_1",
      text: "联合回归：客户登录报错500，影响多人，请排查。",
    }));
    assert.equal(caseCallback.body.accepted, true);

    const caseProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(caseProcess.body.ok, true);
    assert.equal(caseProcess.body.result.rooms[0].ok, true);

    const caseIndex = JSON.parse(fs.readFileSync(path.join(app.dataDir, "index.json"), "utf8"));
    assert.equal(caseIndex.cases.length, 1);
    assert.match(caseIndex.cases[0].summary, /登录报错500/);
    assert.equal(caseIndex.cases[0].category, "case_feedback");

    const noCaseKnowledge = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(noCaseKnowledge.body.ok, true);

    const feishuMessages = [
      "联合回归：报表导出 CSV中文乱码，客户问怎么处理？",
      "联合回归：排查结论是 CSV 为 UTF-8，Windows Excel 直接双击打开导致乱码。",
      "联合回归：解决办法是在 Excel 里通过 数据 -> 自文本/CSV 导入并选择 UTF-8；或另存为带 BOM 的 UTF-8。",
      "@小智 联合回归：CSV中文乱码应该怎么回复客户？",
    ];
    for (let index = 0; index < feishuMessages.length; index += 1) {
      const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
        eventId: `evt_joint_${index + 1}`,
        messageId: `om_joint_${index + 1}`,
        chatId: knowledgeRoomId,
        text: feishuMessages[index],
        senderOpenId: `ou_joint_${index + 1}`,
      }));
      assert.equal(response.body.accepted, true);
      if (index === 3) {
        assert.equal(response.body.route.agentTriggered, true);
      }
    }

    const knowledgeCaseProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(knowledgeCaseProcess.body.ok, true);
    assert.equal(knowledgeCaseProcess.body.result.rooms[0].ok, true);
    assert.equal(knowledgeCaseProcess.body.result.rooms[0].groups[0].action, "ignore");

    const harvest = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(harvest.body.ok, true);
    assert.equal(harvest.body.candidates, 1);

    const candidates = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge-candidates?roomId=${encodeURIComponent(knowledgeRoomId)}&limit=20`);
    assert.equal(candidates.body.candidates.length, 1);
    assert.ok(candidates.body.candidates.every((item) => item.status === "pending_review"));
    assert.ok(candidates.body.candidates.every((item) => item.recommendation));
    assert.ok(candidates.body.candidates.some((item) => item.knowledgeStatus === "new"));

    const selectedCandidate = candidates.body.candidates[0];
    const savedDraft = await requestJson("POST", `${app.baseUrl}/flowbot/agent/knowledge-candidates/action`, {
      candidateId: selectedCandidate.candidateId,
      action: "save",
      title: "人工修订 CSV 中文乱码处理方案",
      scope: "人工修订/报表导出/CSV",
      problem: "人工修订：Windows Excel 直接打开 UTF-8 CSV 时中文乱码。",
      solution: "人工修订：使用 Excel 数据导入选择 UTF-8，或导出带 BOM 的 UTF-8 CSV。",
      tags: "CSV, Excel, UTF-8, 人工审核",
      reviewer: "joint-regression",
      reviewNote: "先保存草稿再发布，验证人工编辑不会丢失。",
    });
    assert.equal(savedDraft.body.ok, true);
    assert.equal(savedDraft.body.candidate.title, "人工修订 CSV 中文乱码处理方案");
    assert.deepEqual(savedDraft.body.candidate.tags, ["CSV", "Excel", "UTF-8", "人工审核"]);

    const publish = await requestJson("POST", `${app.baseUrl}/flowbot/agent/knowledge-candidates/action`, {
      candidateId: selectedCandidate.candidateId,
      action: "approve",
      title: "人工修订 CSV 中文乱码处理方案",
      scope: "人工修订/报表导出/CSV",
      problem: "人工修订：Windows Excel 直接打开 UTF-8 CSV 时中文乱码。",
      solution: "人工修订：使用 Excel 数据导入选择 UTF-8，或导出带 BOM 的 UTF-8 CSV。",
      tags: "CSV, Excel, UTF-8, 人工审核",
      reviewer: "joint-regression",
      reviewNote: "确认发布人工修订版。",
    });
    assert.equal(publish.body.ok, true);
    assert.equal(publish.body.candidate.status, "published");
    assert.ok(fs.existsSync(publish.body.candidate.publishedPath));
    const publishedMarkdown = fs.readFileSync(publish.body.candidate.publishedPath, "utf8");
    assert.match(publishedMarkdown, /# 人工修订 CSV 中文乱码处理方案/);
    assert.match(publishedMarkdown, /审核人：joint-regression/);
    assert.match(publishedMarkdown, /确认发布人工修订版/);
    assert.match(publishedMarkdown, /人工修订：使用 Excel 数据导入选择 UTF-8/);

    const localKnowledge = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge?source=local&limit=5&q=${encodeURIComponent("CSV中文乱码 UTF-8 Excel 怎么处理")}`);
    assert.match(localKnowledge.body.docs[0].title, /人工修订[- ]CSV[- ]中文乱码处理方案/);

    const allKnowledge = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge?source=all&limit=5&q=${encodeURIComponent("CSV中文乱码 UTF-8 Excel 怎么处理")}`);
    assert.equal(allKnowledge.body.docs[0].source, "local");
    assert.match(allKnowledge.body.docs[0].title, /人工修订[- ]CSV[- ]中文乱码处理方案/);

    const tasks = await requestJson("GET", `${app.baseUrl}/flowbot/agent/tasks?status=&roomId=${encodeURIComponent(knowledgeRoomId)}&limit=10`);
    assert.equal(tasks.body.tasks.length, 1);
    assert.equal(tasks.body.tasks[0].routeReason, "explicit_mention");

    const context = await requestJson("GET", `${app.baseUrl}/flowbot/agent/context?taskId=${encodeURIComponent(tasks.body.tasks[0].taskId)}&query=${encodeURIComponent("CSV中文乱码 UTF-8 Excel 怎么处理")}&messageLimit=8&caseLimit=5`);
    assert.equal(context.body.ok, true);
    assert.match(context.body.context.knowledge[0].title, /人工修订[- ]CSV[- ]中文乱码处理方案/);
    assert.equal(context.body.context.roomMessages.length, 4);

    const repeated = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_joint_repeat",
      messageId: "om_joint_repeat",
      chatId: knowledgeRoomId,
      text: "联合回归二次补充：CSV中文乱码仍按 UTF-8 导入处理。",
      senderOpenId: "ou_joint_repeat",
    }));
    assert.equal(repeated.body.accepted, true);
    const repeatedHarvest = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(repeatedHarvest.body.ok, true);

    const nextCandidates = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge-candidates?roomId=${encodeURIComponent(knowledgeRoomId)}&limit=20`);
    const advisoryCandidate = nextCandidates.body.candidates.find((item) => item.sourceMessage?.traceId === repeated.body.traceId);
    assert.ok(advisoryCandidate);
    assert.equal(advisoryCandidate.status, "pending_review");
    assert.equal(advisoryCandidate.knowledgeStatus, "already_exists");
    assert.ok(advisoryCandidate.relatedKnowledge.length >= 1);

    const dashboard = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?roomId=${encodeURIComponent(knowledgeRoomId)}&limit=20`);
    assert.equal(dashboard.body.progress.caseTotal, 0);
    assert.equal(dashboard.body.progress.knowledgePublishedTotal, 1);
    assert.ok(dashboard.body.progress.knowledgePendingReviewTotal >= 1);
    assert.ok(Array.isArray(dashboard.body.needsAttention.items));
    assert.ok(dashboard.body.needsAttention.items.some((item) => item.kind === "knowledge_review"));
    assert.ok(dashboard.body.latest.knowledgeCandidates.every((item) => item.status === "pending_review"));
    assert.ok(dashboard.body.latest.knowledgeCandidateActivity.some((item) => item.status === "published"));

    assert.ok(readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl")).length >= 5);
    assert.ok(mock.calls.llm.length >= 3);
  } finally {
    await terminateProcess(app.child);
    await mock.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  }
});

test("joint regression: customer-service lifecycle covers create, append, feature, ignore, and wecom agent reply", async () => {
  const mock = await startMockServices();
  const app = await startFlowbot(mock);
  try {
    const roomId = "wecom_joint_lifecycle_room";

    await postWecom(app, {
      roomId,
      seq: "pay_seq_1",
      id: "pay_msg_1",
      text: "联合回归：支付回调失败，页面报错500，影响多个客户，请排查。",
      sender: "客户A",
    });
    const firstProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(firstProcess.body.result.rooms[0].ok, true);

    let caseIndex = JSON.parse(fs.readFileSync(path.join(app.dataDir, "index.json"), "utf8"));
    assert.equal(caseIndex.cases.length, 1);
    assert.equal(caseIndex.cases[0].category, "case_feedback");
    assert.match(caseIndex.cases[0].summary, /支付回调失败/);
    const caseId = caseIndex.cases[0].case_id;

    await postWecom(app, {
      roomId,
      seq: "pay_seq_2",
      id: "pay_msg_2",
      text: "联合回归：支付回调失败后续排查，上游 timeout，目前已恢复。",
      sender: "研发B",
    });
    const appendProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(appendProcess.body.result.rooms[0].ok, true);
    assert.equal(appendProcess.body.result.rooms[0].groups[0].action, "append_case_activity");

    const archiveLogs = readJsonl(path.join(app.dataDir, "flowbot-archive-results.jsonl"));
    assert.ok(archiveLogs.some((item) => item.batchAction === "append_case_activity" && item.caseId === caseId && item.caseAction === "update"));

    await postWecom(app, {
      roomId,
      seq: "feature_seq_1",
      id: "feature_msg_1",
      text: "联合回归：希望订单导出增加渠道字段，方便财务核对。",
      sender: "产品C",
    });
    const featureProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(featureProcess.body.result.rooms[0].ok, true);

    caseIndex = JSON.parse(fs.readFileSync(path.join(app.dataDir, "index.json"), "utf8"));
    assert.equal(caseIndex.cases.length, 2);
    assert.ok(caseIndex.cases.some((item) => item.category === "feature_request" && /订单导出增加渠道字段/.test(item.summary)));

    await postWecom(app, {
      roomId,
      seq: "chat_seq_1",
      id: "chat_msg_1",
      text: "联合回归：收到谢谢，辛苦了。",
      sender: "客户A",
    });
    const chatProcess = await requestJson("POST", `${app.baseUrl}/flowbot/process-pending`, {});
    assert.equal(chatProcess.body.result.rooms[0].ok, true);
    assert.equal(chatProcess.body.result.rooms[0].groups[0].action, "ignore");

    caseIndex = JSON.parse(fs.readFileSync(path.join(app.dataDir, "index.json"), "utf8"));
    assert.equal(caseIndex.cases.length, 2);

    const agentCallback = await postWecom(app, {
      roomId,
      seq: "agent_seq_1",
      id: "agent_msg_1",
      text: "联合回归：@小智 支付回调失败怎么回复客户？",
      sender: "客服D",
    });
    assert.equal(agentCallback.body.route.agentTriggered, true);

    const tasks = await requestJson("GET", `${app.baseUrl}/flowbot/agent/tasks?roomId=${encodeURIComponent(roomId)}&limit=10`);
    assert.equal(tasks.body.tasks.length, 1);
    const reply = await requestJson("POST", `${app.baseUrl}/flowbot/agent/reply`, {
      taskId: tasks.body.tasks[0].taskId,
      content: "联合回归自动回复：已收到，会按支付回调失败排查流程处理。",
    });
    assert.equal(reply.body.ok, true);
    assert.equal(reply.body.platform, "wecom");
    assert.equal(mock.calls.wecomSends.length, 1);
    assert.match(mock.calls.wecomSends[0].content, /支付回调失败排查流程/);
  } finally {
    await terminateProcess(app.child);
    await mock.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  }
});

test("joint regression: knowledge review prevents pollution and surfaces existing-knowledge decisions", async () => {
  const mock = await startMockServices();
  const app = await startFlowbot(mock);
  try {
    const chatId = "oc_joint_review_room";

    await postFeishu(app, {
      chatId,
      index: 1,
      text: "联合回归：库存同步失败提示 sku_code_missing，原因是导入模板缺少 sku_code 列。处理办法是使用标准模板补齐 sku_code 列并重新上传。",
    });
    await postFeishu(app, {
      chatId,
      index: 2,
      text: "联合回归：库存同步只有现象没有结论，还没定位原因，待排查。",
    });

    const harvest = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(harvest.body.ok, true);
    assert.equal(harvest.body.candidates, 1);
    assert.equal(harvest.body.ignored, 0);

    const candidates = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge-candidates?roomId=${encodeURIComponent(chatId)}&limit=10`);
    assert.equal(candidates.body.candidates.length, 1);
    assert.equal(candidates.body.candidates[0].knowledgeStatus, "new");

    const rejected = await requestJson("POST", `${app.baseUrl}/flowbot/agent/knowledge-candidates/action`, {
      candidateId: candidates.body.candidates[0].candidateId,
      action: "reject",
      reason: "回归测试：先验证拒绝不会污染知识库",
    });
    assert.equal(rejected.body.ok, true);
    assert.equal(rejected.body.candidate.status, "rejected");

    const rejectedDashboard = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?roomId=${encodeURIComponent(chatId)}&limit=20`);
    assert.equal(rejectedDashboard.body.latest.knowledgeCandidates.length, 0);
    assert.ok(rejectedDashboard.body.latest.knowledgeCandidateActivity.some((item) => item.status === "rejected"));

    const noKnowledge = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge?source=local&limit=5&q=${encodeURIComponent("sku_code_missing 库存同步")}`);
    assert.equal(noKnowledge.body.docs.length, 0);
    assert.equal(fs.existsSync(path.join(app.knowledgeDir, "generated")), false);

    await postFeishu(app, {
      chatId,
      index: 3,
      text: "联合回归：库存同步失败 sku_code_missing 的最终处理方式：补齐 sku_code 列，使用标准模板重新上传，旧任务刷新后重试。",
    });
    const secondHarvest = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(secondHarvest.body.ok, true);
    assert.equal(secondHarvest.body.candidates, 1);

    const nextCandidates = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge-candidates?roomId=${encodeURIComponent(chatId)}&limit=10`);
    const publishCandidate = nextCandidates.body.candidates.find((item) => item.status === "pending_review");
    assert.ok(publishCandidate);
    const published = await requestJson("POST", `${app.baseUrl}/flowbot/agent/knowledge-candidates/action`, {
      candidateId: publishCandidate.candidateId,
      action: "approve",
    });
    assert.equal(published.body.ok, true);
    assert.equal(published.body.candidate.status, "published");
    assert.ok(fs.existsSync(published.body.candidate.publishedPath));

    await postFeishu(app, {
      chatId,
      index: 4,
      text: "联合回归：库存同步失败 sku_code_missing 还是按标准模板补齐 sku_code 列处理。",
    });
    const existingHarvest = await requestJson("POST", `${app.baseUrl}/flowbot/knowledge-harvest/process`, { ignoreReadyAge: true });
    assert.equal(existingHarvest.body.ok, true);
    assert.equal(existingHarvest.body.candidates, 1);

    const allCandidates = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge-candidates?roomId=${encodeURIComponent(chatId)}&limit=20`);
    const existingCandidate = allCandidates.body.candidates.find((item) => item.sourceMessage?.content.includes("还是按标准模板"));
    assert.ok(existingCandidate);
    assert.equal(existingCandidate.knowledgeStatus, "already_exists");
    assert.equal(existingCandidate.recommendation, "needs_human_review");
    assert.ok(existingCandidate.relatedKnowledge.length >= 1);
    const targetKnowledge = existingCandidate.relatedKnowledge.find((item) => item.source === "local" && item.fileName);
    assert.ok(targetKnowledge);
    const updatedExisting = await requestJson("POST", `${app.baseUrl}/flowbot/agent/knowledge-candidates/action`, {
      candidateId: existingCandidate.candidateId,
      action: "update_existing",
      targetKnowledgeFileName: targetKnowledge.fileName,
      title: "人工补充 sku_code_missing 重试说明",
      scope: "人工修订/库存同步",
      problem: "人工补充：sku_code_missing 重复出现时仍按模板列缺失处理。",
      solution: "人工补充：确认模板含 sku_code 列，刷新旧任务后重新上传。",
      tags: "库存同步, sku_code_missing, 人工补充",
      reviewer: "joint-regression",
      reviewNote: "验证更新已有知识而不是新增文件。",
    });
    assert.equal(updatedExisting.body.ok, true);
    assert.equal(updatedExisting.body.candidate.status, "updated_existing");
    assert.ok(fs.existsSync(updatedExisting.body.candidate.updatedExistingPath));
    const updatedMarkdown = fs.readFileSync(updatedExisting.body.candidate.updatedExistingPath, "utf8");
    assert.match(updatedMarkdown, /## 人工审核补充：人工补充 sku_code_missing 重试说明/);
    assert.match(updatedMarkdown, /验证更新已有知识而不是新增文件/);

    const localKnowledge = await requestJson("GET", `${app.baseUrl}/flowbot/agent/knowledge?source=local&limit=5&q=${encodeURIComponent("库存同步 sku_code_missing 标准模板")}`);
    assert.equal(localKnowledge.body.docs[0].source, "local");
    assert.match(localKnowledge.body.docs[0].title, /库存同步.*sku_code_missing/);
  } finally {
    await terminateProcess(app.child);
    await mock.close();
    fs.rmSync(app.root, { recursive: true, force: true });
  }
});
