import React, { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Pagination, Select, Space, Tag, Typography, message } from "antd";
import { requestJson } from "../lib/apiClient";

const { Text, Title } = Typography;
const { TextArea } = Input;
const FLOWBOT_ROOM_FILTER_KEY = "yuebai-flowbot-knowledge-room-filter";

function lines(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join("\n");
  return value || "";
}

const statusText = {
  ready_to_import: "可直接入库",
  needs_review: "需审核",
  pending: "需审核",
  approved: "已入库",
  imported: "已入库",
  rejected: "不入库",
  ignored: "已忽略",
  failed: "扫描失败",
};

const harvestReviewStatuses = new Set(["ignored", "failed"]);

function getStatus(item) {
  const status = item?.decision?.status || item?.ingestion_status || "needs_review";
  if (["pending_review", "reviewing", "draft", "pending", "changes_requested"].includes(status)) return "needs_review";
  if (["published", "approved", "imported"].includes(status)) return "imported";
  if (["ignored", "failed"].includes(status)) return status;
  return status;
}

function getWorkingUnit(item) {
  return item?.decision?.unit || item?.unit || {};
}

function buildDraft(item) {
  const unit = getWorkingUnit(item);
  const finalContent =
    unit.final_content || unit.answer_for_customer || unit.internal_notes || lines(unit.steps);
  return {
    final_content: finalContent,
    visibility: unit.visibility || "public_reply",
    scope: unit.scope || "",
    user_questions: lines(unit.user_questions),
    answer_for_customer: unit.answer_for_customer || "",
    steps: lines(unit.steps),
    internal_notes: unit.internal_notes || "",
    tags: lines(unit.tags),
  };
}

function mapFlowbotCandidate(candidate) {
  const status =
    candidate.status === "published"
      ? "approved"
      : candidate.status === "rejected"
        ? "rejected"
        : "pending";
  return {
    id: candidate.candidateId,
    source_kind: "flowbot",
    document_title: candidate.roomName || candidate.roomId || "群消息知识候选",
    feishu_url: "",
    source_path: candidate.sourceMessage?.traceId || "",
    decision: {
      status,
    },
    raw: candidate,
    unit: {
      unit_type: "group_message",
      title: candidate.title || candidate.candidateId || "知识候选",
      user_questions: [candidate.question || candidate.title || ""].filter(Boolean),
      scope: candidate.scope || "",
      answer_for_customer: candidate.solution || "",
      internal_notes: candidate.problem || "",
      steps: [],
      source_evidence: candidate.evidence || [],
      confidence: candidate.confidence ?? "-",
      visibility: "public_reply",
      needs_human_review: true,
      review_reason: candidate.reason || "群聊中识别到可沉淀内容，需要人工确认后入库。",
      final_content: candidate.solution || "",
      tags: candidate.tags || [],
    },
  };
}

