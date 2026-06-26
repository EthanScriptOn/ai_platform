"use strict";

const { paginateItems, paginationMeta, readJsonl } = require("./data_utils");

function createFlowbotCandidatesService({
  DEFAULT_ROOM_ID,
  FLOWBOT_BASE_URL,
  FLOWBOT_CANDIDATES_PATH,
  fetchImpl = fetch,
}) {
  async function proxyFlowbotKnowledgeCandidates(
    roomId = DEFAULT_ROOM_ID,
    pagination = { page: 1, pageSize: 20 },
    { live = false, status = "" } = {}
  ) {
    if (live) {
      const limit = Math.min(Math.max(1, Number(pagination.page || 1) * Number(pagination.pageSize || 20)), 200);
      const params = new URLSearchParams({
        limit: String(limit),
      });
      if (roomId) params.set("roomId", roomId);
      const flowbotStatus = toFlowbotCandidateStatus(status);
      if (flowbotStatus) params.set("status", flowbotStatus);
      const response = await fetchImpl(
        `${FLOWBOT_BASE_URL}/flowbot/agent/knowledge-candidates?${params.toString()}`,
        { headers: { "Cache-Control": "no-store" } }
      );
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Flowbot HTTP ${response.status}`);
      const data = JSON.parse(text);
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const pageData = paginateItems(candidates, pagination);
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        needsAttention: [],
        progress: buildCandidateProgress(candidates),
        candidates: pageData.items,
        pagination: paginationMeta(pageData),
        live: true,
      };
    }

    if (!live) {
        const historicalCandidates = filterCandidatesByStatus(
          loadHistoricalFlowbotCandidates(roomId, { allowFallbackAll: false }),
          status
        );
      if (historicalCandidates.length > 0) {
        const pageData = paginateItems(historicalCandidates, pagination);
        return {
          ok: true,
          generatedAt: new Date().toISOString(),
          needsAttention: [],
          progress: buildCandidateProgress(historicalCandidates),
          candidates: pageData.items,
          pagination: paginationMeta(pageData),
          historical: true,
        };
      }

    }

    const dashboardLimit = Math.min(Math.max(1, pagination.pageSize || 20), 60);
    const response = await fetchImpl(
      `${FLOWBOT_BASE_URL}/flowbot/dashboard/data?roomId=${encodeURIComponent(roomId)}&limit=${dashboardLimit}`,
      { headers: { "Cache-Control": "no-store" } }
    );
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Flowbot HTTP ${response.status}`);
    const data = JSON.parse(text);
    const candidates = filterCandidatesByStatus(
      filterCandidatesByRoom(extractDashboardKnowledgeCandidates(data), roomId),
      status
    );
    if (candidates.length === 0) {
      const historicalCandidates = filterCandidatesByStatus(
        loadHistoricalFlowbotCandidates(roomId, { allowFallbackAll: false }),
        status
      );
      if (historicalCandidates.length > 0) {
        const pageData = paginateItems(historicalCandidates, pagination);
        return {
          ok: true,
          generatedAt: data.generatedAt,
          needsAttention: data.needsAttention,
          progress: buildCandidateProgress(historicalCandidates),
          candidates: pageData.items,
          pagination: paginationMeta(pageData),
          historical: true,
        };
      }
    }
    const pageData = paginateItems(candidates, pagination);
    return {
      ok: true,
      generatedAt: data.generatedAt,
      needsAttention: data.needsAttention,
      progress: buildCandidateProgress(candidates),
      candidates: pageData.items,
      pagination: paginationMeta(pageData),
    };
  }

  async function proxyFlowbotKnowledgeHarvestMessages(
    roomId = DEFAULT_ROOM_ID,
    pagination = { page: 1, pageSize: 20 },
    { status = "" } = {}
  ) {
    const limit = Math.min(Math.max(1, Number(pagination.page || 1) * Number(pagination.pageSize || 20)), 200);
    const params = new URLSearchParams({
      limit: String(limit),
    });
    if (roomId) params.set("roomId", roomId);
    if (status && status !== "all") params.set("status", status);
    const response = await fetchImpl(
      `${FLOWBOT_BASE_URL}/flowbot/knowledge-harvest/messages?${params.toString()}`,
      { headers: { "Cache-Control": "no-store" } }
    );
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Flowbot HTTP ${response.status}`);
    const data = JSON.parse(text);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const pageData = paginateItems(messages, pagination);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      status,
      roomId,
      messages: pageData.items,
      pagination: paginationMeta(pageData),
    };
  }

  function buildCandidateProgress(candidates, dashboardProgress = null) {
    if (dashboardProgress) {
      return {
        pending: dashboardProgress.knowledgePendingReviewTotal || 0,
        published: dashboardProgress.knowledgePublishedTotal || 0,
        rejected: dashboardProgress.knowledgeRejectedTotal || 0,
      };
    }
    return candidates.reduce(
      (acc, item) => {
        const status = String(item?.status || "");
        if (["pending_review", "reviewing", "draft", "pending"].includes(status)) acc.pending += 1;
        else if (["published", "approved"].includes(status)) acc.published += 1;
        else if (status === "rejected") acc.rejected += 1;
        return acc;
      },
      { pending: 0, published: 0, rejected: 0 }
    );
  }

  function extractDashboardKnowledgeCandidates(data = {}) {
    const latestCandidates = Array.isArray(data.latest?.knowledgeCandidates)
      ? data.latest.knowledgeCandidates
      : [];
    const attentionItems = Array.isArray(data.needsAttention?.items)
      ? data.needsAttention.items
      : [];
    const reviewCandidates = attentionItems
      .filter((item) => String(item?.kind || "") === "knowledge_review")
      .flatMap((item) => Array.isArray(item.items) ? item.items : []);
    const seen = new Set();
    return [...latestCandidates, ...reviewCandidates].filter((item) => {
      const key = String(item?.candidateId || item?.id || item?.traceIds?.[0] || JSON.stringify(item)).trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeCandidateStatus(status) {
    const raw = String(status || "");
    if (["pending_review", "reviewing", "draft", "pending", "changes_requested", "needs_review"].includes(raw)) {
      return "needs_review";
    }
    if (["published", "approved", "imported"].includes(raw)) return "imported";
    if (raw === "rejected") return "rejected";
    return raw;
  }

  function toFlowbotCandidateStatus(status) {
    const normalizedStatus = normalizeCandidateStatus(status);
    if (!normalizedStatus || normalizedStatus === "all") return "";
    if (normalizedStatus === "needs_review") return "pending_review";
    if (normalizedStatus === "imported") return "published";
    return normalizedStatus;
  }

  function filterCandidatesByStatus(candidates, status = "") {
    const normalizedStatus = normalizeCandidateStatus(status);
    if (!normalizedStatus || normalizedStatus === "all") return candidates;
    return candidates.filter((item) => normalizeCandidateStatus(item?.status) === normalizedStatus);
  }

  function filterCandidatesByRoom(candidates, roomId = "") {
    const normalizedRoomId = String(roomId || "").trim();
    if (!normalizedRoomId) return candidates;
    return candidates.filter((item) => String(item?.roomId || "").trim() === normalizedRoomId);
  }

  function loadHistoricalFlowbotCandidates(roomId = DEFAULT_ROOM_ID, { allowFallbackAll = true } = {}) {
    const candidates = readJsonl(FLOWBOT_CANDIDATES_PATH);
    if (!candidates.length) return [];
    const matched = candidates.filter((item) => !roomId || String(item.roomId || "") === String(roomId));
    const source = matched.length > 0 || !allowFallbackAll ? matched : candidates;
    return source
      .slice()
      .sort((a, b) => {
        const timeA = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
        const timeB = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
        return timeB - timeA;
      });
  }

  async function proxyFlowbotCandidateAction(payload) {
    const response = await fetchImpl(`${FLOWBOT_BASE_URL}/flowbot/agent/knowledge-candidates/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || text || `Flowbot HTTP ${response.status}`);
    }
    return data;
  }

  async function proxyFlowbotHarvestPromote(payload) {
    const response = await fetchImpl(`${FLOWBOT_BASE_URL}/flowbot/knowledge-harvest/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || text || `Flowbot HTTP ${response.status}`);
    }
    return data;
  }

  return {
    buildCandidateProgress,
    loadHistoricalFlowbotCandidates,
    proxyFlowbotCandidateAction,
    proxyFlowbotHarvestPromote,
    proxyFlowbotKnowledgeHarvestMessages,
    proxyFlowbotKnowledgeCandidates,
  };
}

module.exports = {
  createFlowbotCandidatesService,
};
