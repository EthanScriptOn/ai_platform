import React from "react";
import { Input, Typography } from "antd";
import { CollectorButton, CollectorPill } from "../lib/collectorTools.jsx";
import { contentAssetFileLabels, contentAssetJobLabels, contentAssetJobStatus, contentAssetStatusLabels, formatContentAssetTime } from "../lib/contentAssetsTools";
import { CollectorRuntimePanel, ContentClipperPanel, ContentTaskPanel } from "./ContentAssetsWorkbenchPanels.jsx";

const { Text, Title } = Typography;
const { TextArea } = Input;

/**
 * @typedef {Object} ContentAssetsWorkbenchViewProps
 * @property {Object|null} authStatus
 * @property {Object} collectorStatus
 * @property {Object} commandLoading
 * @property {Object} contentWorkspace
 * @property {Object} clipModal
 * @property {Array<Object>} visibleContentJobs
 * @property {Array<Object>} visibleLibraryGroups
 * @property {Set<string>} expandedContentJobs
 * @property {Set<string>} expandedLibraryGroups
 * @property {string} collectorBaseUrl
 * @property {string} contentMode
 * @property {string} installCommand
 * @property {string} jobFilter
 * @property {string} libraryFilter
 * @property {string} librarySearch
 * @property {string} loginLabel
 * @property {string} loginTone
 * @property {string} platform
 * @property {string} taskUrl
 * @property {boolean} checking
 * @property {boolean} grabAllProducts
 * @property {boolean} liveProducts
 * @property {boolean} liveRecord
 * @property {boolean} recordUntilEnd
 * @property {number|string} durationSeconds
 * @property {number|string} productLimit
 * @property {React.ReactNode} contextHolder
 * @property {React.RefObject<HTMLElement>} contentClipperRef
 * @property {React.RefObject<HTMLElement>} installCommandRef
 * @property {(silent?: boolean) => void} checkCollector
 * @property {() => void} cancelDouyinLogin
 * @property {() => void} closeContentClipper
 * @property {() => void} copyInstallCommand
 * @property {() => void} logoutDouyin
 * @property {() => void} openContentClipper
 * @property {() => void} refreshContentJobs
 * @property {() => void} refreshContentLibrary
 * @property {() => void} startDouyinLogin
 * @property {() => void} submitContentTask
 * @property {(job: Object) => void} cancelContentJob
 * @property {(job: Object) => void} deleteContentJob
 * @property {(item: Object) => void} exportContentClip
 * @property {(item: Object) => string} formatContentClipTime
 * @property {(item: Object) => void} openContentPlayer
 * @property {(group: Object) => Object|null} pickPrimaryContentAssetItem
 * @property {(job: Object) => React.ReactNode} renderContentJobResult
 * @property {(file: Object, item: Object) => React.ReactNode} renderLibraryFile
 * @property {(value: string) => void} setContentMode
 * @property {(value: Object) => void} setContentWorkspace
 * @property {(value: number|string) => void} setDurationSeconds
 * @property {(value: boolean) => void} setGrabAllProducts
 * @property {(value: string) => void} setJobFilter
 * @property {(value: string) => void} setLibraryFilter
 * @property {(value: string) => void} setLibrarySearch
 * @property {(value: boolean) => void} setLiveProducts
 * @property {(value: boolean) => void} setLiveRecord
 * @property {(value: string) => void} setPlatform
 * @property {(value: number|string) => void} setProductLimit
 * @property {(value: boolean) => void} setRecordUntilEnd
 * @property {(value: string) => void} setTaskUrl
 * @property {(jobId: string) => void} toggleContentJob
 * @property {(groupKey: string) => void} toggleLibraryGroup
 * @property {(range: Object) => void} updateContentClipRange
 */

/**
 * @param {ContentAssetsWorkbenchViewProps} props
 */
