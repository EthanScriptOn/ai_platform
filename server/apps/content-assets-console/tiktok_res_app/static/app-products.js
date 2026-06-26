async function startVideoProductMap(videoPath, productsPath) {
  try {
    if (!videoPath || !productsPath) {
      toast("还缺少视频文件或直播间商品数据，暂时无法判断这段视频在讲哪个抖音商品。");
      return;
    }
    await api("/api/video/products/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_path: videoPath, products_path: productsPath })
    });
    toast("视频讲解商品识别任务已创建。");
    await refreshJobs();
    startJobsPolling();
  } catch (err) {
    toast(err.message || String(err));
  }
}

function renderDetailSection(title, body, sub = "") {
  if (!body) return "";
  return `<section class="detail-section">
    <div class="detail-section-head">
      <div class="detail-section-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="detail-section-sub">${escapeHtml(sub)}</div>` : ""}
    </div>
    <div class="detail-section-body">${body}</div>
  </section>`;
}

function mappingBadgeClass(status) {
  if (status === "failed") return "failed";
  if (["queued", "cutting", "uploading", "ready", "analyzing"].includes(status)) return "running";
  return "";
}

function renderChunkCards(items) {
  return items.map((chunk) => {
    const status = String(chunk.status || "queued");
    const statusLabel = String(chunk.status_label || status);
    const timeLabel = `${formatSeconds(Number(chunk.start_seconds || 0))} - ${formatSeconds(Number(chunk.end_seconds || 0))}`;
    const sizeLabel = chunk.clip_bytes ? `${(Number(chunk.clip_bytes) / 1024 / 1024).toFixed(2)} MB` : "";
    const transportLabel = chunk.input_mode === "oss_url"
      ? (chunk.clip_reference ? "已上传到 OSS" : "将上传到 OSS")
      : (chunk.input_mode === "base64" ? "以内联方式发送" : "");
    const metaLine = [sizeLabel, transportLabel].filter(Boolean).join(" · ");
    const history = Array.isArray(chunk.step_history) ? chunk.step_history : [];
    const historyLine = history.length
      ? `<div class="chunk-meta">处理轨迹：${history.map((step) => {
        const label = String(step.label || step.status || "");
        const at = step.at ? formatTime(Number(step.at) * 1000) : "";
        return escapeHtml(at ? `${label} ${at}` : label);
      }).join(" -> ")}</div>`
      : "";
    const matchedTitle = chunk?.resolved_match?.title
      ? `<div class="chunk-match">命中商品：${escapeHtml(chunk.resolved_match.title)}</div>`
      : "";
    const summary = chunk.summary ? `<div class="chunk-summary">${escapeHtml(chunk.summary)}</div>` : "";
    const error = chunk.error ? `<div class="chunk-error">${escapeHtml(chunk.error)}</div>` : "";
    const ossLink = String(chunk.clip_reference || "").startsWith("http")
      ? `<div class="chunk-actions"><a class="chunk-link" href="${escapeHtml(chunk.clip_reference)}" target="_blank" rel="noreferrer">查看 OSS 片段</a></div>`
      : "";
    return `<div class="chunk-card ${escapeHtml(status)}">
      <div class="chunk-card-head">
        <div>
          <div class="chunk-card-title">第 ${escapeHtml(chunk.chunk_index)} 段</div>
          <div class="chunk-card-time">${escapeHtml(timeLabel)}</div>
        </div>
        <div class="badge ${mappingBadgeClass(status)}">${escapeHtml(statusLabel)}</div>
      </div>
      ${metaLine ? `<div class="chunk-meta">${escapeHtml(metaLine)}</div>` : ""}
      ${historyLine}
      ${matchedTitle}
      ${summary}
      ${error}
      ${ossLink}
    </div>`;
  }).join("");
}

function renderChunkPagination(previewId, currentPage, totalPages, startIndex, endIndex, totalCount) {
  if (totalPages <= 1) {
    return `<div class="product-pagination"><div class="product-page-status">共 ${totalCount} 段</div></div>`;
  }
  const pages = buildProductPageList(currentPage, totalPages);
  return `<div class="product-pagination">
    <div class="product-page-status">第 ${currentPage} / ${totalPages} 页 · 当前展示第 ${startIndex}-${endIndex} 段，共 ${totalCount} 段</div>
    <div class="product-page-actions">
      <button class="secondary product-page-btn" type="button" ${currentPage <= 1 ? "disabled" : ""} onclick="changeChunkPreviewPage('${escapeHtml(previewId)}', ${currentPage - 1}, this)">上一页</button>
      ${pages.map((page) => page === "ellipsis"
        ? `<span class="product-page-ellipsis">...</span>`
        : `<button class="secondary product-page-btn ${page === currentPage ? "active" : ""}" type="button" onclick="changeChunkPreviewPage('${escapeHtml(previewId)}', ${page}, this)">${page}</button>`).join("")}
      <button class="secondary product-page-btn" type="button" ${currentPage >= totalPages ? "disabled" : ""} onclick="changeChunkPreviewPage('${escapeHtml(previewId)}', ${currentPage + 1}, this)">下一页</button>
    </div>
  </div>`;
}

function renderChunkPreview(previewId) {
  const state = chunkPreviewStates.get(previewId);
  if (!state?.chunks?.length) return "";
  const totalPages = Math.max(1, Math.ceil(state.chunks.length / state.pageSize));
  const currentPage = Math.min(Math.max(Number(state.page) || 1, 1), totalPages);
  const start = (currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, state.chunks.length);
  state.page = currentPage;
  const cards = renderChunkCards(state.chunks.slice(start, end));
  const pageSummary = totalPages > 1
    ? `<div class="chunk-page-summary">分页查看更轻一点，避免一次展开 ${escapeHtml(state.chunks.length)} 段。</div>`
    : "";
  const pagination = renderChunkPagination(previewId, currentPage, totalPages, start + 1, end, state.chunks.length);
  const body = `<div class="pipeline-stats">${state.stats.map(([label, value]) => `
    <div class="pipeline-stat">
      <div class="pipeline-stat-label">${escapeHtml(label)}</div>
      <div class="pipeline-stat-value">${escapeHtml(value)}</div>
    </div>
  `).join("")}</div>${state.note}${pageSummary}<div class="chunk-grid">${cards}</div>${pagination}`;
  const sub = totalPages > 1
    ? `${state.summaryText} · 第 ${currentPage} / ${totalPages} 页`
    : state.summaryText;
  const section = renderDetailSection("分段处理概览", body, sub);
  return `<div class="chunk-preview" data-chunk-preview="${escapeHtml(previewId)}">${section}</div>`;
}

function changeChunkPreviewPage(previewId, nextPage, trigger = null) {
  const state = chunkPreviewStates.get(previewId);
  if (!state) return;
  const totalPages = Math.max(1, Math.ceil(state.chunks.length / state.pageSize));
  state.page = Math.min(Math.max(Number(nextPage) || 1, 1), totalPages);
  const scopedNode = trigger?.closest?.(`[data-chunk-preview="${CSS.escape(previewId)}"]`);
  const node = scopedNode || document.querySelector(`[data-chunk-preview="${CSS.escape(previewId)}"]`);
  if (node) node.outerHTML = renderChunkPreview(previewId);
}

function renderVideoMapPipeline(result, options = {}) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (!chunks.length) return "";
  const pipeline = result?.pipeline || {};
  const counts = pipeline.counts || {};
  const stats = [
    ["总段数", chunks.length],
    ["已完成", Number(counts.completed || 0)],
    ["分析中", Number(counts.analyzing || 0)],
    ["待分析", Number(counts.ready || 0)],
    ["上传中", Number(counts.uploading || 0)],
    ["切片中", Number(counts.cutting || 0)],
    ["失败", Number(counts.failed || 0)],
  ];
  const note = pipeline.depends_on_previous_chunk
    ? `<div class="asset-bundle-helper"><strong>顺序分析说明：</strong>当前段的商品判断会参考上一段结果，所以模型分析按顺序进行；切片和上传会提前为下一段准备。</div>`
    : "";
  const previewId = domToken(
    options.cacheKey || result.mapping_path || result.video_path || `chunks:${chunks.length}`,
    "chunk-preview"
  );
  const previousPage = chunkPreviewStates.get(previewId)?.page || 1;
  chunkPreviewStates.set(previewId, {
    page: previousPage,
    pageSize: CHUNK_PAGE_SIZE,
    chunks,
    stats,
    note,
    summaryText: pipeline.summary || `${chunks.length} 段`,
  });
  return renderChunkPreview(previewId);
}

function extractProducts(result) {
  if (Array.isArray(result?.products)) return result.products;
  if (Array.isArray(result?.products?.products)) return result.products.products;
  return [];
}

function buildProductPageList(currentPage, totalPages) {
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  if (currentPage <= 3) [2, 3, 4].forEach((page) => pages.add(page));
  if (currentPage >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((page) => pages.add(page));
  const ordered = Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
  const result = [];
  ordered.forEach((page, index) => {
    const previous = ordered[index - 1];
    if (index > 0 && page - previous > 1) result.push("ellipsis");
    result.push(page);
  });
  return result;
}

function renderFiles(result, options = {}) {
  const files = result?.video_files || result?.recording?.video_files || result?.files || result?.recording?.files || [];
  if (!Array.isArray(files) || !files.length) return "";
  const body = `<div class="result-list">${files.map((file) => {
    const size = file.size_bytes ? ` · ${(file.size_bytes / 1024 / 1024).toFixed(2)} MB` : "";
    const encodedPath = encodeURIComponent(file.path || "");
    const previewId = `${fileDomId(file.path)}-result-video`;
    const canPlayInline = file.type === "video" && isBrowserPlayableVideo(file.path);
    const action = file.type === "video"
      ? `<button class="secondary" type="button" onclick="openClipper('${escapeHtml(file.path || "")}')">剪辑</button>`
      : "";
    const videoPreviewAction = file.type === "video" && !canPlayInline
      ? `<button class="secondary" type="button" onclick="loadVideoPreview(decodeURIComponent('${encodedPath}'), '${previewId}')">播放预览</button>`
      : "";
    const player = canPlayInline
      ? `<video class="inline-player" controls preload="metadata" src="/api/media?path=${encodedPath}"></video>`
      : `<div id="${previewId}"></div>`;
    return `<div class="result-item"><strong>${escapeHtml(file.type === "video" ? "视频文件" : "文件")}${size}</strong><div class="file-row"><span class="file-path">${escapeHtml(file.path || "")}</span>${videoPreviewAction}${action}</div>${player}</div>`;
  }).join("")}</div>`;
  return options.title ? renderDetailSection(options.title, body, `${files.length} 个文件`) : body;
}

function videoSuffix(path) {
  return String(path || "").split("?")[0].split(".").pop().toLowerCase();
}

function isBrowserPlayableVideo(path) {
  return ["mp4", "webm", "mov", "m4v", "ogv"].includes(videoSuffix(path));
}
