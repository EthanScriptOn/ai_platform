import React from "react";
import { Input } from "antd";
import { CollectorButton } from "../lib/collectorTools.jsx";
import {
  contentAssetFileLabels,
  contentAssetProductCount,
  contentAssetResultFiles,
  extractContentAssetProducts,
  formatContentAssetSeconds,
  formatContentAssetSize,
  formatContentAssetTime,
  matchPlatformOptions,
} from "../lib/contentAssetsTools";

/**
 * @typedef {Object} ContentAssetRendererOptions
 * @property {Record<string, Object>} candidateComments
 * @property {(candidate: Object, index: number, product?: Object) => string} candidateCommentKey
 * @property {Record<string, boolean>} contentJsonPreviews
 * @property {Record<string, Object>} contentMatchForms
 * @property {(file: Object, item: Object) => void} deleteLibraryFile
 * @property {(commentKey: string, candidate: Object) => void} openCandidateProduct
 * @property {(item: Object) => void} openContentClipper
 * @property {(commentKey: string, candidate: Object, page?: number) => void} refreshCandidateComments
 * @property {(item: Object) => void} startContentProductMatch
 * @property {(item: Object) => void} startVideoProductMap
 * @property {(key: string) => void} toggleContentJsonPreview
 * @property {(key: string, patch: Object) => void} updateContentMatchForm
 */

/**
 * @param {ContentAssetRendererOptions} options
 * @returns {{
 *   renderContentJobResult: (job: Object) => React.ReactNode,
 *   renderLibraryFile: (file: Object, item: Object) => React.ReactNode,
 * }}
 */
