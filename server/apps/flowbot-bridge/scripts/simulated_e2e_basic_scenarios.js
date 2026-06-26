"use strict";

const { buildImageCallback, buildTextCallback } = require("./simulated_e2e_callbacks");
const { waitFor } = require("./simulated_e2e_http");
const { contextContains, findObservation } = require("./simulated_e2e_llm_helpers");
const { countTasksByStatus, readTaskState } = require("./simulated_e2e_task_state");

async function runBasicSimulatedScenarios({
  assertStableCounts,
  dataDir,
  nowSec,
  postCallback,
  scenarioResults,
  state,
  waitForReplyCount,
}) {
  await postCallback(buildTextCallback({
    seq: 1,
    id: "msg-text-1",
    sender: "user-1",
    senderName: "张三",
    content: "小智你好。你今天心情如何？",
    sendtime: nowSec,
  }), "text_wake");
  await waitForReplyCount(1, "text_reply_sent");
  scenarioResults.textWake = {
    reply: state.upstreamSendTextCalls[0]?.body?.content || "",
    ok: state.upstreamSendTextCalls[0]?.body?.content === "你好呀，我今天心情不错。",
  };

  await postCallback(buildImageCallback({
    seq: 2,
    id: "msg-image-seed-1",
    sender: "user-1",
    senderName: "张三",
    sendtime: nowSec + 1,
  }), "image_seed");
  await postCallback(buildTextCallback({
    seq: 3,
    id: "msg-image-ask-1",
    sender: "user-1",
    senderName: "张三",
    content: "小智，这个图在说什么？",
    sendtime: nowSec + 2,
  }), "image_question");
  await waitForReplyCount(2, "image_reply_sent");
  scenarioResults.imageFollowUp = {
    reply: state.upstreamSendTextCalls[1]?.body?.content || "",
    ok: state.upstreamSendTextCalls[1]?.body?.content === "我看到了，这是一张模拟测试图片。",
  };
  await sleep(400);

  const nonWakeReplyCount = state.upstreamSendTextCalls.length;
  const nonWakeLlmCount = state.llmRequests.length;
  await postCallback(buildTextCallback({
    seq: 4,
    id: "msg-nonwake-1",
    sender: "user-2",
    senderName: "李四",
    content: "11:30 会停服更新，大家先关注一下公告。",
    sendtime: nowSec + 3,
  }), "nonwake_notice");
  await assertStableCounts({
    replyCount: nonWakeReplyCount,
    llmCount: nonWakeLlmCount,
    waitMs: 1200,
    label: "nonwake_notice",
  });
  scenarioResults.nonWakeIgnored = {
    replyCountStable: state.upstreamSendTextCalls.length === nonWakeReplyCount,
    llmCountStable: state.llmRequests.length === nonWakeLlmCount,
  };

  await postCallback(buildTextCallback({
    seq: 5,
    id: "msg-ctx-1",
    sender: "user-1",
    senderName: "张三",
    content: "登录页报 502 了。",
    sendtime: nowSec + 4,
  }), "context_msg_1");
  await postCallback(buildTextCallback({
    seq: 6,
    id: "msg-ctx-2",
    sender: "user-2",
    senderName: "李四",
    content: "我这边下单也卡住了。",
    sendtime: nowSec + 5,
  }), "context_msg_2");
  await postCallback(buildTextCallback({
    seq: 7,
    id: "msg-ctx-3",
    sender: "user-3",
    senderName: "王五",
    content: "中午吃啥？",
    sendtime: nowSec + 6,
  }), "context_msg_3");
  await postCallback(buildTextCallback({
    seq: 8,
    id: "msg-ctx-ask-1",
    sender: "user-1",
    senderName: "张三",
    content: "小智，结合上面看下是什么问题。",
    sendtime: nowSec + 7,
  }), "context_question");
  await waitForReplyCount(3, "context_reply_sent");
  const complexObservation = findObservation(state.toolObservations, "小智，结合上面看下是什么问题。");
  scenarioResults.multiUserContext = {
    reply: state.upstreamSendTextCalls[2]?.body?.content || "",
    sawZhangsan: Boolean(complexObservation && contextContains(complexObservation.contextItems, "张三")),
    sawLisi: Boolean(complexObservation && contextContains(complexObservation.contextItems, "李四")),
    saw502: Boolean(complexObservation && contextContains(complexObservation.contextItems, "登录页报 502")),
    sawOrderBlocked: Boolean(complexObservation && contextContains(complexObservation.contextItems, "下单也卡住")),
  };

  const namedMentionTaskStateBefore = readTaskState(dataDir);
  const ignoredBefore = countTasksByStatus(namedMentionTaskStateBefore, "ignored");
  const noReplyCountBefore = state.upstreamSendTextCalls.length;
  await postCallback(buildTextCallback({
    seq: 9,
    id: "msg-name-review-1",
    sender: "user-2",
    senderName: "李四",
    content: "我记得上次小智这个机器人说过这个问题。",
    sendtime: nowSec + 8,
  }), "named_but_not_wake");
  await waitFor(
    async () => countTasksByStatus(readTaskState(dataDir), "ignored") >= ignoredBefore + 1,
    15000,
    "named_but_not_wake_ignored",
  );
  scenarioResults.namedMentionButNoWake = {
    ignoredTaskRaised: countTasksByStatus(readTaskState(dataDir), "ignored") >= ignoredBefore + 1,
    noExtraReply: state.upstreamSendTextCalls.length === noReplyCountBefore,
  };

  await postCallback(buildTextCallback({
    seq: 10,
    id: "msg-rapid-wake-1",
    sender: "user-3",
    senderName: "王五",
    content: "小智，云发单是干啥的？",
    sendtime: nowSec + 9,
  }), "rapid_wake_1");
  await postCallback(buildTextCallback({
    seq: 11,
    id: "msg-rapid-wake-2",
    sender: "user-4",
    senderName: "赵六",
    content: "@小智 你觉得这次是不是停服导致的？",
    sendtime: nowSec + 10,
    atList: ["小智"],
  }), "rapid_wake_2");
  await waitForReplyCount(5, "rapid_wakes_replied");
  scenarioResults.rapidMultiUserWakes = {
    firstReply: state.upstreamSendTextCalls[3]?.body?.content || "",
    secondReply: state.upstreamSendTextCalls[4]?.body?.content || "",
    ok: (() => {
      const replies = [
        state.upstreamSendTextCalls[3]?.body?.content || "",
        state.upstreamSendTextCalls[4]?.body?.content || "",
      ];
      return (
        replies.includes("云发单主要是做发圈、发群和转链等场景的业务工具。")
        && replies.includes("大概率和停服或上游异常有关，建议先核对当时的停服公告和服务状态。")
      );
    })(),
  };


}

module.exports = {
  runBasicSimulatedScenarios,
};
