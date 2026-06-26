"use strict";

function normalizeText(value, maxLength = 0) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!maxLength || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeList(value, maxItems = 12, maxLength = 80) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，]+/g);
  return Array.from(new Set(
    source
      .map((item) => normalizeText(item, maxLength))
      .filter(Boolean),
  )).slice(0, maxItems);
}

function compactSourceMessage(message) {
  return {
    trace_id: normalizeText(message?.trace_id || message?.traceId || "", 120),
    time: normalizeText(message?.time || message?.sendTimeIso || message?.receivedAt || "", 80),
    sender: normalizeText(message?.sender || message?.senderName || message?.sender_id || message?.senderId || "", 80),
    type: normalizeText(message?.type || message?.msgTypeName || message?.msgType || "", 40),
    content: normalizeText([
      message?.content,
      message?.text,
      message?.quote_content,
      message?.transcript_text,
      message?.title,
      message?.desc,
    ].filter(Boolean).join("\n"), 700),
    has_media: Boolean(message?.has_media || message?.hasMedia),
    media_kind: normalizeText(message?.media_kind || message?.mediaKind || "", 40),
  };
}

function buildKnowledgeRefinementMessages(candidate, options = {}) {
  const maxSourceMessages = Math.max(1, Math.min(30, Number(options.maxSourceMessages || 12)));
  const sourceMessages = (Array.isArray(candidate?.sourceMessages) ? candidate.sourceMessages : [])
    .slice(0, maxSourceMessages)
    .map(compactSourceMessage);
  const payload = {
    candidate_id: normalizeText(candidate?.candidateId || candidate?.id || "", 120),
    topic: normalizeText(candidate?.topic || "", 240),
    question: normalizeText(candidate?.question || "", 500),
    answer_draft: normalizeText(candidate?.answerDraft || candidate?.answer_draft || "", 1500),
    applicability: normalizeText(candidate?.applicability || "", 500),
    risk_level: normalizeText(candidate?.riskLevel || candidate?.risk_level || "", 40),
    confidence: Number(candidate?.confidence || 0),
    tags: normalizeList(candidate?.tags, 12, 40),
    reason: normalizeText(candidate?.reason || "", 500),
    trace_ids: normalizeList(candidate?.traceIds || candidate?.trace_ids, 60, 160),
    source_messages: sourceMessages,
  };
  const schemaText = [
    "{",
    '  "title": "清晰标题",',
    '  "summary": "一句话说明这条知识解决什么问题",',
    '  "formatted_content": "可直接进入知识库的正文。不要套固定模板，自行选择最适合的表达结构。",',
    '  "keywords": ["用户可能搜索或提问的关键词"],',
    '  "missing_info": ["仍然缺少的信息；没有则为空数组"],',
    '  "confidence": 0.0,',
    '  "source_trace_ids": ["支撑正文的 trace_id"],',
    '  "editor_notes": "给审核人的简短说明"',
    "}",
  ].join("\n");

  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: [
            "你是企业内部知识编辑，不是表格填写器。",
            "你的任务是把碎片化群聊候选整理成一篇可直接进入知识库的文档。",
            "不要使用固定模板；同类知识也可以采用不同结构。你要选择最能把事情讲清楚的表达方式。",
            "质量标准：标题清楚；开头说明解决什么问题；正文补齐必要背景、适用场景、判断依据、处理办法或结论；保留用户可能搜索的关键词；信息不足要明确写进 missing_info，不能编造。",
            "正文可以使用 Markdown 小标题、列表或短段落，但不要为了套格式而制造没有证据的内容。",
            "只能基于候选和来源消息写作。不能凭常识补产品规则、金额、承诺、权限或生产处置细节。",
            "source_trace_ids 只能选择输入里存在的 trace_id。",
            "必须只输出合法 JSON，不要输出 markdown 代码块或额外解释。",
            "输出结构必须符合：",
            schemaText,
          ].join("\n"),
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    },
  ];
}

function validateKnowledgeRefinementPayload(value, candidate = {}) {
  if (!value || typeof value !== "object") {
    throw new Error("schema_invalid:not_object");
  }
  const title = normalizeText(value.title || value.topic || "", 160);
  const summary = normalizeText(value.summary || "", 360);
  const formattedContent = normalizeText(value.formatted_content || value.formattedContent || value.content || "", 8000);
  if (!title) {
    throw new Error("schema_invalid:title_required");
  }
  if (!summary) {
    throw new Error("schema_invalid:summary_required");
  }
  if (!formattedContent) {
    throw new Error("schema_invalid:formatted_content_required");
  }

  const allowedTraceIds = new Set(normalizeList(candidate.traceIds || candidate.trace_ids, 100, 180));
  const sourceTraceIds = normalizeList(value.source_trace_ids || value.sourceTraceIds, 100, 180)
    .filter((traceId) => !allowedTraceIds.size || allowedTraceIds.has(traceId));
  const fallbackTraceIds = Array.from(allowedTraceIds);
  return {
    title,
    summary,
    formattedContent,
    keywords: normalizeList(value.keywords, 20, 60),
    missingInfo: normalizeList(value.missing_info || value.missingInfo, 20, 160),
    confidence: Math.max(0, Math.min(1, Number(value.confidence || candidate.confidence || 0))),
    sourceTraceIds: sourceTraceIds.length ? sourceTraceIds : fallbackTraceIds,
    editorNotes: normalizeText(value.editor_notes || value.editorNotes || "", 600),
  };
}

function shouldRefineKnowledgeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const status = String(candidate.status || "").trim();
  if (["rejected", "obsolete", "published"].includes(status)) {
    return false;
  }
  if (normalizeText(candidate.formattedContent || candidate.refinedContent || "")) {
    return false;
  }
  return Boolean(normalizeText(candidate.question || candidate.answerDraft || candidate.answer_draft || ""));
}

module.exports = {
  normalizeText,
  normalizeList,
  compactSourceMessage,
  buildKnowledgeRefinementMessages,
  validateKnowledgeRefinementPayload,
  shouldRefineKnowledgeCandidate,
};