export function ContentAssetsWorkbenchView({
  authStatus,
  cancelContentJob,
  cancelDouyinLogin,
  checking,
  checkCollector,
  clipModal,
  closeContentClipper,
  collectorBaseUrl,
  collectorStatus,
  commandLoading,
  contentClipperRef,
  contentMode,
  contentWorkspace,
  contextHolder,
  copyInstallCommand,
  deleteContentJob,
  durationSeconds,
  expandedContentJobs,
  expandedLibraryGroups,
  exportContentClip,
  formatContentClipTime,
  grabAllProducts,
  installCommand,
  installCommandRef,
  jobFilter,
  libraryFilter,
  librarySearch,
  liveProducts,
  liveRecord,
  loginLabel,
  loginTone,
  logoutDouyin,
  openContentClipper,
  openContentPlayer,
  pickPrimaryContentAssetItem,
  productLimit,
  recordUntilEnd,
  refreshContentJobs,
  refreshContentLibrary,
  renderContentJobResult,
  renderLibraryFile,
  setContentMode,
  setContentWorkspace,
  setDurationSeconds,
  setGrabAllProducts,
  setJobFilter,
  setLibraryFilter,
  setLibrarySearch,
  setLiveProducts,
  setLiveRecord,
  setPlatform,
  setProductLimit,
  setRecordUntilEnd,
  setTaskUrl,
  startDouyinLogin,
  submitContentTask,
  taskUrl,
  toggleContentJob,
  toggleLibraryGroup,
  updateContentClipRange,
  visibleContentJobs,
  visibleLibraryGroups,
  platform,
}) {
  return (
    <div className="wechat-video-workbench">
      {contextHolder}
      <section className="collector-grid content-command-grid">
        <CollectorRuntimePanel
          authStatus={authStatus}
          cancelDouyinLogin={cancelDouyinLogin}
          checking={checking}
          checkCollector={checkCollector}
          collectorBaseUrl={collectorBaseUrl}
          collectorStatus={collectorStatus}
          commandLoading={commandLoading}
          copyInstallCommand={copyInstallCommand}
          installCommand={installCommand}
          installCommandRef={installCommandRef}
          loginLabel={loginLabel}
          loginTone={loginTone}
          logoutDouyin={logoutDouyin}
          platform={platform}
          setPlatform={setPlatform}
          startDouyinLogin={startDouyinLogin}
        />
        <ContentTaskPanel
          commandLoading={commandLoading}
          contentMode={contentMode}
          durationSeconds={durationSeconds}
          grabAllProducts={grabAllProducts}
          liveProducts={liveProducts}
          liveRecord={liveRecord}
          productLimit={productLimit}
          recordUntilEnd={recordUntilEnd}
          setContentMode={setContentMode}
          setDurationSeconds={setDurationSeconds}
          setGrabAllProducts={setGrabAllProducts}
          setLiveProducts={setLiveProducts}
          setLiveRecord={setLiveRecord}
          setProductLimit={setProductLimit}
          setRecordUntilEnd={setRecordUntilEnd}
          setTaskUrl={setTaskUrl}
          submitContentTask={submitContentTask}
          taskUrl={taskUrl}
        />
      </section>
      <ContentClipperPanel
        clipModal={clipModal}
        closeContentClipper={closeContentClipper}
        contentClipperRef={contentClipperRef}
        exportContentClip={exportContentClip}
        formatContentClipTime={formatContentClipTime}
        openContentClipper={openContentClipper}
        openContentPlayer={openContentPlayer}
        updateContentClipRange={updateContentClipRange}
      />
      <section className="collector-panel workspace-panel">
        <div className="collector-section-head">
          <div>
            <Title level={5}>资产库</Title>
          </div>
          <div className="workspace-actions">
            <CollectorButton variant="ghost" size="small" onClick={() => refreshContentJobs(false)} loading={commandLoading.refreshJobs}>
              {commandLoading.refreshJobs ? "刷新中..." : "刷新任务"}
            </CollectorButton>
            <CollectorButton variant="ghost" size="small" onClick={() => refreshContentLibrary(false)} loading={commandLoading.refreshLibrary}>
              {commandLoading.refreshLibrary ? "刷新中..." : "刷新文件"}
            </CollectorButton>
          </div>
        </div>
        <div className="workspace-body">
          <div className="tabs workspace-tabs" role="tablist">
            {[
              { value: "jobs", label: "任务" },
              { value: "library", label: "文件库" },
            ].map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={`tab ${contentWorkspace === tab.value ? "active" : ""}`}
                onClick={() => {
                  setContentWorkspace(tab.value);
                  if (tab.value === "library") refreshContentLibrary(false);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        {contentWorkspace === "jobs" ? (
          <div className="workspace-pane active">
            <div className="jobs-toolbar">
              <div className="hint">按任务状态和任务类型快速筛选</div>
              <div className="job-filters" role="tablist" aria-label="任务筛选">
                {[
                  { value: "all", label: "全部" },
                  { value: "running", label: "进行中" },
                  { value: "completed", label: "已完成" },
                  { value: "cancelled", label: "已暂停" },
                  { value: "failed", label: "失败" },
                  { value: "video", label: "下载视频" },
                  { value: "live", label: "直播处理" },
                  { value: "video_map", label: "视频讲解商品" },
                  { value: "product_pool", label: "商品匹配" },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    className={`filter-chip ${jobFilter === filter.value ? "active" : ""}`}
                    type="button"
                    onClick={() => setJobFilter(filter.value)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="jobs">
              {visibleContentJobs.length ? visibleContentJobs.map((job) => {
                const status = contentAssetJobStatus(job);
                const isExpanded = Boolean(expandedContentJobs[job.id]);
                return (
                  <div className={`job ${isExpanded ? "expanded" : ""}`} key={job.id}>
                    <div className="job-main">
                      <div className="job-head">
                        <div className="job-title">
                          <div className="job-type">{contentAssetJobLabels[job.type] || job.type || "抖音任务"}</div>
                          <div className={`badge ${status}`}>{contentAssetStatusLabels[status] || status || "unknown"}</div>
                        </div>
                        <div className="job-actions">
                          {job.result || job.error ? (
                            <CollectorButton size="small" onClick={() => toggleContentJob(job.id)}>
                              {isExpanded ? "收起" : "展开"}
                            </CollectorButton>
                          ) : (
                            <CollectorButton size="small" onClick={() => toggleContentJob(job.id)}>详情</CollectorButton>
                          )}
                          {["queued", "running"].includes(status) ? (
                            <CollectorButton size="small" onClick={() => cancelContentJob(job.id)}>暂停</CollectorButton>
                          ) : null}
                          <CollectorButton size="small" variant="ghost" onClick={() => deleteContentJob(job.id)}>删除</CollectorButton>
                        </div>
                      </div>
                      <div className="job-url">{job.type === "product_match" ? job.id : (job.input?.url || job.input?.video_path || job.id)}</div>
                      {job.error ? <Text type="danger">{job.error}</Text> : null}
                      {isExpanded ? <div className="job-detail">{renderContentJobResult(job)}</div> : null}
                    </div>
                  </div>
                );
              }) : (
                <div className="empty">{jobFilter === "all" ? "暂无任务" : "没有符合筛选的任务"}</div>
              )}
            </div>
          </div>
        ) : (
          <div className="workspace-pane active">
            <div className="library-toolbar">
              <Input
                value={librarySearch}
                onChange={(event) => setLibrarySearch(event.target.value)}
                placeholder="搜索文件名或路径"
              />
              <div className="library-filters" role="tablist" aria-label="文件筛选">
                {[
                  { value: "all", label: "全部" },
                  { value: "video", label: "视频" },
                  { value: "clip", label: "剪辑片段" },
                  { value: "products", label: "商品数据" },
                  { value: "video_product_map", label: "视频识别结果" },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    className={`filter-chip ${libraryFilter === filter.value ? "active" : ""}`}
                    type="button"
                    onClick={() => setLibraryFilter(filter.value)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="jobs">
              {visibleLibraryGroups.length ? visibleLibraryGroups.map((group) => {
                const primary = pickPrimaryContentAssetItem(group.items);
                const attached = group.items.filter((item) => item !== primary);
                const productsItem = group.items.find((item) => item.type === "products");
                const productsCount = Number(productsItem?.product_count || 0);
                const mapDisabledReason = !productsItem
                  ? "先抓这场直播的商品，再识别视频里讲的是哪件抖音商品。"
                  : productsCount <= 0
                    ? "这场直播当前没有抓到商品，先重新抓商品后再试。"
                    : "";
                const isExpanded = expandedLibraryGroups[group.key] ?? true;
                const types = Array.from(new Set(group.items.map((item) => contentAssetFileLabels[item.type] || item.type || "文件")));
                const title = group.items.some((item) => item.type === "products") && group.items.some((item) => item.type === "video")
                  ? "直播素材包"
                  : group.items.some((item) => item.type === "products")
                    ? "商品数据包"
                    : group.items.some((item) => item.type === "clip")
                      ? "剪辑素材包"
                      : "视频素材包";
                return (
                  <div className={`job asset-bundle ${isExpanded ? "expanded" : ""}`} key={group.key}>
                    <div className="job-main">
                      <div className="asset-bundle-head">
                        <div>
                          <div className="asset-bundle-title">{title}</div>
                          <div className="asset-bundle-meta">
                            {[group.sessionLabel, group.identity ? `来源 ${group.identity}` : "", `${group.items.length} 个文件`, formatContentAssetTime(group.updatedAt)].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <div className="job-actions">
                          <div className="badge">{types.join(" + ")}</div>
                          <CollectorButton size="small" onClick={() => toggleLibraryGroup(group.key)}>{isExpanded ? "收起" : "展开"}</CollectorButton>
                        </div>
                      </div>
                      <div className="asset-bundle-body">
                        <section className="asset-column">
                          <div className="asset-column-head">
                            <div className="asset-column-title">源头</div>
                          </div>
                          <div className="asset-source">{renderLibraryFile(primary, { productsPath: productsItem?.path || "", mapDisabledReason })}</div>
                        </section>
                        <section className="asset-column">
                          <div className="asset-column-head">
                            <div className="asset-column-title">附属物料</div>
                            <div className="detail-section-sub">{attached.length} 项</div>
                          </div>
                          <div className="asset-children">
                            {attached.length ? attached.map((item) => renderLibraryFile(item, { compact: true, productsPath: productsItem?.path || "", mapDisabledReason })) : <div className="empty">暂无附属物料</div>}
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="empty">{librarySearch || libraryFilter !== "all" ? "没有符合筛选的文件" : "暂无本地文件"}</div>
              )}
            </div>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}
