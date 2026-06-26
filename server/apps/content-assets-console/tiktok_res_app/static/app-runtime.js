function labelForLibraryType(type) {
  if (type === "clip") return "剪辑片段";
  if (type === "products") return "商品数据";
  if (type === "video_product_map") return "视频讲解商品识别";
  if (type === "video") return "视频文件";
  if (type === "room") return "房间信息";
  return "文件";
}

function libraryKindLabel(item) {
  if (item.type === "video") return "源头视频";
  if (item.type === "clip") return "剪辑成片";
  if (item.type === "products") return "商品";
  if (item.type === "video_product_map") return "视频识别结果";
  if (item.type === "room") return "直播信息";
  return "文件";
}

function normalizeFilePath(path) {
  return String(path || "").replace(/\\/g, "/");
}

function deriveSessionKeyFromPath(path, typeHint = "") {
  const normalized = normalizeFilePath(path);
  if (!normalized) return "";
  const clipMatch = normalized.match(/^(.*\/live\/[^/]+)\/clips\/[^/]+$/i);
  if (clipMatch) return clipMatch[1];
  const liveMatch = normalized.match(/^(.*\/live\/[^/]+)\/[^/]+$/i);
  if (liveMatch) return liveMatch[1];
  if (typeHint === "clip") {
    const genericClip = normalized.match(/^(.*)\/clips\/[^/]+$/i);
    if (genericClip) return genericClip[1];
  }
  if (["video", "video_product_map", "clip"].includes(typeHint)) {
    const parent = normalized.match(/^(.*)\/[^/]+$/);
    if (parent) return parent[1];
  }
  return "";
}

function deriveLibrarySessionKey(item) {
  return deriveSessionKeyFromPath(item?.path, item?.type || "");
}

function sessionLabelFromKey(key) {
  const normalized = normalizeFilePath(key);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function deriveSessionKeyFromJob(job) {
  const result = job?.result || {};
  const files = collectJobFiles(result);
  const directVideoFile = files.find((file) => file.type === "video") || null;
  const structuredCandidates = [
    ...(Array.isArray(result?.recording?.video_files) ? result.recording.video_files : []),
    ...(Array.isArray(result?.recording?.files) ? result.recording.files : []),
    ...(Array.isArray(result?.video_files) ? result.video_files : []),
    ...(Array.isArray(result?.files) ? result.files : []),
    ...(Array.isArray(result?.recovered_files) ? result.recovered_files : []),
  ];
  const structuredVideoFile = structuredCandidates.find((file) => {
    const path = String(file?.path || "");
    const type = String(file?.type || "");
    return Boolean(path) && (type === "video" || /\.(mp4|flv|m3u8)$/i.test(path));
  }) || null;
  const videoFile = directVideoFile || structuredVideoFile;
  return deriveSessionKeyFromPath(videoFile?.path || "", videoFile?.type || "video");
}

function bestJobLinkedSessionKeyForProduct(item, groupsByKey) {
  const matches = [];
  for (const job of jobItems) {
    const result = job?.result || {};
    const products = job?.type === "live_record_with_products"
      ? (result.products || {})
      : (job?.type === "live_products" ? result : null);
    if (!products) continue;
    const rawPath = normalizeFilePath(products.raw_path || "");
    const summaryPath = normalizeFilePath(products.summary_path || "");
    const itemPath = normalizeFilePath(item.path);
    if (itemPath !== rawPath && itemPath !== summaryPath) continue;
    const sessionKey = deriveSessionKeyFromJob(job);
    if (!sessionKey || !groupsByKey.has(sessionKey)) continue;
    matches.push({ sessionKey, updatedAt: Number(job.updated_at || 0) });
  }
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0]?.sessionKey || "";
}

function nearestSessionKeyForProduct(item, groupsByKey) {
  const identity = String(item.source_identity || "");
  if (!identity) return "";
  const candidates = Array.from(groupsByKey.values()).filter((group) => group.identity === identity && group.sessionKey);
  if (!candidates.length) return "";
  candidates.sort((a, b) => {
    const diffA = Math.abs(Number(a.updatedAt || 0) - Number(item.updated_at || 0));
    const diffB = Math.abs(Number(b.updatedAt || 0) - Number(item.updated_at || 0));
    return diffA - diffB;
  });
  return candidates[0]?.key || "";
}

