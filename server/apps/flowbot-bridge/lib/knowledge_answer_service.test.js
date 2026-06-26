"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKnowledgeAnswerService } = require("./knowledge_answer_service");

function createService(overrides = {}) {
  return createKnowledgeAnswerService({
    LLM_CLASSIFY_ENABLED: true,
    LLM_MAX_REPAIR_ATTEMPTS: 0,
    normalizeKnowledgeSourceInput: (value) => String(value || "all"),
    requestLlmClassify: async () => JSON.stringify({
      decision: "fallback",
      confidence: "low",
      answer: "",
      reason: "default",
      used_doc_ids: [],
    }),
    searchKnowledgeDocuments: async () => ({ docs: [], sources: {} }),
    toFiniteScore: (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    },
    tryParseClassifyJson: (text) => JSON.parse(text),
    ...overrides,
  });
}

test("buildKnowledgeAnswer uses a wider recall pool before LLM judgement", async () => {
  let searchLimit = 0;
  let judgedDocs = [];
  const docs = Array.from({ length: 7 }, (_, index) => ({
    id: `doc-${index + 1}`,
    title: `普通文档 ${index + 1}`,
    score: 0.9 - index * 0.01,
    content: "云发单常见问题。",
  }));
  docs[5] = {
    id: "zhang-kai",
    title: "张凯岗位说明",
    score: 0.4,
    content: "张凯在云发单中是前端的技术开发人员。",
  };

  const service = createService({
    searchKnowledgeDocuments: async (_query, limit) => {
      searchLimit = limit;
      return { docs, sources: { ragflow: { count: docs.length } } };
    },
    requestLlmClassify: async (messages) => {
      judgedDocs = JSON.parse(messages[1].content[0].text).retrieved_docs;
      assert.ok(judgedDocs.some((item) => item.id === "zhang-kai"));
      return JSON.stringify({
        decision: "answer",
        confidence: "high",
        answer: "张凯在云发单中是前端的技术开发人员。",
        reason: "命中张凯岗位说明",
        used_doc_ids: ["zhang-kai"],
      });
    },
  });

  const result = await service.buildKnowledgeAnswer("云发单中张凯是做什么的？", 5, { source: "all" });

  assert.equal(searchLimit, 20);
  assert.equal(judgedDocs.length, 7);
  assert.equal(result.limit, 5);
  assert.equal(result.answer, "张凯在云发单中是前端的技术开发人员。");
  assert.deepEqual(result.usedDocs.map((item) => item.id), ["zhang-kai"]);
});
