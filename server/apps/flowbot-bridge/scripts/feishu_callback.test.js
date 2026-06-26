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

function requestJson(method, target, payload = null) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const body = payload == null ? "" : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        timeout: 5000,
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
          let parsed = null;
          try {
            parsed = raw.trim() ? JSON.parse(raw) : {};
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}:${raw.slice(0, 300)}`));
            return;
          }
          resolve({ statusCode: res.statusCode, body: parsed, raw });
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
    .split(/\r?\n/)
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

async function startFlowbot(env = {}) {
  const port = await findFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-feishu-test-"));
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const logs = [];
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      FLOWBOT_DATA_DIR: dataDir,
      FLOWBOT_BATCH_MODE_ENABLED: "0",
      FLOWBOT_ARCHIVE_ENABLED: "1",
      FLOWBOT_AGENT_LANE_ENABLED: "1",
      FLOWBOT_LLM_CLASSIFY_ENABLED: "0",
      FEISHU_APP_ID: "cli_test_app",
      ...env,
    },
  });
  const collect = (streamName) => (chunk) => {
    for (const line of String(chunk || "").split(/\r?\n/)) {
      if (line.trim()) {
        logs.push(`[${streamName}] ${line}`);
      }
    }
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));

  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const response = await requestJson("GET", `${baseUrl}/health`);
      if (response.statusCode === 200) {
        return { child, dataDir, baseUrl, logs };
      }
    } catch {
      // keep polling until the server is ready
    }
    await sleep(100);
  }
  await terminateProcess(child);
  throw new Error(`server_start_timeout\n${logs.slice(-20).join("\n")}`);
}

function buildFeishuMessage({ eventId, messageId, chatId, text, senderOpenId = "ou_test", mentions = [] }) {
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
        mentions,
      },
    },
  };
}

test("feishu callback returns challenge JSON for URL verification", async () => {
  const app = await startFlowbot({ FEISHU_VERIFICATION_TOKEN: "verify-token" });
  try {
    const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, {
      type: "url_verification",
      token: "verify-token",
      challenge: "challenge-value",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { challenge: "challenge-value" });
  } finally {
    await terminateProcess(app.child);
  }
});

test("feishu message callback normalizes and writes to flowbot message logs", async () => {
  const app = await startFlowbot();
  try {
    const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_test_accept",
      messageId: "om_test_accept",
      chatId: "oc_allowed_room",
      text: "测试1234",
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.accepted, true);
    assert.equal(response.body.reason, "accepted");

    const messages = readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl"));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].sourceIp, "");
    assert.equal(messages[0].roomId, "oc_allowed_room");
    assert.equal(messages[0].id, "om_test_accept");
    assert.equal(messages[0].msgTypeName, "文本");
    assert.equal(messages[0].content, "测试1234");
    assert.equal(messages[0].rawData.source, "feishu");
  } finally {
    await terminateProcess(app.child);
  }
});

test("feishu bot mention wakes the agent even when content uses mention placeholder", async () => {
  const app = await startFlowbot();
  try {
    const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_test_bot_mention",
      messageId: "om_test_bot_mention",
      chatId: "oc_allowed_room",
      text: "@_user_1 你好啊亲",
      mentions: [{
        id: {
          open_id: "ou_bot_open_id",
          union_id: "on_bot_union_id",
        },
        key: "@_user_1",
        name: "collect_bot",
        mentioned_type: "bot",
      }],
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.accepted, true);
    assert.equal(response.body.route.agentTriggered, true);
    assert.equal(response.body.route.routeReason, "explicit_mention");

    const messages = readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl"));
    assert.deepEqual(messages[0].atList, [
      "ou_bot_open_id",
      "on_bot_union_id",
      "@_user_1",
      "collect_bot",
      "cli_test_app",
    ]);
  } finally {
    await terminateProcess(app.child);
  }
});

test("feishu callback uses the dedicated FLOWBOT_FEISHU_TARGET_CHAT_IDS whitelist", async () => {
  const app = await startFlowbot({ FLOWBOT_FEISHU_TARGET_CHAT_IDS: "oc_allowed_room" });
  try {
    const rejected = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_test_reject",
      messageId: "om_test_reject",
      chatId: "oc_blocked_room",
      text: "不应该入库",
    }));
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.body.accepted, false);
    assert.equal(rejected.body.reason, "feishu_chat_id_filtered:oc_blocked_room");

    const accepted = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_test_allowed",
      messageId: "om_test_allowed",
      chatId: "oc_allowed_room",
      text: "允许入库",
    }));
    assert.equal(accepted.body.accepted, true);

    const messages = readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl"));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].roomId, "oc_allowed_room");
    assert.equal(messages[0].content, "允许入库");

    const decisions = readJsonl(path.join(app.dataDir, "flowbot-filter-decisions.jsonl"));
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].accepted, false);
    assert.equal(decisions[0].reason, "feishu_chat_id_filtered:oc_blocked_room");
    assert.equal(decisions[1].accepted, true);
  } finally {
    await terminateProcess(app.child);
  }
});

test("wecom room whitelist does not restrict feishu callbacks", async () => {
  const app = await startFlowbot({ FLOWBOT_TARGET_ROOM_IDS: "wecom_only_room" });
  try {
    const response = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_test_feishu_independent",
      messageId: "om_test_feishu_independent",
      chatId: "oc_any_feishu_room",
      text: "飞书不受企微白名单限制",
    }));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.accepted, true);

    const messages = readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl"));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].roomId, "oc_any_feishu_room");
    assert.equal(messages[0].content, "飞书不受企微白名单限制");
  } finally {
    await terminateProcess(app.child);
  }
});

test("dashboard cleanup_noise closes stale dashboard-only noise without clearing room memory", async () => {
  const app = await startFlowbot();
  try {
    const roomId = "oc_cleanup_room";
    const callback = await requestJson("POST", `${app.baseUrl}/feishu/callback`, buildFeishuMessage({
      eventId: "evt_cleanup",
      messageId: "om_cleanup",
      chatId: roomId,
      text: "清理看板噪音测试",
    }));
    assert.equal(callback.body.accepted, true);

    const oldIso = "2026-01-01T00:00:00.000Z";
    const poolPath = path.join(app.dataDir, "flowbot-message-pool-state.json");
    const poolState = JSON.parse(fs.readFileSync(poolPath, "utf8"));
    poolState.messages[callback.body.traceId] = {
      ...poolState.messages[callback.body.traceId],
      status: "pending",
      sendTimeIso: oldIso,
      updatedAt: oldIso,
    };
    fs.writeFileSync(poolPath, `${JSON.stringify(poolState, null, 2)}\n`, "utf8");

    const taskPath = path.join(app.dataDir, "flowbot-agent-task-state.json");
    fs.writeFileSync(taskPath, `${JSON.stringify({
      version: 1,
      traceToTaskId: {
        [callback.body.traceId]: "agent_cleanup_failed",
      },
      tasks: {
        agent_cleanup_failed: {
          taskId: "agent_cleanup_failed",
          traceId: callback.body.traceId,
          roomId,
          status: "failed",
          sendTimeIso: oldIso,
          updatedAt: oldIso,
          completedAt: oldIso,
          note: "synthetic failure",
        },
      },
    }, null, 2)}\n`, "utf8");

    const before = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?limit=10`);
    assert.ok(before.body.needsAttention.items.some((item) => item.kind === "batch_pending"));
    assert.ok(before.body.needsAttention.items.some((item) => item.kind === "agent_failed"));

    const cleanup = await requestJson("POST", `${app.baseUrl}/flowbot/dashboard/room-action`, {
      roomId: "__all__",
      action: "cleanup_noise",
    });
    assert.equal(cleanup.statusCode, 200);
    assert.equal(cleanup.body.ok, true);
    assert.equal(cleanup.body.result.closedMessagePoolCount, 1);
    assert.equal(cleanup.body.result.removedAgentTaskCount, 1);

    const after = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?limit=10`);
    assert.equal(after.body.needsAttention.items.some((item) => item.kind === "batch_pending"), false);
    assert.equal(after.body.needsAttention.items.some((item) => item.kind === "agent_failed"), false);
    assert.equal(readJsonl(path.join(app.dataDir, "flowbot-room-messages.jsonl")).length, 1);
  } finally {
    await terminateProcess(app.child);
  }
});

test("dashboard dailySummary reports yesterday pilot metrics", async () => {
  const app = await startFlowbot();
  try {
    const initial = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?limit=10`);
    const reportDate = initial.body.dailySummary.date;
    const reportTime = `${reportDate}T12:00:00.000+08:00`;

    fs.appendFileSync(path.join(app.dataDir, "flowbot-callbacks.jsonl"), `${JSON.stringify({
      receivedAt: reportTime,
      jsonBody: {
        data: {
          roomid: "daily_room",
          id: "daily_msg_1",
          content: "日报消息",
        },
      },
    })}\n`, "utf8");
    fs.appendFileSync(path.join(app.dataDir, "flowbot-filter-decisions.jsonl"), `${JSON.stringify({
      receivedAt: reportTime,
      roomId: "daily_room",
      accepted: true,
    })}\n`, "utf8");
    fs.appendFileSync(path.join(app.dataDir, "flowbot-room-messages.jsonl"), `${JSON.stringify({
      traceId: "daily_trace_1",
      receivedAt: reportTime,
      sendTimeIso: reportTime,
      roomId: "daily_room",
      msgType: 2,
      msgTypeName: "文本",
      content: "日报消息",
    })}\n`, "utf8");
    fs.appendFileSync(path.join(app.dataDir, "flowbot-archive-results.jsonl"), `${JSON.stringify({
      receivedAt: reportTime,
      roomId: "daily_room",
      archived: true,
    })}\n`, "utf8");
    fs.writeFileSync(path.join(app.dataDir, "index.json"), `${JSON.stringify({
      version: 1,
      cases: [{
        case_id: "CASE-DAILY-1",
        chat_id: "daily_room",
        summary: "日报 Case",
        created_at: reportTime,
        updated_at: reportTime,
      }],
    }, null, 2)}\n`, "utf8");
    fs.appendFileSync(path.join(app.dataDir, "flowbot-knowledge-candidates.jsonl"), `${JSON.stringify({
      candidateId: "KNOW-DAILY-1",
      roomId: "daily_room",
      status: "pending_review",
      createdAt: reportTime,
      updatedAt: reportTime,
      title: "日报知识候选",
    })}\n`, "utf8");
    fs.appendFileSync(path.join(app.dataDir, "flowbot-knowledge-publish-results.jsonl"), `${JSON.stringify({
      receivedAt: reportTime,
      candidateId: "KNOW-DAILY-1",
      status: "published",
      target: "local",
    })}\n`, "utf8");
    fs.writeFileSync(path.join(app.dataDir, "flowbot-agent-task-state.json"), `${JSON.stringify({
      version: 1,
      traceToTaskId: {},
      tasks: {
        "agent_daily_failed": {
          taskId: "agent_daily_failed",
          roomId: "daily_room",
          status: "failed",
          sendTimeIso: reportTime,
          updatedAt: reportTime,
          completedAt: reportTime,
        },
      },
    }, null, 2)}\n`, "utf8");

    const dashboard = await requestJson("GET", `${app.baseUrl}/flowbot/dashboard/data?limit=10`);
    assert.equal(dashboard.body.dailySummary.date, reportDate);
    assert.equal(dashboard.body.dailySummary.messages.accepted, 1);
    assert.equal(dashboard.body.dailySummary.messages.normalized, 1);
    assert.equal(dashboard.body.dailySummary.cases.created, 1);
    assert.equal(dashboard.body.dailySummary.cases.archivedEvents, 1);
    assert.equal(dashboard.body.dailySummary.knowledge.candidatesCreated, 1);
    assert.equal(dashboard.body.dailySummary.knowledge.published, 1);
    assert.equal(dashboard.body.dailySummary.knowledge.pendingNow, 1);
    assert.equal(dashboard.body.dailySummary.agent.failed, 1);
    assert.ok(dashboard.body.dailySummary.healthNotes.some((item) => /待审核|失败/.test(item)));
  } finally {
    await terminateProcess(app.child);
  }
});
