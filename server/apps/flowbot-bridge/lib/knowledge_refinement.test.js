"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildKnowledgeRefinementMessages,
  validateKnowledgeRefinementPayload,
  shouldRefineKnowledgeCandidate,
} = require("./knowledge_refinement");

test("buildKnowledgeRefinementMessages asks for flexible knowledge writing instead of fixed templates", () => {
  const messages = buildKnowledgeRefinementMessages({
    candidateId: "KC-1",
    topic: "订单页转圈",
    question: "订单页一直转圈怎么排查？",
    answerDraft: "先看订单接口耗时和网关。",
    traceIds: ["trace-1"],
    sourceMessages: [
      {
        trace_id: "trace-1",
        time: "2026-05-08T00:00:00.000Z",
        sender: "张三",
        type: "文本",
        content: "用户说订单页一直转圈，日志里订单接口超时。",
      },
    ],
  });
  const systemText = messages[0].content[0].text;
  const userPayload = JSON.parse(messages[1].content[0].text);

  assert.match(systemText, /不要使用固定模板/);
  assert.match(systemText, /可直接进入知识库/);
  assert.equal(userPayload.candidate_id, "KC-1");
  assert.equal(userPayload.source_messages[0].trace_id, "trace-1");
});

test("validateKnowledgeRefinementPayload normalizes refined content and filters source trace ids", () => {
  const result = validateKnowledgeRefinementPayload({
    title: "订单页一直转圈排查",
    summary: "用于处理订单页加载异常的初步排查。",
    formatted_content: "订单页一直转圈时，先看订单接口耗时、网关状态和前端重试日志。",
    keywords: ["订单页", "一直转圈", "订单接口"],
    missing_info: ["还缺具体接口名"],
    confidence: 1.5,
    source_trace_ids: ["trace-1", "unknown"],
    editor_notes: "来源充分，但接口名缺失。",
  }, {
    traceIds: ["trace-1"],
  });

  assert.equal(result.title, "订单页一直转圈排查");
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.sourceTraceIds, ["trace-1"]);
  assert.deepEqual(result.missingInfo, ["还缺具体接口名"]);
});

test("validateKnowledgeRefinementPayload rejects empty required fields", () => {
  assert.throws(
    () => validateKnowledgeRefinementPayload({
      title: "只有标题",
      summary: "",
      formatted_content: "",
    }),
    /summary_required/,
  );
});

test("shouldRefineKnowledgeCandidate skips rejected, published, obsolete, and already refined candidates", () => {
  assert.equal(shouldRefineKnowledgeCandidate({ status: "pending_review", question: "怎么排查？" }), true);
  assert.equal(shouldRefineKnowledgeCandidate({ status: "rejected", question: "怎么排查？" }), false);
  assert.equal(shouldRefineKnowledgeCandidate({ status: "published", question: "怎么排查？" }), false);
  assert.equal(shouldRefineKnowledgeCandidate({ status: "obsolete", question: "怎么排查？" }), false);
  assert.equal(shouldRefineKnowledgeCandidate({
    status: "pending_review",
    question: "怎么排查？",
    formattedContent: "已经成稿",
  }), false);
});
