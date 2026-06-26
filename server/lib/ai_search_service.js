"use strict";

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function slugifyDirection(label, index) {
  const raw = String(label || "").trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `direction-${index + 1}`;
}

function buildDirectionPrompt(query, previousDirections = [], preferenceChip = "") {
  const priorLabels = Array.isArray(previousDirections)
    ? previousDirections.map((item) => String(item?.label || item || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  const prompt = [
    "你是一个搜索方向规划器。",
    "用户给了一个查询词，你的任务不是回答，而是给出用户可能想深入的方向选项。",
    "不要把方向局限在投资财经；方向也可能是基本情况、最新动态、业务线、产品、技术、地址官网、历史、人物信息、生活娱乐等。",
    "如果查询本身已经包含明显方向，也要保留该方向，并补充相邻方向供用户多选。",
    "方向之间要有跨度，不要只做同义改写；优先覆盖主线、邻近线、外部变量、争议点、应用面、比较面。",
    "输出严格 JSON，不要 Markdown。",
    '格式：{"query":"","chips":["",""],"directions":[{"label":"","reason":"","keywords":["",""]}]}',
    "要求：",
    "1. chips 返回 3 到 6 个短标签，用于前端帮助用户快速切换搜索偏好。",
    "2. chips 要和 directions 有明显区分；chips 更像视角标签，不是完整方向句子。",
    "1. directions 返回 6 到 10 个方向。",
    "2. label 要短，适合前端按钮展示。",
    "3. reason 一句话解释为什么这个方向值得选。",
    "4. keywords 是这个方向下后续扩展检索会关心的词，2 到 5 个。",
    `用户查询：${query}`,
  ];
  if (preferenceChip) {
    prompt.push(`当前用户偏好的视角标签：${preferenceChip}`);
    prompt.push("请适度向这些视角倾斜，但不要把所有方向都做成同一类。");
  }
  if (priorLabels.length) {
    prompt.push(`上一批已给过的方向：${priorLabels.join(" / ")}`);
    prompt.push("这次请尽量避开上一批重复方向；允许保留 1 到 2 个核心主方向，但至少一半以上必须是新的视角。");
  }
  return prompt.join("");
}

function normalizeChips(parsed) {
  const rawItems = Array.isArray(parsed?.chips) ? parsed.chips : [];
  const chips = [];
  const seen = new Set();
  for (const item of rawItems) {
    const label = String(item || "").trim();
    const key = label.toLowerCase();
    if (!label || label.length > 12 || seen.has(key)) continue;
    seen.add(key);
    chips.push(label);
    if (chips.length >= 6) break;
  }
  return chips;
}

function normalizeDirections(query, parsed) {
  const rawItems = Array.isArray(parsed?.directions) ? parsed.directions : [];
  const directions = [];
  const seen = new Set();
  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index] || {};
    const label = String(item.label || "").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 5)
      : [];
    directions.push({
      id: slugifyDirection(label, index),
      label,
      reason: String(item.reason || "").trim(),
      keywords,
    });
  }

  if (!directions.length) {
    return {
      query,
      chips: ["综合", "最新", "基本情况"],
      directions: [
        { id: "basic", label: "基本情况", reason: "先看对象的官网、简介、地址或核心背景。", keywords: ["官网", "简介"] },
        { id: "recent", label: "最近动态", reason: "优先看近期发生了什么。", keywords: ["最近", "新闻"] },
        { id: "business", label: "业务方向", reason: "拆分对象的主要业务面。", keywords: ["业务", "产品"] },
        { id: "deep", label: "深度信息", reason: "如果你想继续深挖，可从技术、供应链或历史切入。", keywords: ["技术", "历史"] },
      ],
    };
  }
  return {
    query,
    chips: normalizeChips(parsed),
    directions: directions.slice(0, 8),
  };
}

