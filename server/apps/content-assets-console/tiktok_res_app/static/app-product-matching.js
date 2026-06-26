const MATCH_PLATFORM_OPTIONS = [
  {
    id: "douyin",
    label: "抖音",
    sub: "已接入，第一版按抖音商品名查询抖音精选联盟商品库",
  },
  {
    id: "jd",
    label: "京东",
    sub: "已接入，第一版按抖音商品名查询京东商品库",
  },
  {
    id: "taobao",
    label: "淘宝",
    sub: "已接入，第一版按抖音商品名查询淘宝联盟商品库",
  },
];

function matchPlatformLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const option = MATCH_PLATFORM_OPTIONS.find((item) => item.id === raw || item.label === raw);
  return option?.label || raw;
}

function formatMatchPlatformList(platforms) {
  const labels = Array.from(
    new Set((Array.isArray(platforms) ? platforms : []).map(matchPlatformLabel).filter(Boolean))
  );
  return labels.join("、");
}

function productMatchSourceCount(input = {}, result = {}) {
  const resultCount = Number(result?.product_count || 0);
  if (resultCount > 0) return resultCount;
  return Array.isArray(input?.products) ? input.products.length : 0;
}

function normalizeProductIdentity(product = {}) {
  const raw = product.raw && typeof product.raw === "object" ? product.raw : {};
  const id = product.product_id
    || product.source_product_id
    || product.promotion_id
    || raw.product_id
    || raw.source_product_id
    || raw.promotion_id
    || product.title
    || "";
  return String(id).trim();
}

function productMatchSignature(products = [], source = "") {
  const ids = (Array.isArray(products) ? products : [])
    .map(normalizeProductIdentity)
    .filter(Boolean)
    .sort();
  return JSON.stringify({
    source: String(source || "").trim(),
    count: ids.length,
    ids,
  });
}

function jobProductMatchSignature(job) {
  const input = job?.input || {};
  return productMatchSignature(input.products || [], input.source || "");
}

function findLatestProductMatchJob(payload = {}) {
  const signature = productMatchSignature(payload.products || [], payload.source || "");
  const candidates = jobItems
    .filter((job) => job?.type === "product_match")
    .filter((job) => jobProductMatchSignature(job) === signature)
    .sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
  return candidates[0] || null;
}

function attachProductMatchJobToState(state, job) {
  if (!state || !job) return false;
  const nextKey = JSON.stringify({
    id: job.id,
    status: job.status,
    updated_at: job.updated_at,
    error: job.error || "",
    result: job.result || null,
  });
  if (nextKey === state.matchJobRenderKey) return false;
  state.matchJobId = job.id || "";
  state.matchJobStatus = job.status || "";
  state.matchJobError = job.error || "";
  state.matchJobResult = job.result || null;
  state.matchJobUpdatedAt = job.updated_at || null;
  state.matchJobRenderKey = nextKey;
  state.matchOptions = {
    ...(state.matchOptions || defaultMatchOptions()),
    platforms: Array.isArray(job.input?.platforms) && job.input.platforms.length
      ? job.input.platforms
      : (state.matchOptions?.platforms || defaultMatchOptions().platforms),
    same_product: Boolean(job.input?.conditions?.same_product ?? state.matchOptions?.same_product ?? true),
    similar_product: Boolean(job.input?.conditions?.similar_product ?? state.matchOptions?.similar_product ?? true),
    same_category: Boolean(job.input?.conditions?.same_category ?? state.matchOptions?.same_category ?? false),
    best_reviewed: Boolean(job.input?.conditions?.best_reviewed ?? state.matchOptions?.best_reviewed ?? false),
    price_float_percent: job.input?.conditions?.price_float_percent ?? state.matchOptions?.price_float_percent ?? "",
    limit_per_product: String(job.input?.conditions?.limit_per_product || state.matchOptions?.limit_per_product || "3"),
  };
  return true;
}

function productMatchSummaryLine(input = {}, result = {}) {
  const sourceCount = productMatchSourceCount(input, result);
  const platformsText = formatMatchPlatformList(result?.platforms_requested || input?.platforms || []);
  const parts = [];
  if (sourceCount > 0) parts.push(`来源抖音商品 ${sourceCount} 个`);
  if (platformsText) parts.push(`平台：${platformsText}`);
  return parts.join(" · ");
}