function mapFlowbotHarvestMessage(entry) {
  const status = String(entry.status || "pending");
  const reason = entry.lastError || entry.reason || "模型判断这条消息暂不适合沉淀。";
  return {
    id: entry.traceId,
    source_kind: "flowbot_harvest",
    document_title: entry.roomName || entry.roomId || "群消息扫描记录",
    feishu_url: "",
    source_path: entry.traceId || "",
    decision: {
      status,
    },
    raw: entry,
    unit: {
      unit_type: "group_message",
      title: entry.contentPreview || entry.traceId || "群消息扫描记录",
      user_questions: [],
      scope: entry.roomName || entry.roomId || "",
      answer_for_customer: entry.contentPreview || "",
      internal_notes: reason,
      steps: [],
      source_evidence: [entry.contentPreview].filter(Boolean),
      confidence: "-",
      visibility: "not_imported",
      needs_human_review: false,
      review_reason: reason,
      final_content: entry.contentPreview || "",
      tags: [],
    },
  };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      resolve(raw.includes(",") ? raw.split(",").pop() : raw);
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function readInitialFlowbotRoomFilter() {
  try {
    const raw = window.sessionStorage.getItem(FLOWBOT_ROOM_FILTER_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value?.roomId) return null;
    return {
      roomId: String(value.roomId || ""),
      roomName: String(value.roomName || value.roomId || ""),
      status: value.status || "needs_review",
    };
  } catch {
    return null;
  }
}

function groupRelatedRagflowDocuments(relatedKnowledge = []) {
  const grouped = new Map();
  for (const item of Array.isArray(relatedKnowledge) ? relatedKnowledge : []) {
    if (String(item?.source || "") !== "ragflow") continue;
    const docId = String(item.docId || item.path || item.id || "").trim();
    const fileName = String(item.fileName || item.title || "RAGFlow 文档").trim();
    const key = docId || fileName;
    if (!key) continue;
    const current = grouped.get(key) || {
      docId,
      fileName,
      title: fileName,
      score: 0,
      chunks: [],
    };
    current.score = Math.max(current.score, Number(item.score || item.similarity || 0));
    current.chunks.push({
      chunkId: item.chunkId || item.id || "",
      score: Number(item.score || item.similarity || 0),
      content: item.content || item.snippet || "",
    });
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((left, right) => right.score - left.score);
}

export default function KnowledgeWorkbench({ module, frameKey }) {
  const initialRoomFilter = useMemo(() => readInitialFlowbotRoomFilter(), []);
  const [items, setItems] = useState([]);
  const [sourceType, setSourceType] = useState("flowbot");
  const [activeId, setActiveId] = useState("");
  const [statusFilter, setStatusFilter] = useState(initialRoomFilter?.status || "needs_review");
  const [query, setQuery] = useState("");
  const [flowbotRoomFilter, setFlowbotRoomFilter] = useState(initialRoomFilter);
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [overwriteTargetKeys, setOverwriteTargetKeys] = useState([]);
  const [rewriteResults, setRewriteResults] = useState({});
  const [rewriteLoading, setRewriteLoading] = useState({});
  const [promoting, setPromoting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [flowbotMeta, setFlowbotMeta] = useState({ historical: false });
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [ragflowConfigOpen, setRagflowConfigOpen] = useState(false);
  const [ragflowConfigLoading, setRagflowConfigLoading] = useState(false);
  const [ragflowConfigSaving, setRagflowConfigSaving] = useState(false);
  const [ragflowConfig, setRagflowConfig] = useState({});
  const [api, contextHolder] = message.useMessage();

  const loadItems = async (selectId, nextPage = pagination.page, nextPageSize = pagination.pageSize) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        pageSize: String(nextPageSize),
      });
      if (sourceType === "docs" && statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      if (sourceType === "flowbot") {
        params.set("live", "1");
        if (flowbotRoomFilter?.roomId) {
          params.set("roomId", flowbotRoomFilter.roomId);
        }
        if (statusFilter !== "all") {
          params.set("status", statusFilter);
        }
      }
      const isHarvestReview = sourceType === "flowbot" && harvestReviewStatuses.has(statusFilter);
      const data = await requestJson(
        `${
          sourceType === "flowbot"
            ? (isHarvestReview ? "/api/flowbot/knowledge-harvest/messages" : "/api/flowbot/knowledge-candidates")
            : "/api/review/items"
        }?${params.toString()}`
      );
      const nextItems =
        sourceType === "flowbot"
          ? (isHarvestReview ? (data.messages || []).map(mapFlowbotHarvestMessage) : (data.candidates || []).map(mapFlowbotCandidate))
          : data.items || [];
      const nextPagination = data.pagination || {
        page: nextPage,
        pageSize: nextPageSize,
        total: nextItems.length,
        totalPages: Math.max(1, Math.ceil(nextItems.length / nextPageSize)),
      };
      setPagination(nextPagination);
      if (sourceType === "flowbot") {
        setFlowbotMeta({ historical: Boolean(data.historical) });
      } else {
        setFlowbotMeta({ historical: false });
      }
      setItems(nextItems);
      const nextId = selectId || activeId || nextItems[0]?.id || "";
      setActiveId(nextItems.some((item) => item.id === nextId) ? nextId : nextItems[0]?.id || "");
    } catch (error) {
      api.error(`加载审核数据失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItems("", 1, pagination.pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, sourceType, flowbotRoomFilter?.roomId]);

  useEffect(() => {
    loadItems("", 1, pagination.pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const clearFlowbotRoomFilter = () => {
    try {
      window.sessionStorage.removeItem(FLOWBOT_ROOM_FILTER_KEY);
    } catch {}
    setFlowbotRoomFilter(null);
    setPagination((current) => ({ ...current, page: 1 }));
  };

  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) || items[0],
    [items, activeId]
  );

  useEffect(() => {
    if (activeItem) {
      setDraft(buildDraft(activeItem));
      setRewriteResults({});
      setRewriteLoading({});
    }
  }, [activeItem?.id]);

  const counts = useMemo(
    () =>
      items.reduce((acc, item) => {
        const status = getStatus(item);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {}),
    [items]
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const unit = getWorkingUnit(item);
      const haystack = [
        item.document_title,
        unit.title,
        unit.scope,
        unit.review_reason,
        unit.answer_for_customer,
        unit.internal_notes,
        ...(unit.user_questions || []),
      ]
        .join(" ")
        .toLowerCase();
      return (statusFilter === "all" || getStatus(item) === statusFilter) && (!q || haystack.includes(q));
    });
  }, [items, query, statusFilter]);

  const editedUnit = () => {
    const unit = JSON.parse(JSON.stringify(getWorkingUnit(activeItem)));
    unit.final_content = draft.final_content?.trim() || "";
    unit.scope = draft.scope || unit.scope || "";
    unit.user_questions = String(draft.user_questions || "")
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    unit.tags = String(draft.tags || "")
      .split(/[\n,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    unit.answer_for_customer = unit.final_content;
    return unit;
  };

  const rewriteDocument = async (doc) => {
    if (!doc) return;
    const key = doc.docId || doc.fileName;
    const original = (doc.chunks || [])
      .slice(0, 4)
      .map((chunk) => chunk.content || "")
      .filter(Boolean)
      .join("\n\n");
    if (!original) {
      api.warning("这个文档没有可改写的命中原文");
      return;
    }
    setRewriteLoading((current) => ({ ...current, [key]: true }));
    try {
      const unit = editedUnit();
      const data = await requestJson("/api/flowbot/knowledge-rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentName: doc.fileName,
          original,
          candidate: unit.final_content || unit.answer_for_customer,
          questions: unit.user_questions || [],
          tags: unit.tags || [],
        }),
      });
      if (!data.ok) throw new Error(data.error || "智能改写失败");
      setRewriteResults((current) => ({ ...current, [key]: data }));
      api.success(data.shouldRewrite === false ? "这个文档不建议改写" : "已生成局部改写建议");
    } catch (error) {
      api.error(error.message);
    } finally {
      setRewriteLoading((current) => ({ ...current, [key]: false }));
    }
  };

  const saveDecision = async (status, options = {}) => {
    if (!activeItem) return;
    setSaving(true);
    try {
      if (sourceType === "flowbot") {
        const action =
          options.action || (status === "approved" ? "approve" : status === "rejected" ? "reject" : "save");
        const unit = editedUnit();
        unit.visibility = status === "approved" ? "public_reply" : unit.visibility || "needs_review";
        const data = await requestJson("/api/flowbot/knowledge-candidates/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateId: activeItem.id,
            action,
            title: unit.title,
            scope: unit.scope,
            user_questions: unit.user_questions,
            solution: unit.final_content || unit.answer_for_customer,
            problem: unit.internal_notes,
            reason: unit.review_reason || activeItem.raw?.reason || "",
            tags: unit.tags,
            evidence: unit.source_evidence || activeItem.raw?.evidence || [],
            confidence: unit.confidence || activeItem.raw?.confidence || "",
            visibility: unit.visibility || "public_reply",
            roomId: activeItem.raw?.roomId || "",
            roomName: activeItem.raw?.roomName || "",
            traceIds: activeItem.raw?.traceIds || [],
            sourceMessage: activeItem.raw?.sourceMessage || null,
            targetRagflowDocumentId: options.target?.docId || "",
            targetRagflowFileName: options.target?.fileName || "",
            targetKnowledgeId: options.target?.docId || "",
            targetKnowledgeFileName: options.target?.fileName || "",
            reviewer: "悦拜AI工具平台",
            reviewNote: options.action === "update_existing" ? "人工确认覆盖 RAGFlow 命中文档。" : "",
          }),
        });
        if (!data.ok) throw new Error(data.error || "保存失败");
        api.success(
          options.action === "update_existing"
            ? "已覆盖并重新入库"
            : status === "approved" ? "已按统一格式入 RAGFlow" : "已保存处理状态"
        );
        setOverwriteOpen(false);
        await loadItems("", pagination.page, pagination.pageSize);
        return;
      }

      const data = await requestJson("/api/review/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeItem.id,
          status,
          unit: {
            ...editedUnit(),
            visibility: status === "approved" ? "public_reply" : getWorkingUnit(activeItem).visibility || "needs_review",
          },
        }),
      });
      if (!data.ok) throw new Error(data.error || "保存失败");
      if (status === "approved") {
        const imported = await requestJson("/api/review/import-ragflow", { method: "POST" });
        if (!imported.ok) throw new Error(imported.error || "导入 RAGFlow 失败");
        api.success(`已确认并同步到 RAGFlow（${imported.count} 条）`);
      } else {
        api.success("已保存处理状态");
      }
      await loadItems(activeItem.id, pagination.page, pagination.pageSize);
    } catch (error) {
      api.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const promoteHarvestMessage = async () => {
    if (!activeItem?.raw?.traceId) return;
    setPromoting(true);
    try {
      const data = await requestJson("/api/flowbot/knowledge-harvest/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: activeItem.raw.traceId,
          title: activeItem.raw.contentPreview || "",
          content: activeItem.raw.contentPreview || "",
          reason: activeItem.raw.reason || activeItem.raw.lastError || "",
        }),
      });
      if (!data.ok) throw new Error(data.error || "转入审核失败");
      api.success(data.alreadyPromoted ? "这条消息已在待审核中" : "已转入待审核");
      setStatusFilter("needs_review");
    } catch (error) {
      api.error(error.message);
    } finally {
      setPromoting(false);
    }
  };

  const exportApproved = async () => {
    if (sourceType === "flowbot") {
      api.info("群消息候选由 Flowbot 原有入库接口处理，无需单独导出。");
      return;
    }
    const data = await requestJson("/api/review/export", { method: "POST" });
    if (!data.ok) {
      api.error(data.error || "导出失败");
      return;
    }
    api.success(`已导出 ${data.count} 条已通过知识`);
  };

  const uploadDocument = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const data = await requestJson("/api/review/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          contentBase64,
        }),
      });
      if (!data.ok) throw new Error(data.error || "上传治理失败");
      api.success(`千问治理完成，生成 ${data.count} 条知识候选`);
      setSourceType("docs");
      await loadItems("", 1, pagination.pageSize);
    } catch (error) {
      api.error(error.message);
    } finally {
      setUploading(false);
    }
  };

  const loadRagflowConfig = async () => {
    setRagflowConfigLoading(true);
    try {
      const data = await requestJson("/api/ragflow/config");
      if (!data.ok) throw new Error(data.error || "读取 RAGFlow 设置失败");
      setRagflowConfig({
        ...data.config,
        apiToken: "",
        loginPassword: "",
        shareAuth: "",
      });
    } catch (error) {
      api.error(error.message);
    } finally {
      setRagflowConfigLoading(false);
    }
  };

  const openRagflowConfig = async () => {
    setRagflowConfigOpen(true);
    await loadRagflowConfig();
  };

  const saveRagflowConfig = async () => {
    setRagflowConfigSaving(true);
    try {
      const { tokenFile: _tokenFile, ...payload } = ragflowConfig;
      const data = await requestJson("/api/ragflow/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!data.ok) throw new Error(data.error || "保存 RAGFlow 设置失败");
      setRagflowConfig({
        ...data.config,
        apiToken: "",
        loginPassword: "",
        shareAuth: "",
      });
      api.success("已保存，重启平台服务后生效");
      setRagflowConfigOpen(false);
    } catch (error) {
      api.error(error.message);
    } finally {
      setRagflowConfigSaving(false);
    }
  };

  const unit = getWorkingUnit(activeItem);
  const status = getStatus(activeItem);
  const isImported = status === "imported";
  const isHarvestRecord = activeItem?.source_kind === "flowbot_harvest";
  const rawCandidate = activeItem?.raw || {};
  const relatedRagflowDocuments = groupRelatedRagflowDocuments(rawCandidate.relatedKnowledge);
  const selectedOverwriteTargets = relatedRagflowDocuments.filter((item) =>
    overwriteTargetKeys.includes(item.docId || item.fileName)
  );

  return (
    <div className="knowledge-workbench">
      {contextHolder}
      <section className="review-pane">
        <div className="review-toolbar">
          <div className="review-toolbar-main">
            <Title level={5}>知识候选</Title>
            <div className="knowledge-stats">
              <span>当前页 {items.length}</span>
              <span>共 {pagination.total || items.length}</span>
              <span>可直接入库 {counts.ready_to_import || 0}</span>
              <span>需审核 {counts.needs_review || 0}</span>
              <span>已入库 {counts.imported || counts.approved || 0}</span>
              <span>已忽略 {counts.ignored || 0}</span>
              <span>失败 {counts.failed || 0}</span>
            </div>
            {sourceType === "flowbot" && flowbotMeta.historical ? (
              <Text type="secondary" className="knowledge-toolbar-note">
                当前展示的是服务器同步下来的历史群消息候选样本。
              </Text>
            ) : null}
            {sourceType === "flowbot" && flowbotRoomFilter?.roomId ? (
              <Text type="secondary" className="knowledge-toolbar-note">
                当前只看：{flowbotRoomFilter.roomName || flowbotRoomFilter.roomId}
                <Button type="link" size="small" onClick={clearFlowbotRoomFilter}>
                  查看全部群
                </Button>
              </Text>
            ) : null}
          </div>
          <Space className="review-toolbar-actions">
            <Button size="small" onClick={() => loadItems(activeItem?.id)} loading={loading}>
              刷新
            </Button>
            <Button size="small" onClick={exportApproved}>
              导出
            </Button>
            <Button size="small" onClick={openRagflowConfig}>
              RAGFlow 设置
            </Button>
            {sourceType === "docs" ? (
              <Button size="small" loading={uploading}>
                <label style={{ cursor: uploading ? "default" : "pointer" }}>
                  上传治理
                  <input type="file" hidden disabled={uploading} onChange={uploadDocument} />
                </label>
              </Button>
            ) : null}
          </Space>
        </div>
        <div className="source-switch">
          <Button
            size="small"
            type={sourceType === "flowbot" ? "primary" : "default"}
            onClick={() => {
              setSourceType("flowbot");
              setActiveId("");
              setPagination((current) => ({ ...current, page: 1 }));
            }}
          >
            群消息候选
          </Button>
          <Button
            size="small"
            type={sourceType === "docs" ? "primary" : "default"}
            onClick={() => {
              setSourceType("docs");
              setActiveId("");
              setPagination((current) => ({ ...current, page: 1 }));
            }}
          >
            飞书文档候选
          </Button>
        </div>
        <div className="review-filters">
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "ready_to_import", label: "可直接入库" },
              { value: "needs_review", label: "需审核" },
              { value: "imported", label: "已入库" },
              { value: "rejected", label: "不入库" },
              { value: "ignored", label: "已忽略" },
              { value: "failed", label: "扫描失败" },
              { value: "all", label: "全部" },
            ]}
          />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档/歧义" />
        </div>
        <div className="review-list">
          {filteredItems.map((item) => {
            const itemUnit = getWorkingUnit(item);
            const itemStatus = getStatus(item);
            return (
              <button
                className={`review-item ${item.id === activeItem?.id ? "active" : ""}`}
                key={item.id}
                onClick={() => setActiveId(item.id)}
              >
                <span>{itemUnit.title}</span>
                <small>
                  {item.document_title} · 置信度 {itemUnit.confidence}
                </small>
                <em>{statusText[itemStatus] || itemStatus}</em>
              </button>
            );
          })}
        </div>
        <Pagination
          className="review-pagination"
          current={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          showSizeChanger
          size="small"
          pageSizeOptions={[10, 20, 50, 100]}
          onChange={(nextPage, nextPageSize) => loadItems("", nextPage, nextPageSize)}
        />
      </section>

      <section className="governance-pane">
        {activeItem ? (
          <>
            <div className="governance-head">
              <div>
                <Title level={4}>{unit.title}</Title>
                <Text className="governance-source">
                  {activeItem.document_title}
                  {activeItem.feishu_url ? (
                    <>
                      {" · "}
                      <a href={activeItem.feishu_url} target="_blank" rel="noreferrer">
                        原始飞书文档
                      </a>
                    </>
                  ) : null}
                </Text>
              </div>
              <Space wrap>
                <Tag>{statusText[status] || status}</Tag>
                <Tag>{unit.unit_type}</Tag>
                {rawCandidate.knowledgeStatus ? <Tag>{rawCandidate.knowledgeStatus}</Tag> : null}
                {rawCandidate.recommendation ? <Tag>{rawCandidate.recommendation}</Tag> : null}
              </Space>
            </div>

            {isHarvestRecord ? (
              <div className="harvest-readonly">
                <div>
                  <span>原消息</span>
                  <p>{rawCandidate.contentPreview || "-"}</p>
                </div>
                <div>
                  <span>{status === "failed" ? "失败原因" : "忽略原因"}</span>
                  <p>{rawCandidate.lastError || rawCandidate.reason || "-"}</p>
                </div>
                <div>
                  <span>处理信息</span>
                  <p>
                    状态：{statusText[status] || status}；尝试次数：{rawCandidate.attempts ?? 0}；
                    更新时间：{rawCandidate.updatedAt || "-"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="review-editor">
                <label className="review-answer-field">
                  <span>最终入库答案</span>
                  <TextArea
                    className="final-content review-answer-input"
                    value={draft.final_content}
                    onChange={(event) => setDraft({ ...draft, final_content: event.target.value })}
                    placeholder="这里写真正要给用户看的答案"
                  />
                </label>
                <div className="review-support-panel">
                  <label className="review-support-row">
                    <span>用户可能怎么问</span>
                    <TextArea
                      className="review-plain-control"
                      value={draft.user_questions}
                      onChange={(event) => setDraft({ ...draft, user_questions: event.target.value })}
                      placeholder="一行一个，例如：云发单有哪些线路？"
                      autoSize={{ minRows: 2, maxRows: 4 }}
                    />
                  </label>
                  <label className="review-support-row">
                    <span>适用场景</span>
                    <Input
                      className="review-plain-control"
                      value={draft.scope}
                      onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
                      placeholder="例如：云发单系统 / 线路配置"
                    />
                  </label>
                  <label className="review-support-row">
                    <span>关键词</span>
                    <TextArea
                      className="review-plain-control"
                      value={draft.tags}
                      onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                      placeholder="逗号或换行分隔"
                      autoSize={{ minRows: 2, maxRows: 3 }}
                    />
                  </label>
                </div>
              </div>
            )}

            <details className="review-details">
              <summary>
                <span>模型判断与原文证据</span>
                <em>{(unit.source_evidence || []).length} 条证据</em>
              </summary>
              <div className="review-details-grid">
                <section>
                  <h3>模型哪里不确定</h3>
                  <p>{unit.review_reason || (status === "ready_to_import" ? "模型判断这条知识证据明确，可直接入 RAGFlow。" : "模型认为这条知识的可见性或内容准确性需要人工确认。")}</p>
                </section>
                {rawCandidate.existingKnowledgeSummary || rawCandidate.delta ? (
                  <section>
                    <h3>已有知识与本次变化</h3>
                    <p>{rawCandidate.existingKnowledgeSummary || "没有匹配到明确的已有知识。"}</p>
                    <p>{rawCandidate.delta ? `本次变化：${rawCandidate.delta}` : "本次没有明显新增内容。"}</p>
                  </section>
                ) : null}
                <section>
                  <h3>原文证据</h3>
                  <ul>
                    {(unit.source_evidence || []).map((evidence) => (
                      <li key={evidence}>{evidence}</li>
                    ))}
                  </ul>
                </section>
              </div>
            </details>

            {isImported ? (
              <div className="review-actions">
                <Tag color="success">已入库</Tag>
              </div>
            ) : !isHarvestRecord ? (
              <div className="review-actions">
                <Button type="primary" loading={saving} onClick={() => saveDecision("approved")}>
                  入库
                </Button>
                <Button
                  loading={saving}
                  disabled={!relatedRagflowDocuments.length}
                  onClick={() => {
                    setOverwriteTargetKeys(relatedRagflowDocuments.map((item) => item.docId || item.fileName).filter(Boolean));
                    setOverwriteOpen(true);
                  }}
                >
                  覆盖
                </Button>
                <Button danger loading={saving} onClick={() => saveDecision("rejected")}>
                  不入库
                </Button>
              </div>
            ) : (
              <div className="review-actions">
                <Button type="primary" loading={promoting} onClick={promoteHarvestMessage}>
                  转为待审核
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">暂无待审核知识。</div>
        )}
      </section>
      <Modal
        title="查看关联文档与改写建议"
        open={overwriteOpen}
        onCancel={() => setOverwriteOpen(false)}
        confirmLoading={saving}
        okText="关闭"
        cancelText="取消"
        width={860}
        onOk={() => setOverwriteOpen(false)}
      >
        <div className="overwrite-dialog">
          <div className="overwrite-targets">
            {relatedRagflowDocuments.map((doc) => {
              const key = doc.docId || doc.fileName;
              const checked = overwriteTargetKeys.includes(key);
              return (
                <button
                  className={`overwrite-target ${checked ? "active" : ""}`}
                  key={key}
                  type="button"
                  onClick={() => setOverwriteTargetKeys((current) =>
                    current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
                  )}
                >
                  <input type="checkbox" checked={checked} readOnly />
                  <strong>{doc.fileName}</strong>
                  <span>相似度 {doc.score ? doc.score.toFixed(2) : "-"}</span>
                </button>
              );
            })}
          </div>
          <div className="overwrite-preview">
            {selectedOverwriteTargets.length ? selectedOverwriteTargets.map((doc) => (
              <section key={doc.docId || doc.fileName}>
                <div className="overwrite-section-head">
                  <h3>{doc.fileName}</h3>
                  <Button
                    size="small"
                    loading={Boolean(rewriteLoading[doc.docId || doc.fileName])}
                    onClick={() => rewriteDocument(doc)}
                  >
                    智能改写
                  </Button>
                </div>
                <div className="overwrite-change four">
                  <div>
                    <span>原文</span>
                    {(doc.chunks || []).slice(0, 4).map((chunk) => (
                      <p key={chunk.chunkId || chunk.content}>{chunk.content || "-"}</p>
                    ))}
                  </div>
                  <div>
                    <span>命中的原句</span>
                    <p className={rewriteResults[doc.docId || doc.fileName]?.shouldRewrite === false ? "rewrite-skip" : ""}>
                      {rewriteResults[doc.docId || doc.fileName]?.matchedText || "点击“智能改写”后定位。"}
                    </p>
                    {rewriteResults[doc.docId || doc.fileName]?.matchedKeywords?.length ? (
                      <div className="matched-keywords">
                        {rewriteResults[doc.docId || doc.fileName].matchedKeywords.map((word) => (
                          <em key={word}>{word}</em>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <span>建议改写</span>
                    <p className={rewriteResults[doc.docId || doc.fileName]?.shouldRewrite === false ? "rewrite-skip" : ""}>
                      {rewriteResults[doc.docId || doc.fileName]?.shouldRewrite === false
                        ? "不建议改这个文档"
                        : rewriteResults[doc.docId || doc.fileName]?.rewrite || "点击“智能改写”后生成。"}
                    </p>
                  </div>
                  <div>
                    <span>合并后的内容</span>
                    <p className={rewriteResults[doc.docId || doc.fileName]?.shouldRewrite === false ? "rewrite-skip" : ""}>
                      {rewriteResults[doc.docId || doc.fileName]?.shouldRewrite === false
                        ? "原文和候选知识主题不一致，不生成合并内容。"
                        : rewriteResults[doc.docId || doc.fileName]?.merged || "点击“智能改写”后生成。"}
                    </p>
                  </div>
                </div>
                {rewriteResults[doc.docId || doc.fileName]?.reason ? (
                  <p className="overwrite-reason">{rewriteResults[doc.docId || doc.fileName].reason}</p>
                ) : null}
              </section>
            )) : (
              <section>
                <h3>未选择文档</h3>
                <p>左侧勾选一个或多个文档后，这里会展示“原文片段 -&gt; 建议内容”。</p>
              </section>
            )}
          </div>
        </div>
      </Modal>
      <Modal
        title="RAGFlow 设置"
        open={ragflowConfigOpen}
        onCancel={() => setRagflowConfigOpen(false)}
        onOk={saveRagflowConfig}
        confirmLoading={ragflowConfigSaving}
        okText="保存"
        cancelText="取消"
        width={720}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Text type="secondary">
            保存后写入数据库，重启平台服务后生效。
          </Text>
          <Input
            disabled={ragflowConfigLoading}
            value={ragflowConfig.baseUrl || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, baseUrl: event.target.value })}
            placeholder="RAGFlow 服务地址，例如 http://127.0.0.1:8080"
          />
          <Input
            disabled={ragflowConfigLoading}
            value={ragflowConfig.agentId || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, agentId: event.target.value })}
            placeholder="RAGFlow 问答应用 ID，可不填"
          />
          <Input
            disabled={ragflowConfigLoading}
            value={ragflowConfig.datasetId || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, datasetId: event.target.value })}
            placeholder="知识库数据集 ID，入 RAGFlow 时会用它"
          />
          <Input.Password
            disabled={ragflowConfigLoading}
            value={ragflowConfig.apiToken || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, apiToken: event.target.value })}
            placeholder={
              ragflowConfig.tokenConfigured
                ? `API Token 已配置：${ragflowConfig.tokenMasked}（存数据库）`
                : "API Token，保存后存入数据库"
            }
          />
          <Input
            disabled={ragflowConfigLoading}
            value={ragflowConfig.loginEmail || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, loginEmail: event.target.value })}
            placeholder="RAGFlow 登录邮箱，可不填"
          />
          <Input.Password
            disabled={ragflowConfigLoading}
            value={ragflowConfig.loginPassword || ""}
            onChange={(event) => setRagflowConfig({ ...ragflowConfig, loginPassword: event.target.value })}
            placeholder={ragflowConfig.loginPasswordConfigured ? "登录密码已配置，如需修改再填写" : "RAGFlow 登录密码"}
          />
          <details className="review-details">
            <summary>
              <span>高级配置</span>
              <em>一般不用改</em>
            </summary>
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <Input
                disabled={ragflowConfigLoading}
                value={ragflowConfig.chatUrl || ""}
                onChange={(event) => setRagflowConfig({ ...ragflowConfig, chatUrl: event.target.value })}
                placeholder="平台问答入口，不填会按 RAGFlow 地址自动生成"
              />
              <TextArea
                disabled={ragflowConfigLoading}
                value={ragflowConfig.loginPublicKey || ""}
                onChange={(event) => setRagflowConfig({ ...ragflowConfig, loginPublicKey: event.target.value })}
                placeholder={ragflowConfig.loginPublicKeyConfigured ? "登录公钥已配置，如需修改再填写" : "RAGFlow 登录公钥"}
                autoSize={{ minRows: 2, maxRows: 5 }}
              />
              <Input.Password
                disabled={ragflowConfigLoading}
                value={ragflowConfig.shareAuth || ""}
                onChange={(event) => setRagflowConfig({ ...ragflowConfig, shareAuth: event.target.value })}
                placeholder={ragflowConfig.shareAuthConfigured ? "共享登录串已配置，如需修改再填写" : "共享登录串，可不填"}
              />
            </Space>
          </details>
        </Space>
      </Modal>
    </div>
  );
}
