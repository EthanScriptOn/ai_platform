"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonl, stableId } = require("./data_utils");
const {
  buildRagflowEntry,
  decisionStatus,
  isRagflowImportableItem,
  renderRagflowEntriesMarkdown,
} = require("./knowledge_ingestion_format");

function createKnowledgeReviewService({
  REVIEW_RUN_DIR,
  REVIEW_STATE_PATH,
}) {
  function loadGovernedItems() {
    const governedPath = path.join(REVIEW_RUN_DIR, "governed_units.jsonl");
    const items = [];
    for (const docResult of readJsonl(governedPath)) {
      const doc = docResult.document || {};
      for (const unit of docResult.knowledge_units || []) {
        items.push({
          id: stableId(doc.title || "", unit),
          source_kind: "document",
          document_title: doc.title || "",
          feishu_url: doc.feishu_url || "",
          source_path: doc.source_path || "",
          unit,
        });
      }
    }
    return items;
  }

  function loadDecisions() {
    if (!fs.existsSync(REVIEW_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(REVIEW_STATE_PATH, "utf-8"));
  }

  function saveDecisions(decisions) {
    fs.mkdirSync(path.dirname(REVIEW_STATE_PATH), { recursive: true });
    fs.writeFileSync(REVIEW_STATE_PATH, JSON.stringify(decisions, null, 2), "utf-8");
  }

  function renderApprovedMarkdown(items, decisions) {
    const entries = [];
    for (const item of items) {
      const decision = decisions[item.id];
      const merged = { ...item, decision };
      if (!isRagflowImportableItem(merged)) continue;
      entries.push(buildRagflowEntry(merged, decision?.unit || item.unit));
    }
    return { markdown: renderRagflowEntriesMarkdown(entries, "悦拜知识库"), count: entries.length, entries };
  }

  function attachDecisions(items, decisions) {
    return items.map((item) => {
      const decision = decisions[item.id];
      const merged = { ...item, decision };
      return {
        ...merged,
        ingestion_status: decisionStatus(merged),
        ragflow_ready: isRagflowImportableItem(merged),
      };
    });
  }

  return {
    attachDecisions,
    loadDecisions,
    loadGovernedItems,
    renderApprovedMarkdown,
    saveDecisions,
  };
}

module.exports = {
  createKnowledgeReviewService,
};