function findProductPreviewByMatchId(matchId) {
  for (const [previewId, state] of productPreviewStates.entries()) {
    if (state?.matchId === matchId) return { previewId, state };
  }
  return { previewId: "", state: null };
}

function rerenderProductPreview(previewId) {
  const state = productPreviewStates.get(previewId);
  if (!state) return;
  state.matchOptions = captureMatchFormState(state.matchId) || state.matchOptions || defaultMatchOptions();
  const node = document.querySelector(`[data-product-preview="${CSS.escape(previewId)}"]`);
  if (node) node.outerHTML = renderProductPreview(previewId);
}

function syncProductMatchPreviewsFromJobs() {
  for (const [previewId, state] of productPreviewStates.entries()) {
    if (!state?.matchJobId) {
      const payload = productMatchPayloads.get(state?.matchId || "");
      const latestJob = findLatestProductMatchJob(payload || {});
      if (latestJob && attachProductMatchJobToState(state, latestJob)) {
        rerenderProductPreview(previewId);
      }
      continue;
    }
    state.matchOptions = captureMatchFormState(state.matchId) || state.matchOptions || defaultMatchOptions();
    const job = jobItems.find((item) => item.id === state.matchJobId);
    if (!job) continue;
    if (attachProductMatchJobToState(state, job)) {
      rerenderProductPreview(previewId);
    }
  }
}

function defaultMatchOptions() {
  return {
    platforms: ["jd"],
    same_product: true,
    similar_product: true,
    same_category: false,
    best_reviewed: false,
    price_float_percent: "",
    limit_per_product: "3",
  };
}

function captureMatchFormState(matchId) {
  const root = document.querySelector(`[data-match-id="${CSS.escape(matchId)}"]`);
  if (!root) return null;
  const valueOf = (name, fallback = "") => root.querySelector(`[data-match-field="${name}"]`)?.value ?? fallback;
  const checked = (name) => Boolean(root.querySelector(`[data-match-field="${name}"]`)?.checked);
  const platforms = Array.from(root.querySelectorAll("[data-match-platform]"))
    .filter((node) => node.checked)
    .map((node) => node.dataset.matchPlatform)
    .filter(Boolean);
  return {
    platforms,
    same_product: checked("same_product"),
    similar_product: checked("similar_product"),
    same_category: checked("same_category"),
    best_reviewed: checked("best_reviewed"),
    price_float_percent: valueOf("price_float_percent"),
    limit_per_product: "3",
  };
}

function renderProductCards(items) {
  return items.map((item) => {
    const price = item.show_price_yuan || item.min_price_yuan || "";
    const img = item.cover ? `<img src="${escapeHtml(item.cover)}" alt="">` : "<div class='product-placeholder'></div>";
    return `<div class="product">${img}<div class="product-title">${escapeHtml(item.title || "")}</div><div class="price">${price ? "¥" + escapeHtml(price) : ""}</div></div>`;
  }).join("");
}

function renderSourceProductCards(items) {
  return items.map((item) => {
    const title = item.title || "抖音商品";
    const price = item.show_price_yuan || item.min_price_yuan || item.price_yuan || "";
    const productId = item.product_id || item.source_product_id || "";
    const img = item.cover
      ? `<img src="${escapeHtml(item.cover)}" alt="">`
      : "<div class='source-product-placeholder'></div>";
    const badges = [
      "抖音源商品",
      price ? `¥${price}` : "",
      productId ? `ID ${productId}` : "",
    ].filter(Boolean);
    return `<div class="source-product">
      ${img}
      <div class="source-product-copy">
        <div class="source-product-title">${escapeHtml(title)}</div>
        <div class="source-product-badges">${badges.map((text) => `<div class="badge">${escapeHtml(text)}</div>`).join("")}</div>
        <div class="source-product-meta">${escapeHtml(price ? `抖音商品价格 ¥${price}` : "抖音商品")}</div>
      </div>
    </div>`;
  }).join("");
}

