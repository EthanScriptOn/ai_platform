"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildImageCallback, buildTextCallback } = require("./simulated_e2e_callbacks");
const { runBasicSimulatedScenarios } = require("./simulated_e2e_basic_scenarios");
const { runMultimodalSimulatedScenarios } = require("./simulated_e2e_multimodal_scenarios");
const { createServer, requestJson, sleep, spawnProcess, terminateProcess, waitFor } = require("./simulated_e2e_http");
const { contextContains, findLatestObservation, findObservation } = require("./simulated_e2e_llm_helpers");
const { EXTRA_INTERLEAVED_MESSAGES, LONG_BURST_MESSAGES, VAGUE_TAIL_MESSAGES } = require("./simulated_e2e_fixtures");
const { handleSimulatedE2eError } = require("./simulated_e2e_error_reporter");
const { createSimulatedMockServers } = require("./simulated_e2e_mock_servers");
const { buildSimulatedE2eResult } = require("./simulated_e2e_result");
const { countTasksByStatus, readTaskState } = require("./simulated_e2e_task_state");

const DEBUG = {};

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const serverScript = path.resolve(repoRoot, "server.js");
  const workerScript = path.resolve(__dirname, "agent_task_worker.js");

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-sim-"));
  const dataDir = path.join(sandboxRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  DEBUG.sandboxRoot = sandboxRoot;
  DEBUG.dataDir = dataDir;

  const state = {
    upstreamSendTextCalls: [],
    llmRequests: [],
    sawTriggerImage: false,
    sawToolVisionImage: false,
    toolObservations: [],
  };
  DEBUG.state = state;

  const { upstream, llm } = await createSimulatedMockServers(state);

  const flowbotPort = await (async () => {
    const probe = await createServer((req, res) => {
      res.writeHead(204);
      res.end();
    });
    const port = probe.port;
    await new Promise((resolve) => probe.server.close(resolve));
    return port;
  })();

  const commonEnv = {
    ...process.env,
    PORT: String(flowbotPort),
    FLOWBOT_DATA_DIR: dataDir,
    FLOWBOT_TARGET_ROOM_IDS: "room-sim-1",
    FLOWBOT_ARCHIVE_ENABLED: "0",
    FLOWBOT_BATCH_MODE_ENABLED: "0",
    FLOWBOT_AGENT_LANE_ENABLED: "1",
    FLOWBOT_AGENT_WAKE_NAMES: "小智",
    FLOWBOT_AGENT_SESSION_KEY_STRATEGY: process.env.FLOWBOT_AGENT_SESSION_KEY_STRATEGY || "wake",
    FLOWBOT_DASHBOARD_PUBLIC_URL: `http://127.0.0.1:${flowbotPort}`,
    FLOWBOT_UPSTREAM_WECOM_API_BASE: upstream.baseUrl,
    FLOWBOT_CDN_DOWNLOAD_ENDPOINT: `${upstream.baseUrl}/cloud/cdn_c2c_download`,
    FLOWBOT_TRANSCRIBE_ENABLED: "0",
    FLOWBOT_LLM_CLASSIFY_ENABLED: "0",
    FLOWBOT_LLM_API_URL: llm.baseUrl,
    FLOWBOT_LLM_API_KEY: "test-key",
    FLOWBOT_LLM_MODEL: "qwen3.6-plus",
    FLOWBOT_LLM_TIMEOUT_MS: "10000",
  };

  const flowbotProc = spawnProcess(
    "flowbot",
    process.execPath,
    [serverScript],
    {
      cwd: repoRoot,
      env: commonEnv,
    },
  );

  const workerProc = spawnProcess(
    "worker",
    process.execPath,
    [workerScript],
    {
      cwd: repoRoot,
      env: {
        ...commonEnv,
        FLOWBOT_AGENT_BASE_URL: `http://127.0.0.1:${flowbotPort}/flowbot/agent`,
        FLOWBOT_AGENT_HANDLER: "sim-worker",
        FLOWBOT_AGENT_POLL_INTERVAL_MS: "200",
        FLOWBOT_AGENT_MAX_CONCURRENCY: "1",
        FLOWBOT_LLM_SUPPORTS_VISION: "1",
        FLOWBOT_LLM_IMAGE_TRANSPORT: "image_url",
        FLOWBOT_LLM_MAX_IMAGES: "2",
      },
    },
  );

  const callbackUrl = `http://127.0.0.1:${flowbotPort}/flowbot/callback`;
  DEBUG.callbackUrl = callbackUrl;
  DEBUG.flowbotLogs = flowbotProc.logs;
  DEBUG.workerLogs = workerProc.logs;

  async function postCallback(callback, label) {
    const accepted = await requestJson("POST", callbackUrl, callback, 10000);
    if (!accepted.accepted) {
      throw new Error(`${label}_callback_rejected:${JSON.stringify(accepted)}`);
    }
    return accepted;
  }

  async function waitForReplyCount(count, label) {
    await waitFor(
      async () => state.upstreamSendTextCalls.length >= count,
      15000,
      label,
    );
  }

  async function assertStableCounts({
    replyCount,
    llmCount,
    waitMs,
    label,
  }) {
    await sleep(waitMs);
    if (state.upstreamSendTextCalls.length !== replyCount) {
      throw new Error(`${label}_unexpected_reply_growth:${state.upstreamSendTextCalls.length}:${replyCount}`);
    }
    if (state.llmRequests.length !== llmCount) {
      throw new Error(`${label}_unexpected_llm_growth:${state.llmRequests.length}:${llmCount}`);
    }
  }

  try {
    await waitFor(async () => {
      try {
        const result = await requestJson(
          "GET",
          `http://127.0.0.1:${flowbotPort}/flowbot/dashboard/data?limit=1`,
          null,
          5000,
        );
        return result?.generatedAt ? true : false;
      } catch {
        return false;
      }
    }, 15000, "flowbot_http_ready");

    await sleep(500);

    const nowSec = Math.floor(Date.now() / 1000);
    const scenarioResults = {};

    await runBasicSimulatedScenarios({
      assertStableCounts,
      dataDir,
      nowSec,
      postCallback,
      scenarioResults,
      state,
      waitForReplyCount,
    });

    await postCallback(buildTextCallback({
      seq: 12,
      id: "msg-long-1",
      sender: "user-1",
      senderName: "张三",
      content: "支付回调失败了，用户付款后没有进入成功页。",
      sendtime: nowSec + 11,
    }), "long_ctx_1");
    await postCallback(buildTextCallback({
      seq: 13,
      id: "msg-long-2",
      sender: "user-2",
      senderName: "李四",
      content: "我这边看到订单状态没更新。",
      sendtime: nowSec + 12,
    }), "long_ctx_2");
    await postCallback(buildTextCallback({
      seq: 14,
      id: "msg-long-3",
      sender: "user-5",
      senderName: "孙七",
      content: "先记录一下 affected 商户有三家。",
      sendtime: nowSec + 13,
    }), "long_ctx_3");
    await postCallback(buildTextCallback({
      seq: 15,
      id: "msg-long-4",
      sender: "user-3",
      senderName: "王五",
      content: "我这边售后消息也没推送。",
      sendtime: nowSec + 14,
    }), "long_ctx_4");
    await postCallback(buildTextCallback({
      seq: 16,
      id: "msg-long-5",
      sender: "user-4",
      senderName: "赵六",
      content: "谁点奶茶？",
      sendtime: nowSec + 15,
    }), "long_ctx_5");
    await postCallback(buildTextCallback({
      seq: 17,
      id: "msg-long-6",
      sender: "user-1",
      senderName: "张三",
      content: "日志里看到 callback timeout。",
      sendtime: nowSec + 16,
    }), "long_ctx_6");
    await postCallback(buildTextCallback({
      seq: 18,
      id: "msg-long-7",
      sender: "user-2",
      senderName: "李四",
      content: "有些订单 5 分钟后也没自动恢复。",
      sendtime: nowSec + 17,
    }), "long_ctx_7");
    await postCallback(buildTextCallback({
      seq: 19,
      id: "msg-long-8",
      sender: "user-5",
      senderName: "孙七",
      content: "财务说退款单量也在涨。",
      sendtime: nowSec + 18,
    }), "long_ctx_8");
    await postCallback(buildTextCallback({
      seq: 20,
      id: "msg-long-9",
      sender: "user-3",
      senderName: "王五",
      content: "刚刚又来了一波用户反馈。",
      sendtime: nowSec + 19,
    }), "long_ctx_9");
    await postCallback(buildTextCallback({
      seq: 21,
      id: "msg-long-10",
      sender: "user-1",
      senderName: "张三",
      content: "小智，基于前面这二十多条消息，帮我总结一下当前主问题和影响。",
      sendtime: nowSec + 20,
    }), "long_ctx_ask");
    await waitForReplyCount(6, "long_dialog_reply_sent");
    const longObservation = findObservation(
      state.toolObservations,
      "小智，基于前面这二十多条消息，帮我总结一下当前主问题和影响。",
    );
    scenarioResults.longDialogueSummary = {
      reply: state.upstreamSendTextCalls[5]?.body?.content || "",
      sawCallbackFail: Boolean(longObservation && contextContains(longObservation.contextItems, "支付回调失败")),
      sawOrderNotUpdated: Boolean(longObservation && contextContains(longObservation.contextItems, "订单状态没更新")),
      sawAfterSale: Boolean(longObservation && contextContains(longObservation.contextItems, "售后消息也没推送")),
      contextItemCount: Array.isArray(longObservation?.contextItems) ? longObservation.contextItems.length : 0,
    };

    await postCallback(buildTextCallback({
      seq: 22,
      id: "msg-switch-1",
      sender: "user-6",
      senderName: "周八",
      content: "素材群发不出去，已经卡了十分钟。",
      sendtime: nowSec + 21,
    }), "switch_ctx_1");
    await postCallback(buildTextCallback({
      seq: 23,
      id: "msg-switch-2",
      sender: "user-7",
      senderName: "吴九",
      content: "我这里是图片发出去了但是文字没带上。",
      sendtime: nowSec + 22,
    }), "switch_ctx_2");
    await postCallback(buildTextCallback({
      seq: 24,
      id: "msg-switch-3",
      sender: "user-4",
      senderName: "赵六",
      content: "下午谁去开会？",
      sendtime: nowSec + 23,
    }), "switch_ctx_3");
    await postCallback(buildTextCallback({
      seq: 25,
      id: "msg-switch-4",
      sender: "user-6",
      senderName: "周八",
      content: "@小智 刚才这个问题你怎么看？",
      sendtime: nowSec + 24,
      atList: ["小智"],
    }), "switch_ctx_ask");
    await waitForReplyCount(7, "switch_topic_reply_sent");
    const switchObservation = findObservation(
      state.toolObservations,
      "@小智 刚才这个问题你怎么看？",
    );
    scenarioResults.multiUserSameTopicWithNoise = {
      reply: state.upstreamSendTextCalls[6]?.body?.content || "",
      sawMaterialIssue: Boolean(switchObservation && contextContains(switchObservation.contextItems, "素材群发不出去")),
      sawTextMissing: Boolean(switchObservation && contextContains(switchObservation.contextItems, "图片发出去了但是文字没带上")),
      sawNoise: Boolean(switchObservation && contextContains(switchObservation.contextItems, "下午谁去开会")),
    };

    const otherRoomReplyCountBefore = state.upstreamSendTextCalls.length;
    const otherRoomLlmCountBefore = state.llmRequests.length;
    const room2Response = await requestJson("POST", callbackUrl, buildTextCallback({
      seq: 26,
      id: "msg-room2-1",
      sender: "user-8",
      senderName: "钱十",
      content: "小智，你能看到这个群里的消息吗？",
      sendtime: nowSec + 25,
      roomId: "room-sim-2",
      roomName: "未放行群",
    }), 10000);
    await assertStableCounts({
      replyCount: otherRoomReplyCountBefore,
      llmCount: otherRoomLlmCountBefore,
      waitMs: 1200,
      label: "room2_blocked",
    });
    scenarioResults.otherRoomBlocked = {
      callbackAccepted: Boolean(room2Response?.accepted),
      replyCountStable: state.upstreamSendTextCalls.length === otherRoomReplyCountBefore,
      llmCountStable: state.llmRequests.length === otherRoomLlmCountBefore,
    };

    let seqCursor = 27;
    const longBurstMessages = LONG_BURST_MESSAGES;
    for (const [sender, senderName, content] of longBurstMessages) {
      await postCallback(buildTextCallback({
        seq: seqCursor,
        id: `msg-burst-${seqCursor}`,
        sender,
        senderName,
        content,
        sendtime: nowSec + seqCursor - 1,
      }), `burst_${seqCursor}`);
      seqCursor += 1;
    }
    await postCallback(buildTextCallback({
      seq: seqCursor,
      id: `msg-burst-${seqCursor}`,
      sender: "user-1",
      senderName: "张三",
      content: "小智，按前面四十条消息总结一下主问题、扩散点和当前影响。",
      sendtime: nowSec + seqCursor - 1,
    }), "burst_summary_ask");
    await waitForReplyCount(8, "burst_summary_reply_sent");
    const burstObservation = findObservation(
      state.toolObservations,
      "小智，按前面四十条消息总结一下主问题、扩散点和当前影响。",
    );
    scenarioResults.veryLongBurstSummary = {
      reply: state.upstreamSendTextCalls[7]?.body?.content || "",
      sawSignatureFail: Boolean(burstObservation && contextContains(burstObservation.contextItems, "回调签名校验失败")),
      sawRetryBacklog: Boolean(burstObservation && contextContains(burstObservation.contextItems, "重试队列积压")),
      sawWecomNotify: Boolean(burstObservation && contextContains(burstObservation.contextItems, "企微通知没发出")),
      contextItemCount: Array.isArray(burstObservation?.contextItems) ? burstObservation.contextItems.length : 0,
    };

    await postCallback(buildTextCallback({
      seq: seqCursor + 1,
      id: `msg-memory-${seqCursor + 1}`,
      sender: "user-2",
      senderName: "李四",
      content: "小智，回到前面支付回调那个问题，现在最核心的异常到底是什么？",
      sendtime: nowSec + seqCursor,
    }), "memory_recall_ask");
    await waitForReplyCount(9, "memory_recall_reply_sent");
    const memoryObservation = findLatestObservation(
      state.toolObservations,
      "小智，回到前面支付回调那个问题，现在最核心的异常到底是什么？",
    );
    scenarioResults.oldQuestionRecall = {
      reply: state.upstreamSendTextCalls[8]?.body?.content || "",
      sawCallbackFail: Boolean(memoryObservation && contextContains(memoryObservation.contextItems, "支付回调失败")),
      sawOrderNotUpdated: Boolean(memoryObservation && contextContains(memoryObservation.contextItems, "订单状态没更新")),
      sawAfterSale: Boolean(memoryObservation && contextContains(memoryObservation.contextItems, "售后消息也没推送")),
      contextItemCount: Array.isArray(memoryObservation?.contextItems) ? memoryObservation.contextItems.length : 0,
      precise: (
        state.upstreamSendTextCalls[8]?.body?.content === "回到前面那个支付回调问题，最核心的异常仍然是支付回调失败，并且已经影响订单状态更新和售后消息推送。"
      ),
    };
    await sleep(400);

    const followUpReplyCountBefore = state.upstreamSendTextCalls.length;
    const followUpLlmCountBefore = state.llmRequests.length;
    await postCallback(buildTextCallback({
      seq: seqCursor + 2,
      id: `msg-followup-${seqCursor + 2}`,
      sender: "user-2",
      senderName: "李四",
      content: "那这个要怎么处理？",
      sendtime: nowSec + seqCursor + 1,
    }), "nonwake_follow_up");
    await assertStableCounts({
      replyCount: followUpReplyCountBefore,
      llmCount: followUpLlmCountBefore,
      waitMs: 1200,
      label: "nonwake_follow_up",
    });
    scenarioResults.followUpWithoutWakeIgnored = {
      replyCountStable: state.upstreamSendTextCalls.length === followUpReplyCountBefore,
      llmCountStable: state.llmRequests.length === followUpLlmCountBefore,
    };

    await postCallback(buildTextCallback({
      seq: seqCursor + 3,
      id: `msg-clarify-seed-${seqCursor + 3}`,
      sender: "user-10",
      senderName: "郑十",
      content: "这边有点怪，但我还没整理清楚。",
      sendtime: nowSec + seqCursor + 2,
    }), "clarify_seed");
    await postCallback(buildTextCallback({
      seq: seqCursor + 4,
      id: `msg-clarify-ask-${seqCursor + 4}`,
      sender: "user-10",
      senderName: "郑十",
      content: "小智，这个情况你怎么看？",
      sendtime: nowSec + seqCursor + 3,
    }), "clarify_ask");
    await waitForReplyCount(10, "clarify_reply_sent");
    const clarifyObservation = findLatestObservation(
      state.toolObservations,
      "小智，这个情况你怎么看？",
    );
    scenarioResults.insufficientInfoClarify = {
      reply: state.upstreamSendTextCalls[9]?.body?.content || "",
      sawOnlyVagueContext: Boolean(clarifyObservation && contextContains(clarifyObservation.contextItems, "有点怪")),
      askedClarify: state.upstreamSendTextCalls[9]?.body?.content === "我先介入，但还缺一个关键信息：请补一下具体报错、影响现象或截图，我再继续判断。",
    };

    await postCallback(buildTextCallback({
      seq: seqCursor + 5,
      id: `msg-ambiguous-1-${seqCursor + 5}`,
      sender: "user-1",
      senderName: "张三",
      content: "支付回调失败那个事今天又出现一次了。",
      sendtime: nowSec + seqCursor + 4,
    }), "ambiguous_old_1");
    await postCallback(buildTextCallback({
      seq: seqCursor + 6,
      id: `msg-ambiguous-2-${seqCursor + 6}`,
      sender: "user-6",
      senderName: "周八",
      content: "素材群发的文字丢失问题也还在。",
      sendtime: nowSec + seqCursor + 5,
    }), "ambiguous_old_2");
    await postCallback(buildTextCallback({
      seq: seqCursor + 7,
      id: `msg-ambiguous-ask-${seqCursor + 7}`,
      sender: "user-3",
      senderName: "王五",
      content: "小智，回到前面那个问题，你觉得根因是啥？",
      sendtime: nowSec + seqCursor + 6,
    }), "ambiguous_old_ask");
    await waitForReplyCount(11, "ambiguous_old_reply_sent");
    const ambiguousObservation = findLatestObservation(
      state.toolObservations,
      "小智，回到前面那个问题，你觉得根因是啥？",
    );
    scenarioResults.ambiguousOldTopicCandidates = {
      reply: state.upstreamSendTextCalls[10]?.body?.content || "",
      sawPaymentTopic: Boolean(ambiguousObservation && contextContains(ambiguousObservation.contextItems, "支付回调失败")),
      sawMaterialTopic: Boolean(ambiguousObservation && contextContains(ambiguousObservation.contextItems, "素材群发")),
      offeredCandidates: (
        (state.upstreamSendTextCalls[10]?.body?.content || "").includes("1. 支付回调失败")
        && (state.upstreamSendTextCalls[10]?.body?.content || "").includes("2. 素材群发异常")
      ),
    };

    await postCallback(buildTextCallback({
      seq: seqCursor + 8,
      id: `msg-sender-scope-1-${seqCursor + 8}`,
      sender: "user-8",
      senderName: "钱十一",
      content: "库存同步失败了，门店库存没有回写过来。",
      sendtime: nowSec + seqCursor + 7,
    }), "sender_scope_1");
    await postCallback(buildTextCallback({
      seq: seqCursor + 9,
      id: `msg-sender-scope-2-${seqCursor + 9}`,
      sender: "user-8",
      senderName: "钱十一",
      content: "ERP 回写延迟已经十几分钟了，而且同步队列积压。",
      sendtime: nowSec + seqCursor + 8,
    }), "sender_scope_2");
    await postCallback(buildTextCallback({
      seq: seqCursor + 10,
      id: `msg-sender-scope-3-${seqCursor + 10}`,
      sender: "user-9",
      senderName: "冯十二",
      content: "登录页样式有点错位，不过不影响下单。",
      sendtime: nowSec + seqCursor + 9,
    }), "sender_scope_3");
    await postCallback(buildTextCallback({
      seq: seqCursor + 11,
      id: `msg-sender-scope-ask-${seqCursor + 11}`,
      sender: "user-8",
      senderName: "钱十一",
      content: "小智，回到我前面那个问题，库存同步现在最可能卡在哪？",
      sendtime: nowSec + seqCursor + 10,
    }), "sender_scope_ask");
    await waitForReplyCount(12, "sender_scope_reply_sent");
    const senderScopeObservation = findLatestObservation(
      state.toolObservations,
      "小智，回到我前面那个问题，库存同步现在最可能卡在哪？",
    );
    scenarioResults.sameSenderScopedRecall = {
      reply: state.upstreamSendTextCalls[11]?.body?.content || "",
      sawInventoryIssue: Boolean(senderScopeObservation && contextContains(senderScopeObservation.contextItems, "库存同步失败")),
      sawErpDelay: Boolean(senderScopeObservation && contextContains(senderScopeObservation.contextItems, "ERP 回写延迟")),
      sawQueueBacklog: Boolean(senderScopeObservation && contextContains(senderScopeObservation.contextItems, "同步队列积压")),
      precise: state.upstreamSendTextCalls[11]?.body?.content === "回到你前面那个库存同步问题，更像是 ERP 回写或消费链路卡住了，建议先查同步队列和重试日志。",
    };

    await postCallback(buildTextCallback({
      seq: seqCursor + 12,
      id: `msg-candidate-pick-${seqCursor + 12}`,
      sender: "user-3",
      senderName: "王五",
      content: "小智，第一个，就是支付回调那个。",
      sendtime: nowSec + seqCursor + 11,
    }), "candidate_pick");
    await waitForReplyCount(13, "candidate_pick_reply_sent");
    const candidatePickObservation = findLatestObservation(
      state.toolObservations,
      "小智，第一个，就是支付回调那个。",
    );
    scenarioResults.candidateSelectionContinuation = {
      reply: state.upstreamSendTextCalls[12]?.body?.content || "",
      sawPaymentTopic: Boolean(candidatePickObservation && contextContains(candidatePickObservation.contextItems, "支付回调失败")),
      precise: state.upstreamSendTextCalls[12]?.body?.content === "如果你说的是第一个，也就是支付回调问题，那当前最核心的还是回调链路失败，并且已经影响订单状态更新和售后消息推送。",
    };

    const extraInterleavedMessages = EXTRA_INTERLEAVED_MESSAGES;
    let extraSeq = seqCursor + 13;
    for (const [sender, senderName, content] of extraInterleavedMessages) {
      await postCallback(buildTextCallback({
        seq: extraSeq,
        id: `msg-extra-${extraSeq}`,
        sender,
        senderName,
        content,
        sendtime: nowSec + extraSeq - 1,
      }), `extra_interleaved_${extraSeq}`);
      extraSeq += 1;
    }
    await postCallback(buildTextCallback({
      seq: extraSeq,
      id: `msg-extra-ask-${extraSeq}`,
      sender: "user-2",
      senderName: "李四",
      content: "小智，跨了这么多轮，单说支付回调那条，现在一句话告诉我根因。",
      sendtime: nowSec + extraSeq - 1,
    }), "deep_payment_recall");
    await waitForReplyCount(14, "deep_payment_recall_reply_sent");
    const deepRecallObservation = findLatestObservation(
      state.toolObservations,
      "小智，跨了这么多轮，单说支付回调那条，现在一句话告诉我根因。",
    );
    scenarioResults.deepInterleavedSpecificRecall = {
      reply: state.upstreamSendTextCalls[13]?.body?.content || "",
      sawCallbackFail: Boolean(deepRecallObservation && contextContains(deepRecallObservation.contextItems, "支付回调失败")),
      sawOrderNotUpdated: Boolean(deepRecallObservation && contextContains(deepRecallObservation.contextItems, "订单状态没更新")),
      sawAfterSale: Boolean(deepRecallObservation && contextContains(deepRecallObservation.contextItems, "售后消息也没推送")),
      precise: state.upstreamSendTextCalls[13]?.body?.content === "单说支付回调这条，根因仍然更像回调链路失败或超时，已经影响订单状态更新和售后消息推送。",
    };

    await postCallback(buildTextCallback({
      seq: extraSeq + 1,
      id: `msg-material-owner-1-${extraSeq + 1}`,
      sender: "user-6",
      senderName: "周八",
      content: "素材群发还是发不出去，我这边继续跟进。",
      sendtime: nowSec + extraSeq,
    }), "material_owner_1");
    await postCallback(buildTextCallback({
      seq: extraSeq + 2,
      id: `msg-material-owner-2-${extraSeq + 2}`,
      sender: "user-6",
      senderName: "周八",
      content: "有些群是图片发出去了但文案丢失。",
      sendtime: nowSec + extraSeq + 1,
    }), "material_owner_2");
    await postCallback(buildTextCallback({
      seq: extraSeq + 3,
      id: `msg-material-owner-3-${extraSeq + 3}`,
      sender: "user-8",
      senderName: "钱十一",
      content: "库存同步队列现在也还没清掉。",
      sendtime: nowSec + extraSeq + 2,
    }), "material_owner_3");
    await postCallback(buildTextCallback({
      seq: extraSeq + 4,
      id: `msg-material-owner-ask-${extraSeq + 4}`,
      sender: "user-6",
      senderName: "周八",
      content: "小智，我说的那个素材问题直接给结论。",
      sendtime: nowSec + extraSeq + 3,
    }), "material_owner_ask");
    await waitForReplyCount(15, "material_owner_reply_sent");
    const materialOwnerObservation = findLatestObservation(
      state.toolObservations,
      "小智，我说的那个素材问题直接给结论。",
    );
    scenarioResults.crossUserWakeIsolation = {
      reply: state.upstreamSendTextCalls[14]?.body?.content || "",
      sawMaterialIssue: Boolean(materialOwnerObservation && contextContains(materialOwnerObservation.contextItems, "素材群发")),
      sawCopyLoss: Boolean(materialOwnerObservation && contextContains(materialOwnerObservation.contextItems, "文案丢失")),
      avoidedInventoryBias: !(state.upstreamSendTextCalls[14]?.body?.content || "").includes("库存"),
      precise: state.upstreamSendTextCalls[14]?.body?.content === "如果回到你说的素材问题，当前更像是素材群发链路或文案拼装异常，优先查群发任务和素材渲染。",
    };

    await postCallback(buildTextCallback({
      seq: extraSeq + 5,
      id: `msg-dual-1-${extraSeq + 5}`,
      sender: "user-11",
      senderName: "顾十三",
      content: "小智，支付回调失败这个问题你先给个排查方向。",
      sendtime: nowSec + extraSeq + 4,
    }), "dual_user_payment_first");
    await postCallback(buildTextCallback({
      seq: extraSeq + 6,
      id: `msg-dual-2-${extraSeq + 6}`,
      sender: "user-12",
      senderName: "韩十四",
      content: "@小智 素材群发文字丢失这个问题先看哪里？",
      sendtime: nowSec + extraSeq + 5,
      atList: ["小智"],
    }), "dual_user_material_first");
    await waitForReplyCount(17, "dual_users_first_round_reply_sent");

    await postCallback(buildTextCallback({
      seq: extraSeq + 7,
      id: `msg-dual-3-${extraSeq + 7}`,
      sender: "user-11",
      senderName: "顾十三",
      content: "小智，我这边那个回调问题现在优先查哪里？",
      sendtime: nowSec + extraSeq + 6,
    }), "dual_user_payment_second");
    await postCallback(buildTextCallback({
      seq: extraSeq + 8,
      id: `msg-dual-4-${extraSeq + 8}`,
      sender: "user-12",
      senderName: "韩十四",
      content: "小智，我这边那个素材问题现在优先看哪里？",
      sendtime: nowSec + extraSeq + 7,
    }), "dual_user_material_second");
    await waitForReplyCount(19, "dual_users_second_round_reply_sent");

    await postCallback(buildTextCallback({
      seq: extraSeq + 9,
      id: `msg-dual-5-${extraSeq + 9}`,
      sender: "user-11",
      senderName: "顾十三",
      content: "小智，那我这个回调问题一句话说根因。",
      sendtime: nowSec + extraSeq + 8,
    }), "dual_user_payment_third");
    await postCallback(buildTextCallback({
      seq: extraSeq + 10,
      id: `msg-dual-6-${extraSeq + 10}`,
      sender: "user-12",
      senderName: "韩十四",
      content: "小智，那我这个素材问题直接给结论。",
      sendtime: nowSec + extraSeq + 9,
    }), "dual_user_material_third");
    await waitForReplyCount(21, "dual_users_third_round_reply_sent");
    const dualPaymentObservation = findLatestObservation(
      state.toolObservations,
      "小智，那我这个回调问题一句话说根因。",
    );
    const dualMaterialObservation = findLatestObservation(
      state.toolObservations,
      "小智，那我这个素材问题直接给结论。",
    );
    const dualReplies = state.upstreamSendTextCalls.slice(15, 21).map((item) => item?.body?.content || "");
    scenarioResults.dualUserExplicitWakeFollowups = {
      replies: dualReplies,
      paymentScoped: Boolean(dualPaymentObservation && contextContains(dualPaymentObservation.contextItems, "支付回调")),
      materialScoped: Boolean(dualMaterialObservation && contextContains(dualMaterialObservation.contextItems, "素材群发")),
      hasPaymentDirection: dualReplies.includes("先查回调网关、超时日志和订单状态回写链路，再确认是否有重试积压。"),
      hasMaterialDirection: dualReplies.includes("先看素材群发任务、文案拼装和发送渲染链路，重点排查图片和文字合并阶段。"),
      hasPaymentFollowup: dualReplies.includes("你这个回调问题现在优先查回调网关、超时日志和订单状态回写，再看是否有重试积压。"),
      hasMaterialFollowup: dualReplies.includes("你这个素材问题现在优先看群发任务、素材渲染和文案拼装链路。"),
      hasPaymentConclusion: dualReplies.includes("你这个回调问题一句话说，还是回调链路失败或超时，已经连带影响订单状态和售后消息。"),
      hasMaterialConclusion: dualReplies.includes("你这个素材问题直接看，还是素材群发链路或文案拼装异常，重点查任务和渲染。"),
    };

    const vagueTailMessages = VAGUE_TAIL_MESSAGES;
    let vagueSeq = extraSeq + 11;
    for (const [sender, senderName, content] of vagueTailMessages) {
      await postCallback(buildTextCallback({
        seq: vagueSeq,
        id: `msg-vague-${vagueSeq}`,
        sender,
        senderName,
        content,
        sendtime: nowSec + vagueSeq - 1,
      }), `vague_tail_${vagueSeq}`);
      vagueSeq += 1;
    }
    await postCallback(buildTextCallback({
      seq: vagueSeq,
      id: `msg-vague-ask-${vagueSeq}`,
      sender: "user-13",
      senderName: "秦十五",
      content: "小智，回到很前面的那个事儿，我只记得好像是回不来，你帮我看下？",
      sendtime: nowSec + vagueSeq - 1,
    }), "vague_old_follow_up");
    await waitForReplyCount(22, "vague_old_follow_up_reply_sent");
    const vagueObservation = findLatestObservation(
      state.toolObservations,
      "小智，回到很前面的那个事儿，我只记得好像是回不来，你帮我看下？",
    );
    scenarioResults.superVagueOldTopicFollowUp = {
      reply: state.upstreamSendTextCalls[21]?.body?.content || "",
      sawPaymentTopic: Boolean(vagueObservation && contextContains(vagueObservation.contextItems, "订单状态没更新")),
      sawInventoryTopic: Boolean(vagueObservation && contextContains(vagueObservation.contextItems, "ERP 回写延迟")),
      sawMaterialTopic: Boolean(vagueObservation && contextContains(vagueObservation.contextItems, "素材群发")),
      offeredCandidates: (
        (state.upstreamSendTextCalls[21]?.body?.content || "").includes("1. 支付回调/订单未更新")
        && (state.upstreamSendTextCalls[21]?.body?.content || "").includes("2. 库存同步/ERP 回写延迟")
        && (state.upstreamSendTextCalls[21]?.body?.content || "").includes("3. 素材群发/文案丢失")
      ),
      noHardAnswer: !(state.upstreamSendTextCalls[21]?.body?.content || "").includes("根因仍然"),
    };

    await postCallback(buildImageCallback({
      seq: vagueSeq + 1,
      id: `msg-mixed-image-${vagueSeq + 1}`,
      sender: "user-14",
      senderName: "沈十六",
      title: "登录页报错截图",
      desc: "打开订单页时异常",
      sendtime: nowSec + vagueSeq,
    }), "mixed_image_seed");
    await postCallback(buildTextCallback({
      seq: vagueSeq + 2,
      id: `msg-mixed-text-${vagueSeq + 2}`,
      sender: "user-14",
      senderName: "沈十六",
      content: "小智，帮我看下刚才这个图对应的是啥问题。",
      sendtime: nowSec + vagueSeq + 1,
    }), "mixed_image_ask");
    await waitForReplyCount(23, "mixed_image_reply_sent");
    await postCallback(buildTextCallback({
      seq: vagueSeq + 3,
      id: `msg-mixed-followup-${vagueSeq + 3}`,
      sender: "user-14",
      senderName: "沈十六",
      content: "用户说报错是订单页一直转圈。",
      sendtime: nowSec + vagueSeq + 2,
    }), "mixed_image_followup");
    await assertStableCounts({
      replyCount: 23,
      llmCount: state.llmRequests.length,
      waitMs: 1200,
      label: "mixed_image_followup_nonwake",
    });
    await postCallback(buildTextCallback({
      seq: vagueSeq + 4,
      id: `msg-mixed-recall-${vagueSeq + 4}`,
      sender: "user-14",
      senderName: "沈十六",
      content: "小智，回到刚才那张图对应的问题，你直接给结论。",
      sendtime: nowSec + vagueSeq + 3,
    }), "mixed_image_recall");
    await waitForReplyCount(24, "mixed_image_recall_reply_sent");
    const mixedRecallObservation = findLatestObservation(
      state.toolObservations,
      "小智，回到刚才那张图对应的问题，你直接给结论。",
    );
    scenarioResults.imageTextOldTopicChain = {
      firstReply: state.upstreamSendTextCalls[22]?.body?.content || "",
      finalReply: state.upstreamSendTextCalls[23]?.body?.content || "",
      sawLogin502: Boolean(mixedRecallObservation && contextContains(mixedRecallObservation.contextItems, "登录页报 502")),
      sawSpin: Boolean(mixedRecallObservation && contextContains(mixedRecallObservation.contextItems, "订单页一直转圈")),
      precise: state.upstreamSendTextCalls[23]?.body?.content === "回到刚才那张图对应的问题，更像是登录或下单页请求异常，优先查网关状态、接口超时和前端重试。",
    };

    await postCallback(buildTextCallback({
      seq: vagueSeq + 5,
      id: `msg-clarify-chain-1-${vagueSeq + 5}`,
      sender: "user-15",
      senderName: "楚十七",
      content: "小智，这个情况你怎么看？",
      sendtime: nowSec + vagueSeq + 4,
    }), "clarify_chain_ask_1");
    await waitForReplyCount(25, "clarify_chain_reply_1");
    await postCallback(buildTextCallback({
      seq: vagueSeq + 6,
      id: `msg-clarify-chain-2-${vagueSeq + 6}`,
      sender: "user-15",
      senderName: "楚十七",
      content: "用户说报错是订单页一直转圈。",
      sendtime: nowSec + vagueSeq + 5,
    }), "clarify_chain_fill");
    await assertStableCounts({
      replyCount: 25,
      llmCount: state.llmRequests.length,
      waitMs: 1200,
      label: "clarify_chain_fill_nonwake",
    });
    await postCallback(buildTextCallback({
      seq: vagueSeq + 7,
      id: `msg-clarify-chain-3-${vagueSeq + 7}`,
      sender: "user-15",
      senderName: "楚十七",
      content: "小智，结合我刚补的内容，继续判断一下。",
      sendtime: nowSec + vagueSeq + 6,
    }), "clarify_chain_ask_2");
    await waitForReplyCount(26, "clarify_chain_reply_2");
    const clarifyChainObservation = findLatestObservation(
      state.toolObservations,
      "小智，结合我刚补的内容，继续判断一下。",
    );
    scenarioResults.clarifyThenContinue = {
      firstReply: state.upstreamSendTextCalls[24]?.body?.content || "",
      secondReply: state.upstreamSendTextCalls[25]?.body?.content || "",
      firstAskedClarify: state.upstreamSendTextCalls[24]?.body?.content === "我先介入，但还缺一个关键信息：请补一下具体报错、影响现象或截图，我再继续判断。",
      sawSpin: Boolean(clarifyChainObservation && contextContains(clarifyChainObservation.contextItems, "订单页一直转圈")),
      precise: state.upstreamSendTextCalls[25]?.body?.content === "结合你刚补的现象，这更像是下单或订单页加载链路卡住了，优先查订单接口耗时、网关超时和前端重试。",
    };

    await runMultimodalSimulatedScenarios({
      nowSec,
      postCallback,
      scenarioResults,
      state,
      vagueSeq,
      waitForReplyCount,
    });

    const result = buildSimulatedE2eResult({
      callbackUrl,
      dataDir,
      flowbotProc,
      llm,
      scenarioResults,
      state,
      upstream,
      workerProc,
    });

    const allOk = Object.values(result.assertions).every(Boolean);
    if (!allOk) {
      throw new Error(`simulated_e2e_assert_failed:${JSON.stringify(result, null, 2)}`);
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.all([
      terminateProcess(workerProc.child),
      terminateProcess(flowbotProc.child),
      new Promise((resolve) => upstream.server.close(resolve)),
      new Promise((resolve) => llm.server.close(resolve)),
    ]);
  }
}

main().catch((error) => {
  handleSimulatedE2eError(error, DEBUG);
  process.exit(1);
});