export function createContentAssetRenderers({
  candidateComments,
  candidateCommentKey,
  contentJsonPreviews,
  contentMatchForms,
  deleteLibraryFile,
  openCandidateProduct,
  openContentClipper,
  refreshCandidateComments,
  startContentProductMatch,
  startVideoProductMap,
  toggleContentJsonPreview,
  updateContentMatchForm,
}) {
  const renderCandidateComments = (commentKey, candidate) => {
    const state = candidateComments[commentKey];
    if (!state) return <div className="candidate-comments"><strong>评论数据</strong>打开商品后，插件采集完成再点“刷新评论”。</div>;
    if (state.status === "loading") return <div className="candidate-comments"><strong>评论数据</strong>正在查询评论库...</div>;
    if (state.status === "failed") return <div className="candidate-comments"><strong>评论数据</strong>{state.error || "查询失败"}</div>;
    const data = state.data || {};
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const stats = data.stats || {};
    const pagination = data.pagination || {};
    const total = Number(stats.comment_count || comments.length || 0);
    const pageSize = Number(pagination.limit || 3);
    const currentPage = Math.floor(Number(pagination.offset || 0) / pageSize) + 1;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return (
      <div className="candidate-comments">
        <strong>评论数据</strong>
        <span>{data.matched ? `已采集 ${total} 条评论` : (data.message || "暂未查到评论。打开商品页后，等待插件上传再刷新。")}</span>
        {comments.map((comment, index) => (
          <div className="comment-line" key={`${comment.id || comment.feedback_date || index}`}>
            <em>{[comment.score ? `${comment.score}分` : "", comment.feedback_date ? formatContentAssetTime(comment.feedback_date) : ""].filter(Boolean).join(" · ")}</em>
            <span>{comment.content || ""}</span>
          </div>
        ))}
        {data.matched && totalPages > 1 ? (
          <div className="comment-pagination">
            <CollectorButton size="small" disabled={currentPage <= 1} onClick={() => refreshCandidateComments(commentKey, candidate, currentPage - 1)}>上一页</CollectorButton>
            <span>{currentPage} / {totalPages}</span>
            <CollectorButton size="small" disabled={currentPage >= totalPages} onClick={() => refreshCandidateComments(commentKey, candidate, currentPage + 1)}>下一页</CollectorButton>
          </div>
        ) : null}
      </div>
    );
  };

  const renderProductMatchResult = (result = {}) => {
    const rows = Array.isArray(result.results) ? result.results : [];
    if (!rows.length) return null;
    return (
      <div className="content-detail-section">
        <div className="detail-section-head">
          <div className="detail-section-title">匹配结果</div>
          <div className="detail-section-sub">{rows.length} 个商品</div>
        </div>
        <div className="match-results">
          {rows.map((row, rowIndex) => {
            const product = row.source_product || {};
            const candidates = Array.isArray(row.candidates) ? row.candidates : [];
            return (
              <div className="match-card" key={`${product.source_product_id || product.title || rowIndex}`}>
                <div className="match-source">
                  {product.cover ? <img src={product.cover} alt="" /> : <div className="product-placeholder" />}
                  <div>
                    <span>原始抖音商品</span>
                    <strong>{product.title || "抖音商品"}</strong>
                    <em>{product.price_yuan ? `¥${product.price_yuan}` : product.source_product_id || ""}</em>
                  </div>
                </div>
                {Array.isArray(row.agent_notes) && row.agent_notes.length ? <div className="match-note">{row.agent_notes.join(" ")}</div> : null}
                <div className="candidate-list">
                  {candidates.length ? candidates.map((candidate, index) => {
                    const commentKey = candidateCommentKey(candidate, index, product);
                    return (
                      <div className="candidate" key={commentKey}>
                        {candidate.image ? <img src={candidate.image} alt="" /> : <div className="product-placeholder" />}
                        <div className="candidate-body">
                          <div className="candidate-title">{candidate.title || "未命名商品"}</div>
                          <div className="candidate-meta">{[candidate.match_type || "候选", candidate.match_reason || ""].filter(Boolean).join(" · ")}</div>
                          <div className="candidate-facts">
                            {[candidate.platform_label || candidate.platform, candidate.price_yuan ? `¥${candidate.price_yuan}` : "", candidate.shop_name ? `店铺 ${candidate.shop_name}` : "", candidate.category_name ? `类目 ${candidate.category_name}` : "", candidate.score != null ? `${(Number(candidate.score) * 100).toFixed(0)}分` : ""].filter(Boolean).map((text) => <span key={text}>{text}</span>)}
                          </div>
                          <div className="candidate-actions">
                            {candidate.detail_url ? <CollectorButton size="small" onClick={() => openCandidateProduct(commentKey, candidate)}>打开商品</CollectorButton> : null}
                            <CollectorButton size="small" onClick={() => refreshCandidateComments(commentKey, candidate)}>刷新评论</CollectorButton>
                          </div>
                          {renderCandidateComments(commentKey, candidate)}
                        </div>
                      </div>
                    );
                  }) : <div className="match-note">当前选中平台没有返回候选商品。</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderVideoProductMapResult = (result = {}) => {
    const isMappingPayload = Array.isArray(result.matched_products) || Array.isArray(result.chunks) || result.mapping_path || result.video_path;
    if (!isMappingPayload) return null;
    const matched = Array.isArray(result.matched_products) ? result.matched_products : [];
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    const pipeline = result.pipeline || {};
    const counts = pipeline.counts || {};
    return (
      <div className="content-detail-section video-map-result">
        <div className="detail-section-head">
          <div className="detail-section-title">视频里正在讲的抖音商品</div>
          <div className="detail-section-sub">{matched.length} 个商品</div>
        </div>
        <div className="result-item">
          <strong>这一步在做什么</strong>
          <span>只从这场直播已经抓到的抖音商品里，判断这段视频正在讲哪一个或哪几个商品。</span>
        </div>
        {matched.length ? (
          <div className="match-results">
            {matched.map((item, index) => {
              const sourceProduct = item.source_product || {};
              const avg = Number(item.avg_confidence || 0);
              const max = Number(item.max_confidence || 0);
              const summaries = Array.isArray(item.sample_summaries) ? item.sample_summaries.filter(Boolean).slice(0, 2) : [];
              return (
                <div className="match-card" key={`${item.title || sourceProduct.title || index}`}>
                  <div className="match-source">
                    {sourceProduct.cover ? <img src={sourceProduct.cover} alt="" /> : <div className="product-placeholder" />}
                    <div>
                      <span>识别到的抖音商品</span>
                      <strong>{item.title || sourceProduct.title || "未识别商品"}</strong>
                      <em>命中 {Number(item.hit_count || 0)} 段 · 平均 {(avg * 100).toFixed(0)} 分 · 最高 {(max * 100).toFixed(0)} 分</em>
                    </div>
                  </div>
                  {summaries.length ? <div className="match-note">{summaries.join(" ")}</div> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="result-item"><strong>识别结果</strong>当前还没有可靠的抖音商品结果。可以先看下面每一段的切片、上传和分析状态。</div>
        )}
        {chunks.length ? (
          <div className="chunk-preview">
            <div className="detail-section-head">
              <div className="detail-section-title">分段处理概览</div>
              <div className="detail-section-sub">{pipeline.summary || `${chunks.length} 段`}</div>
            </div>
            <div className="pipeline-stats">
              {[
                ["总段数", chunks.length],
                ["已完成", Number(counts.completed || result.completed_chunk_count || 0)],
                ["分析中", Number(counts.analyzing || result.analyzing_chunk_count || 0)],
                ["待分析", Number(counts.ready || 0)],
                ["上传中", Number(counts.uploading || 0)],
                ["切片中", Number(counts.cutting || 0)],
                ["失败", Number(counts.failed || result.failed_chunk_count || 0)],
              ].map(([label, value]) => (
                <div className="pipeline-stat" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {pipeline.depends_on_previous_chunk ? (
              <div className="asset-bundle-helper"><strong>顺序分析说明：</strong>当前段的商品判断会参考上一段结果，所以模型分析按顺序进行。</div>
            ) : null}
            <div className="chunk-grid">
              {chunks.slice(0, 30).map((chunk, index) => {
                const status = String(chunk.status_label || chunk.status || "queued");
                const timeLabel = `${formatContentAssetSeconds(chunk.start_seconds)} - ${formatContentAssetSeconds(chunk.end_seconds)}`;
                return (
                  <div className={`chunk-card ${chunk.status || ""}`} key={`${chunk.chunk_index || index}`}>
                    <div className="chunk-card-head">
                      <div>
                        <div className="chunk-card-title">第 {chunk.chunk_index || index + 1} 段</div>
                        <div className="chunk-card-time">{timeLabel}</div>
                      </div>
                      <div className="badge">{status}</div>
                    </div>
                    {chunk.resolved_match?.title ? <div className="chunk-match">命中商品：{chunk.resolved_match.title}</div> : null}
                    {chunk.summary ? <div className="chunk-summary">{chunk.summary}</div> : null}
                    {chunk.error ? <div className="chunk-error">{chunk.error}</div> : null}
                    {chunk.clip_reference && String(chunk.clip_reference).startsWith("http") ? (
                      <a className="chunk-link" href={chunk.clip_reference} target="_blank" rel="noreferrer">查看片段</a>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {chunks.length > 30 ? <div className="hint">已展示前 30 段，完整数据可看下方原始 JSON。</div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderContentJobResult = (job) => {
    const result = job.result && typeof job.result === "object" ? job.result : null;
    const files = contentAssetResultFiles(result || {});
    const products = job.type === "live_record_with_products"
      ? contentAssetProductCount(result?.products || {})
      : contentAssetProductCount(result || {});
    const duration = job.updated_at && job.created_at ? Math.max(0, job.updated_at - job.created_at).toFixed(1) : "-";
    const matchTotal = Array.isArray(result?.results) ? result.results.length : contentAssetProductCount(job.input || {});
    const matches = Number(result?.matched_count || 0);
    const mappedProducts = Array.isArray(result?.matched_products) ? result.matched_products.length : 0;
    const metrics = [
      ["创建时间", formatContentAssetTime(job.created_at)],
      ["最近更新", formatContentAssetTime(job.updated_at)],
      ["耗时", `${duration}s`],
    ];
    if (job.type === "product_match") {
      if (matchTotal > 0) metrics.push(["源商品", `${matchTotal} 个`]);
      metrics.push(["命中商品", `${matches} / ${matchTotal || 0} 个`]);
    } else {
      metrics.push(["产出文件", `${files.length} 个`]);
    }
    if (String(job.type || "").includes("products")) metrics.push(["商品", `${products} 个`]);
    if (job.type === "video_product_map") metrics.push(["识别到的抖音商品", `${mappedProducts} 个`]);
    return (
      <div className="content-job-detail">
        <div className="meta-grid">
          {metrics.map(([label, value]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        {job.error ? <div className="content-detail-alert">{job.error}</div> : null}
        {job.type === "product_match" ? renderProductMatchResult(result || {}) : null}
        {job.type === "video_product_map" ? renderVideoProductMapResult(result || {}) : null}
        {files.length ? (
          <div className="content-detail-section">
            <div className="detail-section-head">
              <div className="detail-section-title">产出摘要</div>
              <div className="detail-section-sub">{files.length} 个文件</div>
            </div>
            <div className="content-detail-list">
              {files.map((file) => (
                <div className="content-detail-file" key={file.path || file.name}>
                  <span>{file.name || file.path}</span>
                  <em>{formatContentAssetSize(file.size_bytes)}</em>
                  {file.path ? <small>{file.path}</small> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderLibraryFile = (item, { compact = false, productsPath = "", mapDisabledReason = "" } = {}) => {
    const isVideo = ["video", "clip"].includes(item.type);
    const isJson = ["products", "room", "video_product_map"].includes(item.type);
    const jsonPreview = contentJsonPreviews[item.path];
    const canMapVideo = isVideo && productsPath && !mapDisabledReason;
    const showMapAction = isVideo && (productsPath || mapDisabledReason);
    return (
      <div className={`asset-file ${compact ? "compact" : ""}`} key={item.path}>
        <div className="asset-file-main">
          <div className="asset-kind">{contentAssetFileLabels[item.type] || item.type || "文件"}</div>
          <div>
            <div className="asset-file-title">
              {item.name || contentAssetFileLabels[item.type] || "文件"}
              {item.size_bytes ? ` · ${formatContentAssetSize(item.size_bytes)}` : ""}
            </div>
            <div className="asset-file-meta">{formatContentAssetTime(item.updated_at)}</div>
            <div className="asset-file-path">{item.path}</div>
          </div>
        </div>
        <div className="job-actions">
          {isJson ? (
            <CollectorButton size="small" onClick={() => toggleContentJsonPreview(item.path)}>
              {jsonPreview?.open ? "收起预览" : "预览"}
            </CollectorButton>
          ) : null}
          {showMapAction ? (
            <CollectorButton
              size="small"
              disabled={!canMapVideo}
              onClick={() => startVideoProductMap(item.path, productsPath)}
              title={mapDisabledReason}
            >
              识别讲解中的抖音商品
            </CollectorButton>
          ) : null}
          {isVideo ? (
            <CollectorButton size="small" onClick={() => openContentClipper(item.path)}>预览/剪辑</CollectorButton>
          ) : null}
          <CollectorButton size="small" variant="ghost" onClick={() => deleteLibraryFile(item.path)}>删除</CollectorButton>
        </div>
        {jsonPreview?.open ? (
          <div className="json-preview">
            {jsonPreview.loading ? (
              <div className="result-item"><strong>正在读取</strong>正在打开这份本机数据...</div>
            ) : jsonPreview.error ? (
              <div className="result-item"><strong>预览失败</strong>{jsonPreview.error}</div>
            ) : (() => {
              const displayData = jsonPreview.data?.summary_data || jsonPreview.data?.data || jsonPreview.data || {};
              const products = extractContentAssetProducts(displayData);
              const form = contentMatchForms[item.path] || { platforms: ["jd"], same_product: true, similar_product: true };
              const videoMapPreview = item.type === "video_product_map" ? renderVideoProductMapResult(displayData) : null;
              return (
                <>
                  {videoMapPreview}
                  {products.length ? (
                    <div className="content-product-preview">
                      <div className="detail-section-head">
                        <div className="detail-section-title">商品预览</div>
                        <div className="detail-section-sub">{products.length} 个商品</div>
                      </div>
                      <div className="content-product-grid">
                        {products.slice(0, 8).map((product, index) => (
                          <div className="content-product-card" key={`${product.product_id || product.source_product_id || product.title || index}`}>
                            {product.cover ? <img src={product.cover} alt="" /> : <div className="product-placeholder" />}
                            <strong>{product.title || "抖音商品"}</strong>
                            <span>{product.show_price_yuan || product.min_price_yuan || product.price_yuan ? `¥${product.show_price_yuan || product.min_price_yuan || product.price_yuan}` : product.product_id || product.source_product_id || ""}</span>
                          </div>
                        ))}
                      </div>
                      <div className="content-match-panel">
                        <div>
                          <strong>匹配平台商品库</strong>
                          <span>按抖音商品名去勾选的平台查询，再按价格、类目和好评做重排。</span>
                        </div>
                        <div className="content-match-platforms">
                          {matchPlatformOptions.map((platform) => {
                            const checked = (form.platforms || ["jd"]).includes(platform.id);
                            return (
                              <label key={platform.id} className="match-platform-chip">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(event) => {
                                    const current = form.platforms || ["jd"];
                                    const next = event.target.checked
                                      ? Array.from(new Set([...current, platform.id]))
                                      : current.filter((itemId) => itemId !== platform.id);
                                    updateContentMatchForm(item.path, { platforms: next });
                                  }}
                                />
                                <span className="match-platform-copy">
                                  <span className="match-platform-title">{platform.label}</span>
                                  <span className="match-platform-sub">{platform.sub}</span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <div className="content-match-options">
                          {[
                            ["same_product", "自动找同一个商品"],
                            ["similar_product", "自动找相似商品"],
                            ["same_category", "限定同类型商品"],
                            ["best_reviewed", "优先好评最多"],
                          ].map(([key, label]) => (
                            <label key={key}>
                              <input
                                type="checkbox"
                                checked={Boolean(form[key])}
                                onChange={(event) => updateContentMatchForm(item.path, { [key]: event.target.checked })}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                          <label>
                            <span>价格浮动正负 %</span>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={form.price_float_percent || ""}
                              onChange={(event) => updateContentMatchForm(item.path, { price_float_percent: event.target.value })}
                              placeholder="不限"
                            />
                          </label>
                        </div>
                        <CollectorButton
                          variant="primary"
                          onClick={() => startContentProductMatch(item.path, jsonPreview.data)}
                          loading={Boolean(form.loading)}
                        >
                          {form.loading ? "匹配中..." : "开始匹配"}
                        </CollectorButton>
                      </div>
                    </div>
                  ) : (
                    <div className="result-item"><strong>预览</strong>这份数据里没有商品列表，下面可以查看原始内容。</div>
                  )}
                  <pre>{JSON.stringify(displayData, null, 2)}</pre>
                </>
              );
            })()}
          </div>
        ) : null}
      </div>
    );
  };


  return {
    renderContentJobResult,
    renderLibraryFile,
  };
}
