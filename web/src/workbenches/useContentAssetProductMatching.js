import { useCallback, useState } from "react";
import { extractContentAssetProducts } from "../lib/contentAssetsTools";

export function useContentAssetProductMatching({
  api,
  refreshContentJobs,
  runContentCommand,
  setContentWorkspace,
}) {
  const [contentJsonPreviews, setContentJsonPreviews] = useState({});
  const [contentMatchForms, setContentMatchForms] = useState({});
  const [candidateComments, setCandidateComments] = useState({});

  const toggleContentJsonPreview = useCallback(async (filePath) => {
    if (!filePath) return;
    const current = contentJsonPreviews[filePath];
    if (current?.open) {
      setContentJsonPreviews((items) => ({ ...items, [filePath]: { ...current, open: false } }));
      return;
    }
    setContentJsonPreviews((items) => ({ ...items, [filePath]: { open: true, loading: true, data: null, error: "" } }));
    try {
      const data = await runContentCommand("/api/library/preview", { path: filePath });
      setContentJsonPreviews((items) => ({ ...items, [filePath]: { open: true, loading: false, data, error: "" } }));
    } catch (error) {
      setContentJsonPreviews((items) => ({ ...items, [filePath]: { open: true, loading: false, data: null, error: error.message } }));
    }
  }, [contentJsonPreviews, runContentCommand]);

  const startVideoProductMap = useCallback(async (videoPath, productsPath) => {
    if (!videoPath || !productsPath) {
      api.warning("还缺少视频文件或直播间商品数据，暂时无法判断这段视频在讲哪个抖音商品。");
      return;
    }
    try {
      await runContentCommand("/api/video/products/map", { video_path: videoPath, products_path: productsPath });
      api.success("视频讲解商品识别任务已创建");
      await refreshContentJobs(true);
      setContentWorkspace("jobs");
    } catch (error) {
      api.error(`创建失败：${error.message}`);
    }
  }, [api, refreshContentJobs, runContentCommand, setContentWorkspace]);

  const updateContentMatchForm = useCallback((filePath, patch) => {
    setContentMatchForms((forms) => ({
      ...forms,
      [filePath]: {
        platforms: ["jd"],
        same_product: true,
        similar_product: true,
        same_category: false,
        best_reviewed: false,
        price_float_percent: "",
        loading: false,
        ...(forms[filePath] || {}),
        ...patch,
      },
    }));
  }, []);

  const startContentProductMatch = useCallback(async (filePath, previewData) => {
    const displayData = previewData?.summary_data || previewData?.data || previewData || {};
    const products = extractContentAssetProducts(displayData);
    if (!products.length) {
      api.warning("没有可匹配的抖音商品。");
      return;
    }
    const form = contentMatchForms[filePath] || {};
    const platforms = Array.isArray(form.platforms) && form.platforms.length ? form.platforms : ["jd"];
    updateContentMatchForm(filePath, { loading: true });
    try {
      await runContentCommand("/api/products/match", {
        products,
        platforms,
        source: displayData.web_rid ? `douyin_live:${displayData.web_rid}` : "douyin_live",
        conditions: {
          same_product: form.same_product ?? true,
          similar_product: form.similar_product ?? true,
          same_category: form.same_category ?? false,
          best_reviewed: form.best_reviewed ?? false,
          price_float_percent: form.price_float_percent === "" || form.price_float_percent == null ? null : Number(form.price_float_percent),
          limit_per_product: 3,
        },
      });
      api.success("商品匹配任务已创建");
      await refreshContentJobs(true);
      setContentWorkspace("jobs");
    } catch (error) {
      api.error(`商品匹配失败：${error.message}`);
    } finally {
      updateContentMatchForm(filePath, { loading: false });
    }
  }, [api, contentMatchForms, refreshContentJobs, runContentCommand, setContentWorkspace, updateContentMatchForm]);

  const candidateCommentKey = useCallback((candidate = {}, index = 0, sourceProduct = {}) => [
    candidate.platform || "",
    candidate.product_id || "",
    candidate.sku_id || "",
    candidate.item_id || "",
    candidate.detail_url || "",
    sourceProduct.source_product_id || "",
    index,
  ].join(":"), []);

  const refreshCandidateComments = useCallback(async (commentKey, candidate, page = 1) => {
    const pageSize = 3;
    const offset = (Math.max(1, Number(page) || 1) - 1) * pageSize;
    setCandidateComments((items) => ({ ...items, [commentKey]: { status: "loading", page, data: null, error: "" } }));
    try {
      const data = await runContentCommand("/api/products/comments", {
        ...candidateCommentPayload(candidate),
        limit: pageSize,
        offset,
      });
      setCandidateComments((items) => ({ ...items, [commentKey]: { status: "completed", page, data, error: "" } }));
    } catch (error) {
      setCandidateComments((items) => ({ ...items, [commentKey]: { status: "failed", page, data: null, error: error.message } }));
    }
  }, [runContentCommand]);

  const openCandidateProduct = useCallback((commentKey, candidate) => {
    if (candidate.detail_url) window.open(candidate.detail_url, "_blank", "noopener,noreferrer");
    refreshCandidateComments(commentKey, candidate);
    window.setTimeout(() => refreshCandidateComments(commentKey, candidate), 5000);
    window.setTimeout(() => refreshCandidateComments(commentKey, candidate), 15000);
  }, [refreshCandidateComments]);

  return {
    candidateCommentKey,
    candidateComments,
    contentJsonPreviews,
    contentMatchForms,
    openCandidateProduct,
    refreshCandidateComments,
    startContentProductMatch,
    startVideoProductMap,
    toggleContentJsonPreview,
    updateContentMatchForm,
  };
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