function pickPrimarySourceItem(items) {
  const videos = items.filter((item) => item.type === "video");
  if (!videos.length) return null;
  const scored = [...videos].sort((a, b) => {
    const score = (item) => {
      const name = String(item.name || "");
      let value = Number(item.size_bytes || 0);
      if (!name.includes("_probe_")) value += 10 ** 12;
      if (!name.endsWith("_preview.mp4")) value += 10 ** 11;
      if (name.endsWith(".flv")) value += 10 ** 10;
      return value;
    };
    return score(b) - score(a);
  });
  return scored[0];
}

function bestAvailableProductItemForGroup(group) {
  const attached = group.items.find((item) => item.type === "products") || null;
  if (attached) return attached;
  const identity = String(group.identity || "");
  if (!identity) return null;
  const candidates = libraryItems
    .filter((item) => item.type === "products" && String(item.source_identity || "") === identity)
    .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return candidates[0] || null;
}

function fileDomId(path) {
  return domToken(path, "file");
}

function clearPreviewNode(node, button, closedLabel) {
  if (!node) return;
  node.querySelectorAll("video").forEach((video) => {
    try { video.pause(); } catch {}
  });
  node.innerHTML = "";
  node.className = "";
  node.dataset.open = "";
  if (button) button.textContent = closedLabel;
}

