export const contentAssetJobLabels = {
  video_download: "下载视频",
  live_record: "直播录制",
  live_products: "直播商品",
  live_record_with_products: "录制并抓商品",
  product_match: "商品匹配",
  video_product_map: "视频讲解商品",
};

export const contentAssetStatusLabels = {
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已暂停",
};

export const contentAssetFileLabels = {
  video: "视频",
  clip: "剪辑片段",
  products: "商品数据",
  room: "直播间数据",
  video_product_map: "视频识别结果",
};

export function formatContentAssetTime(value) {
  const numeric = Number(value || 0);
  if (!numeric) return "";
  return new Date(numeric * 1000).toLocaleString();
}

export function formatContentAssetSize(value) {
  const numeric = Number(value || 0);
  if (!numeric) return "";
  if (numeric >= 1024 * 1024 * 1024) return `${(numeric / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (numeric >= 1024 * 1024) return `${(numeric / 1024 / 1024).toFixed(2)} MB`;
  if (numeric >= 1024) return `${(numeric / 1024).toFixed(1)} KB`;
  return `${numeric} B`;
}

export function formatContentAssetSeconds(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const tenths = Math.floor((total % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function contentAssetJobStatus(job = {}) {
  const result = job.result && typeof job.result === "object" ? job.result : {};
  const success = Number(result.success ?? 0);
  const failed = Number(result.failed ?? 0);
  if (job.status === "completed" && failed > 0 && success <= 0) return "failed";
  if (job.status === "completed" && result.type === "video" && Array.isArray(result.video_files) && result.video_files.length === 0) {
    return "failed";
  }
  return job.status || "unknown";
}

export function contentAssetResultFiles(result = {}) {
  if (!result || typeof result !== "object") return [];
  const files = result.video_files || result.files || result.recording?.video_files || result.recording?.files || [];
  return Array.isArray(files) ? files : [];
}

export function isContentAssetLiveJob(job) {
  return String(job.type || "").startsWith("live_");
}

export function contentAssetProductCount(payload = {}) {
  const candidates = [
    payload.products,
    payload.summary_data?.products,
    payload.data?.products,
    payload.items,
    payload.summary_data?.items,
    payload.data?.items,
  ];
  const products = candidates.find((item) => Array.isArray(item));
  if (products) return products.length;
  return Number(payload?.product_count || payload?.products?.product_count || 0) || 0;
}

export function extractContentAssetProducts(payload = {}) {
  const candidates = [
    payload.products,
    payload.summary_data?.products,
    payload.data?.products,
    payload.items,
    payload.summary_data?.items,
    payload.data?.items,
  ];
  return candidates.find((item) => Array.isArray(item)) || [];
}

export function contentAssetSourceIdentity(text = "") {
  const value = String(text || "");
  const match = value.match(/(\d{8,})/) || value.match(/live_products_(\d+)_/i);
  return match ? match[1] : "";
}

export const matchPlatformOptions = [
  { id: "douyin", label: "抖音", sub: "按抖音商品名查询抖音精选联盟商品库" },
  { id: "jd", label: "京东", sub: "按抖音商品名查询京东商品库" },
  { id: "taobao", label: "淘宝", sub: "按抖音商品名查询淘宝联盟商品库" },
];

export function contentAssetPathSession(path = "", type = "") {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (!normalized) return "";
  if (type === "products" || type === "room") {
    return normalized.replace(/\/(?:products|rooms?)\/[^/]+$/i, "");
  }
  if (type === "clip") {
    return normalized.replace(/\/clips\/[^/]+$/i, "");
  }
  return normalized.replace(/\/[^/]+$/i, "");
}

export function contentAssetSessionLabel(key = "") {
  const parts = String(key || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || key;
}

export function contentAssetVideoSuffix(path = "") {
  return String(path || "").split("?")[0].split(".").pop().toLowerCase();
}

export function isBrowserPlayableContentVideo(path = "") {
  return ["mp4", "webm", "mov", "m4v", "ogv"].includes(contentAssetVideoSuffix(path));
}

export function formatContentClipTime(seconds = 0) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function pickPrimaryContentAssetItem(items = []) {
  const videos = items.filter((item) => item.type === "video");
  if (!videos.length) return items[0];
  return [...videos].sort((a, b) => {
    const score = (item) => {
      const name = String(item.name || "");
      let value = Number(item.size_bytes || 0);
      if (!name.includes("_probe_")) value += 10 ** 12;
      if (!name.endsWith("_preview.mp4")) value += 10 ** 11;
      if (name.endsWith(".flv")) value += 10 ** 10;
      return value;
    };
    return score(b) - score(a);
  })[0];
}

