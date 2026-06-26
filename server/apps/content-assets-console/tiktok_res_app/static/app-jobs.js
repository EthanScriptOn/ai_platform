function collectJobFiles(result) {
  const files = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;
    if (typeof value.path === "string" && value.name && value.type) {
      const key = String(value.path);
      if (!seen.has(key)) {
        seen.add(key);
        files.push(value);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(result);
  return files;
}

function extractSourceIdentityFromText(value) {
  const text = String(value || "");
  const match = text.match(/live\.douyin\.com\/(\d+)/i)
    || text.match(/\/live\/(\d+)/i)
    || text.match(/\/video\/(\d+)/i)
    || text.match(/\/note\/(\d+)/i)
    || text.match(/_(\d{8,})\.(?:mp4|flv|m3u8|json)$/i)
    || text.match(/live_products_(\d+)_/i);
  return match ? match[1] : "";
}

function extractJobSourceIdentity(job) {
  return extractSourceIdentityFromText(job?.result?.source_identity)
    || extractSourceIdentityFromText(job?.input?.url)
    || extractSourceIdentityFromText(job?.input?.video_path)
    || extractSourceIdentityFromText(job?.result?.mapping_path)
    || extractSourceIdentityFromText(job?.result?.products_path);
}

function relatedLibraryItemsForJob(job) {
  const identity = extractJobSourceIdentity(job);
  if (!identity) return [];
  const exactSessionKey = deriveSessionKeyFromJob(job);
  if (exactSessionKey) {
    return libraryItems.filter((item) => deriveLibrarySessionKey(item) === exactSessionKey);
  }
  const sessionCandidates = new Map();
  for (const item of libraryItems) {
    if (String(item.source_identity || "") !== identity) continue;
    const sessionKey = deriveLibrarySessionKey(item);
    if (!sessionKey) continue;
    if (!sessionCandidates.has(sessionKey)) {
      sessionCandidates.set(sessionKey, []);
    }
    sessionCandidates.get(sessionKey).push(item);
  }
  if (!sessionCandidates.size) {
    return libraryItems.filter((item) => String(item.source_identity || "") === identity);
  }
  const interruptedRecovery = job?.status === "failed"
    && /服务启动时发现任务已中断/.test(String(job?.error || ""));
  const targetTime = interruptedRecovery
    ? Number(job.created_at || job.updated_at || 0)
    : Number(job.updated_at || job.created_at || 0);
  const ranked = Array.from(sessionCandidates.entries()).map(([sessionKey, items]) => ({
    sessionKey,
    items,
    updatedAt: Math.max(...items.map((item) => Number(item.updated_at || 0))),
  })).sort((a, b) => Math.abs(a.updatedAt - targetTime) - Math.abs(b.updatedAt - targetTime));
  return ranked[0]?.items || [];
}

function recoveredMediaFilesForJob(job) {
  return relatedLibraryItemsForJob(job).filter((item) => item.type === "video" || item.type === "clip");
}

function isRecoveredInterruptedJob(job) {
  return job?.status === "failed"
    && /服务启动时发现任务已中断/.test(String(job?.error || ""))
    && recoveredMediaFilesForJob(job).length > 0;
}

function jobStatusLabel(job) {
  if (isRecoveredInterruptedJob(job)) return "已中断";
  if (job.status === "queued") return "排队中";
  if (job.status === "running") return "进行中";
  if (job.status === "completed") return "已完成";
  if (job.status === "failed") return "失败";
  if (job.status === "cancelled") return "已暂停";
  return job.status || "-";
}

function jobBadgeClass(job) {
  if (isRecoveredInterruptedJob(job)) return "interrupted";
  return ["failed", "running", "queued", "cancelled"].includes(job.status) ? job.status : "";
}

function productCountFromResult(result) {
  const products = extractProducts(result);
  if (products.length) return products.length;
  return Number(result?.product_count || result?.products?.product_count || 0) || 0;
}

function renderJobMetrics(job, result) {
  const files = collectJobFiles(result);
  const products = job.type === "live_record_with_products"
    ? productCountFromResult(result?.products || {})
    : productCountFromResult(result || {});
  const matchTotal = Array.isArray(result?.results) ? result.results.length : productMatchSourceCount(job.input || {}, result || {});
  const matches = Number(result?.matched_count || 0);
  const mappedProducts = Array.isArray(result?.matched_products) ? result.matched_products.length : 0;
  const duration = job.updated_at && job.created_at ? Math.max(0, job.updated_at - job.created_at).toFixed(1) : "-";
  const metrics = [
    ["创建时间", formatTime(job.created_at * 1000)],
    ["最近更新", formatTime(job.updated_at * 1000)],
    ["耗时", `${duration}s`],
  ];
  if (job.type === "product_match") {
    const requestedPlatforms = formatMatchPlatformList(result?.platforms_requested || job.input?.platforms || []);
    if (requestedPlatforms) metrics.push(["匹配平台", requestedPlatforms]);
    if (matchTotal > 0) metrics.push(["源商品", `${matchTotal} 个`]);
    metrics.push(["命中商品", `${matches} / ${matchTotal} 个`]);
  } else {
    metrics.push(["产出文件", `${files.length} 个`]);
  }
  if (job.type.includes("products")) metrics.push(["商品", `${products} 个`]);
  if (job.type === "video_product_map") metrics.push(["识别到的抖音商品", `${mappedProducts} 个`]);
  if (job.type === "video_product_map") metrics.push(["已完成分段", `${Number(result?.completed_chunk_count || 0)} / ${Number(result?.chunk_count || 0)}`]);
  return `<div class="meta-grid">${metrics.map(([label, value]) => `
    <div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("")}</div>`;
}

function renderJobOutputSummary(result) {
  const files = collectJobFiles(result);
  if (!files.length) return "";
  const body = `<div class="result-list">${files.slice(0, 8).map((file) => {
    const size = file.size_bytes ? ` · ${(file.size_bytes / 1024 / 1024).toFixed(2)} MB` : "";
    return `<div class="result-item"><strong>${escapeHtml(labelForLibraryType(file.type || "metadata"))}${size}</strong><span class="file-path">${escapeHtml(file.path || "")}</span></div>`;
  }).join("")}</div>`;
  return renderDetailSection("产出摘要", body, `${files.length} 个文件`);
}

function renderJobMappingCompact(result) {
  const pipeline = result?.pipeline || {};
  const matchedCount = Array.isArray(result?.matched_products) ? result.matched_products.length : 0;
  const rows = [];
  if (pipeline.summary) {
    rows.push(`<div class="result-item"><strong>当前进度</strong>${escapeHtml(pipeline.summary)}</div>`);
  }
  if (matchedCount > 0) {
    rows.push(`<div class="result-item"><strong>当前识别结果</strong>已识别到 ${escapeHtml(matchedCount)} 个抖音商品。</div>`);
  }
  if (!rows.length) return "";
  rows.push(`<div class="result-item"><strong>详细结果</strong>完整识别过程和命中的抖音商品都放在文件库里查看。</div>`);
  return renderDetailSection("任务概览", rows.join(""), "详细结果请到文件库");
}

function renderRecoveredJobSummary(job) {
  if (!isRecoveredInterruptedJob(job)) return "";
  const files = recoveredMediaFilesForJob(job);
  if (!files.length) return "";
  const body = `<div class="result-list">${files.slice(0, 6).map((file) => {
    const size = file.size_bytes ? ` · ${(file.size_bytes / 1024 / 1024).toFixed(2)} MB` : "";
    return `<div class="result-item"><strong>${escapeHtml(labelForLibraryType(file.type || "video"))}${size}</strong><span class="file-path">${escapeHtml(file.path || "")}</span></div>`;
  }).join("")}</div>`;
  return renderDetailSection("已恢复文件", body, `${files.length} 个文件已保留到文件库`);
}

function renderProductMatchJobCompact(job, result) {
  const sourceCount = productMatchSourceCount(job.input || {}, result || {});
  const matchTotal = Array.isArray(result?.results) ? result.results.length : sourceCount;
  const requestedPlatforms = formatMatchPlatformList(result?.platforms_requested || job.input?.platforms || []);
  const queriedPlatforms = formatMatchPlatformList(result?.platforms_queried || []);
  const rows = [];
  const scopeLine = productMatchSummaryLine(job.input || {}, result || {});
  if (scopeLine) {
    rows.push(`<div class="result-item"><strong>匹配范围</strong>${escapeHtml(scopeLine)}</div>`);
  }
  if (queriedPlatforms) {
    rows.push(`<div class="result-item"><strong>实际查询</strong>${escapeHtml(queriedPlatforms)}</div>`);
  } else if (requestedPlatforms) {
    rows.push(`<div class="result-item"><strong>实际查询</strong>${escapeHtml(requestedPlatforms)}</div>`);
  }
  if (job.status === "completed") {
    rows.push(`<div class="result-item"><strong>结果摘要</strong>命中 ${escapeHtml(Number(result?.matched_count || 0))} / ${escapeHtml(matchTotal)} 个抖音商品。详细候选结果已经回填到对应的“匹配平台商品库”。</div>`);
  } else if (job.status === "failed") {
    rows.push(`<div class="result-item"><strong>结果摘要</strong>这次匹配没有完成，错误信息见下方。</div>`);
  } else {
    rows.push(`<div class="result-item"><strong>当前状态</strong>结果会自动回填到对应的“匹配平台商品库”。</div>`);
  }
  return renderDetailSection("任务概览", rows.join(""), sourceCount > 0 ? `${sourceCount} 个商品` : "商品匹配任务");
}

function renderJobDetail(job, result) {
  const mappingDetail = job.type === "video_product_map"
    ? renderJobMappingCompact(result)
    : "";
  const productMatchDetail = job.type === "product_match"
    ? renderProductMatchJobCompact(job, result)
    : "";
  if (job.error) {
    const recovered = renderRecoveredJobSummary(job);
    const issueTitle = isRecoveredInterruptedJob(job) ? "中断说明" : "失败原因";
    const issueBody = isRecoveredInterruptedJob(job)
      ? "这次任务在服务中断时被打断，但已录到的文件已经恢复到文件库。"
      : job.error;
    return [
      renderJobMetrics(job, result),
      mappingDetail,
      productMatchDetail,
      recovered,
      renderDetailSection(issueTitle, `<div class="result-item">${escapeHtml(issueBody)}</div>`),
    ].join("");
  }
  return [
    renderJobMetrics(job, result),
    mappingDetail,
    productMatchDetail,
    renderJobOutputSummary(result),
  ].join("");
}

function pausePageVideosExcept(exceptId) {
  document.querySelectorAll("video").forEach((video) => {
    if (exceptId && video.id === exceptId) return;
    if (!video.paused) video.pause();
  });
}

async function openClipper(path) {
  try {
    pausePageVideosExcept("clipVideo");
    $("clipper").classList.add("show");
    $("clipFile").textContent = "正在准备预览...";
    $("clipOutput").className = "result-list clip-output";
    $("clipOutput").innerHTML = "";
    const data = await api("/api/video/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    clipState.sourcePath = data.source_path;
    clipState.duration = Number(data.duration_seconds || 0);
    const video = $("clipVideo");
    video.src = `/api/media?path=${encodeURIComponent(data.preview_path)}`;
    video.load();
    const max = Math.max(1, clipState.duration || 1);
    $("clipStart").max = String(max);
    $("clipEnd").max = String(max);
    $("clipStart").value = "0";
    $("clipEnd").value = String(max);
    $("clipFile").textContent = data.source_path;
    syncClipRange("end");
    $("clipper").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    toast(err.message || String(err));
  }
}

function closeClipper() {
  const video = $("clipVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("clipper").classList.remove("show");
  clipState = { sourcePath: "", duration: 0 };
}

function syncClipRange(changed) {
  let start = Number($("clipStart").value || 0);
  let end = Number($("clipEnd").value || 0);
  if (changed === "start" && start >= end) {
    start = Math.max(0, end - 0.5);
    $("clipStart").value = String(start);
  }
  if (changed === "end" && end <= start) {
    end = Math.min(Number($("clipEnd").max || 1), start + 0.5);
    $("clipEnd").value = String(end);
  }
  const startText = formatSeconds(start);
  const endText = formatSeconds(end);
  $("clipStartText").textContent = startText;
  $("clipEndText").textContent = endText;
  $("clipStartBubble").textContent = startText;
  $("clipEndBubble").textContent = endText;
  $("clipDurationText").textContent = `已选 ${formatSeconds(end - start)}`;
  const max = Number($("clipEnd").max || clipState.duration || 1) || 1;
  const startPct = Math.max(0, Math.min(100, (start / max) * 100));
  const endPct = Math.max(0, Math.min(100, (end / max) * 100));
  const track = $("clipRangeTrack");
  track.style.setProperty("--start-pct", `${startPct}%`);
  track.style.setProperty("--end-pct", `${endPct}%`);
  if (changed === "start" || changed === "end") {
    $("clipVideo").currentTime = changed === "start" ? start : end;
  }
}

function seekClipStart() {
  $("clipVideo").currentTime = Number($("clipStart").value || 0);
}

async function exportClip() {
  try {
    if (!clipState.sourcePath) {
      toast("先选择一个录制文件。");
      return;
    }
    const start = Number($("clipStart").value || 0);
    const end = Number($("clipEnd").value || 0);
    $("clipOutput").className = "result-list clip-output show";
    $("clipOutput").innerHTML = "<div class='result-item'><strong>正在导出</strong>请稍等...</div>";
    const data = await api("/api/video/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: clipState.sourcePath, start_seconds: start, end_seconds: end })
    });
    const size = data.size_bytes ? ` · ${(data.size_bytes / 1024 / 1024).toFixed(2)} MB` : "";
    $("clipOutput").innerHTML = `<div class="result-item">
      <strong>片段已导出${size}</strong>
      <div class="file-row">
        <span class="file-path">${escapeHtml(data.clip_path)}</span>
        <button class="secondary" type="button" onclick="openClipper('${escapeHtml(data.clip_path)}')">继续剪</button>
      </div>
      <video class="inline-player" controls preload="metadata" src="/api/media?path=${encodeURIComponent(data.clip_path)}"></video>
    </div>`;
    await refreshLibrary();
    toast("片段已导出。");
  } catch (err) {
    $("clipOutput").innerHTML = `<div class="result-item"><strong>导出失败</strong>${escapeHtml(err.message || String(err))}</div>`;
  }
}

function renderJob(job) {
  const cls = jobBadgeClass(job);
  const result = job.result || {};
  const isExpanded = expandedJobs.has(job.id);
  const hasResult = Boolean(job.result || job.error);
  const statusLabel = jobStatusLabel(job);
  const summary = job.type === "live_record_with_products"
    ? "录制直播 + 抓商品"
    : (job.type === "live_record" ? "录制直播" : (job.type === "live_products" ? "抓商品" : (job.type === "product_match" ? "商品匹配" : (job.type === "video_product_map" ? "识别视频讲解商品" : "下载视频"))));
  const canCancel = ["queued", "running"].includes(job.status);
  const jobLine = job.type === "product_match"
    ? productMatchSummaryLine(job.input || {}, result || {})
    : (job.input?.url || job.input?.video_path || "");
  return `<div class="job ${isExpanded ? "expanded" : ""}" id="job-${escapeHtml(job.id)}">
    <div class="job-main">
      <div class="job-head">
        <div class="job-title">
          <div class="job-type">${escapeHtml(summary)}</div>
          <div class="badge ${cls}">${escapeHtml(statusLabel)}</div>
        </div>
        <div class="job-actions">
          <button class="secondary" type="button" onclick="toggleJob('${escapeHtml(job.id)}')">${isExpanded ? "收起" : (hasResult ? "展开" : "详情")}</button>
          ${canCancel ? `<button class="secondary" type="button" onclick="cancelJob('${escapeHtml(job.id)}')">暂停</button>` : ""}
          <button class="danger" type="button" onclick="deleteJob('${escapeHtml(job.id)}')">删除</button>
        </div>
      </div>
      ${jobLine ? `<div class="job-url">${escapeHtml(jobLine)}</div>` : ""}
      <div class="job-detail">
        ${renderJobDetail(job, result)}
      </div>
    </div>
  </div>`;
}
