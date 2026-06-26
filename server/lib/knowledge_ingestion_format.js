"use strict";

const AUTO_IMPORT_STATUS = "ready_to_import";
const IMPORTED_STATUS = "imported";
const NEEDS_REVIEW_STATUS = "needs_review";
const REJECTED_STATUS = "rejected";
const CHANGES_REQUESTED_STATUS = "changes_requested";

function normalizeText(value = "", maxLength = 20000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function normalizeList(value, maxItems = 20) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/\n|,/g);
  return raw.map((item) => normalizeText(item, 500)).filter(Boolean).slice(0, maxItems);
}

function getFinalContent(unit = {}) {
  return normalizeText(
    unit.final_content
      || unit.answer_for_customer
      || unit.internal_notes
      || (Array.isArray(unit.steps) ? unit.steps.join("\n") : unit.steps)
  );
}

function isDirectlyImportable(unit = {}) {
  return unit.needs_human_review !== true
    && unit.visibility === "public_reply"
    && Boolean(getFinalContent(unit))
    && normalizeList(unit.source_evidence).length > 0;
}

function decisionStatus(item = {}) {
  const status = String(item.decision?.status || "").trim();
  if (status) return status;
  return isDirectlyImportable(item.unit) ? AUTO_IMPORT_STATUS : NEEDS_REVIEW_STATUS;
}

function isRagflowImportableItem(item = {}) {
  const status = decisionStatus(item);
  return status === AUTO_IMPORT_STATUS || status === "approved" || status === IMPORTED_STATUS;
}

function buildRagflowEntry(item = {}, unitOverride = null) {
  const unit = unitOverride || item.decision?.unit || item.unit || {};
  const sourceKind = item.source_kind || item.sourceKind || "document";
  const finalContent = getFinalContent(unit);
  return {
    id: item.id || "",
    source_kind: sourceKind,
    source_label: sourceKind === "flowbot" ? "群消息候选" : "文档治理",
    document_title: item.document_title || item.documentTitle || "",
    source_url: item.feishu_url || item.source_url || "",
    source_path: item.source_path || "",
    title: normalizeText(unit.title || item.title || "未命名知识", 300),
    unit_type: normalizeText(unit.unit_type || "knowledge", 80),
    visibility: normalizeText(unit.visibility || "needs_review", 80),
    scope: normalizeText(unit.scope || "", 1000),
    user_questions: normalizeList(unit.user_questions, 12),
    final_content: finalContent,
    source_evidence: normalizeList(unit.source_evidence || unit.evidence, 20),
    review_reason: normalizeText(unit.review_reason || "", 1000),
    confidence: unit.confidence ?? "",
    tags: normalizeList(unit.tags, 12),
  };
}

function renderRagflowEntriesMarkdown(entries = [], title = "悦拜知识库") {
  const lines = [`# ${title}`, ""];
  for (const entry of entries) {
    lines.push(
      `## ${entry.title}`,
      ""
    );
    if (entry.user_questions.length) {
      lines.push("### 常见问法", ...entry.user_questions.map((question) => `- ${question}`), "");
    }
    lines.push("### 答案", entry.final_content || "待补充", "");
    const keywords = [entry.title, entry.document_title, entry.scope, ...entry.tags]
      .map((item) => normalizeText(item, 300))
      .filter(Boolean);
    const uniqKeywords = [...new Set(keywords)];
    if (uniqKeywords.length) {
      lines.push("### 关键词", ...uniqKeywords.slice(0, 20).map((tag) => `- ${tag}`), "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

module.exports = {
  AUTO_IMPORT_STATUS,
  CHANGES_REQUESTED_STATUS,
  IMPORTED_STATUS,
  NEEDS_REVIEW_STATUS,
  REJECTED_STATUS,
  buildRagflowEntry,
  decisionStatus,
  getFinalContent,
  isDirectlyImportable,
  isRagflowImportableItem,
  renderRagflowEntriesMarkdown,
};