async function toggleVideoPreview(path, mountId, button) {
  const node = $(mountId);
  if (!node) return;
  if (node.dataset.open === "1") {
    clearPreviewNode(node, button, "播放预览");
    return;
  }
  node.className = "json-preview";
  node.dataset.open = "1";
  if (button) button.textContent = "收起预览";
  node.innerHTML = "<div class='result-item'><strong>正在准备预览</strong>正在生成浏览器可播放的视频...</div>";
  try {
    const targetPath = node.dataset.previewPath || (isBrowserPlayableVideo(path)
      ? path
      : (await api("/api/video/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      })).preview_path);
    node.dataset.previewPath = targetPath;
    node.innerHTML = `<video class="inline-player" controls preload="metadata" src="/api/media?path=${encodeURIComponent(targetPath)}"></video>`;
  } catch (err) {
    node.dataset.open = "";
    if (button) button.textContent = "播放预览";
    node.innerHTML = `<div class="result-item"><strong>预览失败</strong>${escapeHtml(err.message || String(err))}</div>`;
  }
}

function renderLibraryFile(item, options = {}) {
  const size = item.size_bytes ? ` · ${(item.size_bytes / 1024 / 1024).toFixed(2)} MB` : "";
  const label = labelForLibraryType(item.type);
  const encodedPath = encodeURIComponent(item.path);
  const encodedProductsPath = options.productsPath ? encodeURIComponent(options.productsPath) : "";
  const mapDisabledReason = options.mapDisabledReason || "";
  const isVideo = item.type === "video" || item.type === "clip";
  const previewId = `${fileDomId(item.path)}-video-preview`;
  const player = isVideo ? `<div id="${previewId}"></div>` : "";
  const clipAction = item.type === "video" || item.type === "clip"
    ? `<button class="secondary" type="button" onclick="openClipper(decodeURIComponent('${encodedPath}'))">剪辑</button>`
    : "";
  const canMapVideo = isVideo && encodedProductsPath && !mapDisabledReason;
  const showMapAction = isVideo && (encodedProductsPath || mapDisabledReason);
  const mapAction = showMapAction
    ? `<button class="secondary" type="button" ${canMapVideo
      ? `onclick="startVideoProductMap(decodeURIComponent('${encodedPath}'), decodeURIComponent('${encodedProductsPath}'))"`
      : `disabled title="${escapeHtml(mapDisabledReason)}"`}>识别讲解中的抖音商品</button>`
    : "";
  const videoPreviewAction = isVideo
    ? `<button class="secondary" type="button" onclick="toggleVideoPreview(decodeURIComponent('${encodedPath}'), '${previewId}', this)">播放预览</button>`
    : "";
  const jsonPreviewAction = item.type === "products" || item.type === "room" || item.type === "video_product_map"
    ? `<button class="secondary" type="button" onclick="toggleJsonPreview(decodeURIComponent('${encodedPath}'), this)">预览</button>`
    : "";
  const compact = Boolean(options.compact);
  return `<div class="asset-file ${compact ? "compact" : ""}">
    <div>
      <div class="asset-kind">${escapeHtml(libraryKindLabel(item))}</div>
      <div>
        <div class="asset-file-title">${escapeHtml(label)}${size}</div>
        <div class="asset-file-meta">${escapeHtml(formatTime(item.updated_at * 1000))}</div>
        <div class="asset-file-path">${escapeHtml(item.path)}</div>
      </div>
    </div>
    <div class="job-actions">
      ${jsonPreviewAction}
      ${videoPreviewAction}
      ${mapAction}
      ${clipAction}
      <button class="danger" type="button" onclick="deleteLibraryFile(decodeURIComponent('${encodedPath}'))">删除</button>
    </div>
    <div id="${fileDomId(item.path)}-preview"></div>
    ${compact ? "" : player}
  </div>`;
}

function renderLibraryItem(item) {
  return `<div class="job asset-bundle expanded">
    <div class="job-main">
      ${renderLibraryFile(item)}
    </div>
  </div>`;
}

function renderLibraryGroup(group) {
  if (group.items.length === 1 && !group.identity) return renderLibraryItem(group.items[0]);
  const primary = pickPrimarySourceItem(group.items);
  const attached = group.items.filter((item) => item !== primary);
  const mapProducts = bestAvailableProductItemForGroup(group);
  const productsCount = Number(mapProducts?.product_count || 0);
  let mapDisabledReason = "";
  if (!mapProducts) {
    mapDisabledReason = "先抓这场直播的商品，再识别视频里讲的是哪件抖音商品。";
  } else if (productsCount <= 0) {
    mapDisabledReason = "这场直播当前没有抓到商品，先重新抓商品后再试。";
  } else if (!videoProductMappingReady) {
    mapDisabledReason = videoProductMappingMessage || "请先完善视频识别配置";
  }
  const mappingHint = !mapProducts
    ? `<div class="asset-bundle-helper"><strong>暂时不能识别：</strong>先抓这场直播的商品，再判断视频里正在讲哪件抖音商品。</div>`
    : (productsCount <= 0
      ? `<div class="asset-bundle-helper"><strong>暂时不能识别：</strong>这场直播当前没有抓到商品，所以还没有候选商品可供识别。</div>`
      : (!videoProductMappingReady
        ? `<div class="asset-bundle-helper"><strong>暂时不能识别：</strong>${escapeHtml(videoProductMappingMessage || "请先完善视频识别配置")}</div>`
        : `<div class="asset-bundle-helper"><strong>视频讲解商品识别：</strong>只会从这场直播已经抓到的 ${escapeHtml(productsCount)} 个抖音商品里，判断这段视频正在讲哪个抖音商品。后面如果要去做京东、淘宝、美团这类平台匹配，会走另一套“商品匹配”逻辑。</div>`));
  const types = new Set(group.items.map((item) => item.type));
  const title = types.has("products") && types.has("video")
    ? "直播素材包"
    : (types.has("products") ? "商品数据包" : (types.has("clip") ? "剪辑素材包" : "视频素材包"));
  const meta = [
    group.sessionLabel ? `${group.sessionLabel}` : "",
    group.identity ? `来源 ${group.identity}` : "",
    `${group.items.length} 个文件`,
    formatTime(group.updatedAt * 1000),
  ].filter(Boolean).join(" · ");
  const isExpanded = expandedLibraryGroups.has(group.key);
  const sourceHtml = primary
    ? renderLibraryFile(primary, { productsPath: mapProducts?.path || "", mapDisabledReason })
    : `<div class="asset-source-empty"><strong>源头暂未在文件库中</strong><span>这组物料会先按来源编号归在一起，后续录制或下载到源视频后会自动合并到这里。</span></div>`;
  const attachedHtml = attached.length
    ? attached.map((item) => renderLibraryFile(item, { compact: true, productsPath: mapProducts?.path || "", mapDisabledReason })).join("")
    : "<div class='empty'>暂无附属物料</div>";
  const encodedGroupKey = encodeURIComponent(group.key);
  return `<div class="job asset-bundle ${isExpanded ? "expanded" : ""}" id="library-group-${escapeHtml(domToken(group.key, "group"))}">
    <div class="job-main">
      <div class="asset-bundle-head">
        <div>
          <div class="asset-bundle-title">${escapeHtml(title)}</div>
          <div class="asset-bundle-meta">${escapeHtml(meta)}</div>
          ${mappingHint}
        </div>
        <div class="job-actions">
          <div class="badge">${escapeHtml(group.items.map((item) => labelForLibraryType(item.type)).filter((v, i, arr) => arr.indexOf(v) === i).join(" + "))}</div>
          <button class="secondary" type="button" onclick="toggleLibraryGroup(decodeURIComponent('${encodedGroupKey}'))">${isExpanded ? "收起" : "展开"}</button>
        </div>
      </div>
      <div class="asset-bundle-body">
        <section class="asset-column">
          <div class="asset-column-head">
            <div class="asset-column-title">源头</div>
          </div>
          <div class="asset-source">${sourceHtml}</div>
        </section>
        <section class="asset-column">
          <div class="asset-column-head">
            <div class="asset-column-title">附属物料</div>
            <div class="detail-section-sub">${escapeHtml(attached.length)} 项</div>
          </div>
          <div class="asset-children">${attachedHtml}</div>
        </section>
      </div>
    </div>
  </div>`;
}

async function toggleJsonPreview(path, button) {
  const node = $(`${fileDomId(path)}-preview`);
  if (!node) return;
  if (node.dataset.open === "1") {
    clearPreviewNode(node, button, "预览");
    return;
  }
  node.className = "json-preview";
  node.dataset.open = "1";
  if (button) button.textContent = "收起预览";
  node.innerHTML = "<div class='result-item'><strong>正在读取</strong>正在打开这份本机数据...</div>";
  try {
    const data = await api("/api/library/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    const displayData = data.summary_data || data.data || {};
    const videoMapHtml = renderVideoProductMapPreview(displayData, { title: "视频里正在讲的抖音商品", cacheKey: `map:${path}` });
    const productHtml = renderProducts(displayData, { title: "商品预览", cacheKey: `library:${path}` });
    const rawHtml = renderDetailSection("原始 JSON", `<pre>${escapeHtml(JSON.stringify(displayData, null, 2))}</pre>`, data.name || "");
    node.innerHTML = `${videoMapHtml || productHtml || "<div class='result-item'><strong>预览</strong>这份数据里没有商品列表，下面可以查看原始内容。</div>"}${rawHtml}`;
  } catch (err) {
    node.dataset.open = "";
    if (button) button.textContent = "预览";
    node.innerHTML = `<div class="result-item"><strong>预览失败</strong>${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function deleteJob(jobId) {
  const job = jobItems.find((item) => item.id === jobId);
  const isActive = ["queued", "running"].includes(job?.status);
  const message = isActive
    ? "这个任务还在运行。删除会先暂停任务，再删除任务记录和关联的本机文件。确定删除吗？"
    : "会删除这个任务记录，并删除它关联的本机文件。确定删除吗？";
  if (!confirm(message)) return;
  try {
    const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    toast(`已删除任务，删除 ${data.deleted_files?.length || 0} 个文件。`);
    await refreshJobs();
    await refreshLibrary();
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function cancelJob(jobId) {
  if (!confirm("确定暂停这个任务吗？已产出的文件会保留在文件库。")) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    toast("任务已暂停。");
    await refreshJobs();
    await refreshLibrary();
  } catch (err) {
    toast(err.message || String(err));
  }
}

async function deleteLibraryFile(path) {
  if (!confirm("只会从本机磁盘删除当前这个文件，不会连带删除同源商品、剪辑或源视频。确定删除吗？")) return;
  try {
    const data = await api("/api/library/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    });
    toast(`已删除 ${data.deleted?.length || 0} 个文件。`);
    await refreshLibrary();
    await refreshJobs();
  } catch (err) {
    toast(err.message || String(err));
  }
}

function selectWorkspace(name) {
  document.querySelectorAll("[data-workspace]").forEach((tab) => tab.classList.toggle("active", tab.dataset.workspace === name));
  $("jobsPane").classList.toggle("active", name === "jobs");
  $("libraryPane").classList.toggle("active", name === "library");
  if (name === "library") refreshLibrary();
}

function isLiveJob(job) {
  return String(job.type || "").startsWith("live_");
}

function matchesJobFilter(job) {
  if (jobFilter === "all") return true;
  if (jobFilter === "running") return ["queued", "running"].includes(job.status);
  if (jobFilter === "completed") return job.status === "completed";
  if (jobFilter === "cancelled") return job.status === "cancelled";
  if (jobFilter === "failed") return job.status === "failed";
  if (jobFilter === "video") return job.type === "video_download";
  if (jobFilter === "live") return isLiveJob(job);
  if (jobFilter === "video_map") return job.type === "video_product_map";
  if (jobFilter === "product_pool") return job.type === "product_match";
  return true;
}

function selectJobFilter(type) {
  jobFilter = type;
  document.querySelectorAll("[data-job-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.jobFilter === type);
  });
  renderJobs();
}

function renderJobs() {
  const items = jobItems.filter(matchesJobFilter);
  const emptyText = jobFilter === "all" ? "暂无任务" : "没有符合筛选的任务";
  $("jobs").innerHTML = items.map(renderJob).join("") || `<div class='empty'>${emptyText}</div>`;
}

function selectLibraryFilter(type) {
  libraryFilter = type;
  document.querySelectorAll("[data-library-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.libraryFilter === type);
  });
  renderLibrary();
}

function renderLibrary() {
  const query = ($("librarySearch")?.value || "").trim().toLowerCase();
  const filteredItems = libraryItems.filter((item) => {
    const matchesType = libraryFilter === "all" || item.type === libraryFilter;
    const matchesQuery = !query || `${item.name} ${item.path} ${item.type} ${item.source_identity || ""}`.toLowerCase().includes(query);
    return matchesType && matchesQuery;
  });
  const groupMap = new Map();
  const pendingProducts = [];
  for (const item of filteredItems) {
    if (item.type === "products") {
      pendingProducts.push(item);
      continue;
    }
    const identity = item.source_identity || "";
    const sessionKey = deriveLibrarySessionKey(item);
    const key = sessionKey || `file:${item.path}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        identity,
        sessionKey,
        sessionLabel: sessionKey ? sessionLabelFromKey(sessionKey) : "",
        items: [],
        updatedAt: 0,
      });
    }
    const group = groupMap.get(key);
    group.items.push(item);
    group.updatedAt = Math.max(group.updatedAt, Number(item.updated_at || 0));
  }
  for (const item of pendingProducts) {
    const linkedKey = bestJobLinkedSessionKeyForProduct(item, groupMap) || nearestSessionKeyForProduct(item, groupMap);
    const identity = item.source_identity || "";
    const key = linkedKey || `product:${item.path}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        identity,
        sessionKey: "",
        sessionLabel: "",
        items: [],
        updatedAt: 0,
      });
    }
    const group = groupMap.get(key);
    if (!group.identity && identity) group.identity = identity;
    group.items.push(item);
    group.updatedAt = Math.max(group.updatedAt, Number(item.updated_at || 0));
  }
  const groups = Array.from(groupMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  const emptyText = query || libraryFilter !== "all" ? "没有符合筛选的文件" : "暂无本地文件";
  $("library").innerHTML = groups.map(renderLibraryGroup).join("") || `<div class='empty'>${emptyText}</div>`;
}

async function refreshLibrary() {
  try {
    const data = await api("/api/library");
    libraryItems = data.items || [];
    videoProductMappingReady = Boolean(data.video_product_mapping_ready);
    videoProductMappingMessage = data.video_product_mapping_message || "请先完善视频识别配置";
    renderLibrary();
    renderJobs();
  } catch (err) {
    $("library").innerHTML = `<pre>${escapeHtml(err.message || String(err))}</pre>`;
  }
}

function toggleLibraryGroup(groupKey) {
  if (expandedLibraryGroups.has(groupKey)) {
    expandedLibraryGroups.delete(groupKey);
  } else {
    expandedLibraryGroups.add(groupKey);
  }
  renderLibrary();
}

function toggleJob(jobId) {
  if (expandedJobs.has(jobId)) {
    expandedJobs.delete(jobId);
  } else {
    expandedJobs.add(jobId);
  }
  const node = document.getElementById(`job-${jobId}`);
  if (node) {
    node.classList.toggle("expanded", expandedJobs.has(jobId));
    const button = node.querySelector(".job-head button");
    if (button) button.textContent = expandedJobs.has(jobId) ? "收起" : "展开";
  }
}

async function refreshJobs() {
  try {
    const data = await api("/api/jobs");
    jobItems = data.jobs || [];
    syncProductMatchPreviewsFromJobs();
    const hasRunningJobs = jobItems.some((job) => ["queued", "running"].includes(job.status));
    if (!hasRunningJobs) stopJobsPolling();
    const nextKey = JSON.stringify(jobItems.map((job) => ({
      id: job.id,
      status: job.status,
      updated_at: job.updated_at,
      error: job.error || "",
      result: job.result || null,
    })));
    if (nextKey === jobsRenderKey) return;
    jobsRenderKey = nextKey;
    renderJobs();
  } catch (err) {
    const message = err.message || String(err);
    if (jobsRenderKey === `error:${message}`) return;
    jobsRenderKey = `error:${message}`;
    $("jobs").innerHTML = `<pre>${escapeHtml(message)}</pre>`;
  }
}

function startJobsPolling() {
  if (jobsTimer) return;
  jobsTimer = setInterval(refreshJobs, 2500);
}

function stopJobsPolling() {
  if (!jobsTimer) return;
  clearInterval(jobsTimer);
  jobsTimer = null;
}

checkHealth();
refreshAuth();
refreshJobs();
refreshLibrary();
selectMode(currentMode);
