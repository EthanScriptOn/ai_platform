import {
  contentAssetJobStatus,
  contentAssetPathSession,
  contentAssetSessionLabel,
  contentAssetSourceIdentity,
  isContentAssetLiveJob,
} from "../lib/contentAssetsTools";
import { buildUrl } from "../lib/collectorTools.jsx";

export const contentAssetCollectorTokenStorageKey = "yuebai-douyin-collector-token";

export function buildContentAssetInstallCommand({
  collectorToken,
  installBaseUrl,
  platform,
}) {
  const installScriptPath =
    platform === "macos"
      ? "/install/yuebai-douyin-collector-macos.sh"
      : "/install/yuebai-douyin-collector-windows.ps1";
  const installScriptUrl = new URL(buildUrl(installBaseUrl, installScriptPath));
  if (collectorToken) installScriptUrl.searchParams.set("token", collectorToken);
  return platform === "macos"
    ? `/bin/bash -c "$(curl -fsSL '${installScriptUrl.toString()}')"`
    : `powershell -ExecutionPolicy Bypass -Command "irm '${installScriptUrl.toString()}' | iex"`;
}

export function extractDouyinUrl(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(/https?:\/\/[^\s，,。]+/);
  return match ? match[0].replace(/[。，,.!！?？]+$/, "") : raw;
}

export function isDouyinLiveUrl(url = "") {
  return /live\.douyin\.com|douyin\.com\/(?:follow\/)?live\//i.test(String(url || ""));
}

export function filterContentJobs(contentJobs, jobFilter) {
  return contentJobs.filter((job) => {
    const status = contentAssetJobStatus(job);
    if (jobFilter === "all") return true;
    if (jobFilter === "running") return ["queued", "running"].includes(status);
    if (jobFilter === "completed") return status === "completed";
    if (jobFilter === "failed") return status === "failed";
    if (jobFilter === "cancelled") return status === "cancelled";
    if (jobFilter === "video") return job.type === "video_download";
    if (jobFilter === "live") return isContentAssetLiveJob(job);
    if (jobFilter === "product_pool") return job.type === "product_match";
    if (jobFilter === "video_map") return job.type === "video_product_map";
    return true;
  });
}

export function filterContentLibrary(contentLibrary, libraryFilter, librarySearch) {
  return contentLibrary.filter((item) => {
    const typeMatched = libraryFilter === "all" || item.type === libraryFilter;
    const query = librarySearch.trim().toLowerCase();
    const queryMatched = !query || `${item.name || ""} ${item.path || ""} ${item.source_identity || ""}`.toLowerCase().includes(query);
    return typeMatched && queryMatched;
  });
}

export function groupContentLibraryItems(visibleLibraryItems) {
  const groups = new Map();
  const ensureGroup = (key, item) => {
    if (!groups.has(key)) {
      const identity = item.source_identity || contentAssetSourceIdentity(item.path);
      groups.set(key, {
        key,
        identity,
        sessionLabel: contentAssetSessionLabel(key),
        items: [],
        updatedAt: 0,
      });
    }
    const group = groups.get(key);
    group.items.push(item);
    group.updatedAt = Math.max(group.updatedAt, Number(item.updated_at || 0));
    return group;
  };

  visibleLibraryItems.forEach((item) => {
    const key = contentAssetPathSession(item.path, item.type) || `file:${item.path}`;
    ensureGroup(key, item);
  });

  return Array.from(groups.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}
