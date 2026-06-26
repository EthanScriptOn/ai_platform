"use strict";

const fs = require("fs");
const path = require("path");
const { countTasksByStatus, readTaskState } = require("./simulated_e2e_task_state");

function buildSimulatedE2eResult({
  callbackUrl,
  dataDir,
  flowbotProc,
  llm,
  scenarioResults,
  state,
  upstream,
  workerProc,
}) {
  const taskStatePath = path.join(dataDir, "flowbot-agent-task-state.json");
  const taskState = readTaskState(dataDir);
  const tasks = Object.values(taskState.tasks || {});

  const result = {
    ok: true,
    callbackUrl,
    upstreamBaseUrl: upstream.baseUrl,
    llmBaseUrl: llm.baseUrl,
    sendTextCalls: state.upstreamSendTextCalls,
    scenarios: scenarioResults,
    assertions: {
      textReplySent: scenarioResults.textWake.ok,
      imageReplySent: scenarioResults.imageFollowUp.ok,
      nonWakeDidNotTriggerAgent: scenarioResults.nonWakeIgnored.replyCountStable && scenarioResults.nonWakeIgnored.llmCountStable,
      multiUserContextReplySent: scenarioResults.multiUserContext.reply === "从上面的群消息看，像是服务异常或停服影响，建议先确认上游服务状态和回调链路。",
      multiUserContextObserved: (
        scenarioResults.multiUserContext.sawZhangsan
        && scenarioResults.multiUserContext.sawLisi
        && scenarioResults.multiUserContext.saw502
        && scenarioResults.multiUserContext.sawOrderBlocked
      ),
      namedMentionNoWakeIgnored: scenarioResults.namedMentionButNoWake.ignoredTaskRaised && scenarioResults.namedMentionButNoWake.noExtraReply,
      rapidMultiUserWakesOk: scenarioResults.rapidMultiUserWakes.ok,
      longDialogueSummaryOk: (
        scenarioResults.longDialogueSummary.reply === "我整理了一下，当前主问题是支付回调异常，已经影响到订单状态更新和售后消息推送。"
        && scenarioResults.longDialogueSummary.sawCallbackFail
        && scenarioResults.longDialogueSummary.sawOrderNotUpdated
        && scenarioResults.longDialogueSummary.sawAfterSale
        && scenarioResults.longDialogueSummary.contextItemCount >= 8
      ),
      multiUserSameTopicWithNoiseOk: (
        scenarioResults.multiUserSameTopicWithNoise.reply === "看起来是同一条素材群发链路异常，表现为发送失败或文案丢失，建议优先排查群发任务和素材拼装。"
        && scenarioResults.multiUserSameTopicWithNoise.sawMaterialIssue
        && scenarioResults.multiUserSameTopicWithNoise.sawTextMissing
      ),
      otherRoomBlockedOk: scenarioResults.otherRoomBlocked.replyCountStable && scenarioResults.otherRoomBlocked.llmCountStable,
      veryLongBurstSummaryOk: (
        scenarioResults.veryLongBurstSummary.reply === "综合前面的长链路消息，主问题更像是回调验签失败，已经进一步拖慢重试队列，并导致企微通知发送异常。"
        && scenarioResults.veryLongBurstSummary.sawSignatureFail
        && scenarioResults.veryLongBurstSummary.sawRetryBacklog
        && scenarioResults.veryLongBurstSummary.sawWecomNotify
        && scenarioResults.veryLongBurstSummary.contextItemCount >= 20
      ),
      oldQuestionRecallOk: (
        scenarioResults.oldQuestionRecall.precise
        && scenarioResults.oldQuestionRecall.sawCallbackFail
        && scenarioResults.oldQuestionRecall.sawOrderNotUpdated
        && scenarioResults.oldQuestionRecall.sawAfterSale
        && scenarioResults.oldQuestionRecall.contextItemCount >= 6
      ),
      followUpWithoutWakeIgnoredOk: (
        scenarioResults.followUpWithoutWakeIgnored.replyCountStable
        && scenarioResults.followUpWithoutWakeIgnored.llmCountStable
      ),
      insufficientInfoClarifyOk: (
        scenarioResults.insufficientInfoClarify.askedClarify
        && scenarioResults.insufficientInfoClarify.sawOnlyVagueContext
      ),
      ambiguousOldTopicCandidatesOk: (
        scenarioResults.ambiguousOldTopicCandidates.sawPaymentTopic
        && scenarioResults.ambiguousOldTopicCandidates.sawMaterialTopic
        && scenarioResults.ambiguousOldTopicCandidates.offeredCandidates
      ),
      sameSenderScopedRecallOk: (
        scenarioResults.sameSenderScopedRecall.precise
        && scenarioResults.sameSenderScopedRecall.sawInventoryIssue
        && scenarioResults.sameSenderScopedRecall.sawErpDelay
        && scenarioResults.sameSenderScopedRecall.sawQueueBacklog
      ),
      candidateSelectionContinuationOk: (
        scenarioResults.candidateSelectionContinuation.precise
        && scenarioResults.candidateSelectionContinuation.sawPaymentTopic
      ),
      deepInterleavedSpecificRecallOk: (
        scenarioResults.deepInterleavedSpecificRecall.precise
        && scenarioResults.deepInterleavedSpecificRecall.sawCallbackFail
        && scenarioResults.deepInterleavedSpecificRecall.sawOrderNotUpdated
        && scenarioResults.deepInterleavedSpecificRecall.sawAfterSale
      ),
      crossUserWakeIsolationOk: (
        scenarioResults.crossUserWakeIsolation.precise
        && scenarioResults.crossUserWakeIsolation.sawMaterialIssue
        && scenarioResults.crossUserWakeIsolation.sawCopyLoss
        && scenarioResults.crossUserWakeIsolation.avoidedInventoryBias
      ),
      dualUserExplicitWakeFollowupsOk: (
        scenarioResults.dualUserExplicitWakeFollowups.paymentScoped
        && scenarioResults.dualUserExplicitWakeFollowups.materialScoped
        && scenarioResults.dualUserExplicitWakeFollowups.hasPaymentDirection
        && scenarioResults.dualUserExplicitWakeFollowups.hasMaterialDirection
        && scenarioResults.dualUserExplicitWakeFollowups.hasPaymentFollowup
        && scenarioResults.dualUserExplicitWakeFollowups.hasMaterialFollowup
        && scenarioResults.dualUserExplicitWakeFollowups.hasPaymentConclusion
        && scenarioResults.dualUserExplicitWakeFollowups.hasMaterialConclusion
      ),
      superVagueOldTopicFollowUpOk: (
        scenarioResults.superVagueOldTopicFollowUp.sawPaymentTopic
        && scenarioResults.superVagueOldTopicFollowUp.sawInventoryTopic
        && scenarioResults.superVagueOldTopicFollowUp.sawMaterialTopic
        && scenarioResults.superVagueOldTopicFollowUp.offeredCandidates
        && scenarioResults.superVagueOldTopicFollowUp.noHardAnswer
      ),
      imageTextOldTopicChainOk: (
        scenarioResults.imageTextOldTopicChain.sawSpin
        && scenarioResults.imageTextOldTopicChain.precise
      ),
      clarifyThenContinueOk: (
        scenarioResults.clarifyThenContinue.firstAskedClarify
        && scenarioResults.clarifyThenContinue.sawSpin
        && scenarioResults.clarifyThenContinue.precise
      ),
      voiceImageNoiseOldTopicChainOk: (
        scenarioResults.voiceImageNoiseOldTopicChain.sawTranscriptOnAsk
        && scenarioResults.voiceImageNoiseOldTopicChain.sawImageDescOnAsk
        && scenarioResults.voiceImageNoiseOldTopicChain.sawTranscriptOnRecall
        && scenarioResults.voiceImageNoiseOldTopicChain.sawImageDescOnRecall
        && scenarioResults.voiceImageNoiseOldTopicChain.precise
      ),
      progressiveThreeStepConvergenceOk: (
        scenarioResults.progressiveThreeStepConvergence.firstAskedClarify
        && scenarioResults.progressiveThreeStepConvergence.secondSawPageDown
        && scenarioResults.progressiveThreeStepConvergence.thirdSawPageDown
        && scenarioResults.progressiveThreeStepConvergence.thirdSawTimeout
        && scenarioResults.progressiveThreeStepConvergence.thirdSawSpin
        && scenarioResults.progressiveThreeStepConvergence.secondConverged
        && scenarioResults.progressiveThreeStepConvergence.thirdPrecise
      ),
      textConversationIdOk: state.upstreamSendTextCalls[0]?.body?.conversation_id === "R:room-sim-1",
      imageConversationIdOk: state.upstreamSendTextCalls[1]?.body?.conversation_id === "R:room-sim-1",
      toolVisionImageObserved: state.sawToolVisionImage,
      taskFileCreated: fs.existsSync(taskStatePath),
      completedTasksAtLeastThirtyOne: countTasksByStatus(taskState, "completed") >= 31,
      ignoredTasksAtLeastOne: countTasksByStatus(taskState, "ignored") >= 1,
      messageIndexCreated: fs.existsSync(path.join(dataDir, "flowbot-message-search-index.jsonl")),
    },
    observations: {
      triggerImageObserved: state.sawTriggerImage,
      llmRequestCount: state.llmRequests.length,
      taskStatuses: {
        completed: countTasksByStatus(taskState, "completed"),
        ignored: countTasksByStatus(taskState, "ignored"),
        failed: countTasksByStatus(taskState, "failed"),
        total: tasks.length,
      },
    },
    logs: {
      flowbot: flowbotProc.logs.slice(-60),
      worker: workerProc.logs.slice(-60),
    },
  };


  return result;
}

module.exports = {
  buildSimulatedE2eResult,
};