function buildFocusedQueryPrompt({ query, directions }) {
  const picked = directions.map((item) => item.label).join(" / ");
  const directionJson = JSON.stringify(directions, null, 2);
  return [
    "你是一个检索动作规划器。",
    "用户已经给定原始查询和方向选择。请基于这些方向，生成适合搜索系统使用的聚焦检索计划。",
    "不要回答问题，只生成检索计划。",
    "输出严格 JSON，不要 Markdown。",
    '格式：{"focused_query":"","why":"","search_terms":["",""],"notes":["",""]}',
    "focused_query 要是单条自然语言检索表达，兼顾中文和必要英文专有名词。",
    "search_terms 返回 3 到 8 个后续应该关注的关键词。",
    `原始查询：${query}`,
    `已选方向：${picked}`,
    `方向详情：${directionJson}`,
  ].join("");
}

function normalizeFocusedPlan(query, directions, parsed) {
  const labels = directions.map((item) => item.label).join(" ");
  const focusedQuery = String(parsed?.focused_query || "").trim() || `${query} ${labels}`.trim();
  const searchTerms = Array.isArray(parsed?.search_terms)
    ? parsed.search_terms.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const notes = Array.isArray(parsed?.notes)
    ? parsed.notes.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    focusedQuery,
    why: String(parsed?.why || "").trim(),
    searchTerms,
    notes,
  };
}

function buildRetrievalQuery(query, focusedPlan) {
  const base = String(query || "").trim();
  const searchTerms = Array.isArray(focusedPlan?.searchTerms) ? focusedPlan.searchTerms : [];
  const compactTerms = searchTerms
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const joined = [base, ...compactTerms].join(" ").trim();
  return joined || base;
}

function buildDirectionRetrievalQuery(query, direction) {
  const base = String(query || "").trim();
  const label = String(direction?.label || "").trim();
  const keywords = Array.isArray(direction?.keywords)
    ? direction.keywords.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  return [base, label, ...keywords].join(" ").trim();
}

function dedupeQueryTasks(tasks) {
  const seen = new Set();
  const deduped = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const query = String(task?.query || "").trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...task, query });
  }
  return deduped;
}