function renderProductPagination(previewId, currentPage, totalPages, startIndex, endIndex, totalCount) {
  if (totalPages <= 1) {
    return `<div class="product-pagination"><div class="product-page-status">共 ${totalCount} 个商品</div></div>`;
  }
  const pages = buildProductPageList(currentPage, totalPages);
  return `<div class="product-pagination">
    <div class="product-page-status">第 ${currentPage} / ${totalPages} 页 · 当前展示 ${startIndex}-${endIndex} 个，共 ${totalCount} 个商品</div>
    <div class="product-page-actions">
      <button class="secondary product-page-btn" type="button" ${currentPage <= 1 ? "disabled" : ""} onclick="changeProductPreviewPage('${escapeHtml(previewId)}', ${currentPage - 1})">上一页</button>
      ${pages.map((page) => page === "ellipsis"
        ? `<span class="product-page-ellipsis">...</span>`
        : `<button class="secondary product-page-btn ${page === currentPage ? "active" : ""}" type="button" onclick="changeProductPreviewPage('${escapeHtml(previewId)}', ${page})">${page}</button>`).join("")}
      <button class="secondary product-page-btn" type="button" ${currentPage >= totalPages ? "disabled" : ""} onclick="changeProductPreviewPage('${escapeHtml(previewId)}', ${currentPage + 1})">下一页</button>
    </div>
  </div>`;
}

