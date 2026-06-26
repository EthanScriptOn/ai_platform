"use strict";

const fs = require("fs");
const path = require("path");

const { paginateItems, paginationMeta, parsePagination } = require("./data_utils");
const { buildRagflowEntry } = require("./knowledge_ingestion_format");

function normalizeReviewStatus(status = "") {
  const value = String(status || "").trim();
  if (["pending_review", "reviewing", "draft", "pending"].includes(value)) return "needs_review";
  if (["published", "approved", "imported"].includes(value)) return "imported";
  return value;
}

function filterReviewItems(items, searchParams) {
  const requestedStatus = normalizeReviewStatus(searchParams.get("status"));
  if (!requestedStatus || requestedStatus === "all") return items;
  return items.filter((item) => normalizeReviewStatus(item.ingestion_status || item.decision?.status) === requestedStatus);
}

function createKnowledgeRoutes({
  DEFAULT_ROOM_ID,
  RAGFLOW_AGENT_ID,
  RAGFLOW_CHAT_URL,
  REVIEW_RUN_DIR,
  attachDecisions,
  callKnowledgeRewrite,
  createRagflowChatSession,
  createRagflowNativeSession,
  getRagflowChatInfo,
  getRagflowDatasetId,
  getRagflowConfig,
  ingestUploadedDocument,
  importApprovedToRagflow,
  importMarkdownToRagflow,
  importRagflowEntries,
  loadDecisions,
  loadGovernedItems,
  proxyFlowbotCandidateAction,
  proxyFlowbotHarvestPromote,
  proxyFlowbotKnowledgeHarvestMessages,
  proxyFlowbotKnowledgeCandidates,
  proxyRagflowChatCompletion,
  ragflowJson,
  renderApprovedMarkdown,
  saveRagflowConfig,
  saveDecisions,
  sendJson,
  sendJsonWithHeaders,
}) {
  function extractJsonObject(text = "") {
    const raw = String(text || "").trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {}
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {}
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
    return {};
  }

  function handleKnowledgeRoute(req, res, url, method, readPayload) {
    if (url.pathname === "/api/review/items") {
      const decisions = loadDecisions();
      const allItems = attachDecisions
        ? attachDecisions(loadGovernedItems(), decisions)
        : loadGovernedItems().map((item) => ({ ...item, decision: decisions[item.id] }));
      const filteredItems = filterReviewItems(allItems, url.searchParams);
      const pageData = paginateItems(filteredItems, parsePagination(url.searchParams));
      sendJson(res, {
        items: pageData.items,
        pagination: paginationMeta(pageData),
        runDir: REVIEW_RUN_DIR,
        ragflowChatUrl: RAGFLOW_CHAT_URL,
      });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/review/upload") {
      readPayload()
        .then((payload) => ingestUploadedDocument(payload))
        .then((result) => sendJson(res, result, result.ok ? 200 : 400))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (url.pathname === "/api/ragflow-chat-info") {
      getRagflowChatInfo(url.searchParams.get("chatId") || RAGFLOW_AGENT_ID)
        .then((chat) => sendJson(res, { ok: true, chat }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (url.pathname === "/api/ragflow-native-session") {
      createRagflowNativeSession()
        .then((data) => {
          const { setCookie, ...payload } = data || {};
          const extraHeaders = Array.isArray(setCookie) && setCookie.length
            ? { "Set-Cookie": setCookie }
            : {};
          sendJsonWithHeaders(res, payload, 200, extraHeaders);
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (url.pathname === "/api/ragflow/config") {
      if (method === "GET") {
        try {
          sendJson(res, getRagflowConfig ? getRagflowConfig() : { ok: false, error: "RAGFlow 配置接口未启用" });
        } catch (error) {
          sendJson(res, { ok: false, error: error.message }, 500);
        }
        return true;
      }
      if (method === "POST") {
        readPayload()
          .then((payload) => {
            if (!saveRagflowConfig) return { ok: false, error: "RAGFlow 配置接口未启用" };
            return saveRagflowConfig(payload);
          })
          .then((result) => sendJson(res, result, result.ok ? 200 : 400))
          .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
        return true;
      }
    }
    if (url.pathname === "/api/flowbot/knowledge-candidates") {
      proxyFlowbotKnowledgeCandidates(
        url.searchParams.get("roomId") || "",
        parsePagination(url.searchParams),
        {
          live: url.searchParams.get("live") === "1",
          status: url.searchParams.get("status") || "",
        }
      )
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (url.pathname === "/api/flowbot/knowledge-harvest/messages") {
      proxyFlowbotKnowledgeHarvestMessages(
        url.searchParams.get("roomId") || "",
        parsePagination(url.searchParams),
        {
          status: url.searchParams.get("status") || "",
        }
      )
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/flowbot/knowledge-harvest/promote") {
      readPayload()
        .then((payload) => proxyFlowbotHarvestPromote(payload))
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/flowbot/knowledge-rewrite") {
      readPayload()
        .then(async (payload) => {
          if (!callKnowledgeRewrite) throw new Error("智能改写接口未启用");
          const documentName = String(payload.documentName || "RAGFlow 文档").trim();
          const original = String(payload.original || "").trim().slice(0, 6000);
          const candidate = String(payload.candidate || "").trim().slice(0, 3000);
          const questions = Array.isArray(payload.questions) ? payload.questions.filter(Boolean).slice(0, 12) : [];
          const tags = Array.isArray(payload.tags) ? payload.tags.filter(Boolean).slice(0, 12) : [];
          if (!original) throw new Error("缺少原文片段");
          if (!candidate) throw new Error("缺少候选内容");
          const content = await callKnowledgeRewrite({
            temperature: 0.2,
            responseFormat: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: [
                  "你是知识库 md 局部改写助手。",
                  "你的任务不是整篇重写，而是根据候选知识，给出命中片段的局部修改建议。",
                  "第一步必须判断 original_fragment 和 candidate_answer 是否属于同一个知识主题。",
                  "如果主题不一致，比如原文讲登录/平台/接口，候选讲发票/财务规则，就不要改写。",
                  "不相关时 shouldRewrite=false，rewrite 和 merged 置空，reason 说明为什么不建议改这个文档。",
                  "相关时 shouldRewrite=true，再给局部改写建议。",
                  "相关时还要从 original_fragment 中找出最相关的原句或短段，写入 matchedText；找出真正命中的关键词，写入 matchedKeywords。",
                  "matchedText 必须来自 original_fragment 原文，不要自己改写；如果找不到明确原句，shouldRewrite=false。",
                  "不要编造原文没有支持的信息；不要输出无关说明。",
                  "必须只输出 JSON，字段为 shouldRewrite、matchedText、matchedKeywords、rewrite、merged、reason。",
                  "rewrite 写应该替换或补充成什么；merged 写把原文片段和新知识合并后的局部 md 内容。",
                ].join("\n"),
              },
              {
                role: "user",
                content: JSON.stringify({
                  document_name: documentName,
                  original_fragment: original,
                  candidate_answer: candidate,
                  candidate_questions: questions,
                  candidate_tags: tags,
                }),
              },
            ],
          });
          const parsed = extractJsonObject(content);
          const shouldRewrite = parsed.shouldRewrite === true || parsed.should_rewrite === true;
          const matchedText = String(parsed.matchedText || parsed.matched_text || "").trim();
          const matchedKeywords = Array.isArray(parsed.matchedKeywords || parsed.matched_keywords)
            ? (parsed.matchedKeywords || parsed.matched_keywords).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
            : String(parsed.matchedKeywords || parsed.matched_keywords || "")
              .split(/[,，\n]+/g)
              .map((item) => item.trim())
              .filter(Boolean)
              .slice(0, 12);
          const rewrite = shouldRewrite ? String(parsed.rewrite || parsed.suggestion || candidate).trim() : "";
          const merged = shouldRewrite ? String(parsed.merged || parsed.merged_content || rewrite).trim() : "";
          const reason = String(parsed.reason || "").trim();
          return { ok: true, documentName, original, shouldRewrite, matchedText, matchedKeywords, rewrite, merged, reason };
        })
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/review/decision") {
      readPayload()
        .then((payload) => {
          if (!payload.id) {
            sendJson(res, { error: "missing id" }, 400);
            return;
          }
          const decisions = loadDecisions();
          decisions[payload.id] = {
            status: payload.status || "pending",
            note: payload.note || "",
            unit: payload.unit || {},
            updated_at: new Date().toISOString(),
          };
          saveDecisions(decisions);
          sendJson(res, { ok: true });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/ragflow-chat-session") {
      readPayload()
        .then((payload) =>
          createRagflowChatSession(
            payload.chatId || RAGFLOW_AGENT_ID,
            payload.name || "悦拜 AI 工具平台会话"
          )
        )
        .then((session) => sendJson(res, { ok: true, session }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/ragflow-chat-completions") {
      readPayload()
        .then((payload) => proxyRagflowChatCompletion(res, payload))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/review/export") {
      const items = loadGovernedItems();
      const decisions = loadDecisions();
      const { markdown, count } = renderApprovedMarkdown(items, decisions);
      const exportDir = path.join(REVIEW_RUN_DIR, "approved_ragflow_markdown");
      fs.mkdirSync(exportDir, { recursive: true });
      const outPath = path.join(exportDir, "approved_knowledge.md");
      fs.writeFileSync(outPath, markdown, "utf-8");
      sendJson(res, { ok: true, count, path: outPath });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/review/import-ragflow") {
      importApprovedToRagflow()
        .then((result) => sendJson(res, result, result.ok ? 200 : 400))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/flowbot/knowledge-candidates/action") {
      readPayload()
        .then(async (payload) => {
          const action = String(payload.action || "").trim();
          if ((action === "approve" || action === "publish") && importRagflowEntries) {
            const candidateId = String(payload.candidateId || "").trim();
            const unit = {
              title: payload.title || candidateId || "群消息知识候选",
              unit_type: "group_message",
              visibility: payload.visibility || "public_reply",
              scope: payload.scope || "",
              user_questions: payload.user_questions || payload.userQuestions || [],
              answer_for_customer: payload.solution || payload.final_content || "",
              internal_notes: payload.problem || "",
              final_content: payload.solution || payload.final_content || "",
              source_evidence: payload.evidence || [],
              confidence: payload.confidence || "",
              review_reason: payload.reason || "群消息候选经人工确认入库。",
              tags: typeof payload.tags === "string" ? payload.tags.split(/[,，\n]+/g) : (payload.tags || []),
            };
            const entry = buildRagflowEntry({
              id: candidateId,
              source_kind: "flowbot",
              document_title: payload.roomName || payload.roomId || "群消息候选",
              source_path: [
                payload.sourceMessage?.traceId,
                ...(Array.isArray(payload.traceIds) ? payload.traceIds : []),
              ].filter(Boolean).join(","),
              unit,
            });
            const fileName = `flowbot-${candidateId || Date.now()}.md`;
            const imported = await importRagflowEntries([entry], {
              fileName,
              title: "悦拜群消息知识库",
            });
            if (!imported?.ok) {
              throw new Error(imported?.error || "导入 RAGFlow 失败");
            }
            let flowbotData = null;
            try {
              flowbotData = await proxyFlowbotCandidateAction({
                ...payload,
                action: "save",
                status: "published",
                publishedTarget: "ragflow",
                ragflowDocumentIds: imported.document_ids,
              });
            } catch (error) {
              flowbotData = { ok: false, error: error.message };
            }
            return { ok: true, data: flowbotData, imported };
          }
          if (
            (action === "update_existing" || action === "merge_existing")
            && importMarkdownToRagflow
            && String(payload.targetRagflowDocumentId || "").trim()
          ) {
            const targetRagflowDocumentId = String(
              payload.targetRagflowDocumentId || payload.targetKnowledgeId || ""
            ).trim();
            if (!targetRagflowDocumentId) {
              throw new Error("请选择要覆盖的 RAGFlow 文档");
            }
            const candidateId = String(payload.candidateId || "").trim();
            const unit = {
              title: payload.title || candidateId || "群消息知识候选",
              unit_type: "group_message",
              visibility: payload.visibility || "public_reply",
              scope: payload.scope || "",
              user_questions: payload.user_questions || payload.userQuestions || [],
              answer_for_customer: payload.solution || payload.final_content || "",
              internal_notes: payload.problem || "",
              final_content: payload.solution || payload.final_content || "",
              source_evidence: payload.evidence || [],
              confidence: payload.confidence || "",
              review_reason: payload.reason || "群消息候选经人工覆盖已有知识。",
              tags: typeof payload.tags === "string" ? payload.tags.split(/[,，\n]+/g) : (payload.tags || []),
            };
            const entry = buildRagflowEntry({
              id: candidateId,
              source_kind: "flowbot",
              document_title: payload.roomName || payload.roomId || "群消息候选",
              source_path: [
                payload.sourceMessage?.traceId,
                ...(Array.isArray(payload.traceIds) ? payload.traceIds : []),
              ].filter(Boolean).join(","),
              unit,
            });
            const fileName = String(
              payload.targetRagflowFileName || payload.targetKnowledgeFileName || `flowbot-${candidateId || Date.now()}.md`
            ).trim();
            if (ragflowJson) {
              const datasetId = String(getRagflowDatasetId?.() || "").trim();
              if (!datasetId) throw new Error("缺少 RAGFlow dataset_id。");
              await ragflowJson("DELETE", `/api/v1/datasets/${datasetId}/documents`, { ids: [targetRagflowDocumentId] })
                .catch(async (error) => {
                  if (!/datasets\/documents|404|not found/i.test(String(error?.message || error))) throw error;
                });
            }
            const imported = await importRagflowEntries([entry], {
              fileName,
              title: "悦拜群消息知识库",
            });
            if (!imported?.ok) {
              throw new Error(imported?.error || "覆盖导入 RAGFlow 失败");
            }
            let flowbotData = null;
            try {
              flowbotData = await proxyFlowbotCandidateAction({
                ...payload,
                action: "save",
                status: "updated_existing",
                publishedTarget: "ragflow",
                targetKnowledgeId: targetRagflowDocumentId,
                targetKnowledgeFileName: fileName,
                ragflowDocumentIds: imported.document_ids,
              });
            } catch (error) {
              flowbotData = { ok: false, error: error.message };
            }
            return { ok: true, data: flowbotData, imported, replaced_document_ids: [targetRagflowDocumentId] };
          }
          const data = await proxyFlowbotCandidateAction(payload);
          return { ok: true, data };
        })
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    return false;
  }

  return { handleKnowledgeRoute };
}

module.exports = { createKnowledgeRoutes };
