const crypto = require("crypto");

function toFiniteScore(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createKnowledgeSearchClients({
  MAXKB_BASE_URL,
  MAXKB_CACHE_TTL_MS,
  MAXKB_ENABLED,
  MAXKB_KNOWLEDGE_FILTER,
  MAXKB_KNOWLEDGE_PREFIX_FILTER,
  MAXKB_PASSWORD,
  MAXKB_SEARCH_MODE,
  MAXKB_SEARCH_SIMILARITY,
  MAXKB_TIMEOUT_MS,
  MAXKB_USERNAME,
  MAXKB_WORKSPACE_ID,
  RAGFLOW_BASE_URL,
  RAGFLOW_DATASET_IDS,
  RAGFLOW_DATASET_NAMES,
  RAGFLOW_ENABLED,
  RAGFLOW_LOGIN_EMAIL,
  RAGFLOW_LOGIN_PASSWORD,
  RAGFLOW_LOGIN_PUBLIC_KEY,
  RAGFLOW_SEARCH_SIMILARITY,
  RAGFLOW_TIMEOUT_MS,
  RAGFLOW_TOP_K,
  RAGFLOW_VECTOR_SIMILARITY_WEIGHT,
  hashText,
  normalizeKnowledgeSourceInput,
  requestJson,
  requestJsonWithHeaders,
  searchLocalKnowledgeDocuments,
  summarizeSnippet,
}) {
  const maxkbAuthCache = {
    token: "",
    expiresAt: 0,
  };
  const maxkbKnowledgeCache = {
    loadedAt: 0,
    items: null,
  };
  const ragflowAuthCache = {
    token: "",
    expiresAt: 0,
  };
  const ragflowDatasetCache = {
    loadedAt: 0,
    items: null,
    resolvedIds: null,
  };

  function buildMaxkbUrl(pathname, params = null) {
    const target = new URL(`${MAXKB_BASE_URL}${pathname}`);
    if (params && typeof params === "object") {
      for (const [key, value] of Object.entries(params)) {
        if (value == null || value === "") {
          continue;
        }
        target.searchParams.set(key, String(value));
      }
    }
    return target.toString();
  }

  async function requestMaxkbJson(method, pathname, payload = null, params = null, options = {}) {
    if (!MAXKB_ENABLED) {
      throw new Error("maxkb_disabled");
    }
    const attempt = async (forceRefresh = false) => {
      const token = await getMaxkbAccessToken(forceRefresh);
      return requestJsonWithHeaders(
        method,
        buildMaxkbUrl(pathname, params),
        payload,
        {
          Authorization: `Bearer ${token}`,
        },
        options.timeoutMs || MAXKB_TIMEOUT_MS,
      );
    };
    try {
      return await attempt(false);
    } catch (error) {
      const message = String(error?.message || "");
      if (!/http_401|http_403/i.test(message)) {
        throw error;
      }
      return attempt(true);
    }
  }

  async function getMaxkbAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && maxkbAuthCache.token && maxkbAuthCache.expiresAt > now) {
      return maxkbAuthCache.token;
    }
    const response = await requestJson(
      "POST",
      buildMaxkbUrl("/admin/api/user/login"),
      {
        username: MAXKB_USERNAME,
        password: MAXKB_PASSWORD,
      },
      MAXKB_TIMEOUT_MS,
    );
    const token = String(response?.data?.token || "").trim();
    if (!token) {
      throw new Error(`maxkb_token_missing:${JSON.stringify(response).slice(0, 500)}`);
    }
    maxkbAuthCache.token = token;
    maxkbAuthCache.expiresAt = now + Math.max(30 * 1000, MAXKB_CACHE_TTL_MS);
    return token;
  }

  function filterMaxkbKnowledges(items) {
    const list = Array.isArray(items) ? items : [];
    if (!MAXKB_KNOWLEDGE_FILTER.length && !MAXKB_KNOWLEDGE_PREFIX_FILTER.length) {
      return list;
    }
    const filterSet = new Set(MAXKB_KNOWLEDGE_FILTER.map((item) => item.toLowerCase()));
    const prefixList = MAXKB_KNOWLEDGE_PREFIX_FILTER.map((item) => item.toLowerCase());
    return list.filter((item) => {
      const id = String(item?.id || "").trim().toLowerCase();
      const name = String(item?.name || "").trim().toLowerCase();
      if (filterSet.has(id) || filterSet.has(name)) {
        return true;
      }
      return prefixList.some((prefix) => name.startsWith(prefix));
    });
  }

  async function listMaxkbKnowledges(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && Array.isArray(maxkbKnowledgeCache.items) && maxkbKnowledgeCache.loadedAt + MAXKB_CACHE_TTL_MS > now) {
      return maxkbKnowledgeCache.items;
    }
    const response = await requestMaxkbJson(
      "GET",
      `/admin/api/workspace/${encodeURIComponent(MAXKB_WORKSPACE_ID)}/knowledge`,
      null,
      {
        folder_id: MAXKB_WORKSPACE_ID,
      },
    );
    const items = filterMaxkbKnowledges(response?.data || []);
    maxkbKnowledgeCache.items = items;
    maxkbKnowledgeCache.loadedAt = now;
    return items;
  }

  function buildMaxkbHitItem(hit, knowledge, query) {
    const content = String(hit?.content || "").trim();
    const title = String(hit?.document_name || hit?.title || knowledge?.name || "未命名文档").trim();
    const paragraphId = String(hit?.id || "").trim();
    const documentId = String(hit?.document_id || "").trim();
    const similarity = toFiniteScore(hit?.similarity, 0);
    const comprehensiveScore = toFiniteScore(hit?.comprehensive_score, similarity);
    return {
      id: paragraphId || `${knowledge?.id || "maxkb"}:${documentId}:${hashText(title).slice(0, 8)}`,
      title,
      fileName: title,
      path: "",
      source: "maxkb",
      sourceLabel: "MaxKB",
      knowledgeId: String(knowledge?.id || "").trim(),
      knowledgeName: String(knowledge?.name || "").trim(),
      documentId,
      paragraphId,
      score: Number(comprehensiveScore.toFixed(4)),
      similarity: Number(similarity.toFixed(4)),
      snippet: summarizeSnippet(content || title, query),
    };
  }

  async function searchMaxkbKnowledgeDocuments(query, limit = 5) {
    const normalizedQuery = String(query || "").trim();
    if (!MAXKB_ENABLED || !normalizedQuery) {
      return {
        docs: [],
        meta: {
          enabled: MAXKB_ENABLED,
          mode: MAXKB_SEARCH_MODE,
          knowledgeCount: 0,
        },
      };
    }
    const knowledges = await listMaxkbKnowledges(false);
    if (!knowledges.length) {
      return {
        docs: [],
        meta: {
          enabled: true,
          mode: MAXKB_SEARCH_MODE,
          knowledgeCount: 0,
        },
      };
    }
    const perKnowledgeLimit = Math.max(1, Math.min(10, limit));
    const results = await Promise.allSettled(
      knowledges.map(async (knowledge) => {
        const response = await requestMaxkbJson(
          "POST",
          `/admin/api/workspace/${encodeURIComponent(MAXKB_WORKSPACE_ID)}/knowledge/${encodeURIComponent(String(knowledge.id || "").trim())}/hit_test`,
          {
            query_text: normalizedQuery,
            top_number: perKnowledgeLimit,
            similarity: MAXKB_SEARCH_SIMILARITY,
            search_mode: MAXKB_SEARCH_MODE,
          },
          null,
        );
        const hits = Array.isArray(response?.data) ? response.data : [];
        return hits.map((hit) => buildMaxkbHitItem(hit, knowledge, normalizedQuery));
      }),
    );
    const docs = [];
    const errors = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        docs.push(...result.value);
        continue;
      }
      errors.push({
        knowledgeId: String(knowledges[index]?.id || "").trim(),
        knowledgeName: String(knowledges[index]?.name || "").trim(),
        error: String(result.reason?.message || result.reason || "unknown_error"),
      });
    }
    docs.sort((left, right) => (
      toFiniteScore(right.score, 0) - toFiniteScore(left.score, 0)
        || toFiniteScore(right.similarity, 0) - toFiniteScore(left.similarity, 0)
        || left.title.localeCompare(right.title)
    ));
    return {
      docs: docs.slice(0, limit),
      meta: {
        enabled: true,
        mode: MAXKB_SEARCH_MODE,
        knowledgeCount: knowledges.length,
        errors,
      },
    };
  }

  async function requestRagflowJson(method, pathname, payload = null, options = {}) {
    if (!RAGFLOW_ENABLED) {
      throw new Error("ragflow_not_configured");
    }
    const target = new URL(`${RAGFLOW_BASE_URL}${pathname}`);
    const attempt = async (forceRefresh = false) => {
      const headers = {
        Authorization: `Bearer ${await getRagflowAuthorization(forceRefresh || Boolean(options.forceRefreshAuth))}`,
      };
      return requestJsonWithHeaders(method, target.toString(), payload, headers, options.timeoutMs || RAGFLOW_TIMEOUT_MS);
    };
    try {
      return await attempt(false);
    } catch (error) {
      const message = String(error?.message || "");
      if (!/http_401|http_403/i.test(message)) {
        throw error;
      }
      return attempt(true);
    }
  }

  async function getRagflowAuthorization(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && ragflowAuthCache.token && ragflowAuthCache.expiresAt > now) {
      return ragflowAuthCache.token;
    }
    const encodedPassword = Buffer.from(RAGFLOW_LOGIN_PASSWORD, "utf8").toString("base64");
    const publicKey = crypto.createPublicKey(RAGFLOW_LOGIN_PUBLIC_KEY);
    const encryptedPassword = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(encodedPassword, "utf8"),
    ).toString("base64");
    const httpResponse = await fetch(`${RAGFLOW_BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: RAGFLOW_LOGIN_EMAIL,
        password: encryptedPassword,
      }),
      signal: AbortSignal.timeout(RAGFLOW_TIMEOUT_MS),
    });
    const rawText = await httpResponse.text();
    const response = rawText ? JSON.parse(rawText) : {};
    if (!httpResponse.ok || Number(response?.code || 0) !== 0) {
      throw new Error(`ragflow_login_failed:${rawText.slice(0, 500)}`);
    }
    const token = String(
      httpResponse.headers.get("authorization")
        || httpResponse.headers.get("Authorization")
        || response?.data?.access_token
        || response?.data?.token
        || response?.access_token
        || response?.authorization
        || "",
    ).trim();
    if (!token) {
      throw new Error(`ragflow_login_token_missing:${JSON.stringify(response).slice(0, 500)}`);
    }
    ragflowAuthCache.token = token;
    ragflowAuthCache.expiresAt = now + 60 * 1000;
    return token;
  }

  async function listRagflowDatasets(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && Array.isArray(ragflowDatasetCache.items) && ragflowDatasetCache.loadedAt + 5 * 60 * 1000 > now) {
      return ragflowDatasetCache.items;
    }
    const response = await requestRagflowJson("GET", "/api/v1/datasets?page=1&page_size=100", null);
    const items = Array.isArray(response?.data) ? response.data : Array.isArray(response?.data?.datasets) ? response.data.datasets : [];
    ragflowDatasetCache.items = items;
    ragflowDatasetCache.loadedAt = now;
    return items;
  }

  async function resolveRagflowDatasetIds(forceRefresh = false) {
    if (Array.isArray(ragflowDatasetCache.resolvedIds) && ragflowDatasetCache.resolvedIds.length && !forceRefresh) {
      return ragflowDatasetCache.resolvedIds;
    }
    const resolved = [];
    if (RAGFLOW_DATASET_IDS.length) {
      resolved.push(...RAGFLOW_DATASET_IDS);
    }
    if (RAGFLOW_DATASET_NAMES.length) {
      const datasets = await listRagflowDatasets(forceRefresh);
      const nameMap = new Map(
        datasets.map((item) => [String(item?.name || "").trim().toLowerCase(), String(item?.id || "").trim()]),
      );
      for (const name of RAGFLOW_DATASET_NAMES) {
        const matchedId = nameMap.get(name.toLowerCase());
        if (matchedId) {
          resolved.push(matchedId);
        }
      }
    }
    ragflowDatasetCache.resolvedIds = Array.from(new Set(resolved.filter(Boolean)));
    return ragflowDatasetCache.resolvedIds;
  }

  function buildRagflowHitItem(hit, query) {
    const title = String(hit?.docnm_kwd || hit?.doc_name || hit?.document_name || "RAGFlow 文档").trim();
    const content = String(hit?.content_with_weight || hit?.content || "").trim();
    const snippet = summarizeSnippet(content, query, 320);
    const similarity = Math.max(
      toFiniteScore(hit?.similarity, 0),
      toFiniteScore(hit?.vector_similarity, 0),
      toFiniteScore(hit?.term_similarity, 0),
    );
    return {
      id: String(hit?.chunk_id || hit?.id || `${title}:${hashText(content).slice(0, 12)}`),
      title,
      fileName: title,
      path: String(hit?.doc_id || "").trim(),
      docId: String(hit?.doc_id || "").trim(),
      chunkId: String(hit?.chunk_id || hit?.id || "").trim(),
      source: "ragflow",
      sourceLabel: "RAGFlow",
      score: Number(similarity.toFixed(4)),
      similarity: Number(toFiniteScore(hit?.similarity, 0).toFixed(4)),
      vectorSimilarity: Number(toFiniteScore(hit?.vector_similarity, 0).toFixed(4)),
      termSimilarity: Number(toFiniteScore(hit?.term_similarity, 0).toFixed(4)),
      snippet,
      content,
    };
  }

  async function searchRagflowKnowledgeDocuments(query, limit = 5) {
    const normalizedQuery = String(query || "").trim();
    if (!RAGFLOW_ENABLED || !normalizedQuery) {
      return {
        docs: [],
        meta: {
          enabled: RAGFLOW_ENABLED,
          datasetIds: [],
        },
      };
    }
    const datasetIds = await resolveRagflowDatasetIds(false);
    if (!datasetIds.length) {
      return {
        docs: [],
        meta: {
          enabled: true,
          datasetIds: [],
        },
      };
    }
    const perDatasetLimit = Math.max(limit, RAGFLOW_TOP_K);
    const results = await Promise.allSettled(
      datasetIds.map((datasetId) => requestRagflowJson(
        "POST",
        `/api/v1/datasets/${encodeURIComponent(datasetId)}/search`,
        {
          question: normalizedQuery,
          top_k: perDatasetLimit,
          page: 1,
          size: perDatasetLimit,
          similarity_threshold: RAGFLOW_SEARCH_SIMILARITY,
          vector_similarity_weight: RAGFLOW_VECTOR_SIMILARITY_WEIGHT,
        },
        { timeoutMs: RAGFLOW_TIMEOUT_MS },
      )),
    );
    const chunks = [];
    const errors = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        chunks.push(...(Array.isArray(result.value?.data?.chunks) ? result.value.data.chunks : []));
        continue;
      }
      errors.push({
        datasetId: datasetIds[index],
        error: String(result.reason?.message || result.reason || "unknown_error"),
      });
    }
    const docs = [];
    const seen = new Set();
    for (const chunk of chunks
      .map((item) => buildRagflowHitItem(item, normalizedQuery))
      .sort((left, right) => toFiniteScore(right.score, 0) - toFiniteScore(left.score, 0))) {
      const dedupeKey = `${chunk.docId || chunk.title}::${chunk.chunkId || chunk.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      docs.push(chunk);
      if (docs.length >= limit) break;
    }
    return {
      docs,
      meta: {
        enabled: true,
        datasetIds,
        total: chunks.length,
        errors,
      },
    };
  }

  async function searchKnowledgeDocuments(query, limit = 5, options = {}) {
    const normalizedQuery = String(query || "").trim();
    const source = normalizeKnowledgeSourceInput(options.source);
    const docs = [];
    const sources = {};

    if (source === "all" || source === "ragflow") {
      try {
        const ragflow = await searchRagflowKnowledgeDocuments(normalizedQuery, limit);
        docs.push(...ragflow.docs);
        sources.ragflow = {
          enabled: ragflow.meta.enabled,
          datasetIds: ragflow.meta.datasetIds,
          total: ragflow.meta.total,
          count: ragflow.docs.length,
        };
      } catch (error) {
        sources.ragflow = {
          enabled: RAGFLOW_ENABLED,
          error: String(error?.message || error || "unknown_error"),
        };
      }
    }

    if (source === "all" || source === "local") {
      const localDocs = searchLocalKnowledgeDocuments(normalizedQuery, limit);
      docs.push(...localDocs);
      sources.local = {
        enabled: true,
        count: localDocs.length,
      };
    }

    if (source === "maxkb") {
      try {
        const maxkb = await searchMaxkbKnowledgeDocuments(normalizedQuery, limit);
        docs.push(...maxkb.docs);
        sources.maxkb = {
          enabled: maxkb.meta.enabled,
          mode: maxkb.meta.mode,
          knowledgeCount: maxkb.meta.knowledgeCount,
          count: maxkb.docs.length,
          errors: maxkb.meta.errors,
        };
      } catch (error) {
        sources.maxkb = {
          enabled: MAXKB_ENABLED,
          error: String(error?.message || error || "unknown_error"),
        };
      }
    }

    const rankKnowledgeHit = (item) => {
      const score = toFiniteScore(item?.score, 0);
      if (String(item?.source || "") === "ragflow" && score > 0) {
        return score + 0.45;
      }
      if (String(item?.source || "") === "local" && score > 0) {
        return score + 0.35;
      }
      return score;
    };
    const merged = docs
      .sort((left, right) => rankKnowledgeHit(right) - rankKnowledgeHit(left) || left.title.localeCompare(right.title))
      .slice(0, limit);

    return {
      query: normalizedQuery,
      limit,
      source,
      docs: merged,
      sources,
    };
  }

  return {
    buildMaxkbHitItem,
    buildRagflowHitItem,
    searchKnowledgeDocuments,
    searchMaxkbKnowledgeDocuments,
    searchRagflowKnowledgeDocuments,
    toFiniteScore,
  };
}

module.exports = {
  createKnowledgeSearchClients,
  toFiniteScore,
};
