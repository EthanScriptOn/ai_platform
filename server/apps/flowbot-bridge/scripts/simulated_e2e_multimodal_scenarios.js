"use strict";

const { buildImageCallback, buildTextCallback, buildVoiceCallback } = require("./simulated_e2e_callbacks");
const { contextContains, findLatestObservation } = require("./simulated_e2e_llm_helpers");

async function runMultimodalSimulatedScenarios({
  nowSec,
  postCallback,
  scenarioResults,
  state,
  vagueSeq,
  waitForReplyCount,
}) {
  await postCallback(buildVoiceCallback({
    seq: vagueSeq + 8,
    id: `msg-voice-seed-${vagueSeq + 8}`,
    sender: "user-16",
    senderName: "鲁十八",
    sendtime: nowSec + vagueSeq + 7,
    transcriptText: "支付成功了，但是订单页一直转圈，回不来。",
    transcriptDurationSeconds: 11,
  }), "voice_chain_seed");
  await postCallback(buildImageCallback({
    seq: vagueSeq + 9,
    id: `msg-voice-image-${vagueSeq + 9}`,
    sender: "user-16",
    senderName: "鲁十八",
    sendtime: nowSec + vagueSeq + 8,
    title: "订单页报错截图",
    desc: "打开订单详情页时页面一直加载",
  }), "voice_chain_image");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 10,
    id: `msg-voice-noise-${vagueSeq + 10}`,
    sender: "user-4",
    senderName: "赵六",
    content: "今晚谁去巡检一下机房？",
    sendtime: nowSec + vagueSeq + 9,
  }), "voice_chain_noise");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 11,
    id: `msg-voice-ask-${vagueSeq + 11}`,
    sender: "user-16",
    senderName: "鲁十八",
    content: "小智，你看下我刚才语音和截图说的是什么问题？",
    sendtime: nowSec + vagueSeq + 10,
  }), "voice_chain_ask");
  await waitForReplyCount(27, "voice_chain_reply_1");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 12,
    id: `msg-voice-noise-2-${vagueSeq + 12}`,
    sender: "user-6",
    senderName: "周八",
    content: "素材群发那边先别忘了继续看。",
    sendtime: nowSec + vagueSeq + 11,
  }), "voice_chain_noise_2");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 13,
    id: `msg-voice-recall-${vagueSeq + 13}`,
    sender: "user-16",
    senderName: "鲁十八",
    content: "小智，回到我刚才语音那个问题，直接给结论。",
    sendtime: nowSec + vagueSeq + 12,
  }), "voice_chain_recall");
  await waitForReplyCount(28, "voice_chain_reply_2");
  const voiceAskObservation = findLatestObservation(
    state.toolObservations,
    "小智，你看下我刚才语音和截图说的是什么问题？",
  );
  const voiceRecallObservation = findLatestObservation(
    state.toolObservations,
    "小智，回到我刚才语音那个问题，直接给结论。",
  );
  scenarioResults.voiceImageNoiseOldTopicChain = {
    firstReply: state.upstreamSendTextCalls[26]?.body?.content || "",
    finalReply: state.upstreamSendTextCalls[27]?.body?.content || "",
    sawTranscriptOnAsk: Boolean(voiceAskObservation && contextContains(voiceAskObservation.contextItems, "支付成功了，但是订单页一直转圈，回不来")),
    sawImageDescOnAsk: Boolean(voiceAskObservation && contextContains(voiceAskObservation.contextItems, "打开订单详情页时页面一直加载")),
    sawTranscriptOnRecall: Boolean(voiceRecallObservation && contextContains(voiceRecallObservation.contextItems, "支付成功了，但是订单页一直转圈，回不来")),
    sawImageDescOnRecall: Boolean(voiceRecallObservation && contextContains(voiceRecallObservation.contextItems, "打开订单详情页时页面一直加载")),
    precise: state.upstreamSendTextCalls[27]?.body?.content === "回到你刚才语音那个问题，更像支付后的订单页加载链路异常，重点查订单接口超时、网关和前端重试。",
  };

  await postCallback(buildTextCallback({
    seq: vagueSeq + 14,
    id: `msg-progressive-1-${vagueSeq + 14}`,
    sender: "user-17",
    senderName: "燕十九",
    content: "小智，这个情况你怎么看？",
    sendtime: nowSec + vagueSeq + 13,
  }), "progressive_chain_ask_1");
  await waitForReplyCount(29, "progressive_chain_reply_1");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 15,
    id: `msg-progressive-2-${vagueSeq + 15}`,
    sender: "user-17",
    senderName: "燕十九",
    content: "小智，补充一点，用户说下单页打不开。",
    sendtime: nowSec + vagueSeq + 14,
  }), "progressive_chain_ask_2");
  await waitForReplyCount(30, "progressive_chain_reply_2");
  await postCallback(buildTextCallback({
    seq: vagueSeq + 16,
    id: `msg-progressive-3-${vagueSeq + 16}`,
    sender: "user-17",
    senderName: "燕十九",
    content: "小智，再补一条，日志里订单接口超时，页面一直转圈。",
    sendtime: nowSec + vagueSeq + 15,
  }), "progressive_chain_ask_3");
  await waitForReplyCount(31, "progressive_chain_reply_3");
  const progressiveSecondObservation = findLatestObservation(
    state.toolObservations,
    "小智，补充一点，用户说下单页打不开。",
  );
  const progressiveThirdObservation = findLatestObservation(
    state.toolObservations,
    "小智，再补一条，日志里订单接口超时，页面一直转圈。",
  );
  scenarioResults.progressiveThreeStepConvergence = {
    firstReply: state.upstreamSendTextCalls[28]?.body?.content || "",
    secondReply: state.upstreamSendTextCalls[29]?.body?.content || "",
    thirdReply: state.upstreamSendTextCalls[30]?.body?.content || "",
    firstAskedClarify: state.upstreamSendTextCalls[28]?.body?.content === "我先介入，但还缺一个关键信息：请补一下具体报错、影响现象或截图，我再继续判断。",
    secondSawPageDown: Boolean(progressiveSecondObservation && contextContains(progressiveSecondObservation.contextItems, "下单页打不开")),
    thirdSawPageDown: Boolean(progressiveThirdObservation && contextContains(progressiveThirdObservation.contextItems, "下单页打不开")),
    thirdSawTimeout: Boolean(progressiveThirdObservation && contextContains(progressiveThirdObservation.contextItems, "订单接口超时")),
    thirdSawSpin: Boolean(progressiveThirdObservation && contextContains(progressiveThirdObservation.contextItems, "页面一直转圈")),
    secondConverged: state.upstreamSendTextCalls[29]?.body?.content === "我先收敛到下单页加载链路异常了，但还差最直接的报错或现象，比如超时、502 或一直转圈。",
    thirdPrecise: state.upstreamSendTextCalls[30]?.body?.content === "结合你这三次补充，问题已经比较明确了：更像订单接口超时把页面加载链路拖住了，所以用户看到一直转圈。",
  };
}

module.exports = { runMultimodalSimulatedScenarios };
