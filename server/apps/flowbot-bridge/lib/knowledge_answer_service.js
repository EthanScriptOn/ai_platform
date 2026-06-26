function createKnowledgeAnswerService({
  LLM_CLASSIFY_ENABLED,
  LLM_MAX_REPAIR_ATTEMPTS,
  normalizeKnowledgeSourceInput,
  requestLlmClassify,
  searchKnowledgeDocuments,
  toFiniteScore,
  tryParseClassifyJson,
}) {
  function buildKnowledgeAnswerFallbackText() {
    return "当前知识库没有搜索到明确解决方案。";
  }

  function sanitizeKnowledgeAnswerText(text) {
    const normalized = String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^[*-]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .trim();
    return normalized;
  }

  function buildKnowledgeAnswerJudgeMessages({ query, docs = [] }) {
    const schemaText = [
      "{",
      '  "decision": "answer|fallback",',
      '  "confidence": "high|medium|low",',
      '  "answer": "当 decision=answer 时，输出可直接发到群里的最终答案；否则为空字符串",',
      '  "reason": "简短说明判断依据",',
      '  "used_doc_ids": ["命中的文档或 chunk id，可为空"]',
      "}",
    ].join("\n");
    const condensedDocs = docs.slice(0, 8).map((item) => ({
      id: String(item?.id || item?.chunkId || item?.docId || "").trim(),
      title: String(item?.title || item?.fileName || "").trim(),
      score: toFiniteScore(item?.score, 0),
      snippet: String(item?.snippet || "").trim(),
      content: String(item?.content || "").trim().slice(0, 1800),
    }));
    return [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: [
              "你是企业微信群知识问答的二次质检器。",
              "用户问题已经先经过了一次知识库检索，你要判断这批召回结果是否真的足以回答问题。",
              "只有在证据直接、明确、针对性强时，decision 才能是 answer。",
              "如果召回结果只是主题相近、只有部分概念重合、没有明确结论、没有直接步骤、没有直接地址、没有直接枚举，必须返回 fallback。",
              "如果用户问题本身不是知识库问题，例如闲聊、寒暄、日期时间、情绪表达、泛泛聊天，即使检索到了东西，也必须返回 fallback。",
              "不要根据常识脑补业务答案，只能依据给你的召回内容判断。",
              "当可以回答时，answer 必须是可直接发群的最终文本，不要带 markdown 星号，不要带“来源/原文路径/文档名/飞书地址/MD地址”等说明，不要暴露检索过程。",
              "如果用户问的是文档地址、接口地址、系统地址，可以直接返回最相关的那个地址，不要顺手带出一串无关地址。",
              "如果用户问的是枚举类问题，只回答与问题直接相关的那组枚举。",
              "如果用户问的是解决方案类问题，但证据里没有明确解决方案，必须 fallback。",
              "必须只输出合法 JSON，不要输出解释、markdown、代码块。",
              "输出结构必须严格符合以下 schema：",
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
            text: JSON.stringify({
              query: String(query || "").trim(),
              retrieved_docs: condensedDocs,
            }, null, 2),
          },
        ],
      },
    ];
  }

  function validateKnowledgeAnswerJudgePayload(value) {
    if (!value || typeof value !== "object") {
      throw new Error("schema_invalid:not_object");
    }
    const decision = String(value.decision || "").trim();
    const confidence = String(value.confidence || "").trim().toLowerCase();
    if (!["answer", "fallback"].includes(decision)) {
      throw new Error(`schema_invalid:decision:${decision || "empty"}`);
    }
    if (!["high", "medium", "low"].includes(confidence)) {
      throw new Error(`schema_invalid:confidence:${confidence || "empty"}`);
    }
    const answer = sanitizeKnowledgeAnswerText(value.answer || "");
    const usedDocIds = Array.isArray(value.used_doc_ids || value.usedDocIds)
      ? (value.used_doc_ids || value.usedDocIds).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10)
      : [];
    return {
      decision,
      confidence,
      answer,
      reason: String(value.reason || "").trim(),
      usedDocIds,
    };
  }

  async function judgeKnowledgeAnswerWithLlm(query, docs = []) {
    if (!LLM_CLASSIFY_ENABLED) {
      return {
        ok: true,
        repaired: false,
        decision: "fallback",
        confidence: "low",
        answer: "",
        reason: "llm_classify_disabled",
        usedDocIds: [],
        rawOutput: "",
      };
    }
    if (!Array.isArray(docs) || !docs.length) {
      return {
        ok: true,
        repaired: false,
        decision: "fallback",
        confidence: "low",
        answer: "",
        reason: "no_docs",
        usedDocIds: [],
        rawOutput: "",
      };
    }
    const baseMessages = buildKnowledgeAnswerJudgeMessages({ query, docs });
    let rawOutput = "";
    try {
      rawOutput = await requestLlmClassify(baseMessages);
      return {
        ok: true,
        repaired: false,
        rawOutput,
        ...validateKnowledgeAnswerJudgePayload(tryParseClassifyJson(rawOutput)),
      };
    } catch (error) {
      const parseError = String(error?.message || error);
      const canRepair = Boolean(rawOutput)
        && !/^(llm_config_missing|request_timeout|http_\d+:|invalid_json:http_\d+:)/i.test(parseError);
      if (!canRepair) {
        return {
          ok: false,
          reason: "llm_request_failed",
          parseError,
          rawOutput,
        };
      }
      for (let attempt = 0; attempt < LLM_MAX_REPAIR_ATTEMPTS; attempt += 1) {
        const repairMessages = [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: [
                  "你是 JSON 修复器。",
                  "你会收到一次知识问答质检模型的原始输出和解析错误。",
                  "请只返回一个合法 JSON 对象，不要解释。",
                  "decision 只能是 answer 或 fallback。",
                  "confidence 只能是 high、medium、low。",
                  "当 decision=fallback 时，answer 应为空字符串。",
                ].join("\n"),
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  parse_error: parseError,
                  raw_output: rawOutput,
                }, null, 2),
              },
            ],
          },
        ];
        try {
          const repairedRaw = await requestLlmClassify(repairMessages);
          return {
            ok: true,
            repaired: true,
            rawOutput: repairedRaw,
            previousRawOutput: rawOutput,
            parseError,
            ...validateKnowledgeAnswerJudgePayload(tryParseClassifyJson(repairedRaw)),
          };
        } catch (repairError) {
          if (attempt === LLM_MAX_REPAIR_ATTEMPTS - 1) {
            return {
              ok: false,
              reason: "llm_repair_failed",
              parseError: String(repairError?.message || repairError),
              rawOutput,
            };
          }
        }
      }
    }
    return {
      ok: false,
      reason: "llm_repair_failed",
      parseError: "unknown",
      rawOutput,
    };
  }

  async function buildKnowledgeAnswer(query, limit = 5, options = {}) {
    const normalizedQuery = String(query || "").trim();
    const publicLimit = Math.max(1, Number(limit) || 5);
    const recallLimit = Math.max(publicLimit, 20);
    const knowledge = await searchKnowledgeDocuments(normalizedQuery, recallLimit, options);
    const allDocs = Array.isArray(knowledge.docs) ? knowledge.docs : [];
    const judgeDocs = allDocs.slice(0, Math.max(publicLimit, 8));
    const docs = allDocs.slice(0, publicLimit);
    const judged = await judgeKnowledgeAnswerWithLlm(normalizedQuery, judgeDocs);
    const usedDocs = judged.ok && judged.usedDocIds?.length
      ? judgeDocs.filter((item) => judged.usedDocIds.includes(String(item?.id || item?.chunkId || item?.docId || "").trim()))
      : [];
    const answer = judged.ok && judged.decision === "answer" && judged.answer
      ? judged.answer
      : buildKnowledgeAnswerFallbackText();
    return {
      query: normalizedQuery,
      limit: publicLimit,
      source: normalizeKnowledgeSourceInput(options.source),
      answer,
      decision: judged.ok ? judged.decision : "fallback",
      confidence: judged.ok ? judged.confidence : "low",
      reason: judged.ok ? judged.reason : judged.reason || judged.parseError || "judge_failed",
      docs,
      usedDocs,
      sources: knowledge.sources,
      judge: judged,
    };
  }

  return {
    buildKnowledgeAnswer,
    buildKnowledgeAnswerFallbackText,
    buildKnowledgeAnswerJudgeMessages,
    judgeKnowledgeAnswerWithLlm,
    sanitizeKnowledgeAnswerText,
    validateKnowledgeAnswerJudgePayload,
  };
}

module.exports = { createKnowledgeAnswerService };
