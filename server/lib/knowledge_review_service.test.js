"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKnowledgeReviewService } = require("./knowledge_review_service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-review-test-"));
  return {
    dir,
    service: createKnowledgeReviewService({
      REVIEW_RUN_DIR: dir,
      REVIEW_STATE_PATH: path.join(dir, "review_decisions.json"),
    }),
  };
}

test("loadGovernedItems loads all governed units and marks source metadata", () => {
  const { dir, service } = createService();
  fs.writeFileSync(
    path.join(dir, "governed_units.jsonl"),
    JSON.stringify({
      document: { title: "客服手册", feishu_url: "https://feishu.test", source_path: "doc.md" },
      knowledge_units: [
        { title: "公开", visibility: "public_reply", answer_for_customer: "可答复", source_evidence: ["A"] },
        { title: "需审核", visibility: "internal", source_evidence: ["B"] },
        { title: "人工", visibility: "public_reply", needs_human_review: true, source_evidence: ["C"] },
      ],
    }),
    "utf8"
  );

  const items = service.loadGovernedItems();

  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.unit.title), ["公开", "需审核", "人工"]);
  assert.equal(items[0].source_kind, "document");
  assert.equal(items[0].document_title, "客服手册");
  assert.equal(items[0].feishu_url, "https://feishu.test");
});

test("attachDecisions computes direct import and review statuses", () => {
  const { service } = createService();
  const items = [
    {
      id: "auto",
      unit: {
        title: "可直接入库",
        visibility: "public_reply",
        answer_for_customer: "明确答案",
        source_evidence: ["证据"],
      },
    },
    {
      id: "review",
      unit: { title: "需审核", visibility: "internal_only", source_evidence: ["证据"] },
    },
  ];

  const result = service.attachDecisions(items, { review: { status: "rejected" } });

  assert.equal(result[0].ingestion_status, "ready_to_import");
  assert.equal(result[0].ragflow_ready, true);
  assert.equal(result[1].ingestion_status, "rejected");
  assert.equal(result[1].ragflow_ready, false);
});

test("loadDecisions and saveDecisions round-trip review state", () => {
  const { service } = createService();

  assert.deepEqual(service.loadDecisions(), {});
  service.saveDecisions({ item1: { status: "approved" } });

  assert.deepEqual(service.loadDecisions(), { item1: { status: "approved" } });
});

test("renderApprovedMarkdown groups approved units and prefers edited unit content", () => {
  const { service } = createService();
  const items = [
    {
      id: "item1",
      document_title: "文档 A",
      feishu_url: "https://doc.test/a",
      unit: {
        title: "原始标题",
        visibility: "internal",
        unit_type: "qa",
        scope: "客服",
        user_questions: ["怎么处理？"],
        answer_for_customer: "原始答复",
        source_evidence: ["证据"],
      },
    },
    {
      id: "item2",
      document_title: "文档 A",
      feishu_url: "https://doc.test/a",
      unit: { title: "未通过", visibility: "internal" },
    },
    {
      id: "item3",
      document_title: "文档 B",
      feishu_url: "https://doc.test/b",
      unit: {
        title: "自动入库",
        visibility: "public_reply",
        unit_type: "faq",
        answer_for_customer: "自动内容",
        source_evidence: ["自动证据"],
      },
    },
  ];

  const result = service.renderApprovedMarkdown(items, {
    item1: {
      status: "approved",
      unit: {
        title: "编辑后标题",
        visibility: "public_reply",
        unit_type: "qa",
        scope: "客服",
        final_content: "最终内容",
        source_evidence: ["编辑证据"],
      },
    },
    item2: { status: "rejected" },
  });

  assert.equal(result.count, 2);
  assert.match(result.markdown, /## 编辑后标题/);
  assert.match(result.markdown, /### 答案/);
  assert.match(result.markdown, /最终内容/);
  assert.match(result.markdown, /## 自动入库/);
  assert.match(result.markdown, /自动内容/);
  assert.doesNotMatch(result.markdown, /未通过/);
  assert.doesNotMatch(result.markdown, /来源文档|来源路径|来源链接|飞书地址|原文证据|置信度|最终入库内容/);
});