function renderInlineMatchMetrics(items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<div class="match-inline-metrics">${items.map(([label, value]) => `
    <div class="match-inline-metric">
      <div class="match-inline-metric-label">${escapeHtml(label)}</div>
      <div class="match-inline-metric-value">${escapeHtml(value)}</div>
    </div>
  `).join("")}</div>`;
}

function renderInlineProductMatchState(state) {
  if (!state?.matchJobId && !state?.matchJobResult && !state?.matchJobError) return "";
  const result = state.matchJobResult || null;
  const status = String(state.matchJobStatus || (result ? "completed" : ""));
  const requestedPlatforms = formatMatchPlatformList(result?.platforms_requested || state.matchOptions?.platforms || []);
  const queriedPlatforms = formatMatchPlatformList(result?.platforms_queried || []);
  const sourceCount = productMatchSourceCount({ products: state.products }, result || {});
  const matchTotal = Array.isArray(result?.results) ? result.results.length : sourceCount;
  const metaBits = [];
  if (requestedPlatforms) metaBits.push(`平台：${requestedPlatforms}`);
  metaBits.push("每个平台固定展示前 3 个商品");
  if (state.matchJobId) metaBits.push(`任务 ${state.matchJobId}`);
  if (state.matchJobUpdatedAt) metaBits.push(`最近更新 ${formatTime(state.matchJobUpdatedAt * 1000)}`);
  const metaLine = metaBits.join(" · ");

  if (status === "queued" || status === "running") {
    const title = status === "queued" ? "任务已创建，正在排队" : "任务正在执行，结果会自动回填";
    return `<div class="match-inline-output">
      <div class="match-inline-state running">
        <div class="match-inline-state-title">${escapeHtml(title)}</div>
        <div class="match-inline-state-sub">${escapeHtml(metaLine)}</div>
      </div>
    </div>`;
  }

  if (status === "failed") {
    const title = "本次匹配失败";
    const body = state.matchJobError || "服务暂时没有返回更详细的报错。";
    return `<div class="match-inline-output">
      <div class="match-inline-state failed">
        <div class="match-inline-state-title">${escapeHtml(title)}</div>
        <div class="match-inline-state-sub">${escapeHtml(metaLine)}</div>
        <div class="match-inline-state-sub">${escapeHtml(body)}</div>
      </div>
    </div>`;
  }

  const metrics = [
    ["任务状态", "已完成"],
    ["源商品", `${sourceCount} 个`],
    ["命中", `${Number(result?.matched_count || 0)} / ${matchTotal} 个`],
  ];
  if (queriedPlatforms) metrics.splice(1, 0, ["实际查询", queriedPlatforms]);
  const resultHtml = renderProductMatchResult(result, { title: "匹配结果" })
    || renderDetailSection("匹配结果", `<div class="result-item"><strong>完成</strong>当前没有返回候选商品。</div>`, `${sourceCount} 个商品`);
  return `<div class="match-inline-output">
    <div class="match-inline-state">
      <div class="match-inline-state-title">本次匹配已完成</div>
      <div class="match-inline-state-sub">${escapeHtml(metaLine)}</div>
      ${renderInlineMatchMetrics(metrics)}
    </div>
    ${resultHtml}
  </div>`;
}

function shouldRenderStandaloneSourceProducts(state) {
  if (!state) return false;
  const status = String(state.matchJobStatus || "");
  const results = Array.isArray(state.matchJobResult?.results) ? state.matchJobResult.results : [];
  if (status === "completed" && results.length) return false;
  return true;
}

function renderProductPreview(previewId) {
  const state = productPreviewStates.get(previewId);
  if (!state?.products?.length) return "";
  const matchOptions = state.matchOptions || defaultMatchOptions();
  const selectedPlatforms = Array.isArray(matchOptions.platforms) && matchOptions.platforms.length
    ? matchOptions.platforms
    : defaultMatchOptions().platforms;
  const isMatchRunning = ["queued", "running"].includes(String(state.matchJobStatus || ""));
  const totalPages = Math.max(1, Math.ceil(state.products.length / state.pageSize));
  const currentPage = Math.min(Math.max(Number(state.page) || 1, 1), totalPages);
  const start = (currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, state.products.length);
  state.page = currentPage;
  const lab = `<div class="match-lab" data-match-id="${escapeHtml(state.matchId)}">
    <div class="match-lab-head">
      <div>
        <div class="match-lab-title">匹配平台商品库</div>
        <div class="match-lab-sub">第一版先拿抖音商品名去勾选的平台查询，再按价格、类目和好评做重排。每个平台固定只查和展示前 3 个商品。</div>
      </div>
      <button type="button" ${isMatchRunning ? "disabled" : ""} onclick="startProductMatch('${escapeHtml(state.matchId)}')">${isMatchRunning ? "匹配中..." : "开始匹配"}</button>
    </div>
    <div class="match-platforms">
      <div class="match-lab-sub">匹配平台</div>
      <div class="match-platform-list">${MATCH_PLATFORM_OPTIONS.map((platform) => `
        <label class="match-platform-chip">
          <input type="checkbox" data-match-platform="${escapeHtml(platform.id)}" ${selectedPlatforms.includes(platform.id) ? "checked" : ""}>
          <span class="match-platform-copy">
            <span class="match-platform-title">${escapeHtml(platform.label)}</span>
            <span class="match-platform-sub">${escapeHtml(platform.sub)}</span>
          </span>
        </label>
      `).join("")}</div>
    </div>
    <div class="match-options">
      <label class="match-option"><input type="checkbox" data-match-field="same_product" ${matchOptions.same_product ? "checked" : ""}><span>自动找同一个商品</span></label>
      <label class="match-option"><input type="checkbox" data-match-field="similar_product" ${matchOptions.similar_product ? "checked" : ""}><span>自动找相似商品</span></label>
      <label class="match-option"><input type="checkbox" data-match-field="same_category" ${matchOptions.same_category ? "checked" : ""}><span>限定同类型商品</span></label>
      <label class="match-option"><input type="checkbox" data-match-field="best_reviewed" ${matchOptions.best_reviewed ? "checked" : ""}><span>优先好评最多</span></label>
      <label class="match-option number"><span>价格浮动正负 %</span><input type="number" data-match-field="price_float_percent" min="0" max="100" placeholder="不限" value="${escapeHtml(matchOptions.price_float_percent)}"></label>
    </div>
  </div>`;
  const matchFeedback = renderInlineProductMatchState(state);
  const showStandaloneSourceProducts = shouldRenderStandaloneSourceProducts(state);
  const sourceProductsHtml = showStandaloneSourceProducts
    ? `<div class="source-products">${renderSourceProductCards(state.products.slice(start, end))}</div>${renderProductPagination(previewId, currentPage, totalPages, start + 1, end, state.products.length)}`
    : "";
  const body = `${state.notice}${lab}${matchFeedback}${sourceProductsHtml}`;
  const sub = totalPages > 1
    ? `第 ${currentPage} / ${totalPages} 页`
    : `${state.products.length} 个商品`;
  const section = state.sectionTitle ? renderDetailSection(state.sectionTitle, body, sub) : body;
  return `<div class="product-preview" data-product-preview="${escapeHtml(previewId)}">${section}</div>`;
}

function changeProductPreviewPage(previewId, nextPage) {
  const state = productPreviewStates.get(previewId);
  if (!state) return;
  state.matchOptions = captureMatchFormState(state.matchId) || state.matchOptions || defaultMatchOptions();
  const totalPages = Math.max(1, Math.ceil(state.products.length / state.pageSize));
  state.page = Math.min(Math.max(Number(nextPage) || 1, 1), totalPages);
  const node = document.querySelector(`[data-product-preview="${CSS.escape(previewId)}"]`);
  if (node) node.outerHTML = renderProductPreview(previewId);
}

function renderProducts(result, options = {}) {
  const products = extractProducts(result);
  const notice = result?.api_message
    ? `<div class="result-item"><strong>商品结果</strong>${escapeHtml(result.api_message)}</div>`
    : "";
  const sectionTitle = options.title || "";
  if (!Array.isArray(products) || !products.length) {
    const body = notice ? `<div class="result-list">${notice}</div>` : "";
    return sectionTitle ? renderDetailSection(sectionTitle, body) : body;
  }
  const cacheKey = options.cacheKey
    || [
      sectionTitle,
      result?.summary_path || "",
      result?.raw_path || "",
      result?.web_rid || result?.room_id || result?.author_id || "",
      products.length,
    ].filter(Boolean).join(":");
  const previewId = domToken(cacheKey || `${sectionTitle}:${products[0]?.product_id || products[0]?.title || "products"}`, "product-preview");
  const matchId = domToken(`${previewId}:match`, "match");
  const existingState = productPreviewStates.get(previewId) || {};
  const previousPage = existingState.page || 1;
  productPreviewStates.set(previewId, {
    ...existingState,
    page: previousPage,
    pageSize: PRODUCT_PAGE_SIZE,
    products,
    notice,
    sectionTitle,
    matchId,
    matchOptions: existingState.matchOptions || defaultMatchOptions(),
  });
  productMatchPayloads.set(matchId, {
    products,
    source: result?.web_rid ? `douyin_live:${result.web_rid}` : "douyin_live",
    previewId,
  });
  const latestJob = findLatestProductMatchJob(productMatchPayloads.get(matchId));
  if (latestJob) {
    attachProductMatchJobToState(productPreviewStates.get(previewId), latestJob);
  }
  return renderProductPreview(previewId);
}

function renderVideoProductMapPreview(result, options = {}) {
  const isMappingPayload = Array.isArray(result?.matched_products)
    || Array.isArray(result?.chunks)
    || Boolean(result?.mapping_path || result?.video_path);
  if (!isMappingPayload) return "";
  const matched = Array.isArray(result?.matched_products) ? result.matched_products : [];
  const cacheKey = options.cacheKey || result.mapping_path || result.video_path || "mapped-products";
  const intro = `<div class="result-item"><strong>这一步在做什么</strong>只会从这场直播已经抓到的抖音商品里，判断这段视频正在讲哪一个或哪几个抖音商品，不会去做跨平台商品匹配。</div>`;
  const pipelineSection = renderVideoMapPipeline(result, { cacheKey: `${cacheKey}:chunks` });
  const body = matched.length
    ? `<div class="match-results">${matched.map((item) => {
      const sourceProduct = item.source_product || {};
      const avg = Number(item.avg_confidence || 0);
      const max = Number(item.max_confidence || 0);
      const hitCount = Number(item.hit_count || 0);
      const summaries = Array.isArray(item.sample_summaries) ? item.sample_summaries.filter(Boolean).slice(0, 2) : [];
      return `<div class="match-card">
        <div class="match-card-title">${escapeHtml(item.title || sourceProduct.title || "未识别商品")}</div>
        <div class="match-note">命中 ${escapeHtml(hitCount)} 段 · 平均 ${escapeHtml((avg * 100).toFixed(0))} 分 · 最高 ${escapeHtml((max * 100).toFixed(0))} 分</div>
        ${summaries.length ? `<div class="match-note">${escapeHtml(summaries.join(" "))}</div>` : ""}
      </div>`;
    }).join("")}</div>`
    : `<div class="result-item"><strong>识别结果</strong>当前还没有可靠的抖音商品结果。可以先看下面每一段的切片、上传和分析状态。</div>`;
  const mappedProductsPayload = matched
    .map((item) => item.source_product)
    .filter((item) => item && (item.title || item.product_id));
  const productSection = mappedProductsPayload.length
    ? renderProducts(
      {
        products: mappedProductsPayload,
        web_rid: result.source_identity || "",
      },
      { title: "识别到的抖音商品", cacheKey: `${cacheKey}:products` }
    )
    : "";
  return `${renderDetailSection(options.title || "视频里正在讲的抖音商品", `${intro}${body}`, `${matched.length} 个商品`)}${pipelineSection}${productSection}`;
}

function readMatchConditions(matchId) {
  const root = document.querySelector(`[data-match-id="${CSS.escape(matchId)}"]`);
  const numberValue = (name, fallback = null) => {
    const value = root?.querySelector(`[data-match-field="${name}"]`)?.value;
    if (value === "" || value == null) return fallback;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const checked = (name) => Boolean(root?.querySelector(`[data-match-field="${name}"]`)?.checked);
  return {
    same_product: checked("same_product"),
    similar_product: checked("similar_product"),
    same_category: checked("same_category"),
    best_reviewed: checked("best_reviewed"),
    price_float_percent: numberValue("price_float_percent", null),
    limit_per_product: 3,
  };
}

function readMatchPlatforms(matchId) {
  const root = document.querySelector(`[data-match-id="${CSS.escape(matchId)}"]`);
  return Array.from(root?.querySelectorAll("[data-match-platform]") || [])
    .filter((node) => node.checked)
    .map((node) => node.dataset.matchPlatform)
    .filter(Boolean);
}

async function startProductMatch(matchId) {
  try {
    const payload = productMatchPayloads.get(matchId);
    if (!payload?.products?.length) {
      toast("没有可匹配的抖音商品。");
      return;
    }
    const platforms = readMatchPlatforms(matchId);
    if (!platforms.length) {
      toast("至少勾选一个匹配平台。");
      return;
    }
    const response = await api("/api/products/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        products: payload.products,
        platforms,
        source: payload.source,
        conditions: readMatchConditions(matchId),
      })
    });
    const targetPreviewId = payload.previewId || findProductPreviewByMatchId(matchId).previewId;
    const targetState = targetPreviewId ? productPreviewStates.get(targetPreviewId) : null;
    if (targetPreviewId && targetState) {
      targetState.matchOptions = captureMatchFormState(matchId) || targetState.matchOptions || defaultMatchOptions();
      targetState.matchJobId = response.job_id || "";
      targetState.matchJobStatus = response.status || "queued";
      targetState.matchJobError = "";
      targetState.matchJobResult = null;
      targetState.matchJobUpdatedAt = null;
      targetState.matchJobRenderKey = JSON.stringify({
        id: targetState.matchJobId,
        status: targetState.matchJobStatus,
        error: "",
        result: null,
      });
      rerenderProductPreview(targetPreviewId);
    }
    toast("商品匹配任务已创建。");
    await refreshJobs();
    startJobsPolling();
  } catch (err) {
    toast(err.message || String(err));
  }
}

function candidateCommentId(candidate, index, sourceProduct = {}) {
  return domToken([
    candidate.platform || "",
    candidate.product_id || "",
    candidate.sku_id || "",
    candidate.item_id || "",
    candidate.detail_url || "",
    sourceProduct.source_product_id || "",
    index,
  ].join(":"), "candidate-comments");
}

function candidateCommentPayload(candidate = {}) {
  const raw = candidate.raw && typeof candidate.raw === "object" ? candidate.raw : {};
  return {
    platform: candidate.platform || "",
    product_id: candidate.product_id || "",
    sku_id: candidate.sku_id || raw.sku_id || raw.skuId || "",
    item_id: candidate.item_id || raw.item_id || raw.itemId || raw.auctionNumId || "",
    detail_url: candidate.detail_url || "",
    raw,
    limit: 3,
    offset: 0,
  };
}

function renderCandidateComments(commentId) {
  const state = candidateCommentStates.get(commentId);
  if (!state) {
    return `<div class="candidate-comments" id="${escapeHtml(commentId)}"><strong>评论数据</strong>打开商品后，插件采集完成再点“刷新评论”。</div>`;
  }
  if (state.status === "loading") {
    return `<div class="candidate-comments" id="${escapeHtml(commentId)}"><strong>评论数据</strong>正在查询评论库...</div>`;
  }
  if (state.status === "failed") {
    return `<div class="candidate-comments" id="${escapeHtml(commentId)}"><strong>评论数据</strong>${escapeHtml(state.error || "查询失败")}</div>`;
  }
  const data = state.data || {};
  const stats = data.stats || {};
  const pagination = data.pagination || {};
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const tags = Array.isArray(data.subject?.tags) ? data.subject.tags.slice(0, 5) : [];
  const totalComments = Number(stats.comment_count || comments.length || 0);
  const pageSize = Math.max(1, Number(pagination.limit || state.pageSize || 3));
  const pageOffset = Math.max(0, Number(pagination.offset || 0));
  const currentPage = Math.floor(pageOffset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(totalComments / pageSize));
  const summary = data.matched
    ? `已采集 ${totalComments} 条评论${stats.latest_feedback_date ? ` · 最新 ${formatTime(stats.latest_feedback_date)}` : ""}`
    : (data.message || "暂未查到评论。打开商品页后，等待插件上传再刷新。");
  const tagHtml = tags.length
    ? `<div class="candidate-facts">${tags.map((tag) => `<div class="candidate-chip">${escapeHtml(String(tag))}</div>`).join("")}</div>`
    : "";
  const commentHtml = comments.map((item) => {
    const spec = item.specifications && typeof item.specifications === "object"
      ? Object.values(item.specifications).filter(Boolean).join(" ")
      : "";
    const meta = [item.score ? `${item.score}分` : "", item.feedback_date ? formatTime(item.feedback_date) : "", spec].filter(Boolean).join(" · ");
    return `<div class="comment-line">${meta ? `<div class="candidate-meta">${escapeHtml(meta)}</div>` : ""}${escapeHtml(item.content || "")}</div>`;
  }).join("");
  const pageHtml = data.matched && totalPages > 1
    ? `<div class="product-pagination comment-pagination">
        <div class="product-page-status">第 ${currentPage} / ${totalPages} 页</div>
        <div class="product-page-actions">
          <button class="secondary product-page-btn" type="button" ${currentPage <= 1 ? "disabled" : ""} onclick="refreshCandidateComments('${escapeHtml(commentId)}', ${currentPage - 1})">上一页</button>
          <button class="secondary product-page-btn" type="button" ${currentPage >= totalPages ? "disabled" : ""} onclick="refreshCandidateComments('${escapeHtml(commentId)}', ${currentPage + 1})">下一页</button>
        </div>
      </div>`
    : "";
  return `<div class="candidate-comments" id="${escapeHtml(commentId)}"><strong>评论数据</strong>${escapeHtml(summary)}${tagHtml}${commentHtml}${pageHtml}</div>`;
}

function replaceCandidateComments(commentId) {
  const node = document.getElementById(commentId);
  if (node) node.outerHTML = renderCandidateComments(commentId);
}

async function refreshCandidateComments(commentId, page = 1) {
  const payload = candidateCommentPayloads.get(commentId);
  if (!payload) return;
  const pageSize = Math.max(1, Number(payload.limit || 3));
  const nextPage = Math.max(1, Number(page) || 1);
  const requestPayload = {
    ...payload,
    limit: pageSize,
    offset: (nextPage - 1) * pageSize,
  };
  candidateCommentStates.set(commentId, { status: "loading", page: nextPage, pageSize });
  replaceCandidateComments(commentId);
  try {
    const data = await api("/api/products/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });
    candidateCommentStates.set(commentId, { status: "completed", data, page: nextPage, pageSize });
  } catch (err) {
    candidateCommentStates.set(commentId, { status: "failed", error: err.message || String(err) });
  }
  replaceCandidateComments(commentId);
}

function openCandidateProduct(commentId, detailUrl) {
  if (detailUrl) window.open(detailUrl, "_blank", "noopener,noreferrer");
  refreshCandidateComments(commentId);
  window.setTimeout(() => refreshCandidateComments(commentId), 5000);
  window.setTimeout(() => refreshCandidateComments(commentId), 15000);
}

function renderProductMatchResult(result, options = {}) {
  const results = Array.isArray(result?.results) ? result.results : [];
  if (!results.length) return "";
  const body = `<div class="match-results">${results.map((item) => {
    const product = item.source_product || {};
    const candidates = Array.isArray(item.candidates) ? item.candidates : [];
    const notes = Array.isArray(item.agent_notes) ? item.agent_notes : [];
    const sourcePrice = product.price_yuan ? `¥${escapeHtml(product.price_yuan)}` : "";
    const sourceImage = product.cover
      ? `<img src="${escapeHtml(product.cover)}" alt="">`
      : "<div class='match-source-placeholder'></div>";
    const sourceMeta = [sourcePrice, "抖音源商品"].filter(Boolean).join(" · ");
    const candidateHtml = candidates.length
      ? `<div class="candidate-list">${candidates.map((candidate, candidateIndex) => {
        const price = candidate.price_yuan ? `¥${escapeHtml(candidate.price_yuan)}` : "";
        const score = candidate.score != null ? `${(Number(candidate.score) * 100).toFixed(0)}分` : "";
        const commentId = candidateCommentId(candidate, candidateIndex, product);
        candidateCommentPayloads.set(commentId, candidateCommentPayload(candidate));
        const candidateImage = candidate.image
          ? `<div class="candidate-thumb"><img src="${escapeHtml(candidate.image)}" alt=""></div>`
          : "<div class='candidate-thumb-placeholder'></div>";
        const facts = [
          candidate.brand_name ? `品牌 ${candidate.brand_name}` : "",
          candidate.shop_name ? `店铺 ${candidate.shop_name}` : "",
          candidate.category_name ? `类目 ${candidate.category_name}` : "",
        ].filter(Boolean);
        const metrics = [
          candidate.comments_count ? `评论 ${formatMatchMetricNumber(candidate.comments_count)}` : "",
          candidate.good_comments_share ? `好评率 ${formatMatchPercent(candidate.good_comments_share)}` : "",
          candidate.sales_count ? `${candidate.sales_label || "销量"} ${formatMatchMetricNumber(candidate.sales_count)}` : "",
        ].filter(Boolean);
        const factHtml = facts.length
          ? `<div class="candidate-facts">${facts.map((text) => `<div class="candidate-chip">${escapeHtml(text)}</div>`).join("")}</div>`
          : "";
        const metricHtml = metrics.length
          ? `<div class="candidate-metrics">${metrics.map((text) => `<div class="candidate-chip metric">${escapeHtml(text)}</div>`).join("")}</div>`
          : "";
        const detailLink = `<div class="candidate-actions">
          ${candidate.detail_url ? `<button class="candidate-action-link" type="button" onclick="openCandidateProduct('${escapeHtml(commentId)}', '${escapeHtml(candidate.detail_url)}')">打开商品</button>` : ""}
          <button class="candidate-action-link" type="button" onclick="refreshCandidateComments('${escapeHtml(commentId)}')">刷新评论</button>
        </div>`;
        return `<div class="candidate">
          ${candidateImage}
          <div class="candidate-body">
            <div class="candidate-head">
              <div class="candidate-copy">
              <div class="candidate-title">${escapeHtml(candidate.title || "未命名商品")}</div>
              <div class="candidate-meta">${escapeHtml(candidate.match_type || "候选")} · ${escapeHtml(candidate.match_reason || "")}</div>
              ${factHtml}
              ${metricHtml}
              ${detailLink}
              ${renderCandidateComments(commentId)}
              </div>
              <div class="candidate-badges">
                <div class="badge">${escapeHtml(candidate.platform_label || candidate.platform || "平台")}</div>
                <div class="badge">${escapeHtml(candidate.confidence_label || "可信度")}</div>
                ${price ? `<div class="badge">${escapeHtml(price)}</div>` : ""}
                ${score ? `<div class="badge">${escapeHtml(score)}</div>` : ""}
              </div>
            </div>
          </div>
        </div>`;
      }).join("")}</div>`
      : "<div class='match-note'>当前选中平台没有返回候选商品。</div>";
    return `<div class="match-card">
      <div class="match-source">
        ${sourceImage}
        <div class="match-source-copy">
          <div class="match-source-eyebrow">原始抖音商品</div>
          <div class="match-source-title">${escapeHtml(product.title || "抖音商品")}</div>
          ${sourceMeta ? `<div class="match-source-meta">${sourceMeta}</div>` : ""}
        </div>
      </div>
      <div class="match-note">${escapeHtml(notes.join(" "))}</div>
      ${candidateHtml}
    </div>`;
  }).join("")}</div>`;
  return options.title ? renderDetailSection(options.title, body, `${results.length} 个商品`) : body;
}