function normalizeSourceItems(items, maxItems = 18) {
  const normalized = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const url = String(item?.url || "").trim();
    const title = String(item?.title || "").trim();
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    normalized.push({
      id: normalized.length + 1,
      title,
      url,
      source: String(item?.source || "").trim(),
      publishedAt: String(item?.published_at || "").trim(),
      summary: String(item?.summary || "").trim(),
      evidenceLevel: String(item?.evidence_level || "").trim(),
      searchProvider: String(item?.search_provider || "").trim(),
    });
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function buildArticlePlan(directions, searchCount, searchDepth) {
  const directionCount = Math.max(1, Array.isArray(directions) ? directions.length : 0);
  const normalizedSearchCount = clampInt(searchCount, 1, 6, 2);
  const normalizedSearchDepth = clampInt(searchDepth, 1, 5, 2);
  const desiredSections = Math.min(8, Math.max(4, Math.ceil(directionCount * 0.75)));
  const overallLimit = Math.min(20, Math.max(10, normalizedSearchCount * normalizedSearchDepth * 4 + Math.max(0, directionCount - 4)));
  const perQueryLimit = Math.min(10, Math.max(4, Math.ceil(overallLimit / Math.max(2, normalizedSearchCount + normalizedSearchDepth))));
  const sourceCap = Math.min(30, Math.max(12, overallLimit + Math.max(4, directionCount)));
  return {
    desiredSections,
    overallLimit,
    perQueryLimit,
    sourceCap,
  };
}

function mergeProviderStats(target, incoming) {
  const next = target || {};
  for (const [provider, stats] of Object.entries(incoming || {})) {
    const bucket = next[provider] || { queries: 0, items: 0, errors: 0 };
    bucket.queries += Number(stats?.queries || 0);
    bucket.items += Number(stats?.items || 0);
    bucket.errors += Number(stats?.errors || 0);
    next[provider] = bucket;
  }
  return next;
}

function buildArticlePrompt({ query, directions, focusedPlan, unifiedResult, sources, articlePlan }) {
  const slimResult = {
    query: unifiedResult.query,
    time_window: unifiedResult.time_window,
    query_plan: unifiedResult.query_plan,
    branches: unifiedResult.branches,
    selected_branches: unifiedResult.selected_branches,
    provider_stats: unifiedResult.provider_stats,
    section_status: unifiedResult.section_status,
  };
  return [
    "你是一个研究型写作者。",
    "请根据搜索结果写一篇中文文章式回答。",
    "文章要像高质量研究笔记，不要写成项目符号堆砌，也不要写成营销稿。",
    "必须尽量引用给定来源。每段都可以附 citations 数组，填写来源编号。",
    "如果某个判断只是推断，不要写成确定事实。",
    "优先覆盖用户已选方向；如果某些方向证据不足，不要直接忽略，要明确写出证据不足或仅能弱判断。",
    "如果多个方向高度相关，可以合并，但不要把很多方向压成过少的段落。",
    "输出严格 JSON，不要 Markdown。",
    '格式：{"title":"","lead":"","sections":[{"heading":"","paragraphs":[{"text":"","citations":[1,2]}]}],"closing":"","citation_ids":[1,2,3]}',
    `sections 优先写 ${articlePlan?.desiredSections || 5} 到 ${Math.min(8, (articlePlan?.desiredSections || 5) + 1)} 段。`,
    "如果来源足够，每节可写 1 到 2 个自然段。",
    "paragraph text 用自然段，不要带编号。",
    `原始查询：${query}`,
    `已选方向：${directions.map((item) => item.label).join(" / ")}`,
    `聚焦检索计划：${JSON.stringify(focusedPlan, null, 2)}`,
    `检索摘要：${JSON.stringify(slimResult, null, 2)}`,
    `来源池：${JSON.stringify(sources, null, 2)}`,
  ].join("");
}

function normalizeArticle(query, directions, focusedPlan, parsed, sources) {
  const sourceMap = new Map(sources.map((item) => [item.id, item]));
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const normalizedSections = sections
    .map((section) => {
      const heading = String(section?.heading || "").trim();
      const paragraphs = Array.isArray(section?.paragraphs)
        ? section.paragraphs
            .map((paragraph) => {
              const text = String(paragraph?.text || "").trim();
              if (!text) return null;
              const citations = Array.isArray(paragraph?.citations)
                ? paragraph.citations
                    .map((id) => Number(id))
                    .filter((id) => sourceMap.has(id))
                    .slice(0, 4)
                : [];
              return { text, citations };
            })
            .filter(Boolean)
        : [];
      if (!heading || !paragraphs.length) return null;
      return { heading, paragraphs };
    })
    .filter(Boolean);

  const usedIds = new Set();
  normalizedSections.forEach((section) => {
    section.paragraphs.forEach((paragraph) => {
      paragraph.citations.forEach((id) => usedIds.add(id));
    });
  });

  return {
    title: String(parsed?.title || "").trim() || `${query} · ${directions.map((item) => item.label).join(" / ")}`,
    lead: String(parsed?.lead || "").trim() || focusedPlan.why || "",
    sections: normalizedSections,
    closing: String(parsed?.closing || "").trim(),
    references: Array.from(usedIds).map((id) => sourceMap.get(id)).filter(Boolean),
  };
}

function normalizeSearchConfig(rawConfig = {}) {
  const writer = rawConfig?.writer || {};
  const searchCenter = rawConfig?.searchCenter || {};
  return {
    writer: {
      provider: String(writer.provider || "qwen"),
      model: String(writer.model || "").trim(),
    },
    searchCenter: {
      baseUrl: String(searchCenter.baseUrl || "").trim(),
      apiKey: String(searchCenter.apiKey || "").trim(),
      webSearchModel: String(searchCenter.webSearchModel || "").trim(),
      queryExpandModel: String(searchCenter.queryExpandModel || "").trim(),
      sslVerify: Boolean(searchCenter.sslVerify),
      apiKeyConfigured: Boolean(searchCenter.apiKeyConfigured),
    },
  };
}

function buildIntelHeaders(searchCenter = {}) {
  const headers = {};
  if (searchCenter.baseUrl) headers["x-intel-openai-base-url"] = searchCenter.baseUrl;
  if (searchCenter.apiKey) headers["x-intel-openai-api-key"] = searchCenter.apiKey;
  if (typeof searchCenter.sslVerify === "boolean") {
    headers["x-intel-openai-ssl-verify"] = String(Boolean(searchCenter.sslVerify));
  }
  return headers;
}

function createAiSearchService({
  callQwenChat,
  fetchImpl = fetch,
  intelApiBaseUrl,
  model,
}) {
  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    const payload = text ? safeJsonParse(text, {}) : {};
    if (!response.ok) {
      throw new Error(payload?.error || payload?.detail?.error || text || `HTTP ${response.status}`);
    }
    return payload;
  }

  async function fetchSearchConfig() {
    const payload = await fetchJson(`${intelApiBaseUrl.replace(/\/$/, "")}/api/search/config`);
    const defaults = normalizeSearchConfig({
      writer: {
        provider: "qwen",
        model,
      },
      searchCenter: {
        baseUrl: payload?.llm?.base_url,
        apiKeyConfigured: payload?.llm?.api_key_configured,
        webSearchModel: payload?.llm?.web_search_model,
        queryExpandModel: payload?.llm?.query_expand_model,
        sslVerify: payload?.llm?.ssl_verify,
      },
    });
    return {
      defaults,
      capabilities: {
        writerProviders: [
          { value: "qwen", label: "千问" },
        ],
        searchCenterProviders: [
          { value: "openai_compatible", label: "OpenAI 兼容 Web Search" },
        ],
      },
    };
  }

  async function generateDirections(query, runtimeConfig = {}, previousDirections = [], preferenceChip = "") {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw new Error("请输入搜索词");
    const config = normalizeSearchConfig(runtimeConfig);
    const raw = await callQwenChat({
      model: config.writer.model || model,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: buildDirectionPrompt(normalizedQuery, previousDirections, preferenceChip) }],
      timeoutMs: 90000,
    });
    return normalizeDirections(normalizedQuery, safeJsonParse(raw, {}));
  }

  async function buildFocusedPlan(query, directions, runtimeConfig = {}) {
    const config = normalizeSearchConfig(runtimeConfig);
    const raw = await callQwenChat({
      model: config.writer.model || model,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: buildFocusedQueryPrompt({ query, directions }) }],
      timeoutMs: 90000,
    });
    return normalizeFocusedPlan(query, directions, safeJsonParse(raw, {}));
  }

  async function runUnifiedSearchTask({
    task,
    articlePlan,
    runtimeConfig,
    searchCount,
    searchDepth,
    onProgress,
    taskIndex,
    taskCount,
  }) {
    const params = new URLSearchParams({
      q: task.query,
      days: "30",
      limit: String(task.limit || articlePlan.overallLimit),
      mode: searchDepth >= 3 ? "deep" : "standard",
      include_x: "false",
      include_raw_web: "false",
      include_b_fallback: "true",
      include_query_expansion: "true",
      max_expansion_queries: String(clampInt(searchCount, 1, 6, 2)),
      max_followup_queries: String(clampInt(searchCount, 1, 6, 2)),
      max_rounds: String(clampInt(searchDepth, 1, 5, 2)),
      round1_per_query_limit: String(task.perQueryLimit || articlePlan.perQueryLimit),
      followup_per_query_limit: String(task.followupPerQueryLimit || Math.max(3, articlePlan.perQueryLimit - 1)),
    });
    if (runtimeConfig.searchCenter.webSearchModel) params.set("web_search_model", runtimeConfig.searchCenter.webSearchModel);
    if (runtimeConfig.searchCenter.queryExpandModel) params.set("query_expand_model", runtimeConfig.searchCenter.queryExpandModel);

    if (typeof onProgress === "function") {
      onProgress({
        stage: "searching",
        message: `正在检索 ${task.title}（${taskIndex + 1}/${taskCount}）`,
        search: {
          currentTask: task.title,
          focusedQuery: task.query,
          searchCount: clampInt(searchCount, 1, 6, 2),
          searchDepth: clampInt(searchDepth, 1, 5, 2),
          overallLimit: task.limit || articlePlan.overallLimit,
          perQueryLimit: task.perQueryLimit || articlePlan.perQueryLimit,
          taskIndex: taskIndex + 1,
          taskCount,
        },
      });
    }

    const payload = await fetchJson(`${intelApiBaseUrl.replace(/\/$/, "")}/api/search/unified?${params.toString()}`, {
      headers: buildIntelHeaders(runtimeConfig.searchCenter),
    });
    return {
      task,
      payload,
    };
  }

  async function searchAndDraftArticle({
    query,
    directions,
    searchCount,
    searchDepth,
    runtimeConfig = {},
    onProgress,
  }) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw new Error("请输入搜索词");
    const pickedDirections = Array.isArray(directions) ? directions.filter((item) => item && item.label) : [];
    if (!pickedDirections.length) throw new Error("请至少选择一个方向");
    const config = normalizeSearchConfig(runtimeConfig);
    const articlePlan = buildArticlePlan(pickedDirections, searchCount, searchDepth);

    if (typeof onProgress === "function") {
      onProgress({
        stage: "planning",
        message: "正在规划检索表达",
      });
    }

    const focusedPlan = await buildFocusedPlan(normalizedQuery, pickedDirections, config);
    const retrievalQuery = buildRetrievalQuery(normalizedQuery, focusedPlan);
    if (typeof onProgress === "function") {
      onProgress({
        stage: "focused_plan",
        message: "已生成检索计划",
        focusedPlan: { ...focusedPlan, retrievalQuery },
      });
    }
    const branchLimit = Math.max(8, articlePlan.perQueryLimit + 2);
    const searchTasks = dedupeQueryTasks([
      {
        type: "main",
        title: "主查询",
        query: retrievalQuery,
        limit: articlePlan.overallLimit,
        perQueryLimit: articlePlan.perQueryLimit,
        followupPerQueryLimit: Math.max(3, articlePlan.perQueryLimit - 1),
      },
      ...pickedDirections.map((direction) => ({
        type: "direction",
        title: direction.label,
        directionLabel: direction.label,
        query: buildDirectionRetrievalQuery(normalizedQuery, direction),
        limit: branchLimit,
        perQueryLimit: Math.max(3, articlePlan.perQueryLimit - 1),
        followupPerQueryLimit: Math.max(2, articlePlan.perQueryLimit - 2),
      })),
    ]);

    const branchRuns = [];
    const aggregateItems = [];
    const aggregateErrors = [];
    const aggregateProviderStats = {};
    const aggregateRoundTraces = [];
    const aggregateBranches = [];
    const aggregateSelectedBranches = [];
    const aggregateTimeWindows = [];
    const aggregateQueryPlans = [];

    for (let index = 0; index < searchTasks.length; index += 1) {
      const task = searchTasks[index];
      const result = await runUnifiedSearchTask({
        task,
        articlePlan,
        runtimeConfig: config,
        searchCount,
        searchDepth,
        onProgress,
        taskIndex: index,
        taskCount: searchTasks.length,
      });
      const payload = result.payload || {};
      branchRuns.push({
        task: result.task,
        itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
        errorCount: Array.isArray(payload.errors) ? payload.errors.length : 0,
      });
      aggregateItems.push(...(Array.isArray(payload.items) ? payload.items : []));
      aggregateErrors.push(...(Array.isArray(payload.errors) ? payload.errors : []).map((error) => ({ task: result.task.title, ...error })));
      mergeProviderStats(aggregateProviderStats, payload.provider_stats || {});
      aggregateRoundTraces.push(
        ...(Array.isArray(payload.round_traces) ? payload.round_traces : []).map((trace) => ({
          ...trace,
          task: result.task.title,
          taskType: result.task.type,
        }))
      );
      if (Array.isArray(payload.branches)) {
        aggregateBranches.push(...payload.branches);
      }
      if (Array.isArray(payload.selected_branches)) {
        aggregateSelectedBranches.push(...payload.selected_branches);
      }
      if (payload.time_window) {
        aggregateTimeWindows.push(payload.time_window);
      }
      if (payload.query_plan) {
        aggregateQueryPlans.push({
          task: result.task.title,
          taskType: result.task.type,
          plan: payload.query_plan,
        });
      }
    }

    const unifiedResult = {
      items: aggregateItems,
      errors: aggregateErrors,
      provider_stats: aggregateProviderStats,
      round_traces: aggregateRoundTraces,
      branches: Array.from(new Set(aggregateBranches.map((item) => JSON.stringify(item)))).map((item) => safeJsonParse(item, item)),
      selected_branches: Array.from(new Set(aggregateSelectedBranches.map((item) => String(item || "").trim()).filter(Boolean))),
      time_window: aggregateTimeWindows[0] || null,
      query_plan: {
        primary: {
          focused_query: retrievalQuery,
          search_terms: focusedPlan.searchTerms,
          notes: focusedPlan.notes,
        },
        queries: searchTasks.map((task, index) => ({
          query: task.query,
          why: index === 0 ? "main_query" : `direction:${task.title}`,
          priority: index + 1,
        })),
        tasks: searchTasks.map((task) => ({
          title: task.title,
          type: task.type,
          query: task.query,
          limit: task.limit,
        })),
        upstream: aggregateQueryPlans,
      },
      branch_runs: branchRuns,
    };

    const sources = normalizeSourceItems(unifiedResult.items || [], articlePlan.sourceCap);
    const providerStats = unifiedResult.provider_stats || {};
    const providerErrorCount = Object.values(providerStats).reduce((sum, item) => sum + Number(item?.errors || 0), 0);
    if (!sources.length) {
      const firstError = Array.isArray(unifiedResult.errors) && unifiedResult.errors.length
        ? JSON.stringify(unifiedResult.errors[0])
        : "";
      throw new Error(
        `本次检索没有拿到有效来源（provider errors: ${providerErrorCount}）${firstError ? `；首个错误：${firstError}` : ""}`
      );
    }
    if (typeof onProgress === "function") {
      onProgress({
        stage: "search_complete",
        message: "联网检索完成，正在整理材料",
        searchResult: {
          providerStats,
          queryPlan: unifiedResult.query_plan || {},
          roundTraces: unifiedResult.round_traces || [],
          sourceCount: sources.length,
          branchRuns,
        },
      });
    }

    const rawArticle = await callQwenChat({
      model: config.writer.model || model,
      temperature: 0.25,
      responseFormat: { type: "json_object" },
      messages: [{ role: "user", content: buildArticlePrompt({ query: normalizedQuery, directions: pickedDirections, focusedPlan, unifiedResult, sources, articlePlan }) }],
      timeoutMs: 120000,
    });
    const article = normalizeArticle(normalizedQuery, pickedDirections, focusedPlan, safeJsonParse(rawArticle, {}), sources);
    if (typeof onProgress === "function") {
      onProgress({
        stage: "article_complete",
        message: "文章已生成",
      });
    }

    return {
      query: normalizedQuery,
      focusedPlan,
      retrievalQuery,
      directions: pickedDirections,
      budget: {
        searchCount: clampInt(searchCount, 1, 6, 2),
        searchDepth: clampInt(searchDepth, 1, 5, 2),
      },
      article,
      searchResult: {
        timeWindow: unifiedResult.time_window,
        providerStats,
        branches: unifiedResult.branches || [],
        selectedBranches: unifiedResult.selected_branches || [],
        roundTraces: unifiedResult.round_traces || [],
        queryPlan: unifiedResult.query_plan || {},
        errors: unifiedResult.errors || [],
        sources,
      },
    };
  }

  return {
    fetchSearchConfig,
    generateDirections,
    searchAndDraftArticle,
  };
}

module.exports = {
  createAiSearchService,
};
