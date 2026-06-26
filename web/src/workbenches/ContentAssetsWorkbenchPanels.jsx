import React from "react";
import { Input, Select, Typography } from "antd";
import { CollectorButton, CollectorPill } from "../lib/collectorTools.jsx";
import { formatContentAssetSize } from "../lib/contentAssetsTools";

const { Text, Title } = Typography;
const { TextArea } = Input;

export function CollectorRuntimePanel({
  authStatus,
  cancelDouyinLogin,
  checking,
  checkCollector,
  collectorBaseUrl,
  collectorStatus,
  commandLoading,
  copyInstallCommand,
  installCommand,
  installCommandRef,
  loginLabel,
  loginTone,
  logoutDouyin,
  platform,
  setPlatform,
  startDouyinLogin,
}) {
  return (
    <div className="collector-panel content-control-panel">
      <div className="collector-section-head">
        <div>
          <Title level={5}>抖音本地执行端</Title>
          <Text type="secondary">登录、下载、录制都在这台电脑执行，平台只负责下发指令和展示结果。</Text>
        </div>
        <CollectorPill tone={collectorStatus.connected ? "ready" : collectorStatus.installed ? "warning" : "neutral"}>
          {collectorStatus.connected ? "在线" : collectorStatus.installed ? "待启动" : "待安装"}
        </CollectorPill>
      </div>
      <div className="collector-status content-status-card">
        <div>
          <strong>
            {collectorStatus.connected
              ? authStatus?.likely_logged_in
                ? "本机已就绪，可以开始任务"
                : "本机已连接，先同步抖音登录"
              : collectorStatus.installed
                ? "已安装，等待本机执行端上线"
                : "先安装本地执行端"}
          </strong>
          <span>
            {collectorStatus.connected
              ? authStatus?.likely_logged_in
                ? "可以直接提交视频下载、直播录制或商品抓取任务。"
                : "打开抖音并完成登录后，任务会在本机执行。"
              : collectorStatus.message}
          </span>
        </div>
      </div>
      <div className="collector-runtime content-runtime">
        <div>
          <span>本机连接</span>
          <CollectorPill tone={collectorStatus.connected ? "ready" : "danger"}>
            {collectorStatus.connected ? "在线" : "离线"}
          </CollectorPill>
        </div>
        <div>
          <span>登录状态</span>
          <CollectorPill tone={loginTone}>{loginLabel}</CollectorPill>
        </div>
        <div>
          <span>本地地址</span>
          <CollectorPill tone="neutral">{collectorBaseUrl.replace(/^https?:\/\//, "")}</CollectorPill>
        </div>
      </div>
      <div className="content-action-stack">
        <CollectorButton onClick={() => checkCollector(false)} loading={checking}>
          {checking ? "检测中..." : "重新检测"}
        </CollectorButton>
        <CollectorButton
          variant="primary"
          onClick={startDouyinLogin}
          loading={commandLoading.loginStart}
          disabled={!collectorStatus.connected || (authStatus?.likely_logged_in && !authStatus?.auth_issue)}
        >
          {commandLoading.loginStart ? "打开中..." : "打开抖音并同步登录"}
        </CollectorButton>
        <CollectorButton onClick={cancelDouyinLogin} loading={commandLoading.loginCancel} disabled={!collectorStatus.connected}>
          {commandLoading.loginCancel ? "关闭中..." : "关闭抖音窗口"}
        </CollectorButton>
        <CollectorButton variant="danger" onClick={logoutDouyin} loading={commandLoading.logout} disabled={!collectorStatus.connected || !authStatus?.has_cookie}>
          {commandLoading.logout ? "退出中..." : "退出登录"}
        </CollectorButton>
      </div>
      <div className="content-setup-card">
        <div>
          <strong>{collectorStatus.installed ? "安装状态" : "安装本地执行端"}</strong>
          <span>{collectorStatus.installed ? "如果本机端离线，重新运行安装命令会自动更新并启动。" : "复制命令到这台电脑的终端运行，完成后回到页面点重新检测。"}</span>
        </div>
        {collectorStatus.installed ? (
          <CollectorPill tone="ready">已安装</CollectorPill>
        ) : (
          <CollectorButton onClick={copyInstallCommand}>复制安装命令</CollectorButton>
        )}
      </div>
      {!collectorStatus.installed ? (
        <div className="content-install-box">
          <label>
            <span>系统</span>
            <Select
              value={platform}
              onChange={setPlatform}
              options={[
                { value: "macos", label: "macOS" },
                { value: "windows", label: "Windows" },
              ]}
            />
          </label>
          <TextArea ref={installCommandRef} className="install-command" value={installCommand} readOnly />
        </div>
      ) : null}
    </div>
  );
}

export function ContentTaskPanel({
  commandLoading,
  contentMode,
  durationSeconds,
  grabAllProducts,
  liveProducts,
  liveRecord,
  productLimit,
  recordUntilEnd,
  setContentMode,
  setDurationSeconds,
  setGrabAllProducts,
  setLiveProducts,
  setLiveRecord,
  setProductLimit,
  setRecordUntilEnd,
  setTaskUrl,
  submitContentTask,
  taskUrl,
}) {
  return (
    <section className="collector-panel command-panel">
      <div className="collector-section-head">
        <div>
          <Title level={5}>任务台</Title>
        </div>
        <CollectorPill tone="neutral">{contentMode === "video" ? "下载视频" : "处理直播"}</CollectorPill>
      </div>
      <div className="command-panel-body">
        <div className="tabs" role="tablist">
          {[
            { value: "video", label: "下载视频" },
            { value: "live", label: "处理直播" },
          ].map((mode) => (
            <button
              key={mode.value}
              type="button"
              className={`tab ${contentMode === mode.value ? "active" : ""}`}
              onClick={() => setContentMode(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <label htmlFor="douyin-task-url">抖音视频 / 直播链接</label>
        <TextArea
          id="douyin-task-url"
          value={taskUrl}
          onChange={(event) => setTaskUrl(event.target.value)}
          placeholder="https://v.douyin.com/... 或 https://live.douyin.com/80017709309"
        />

        {contentMode === "live" ? (
          <>
            <div className="live-options">
              <label className="option">
                <input type="checkbox" checked={liveRecord} onChange={(event) => setLiveRecord(event.target.checked)} />
                <span>录制直播</span>
              </label>
              <label className="option">
                <input type="checkbox" checked={liveProducts} onChange={(event) => setLiveProducts(event.target.checked)} />
                <span>抓商品</span>
              </label>
              <label className="option">
                <input type="checkbox" checked={recordUntilEnd} onChange={(event) => setRecordUntilEnd(event.target.checked)} disabled={!liveRecord} />
                <span>录到直播结束</span>
              </label>
              <label className="option">
                <input type="checkbox" checked={grabAllProducts} onChange={(event) => setGrabAllProducts(event.target.checked)} disabled={!liveProducts} />
                <span>尽量获取全部商品</span>
              </label>
            </div>
            <div className="field-grid">
              {liveRecord && !recordUntilEnd ? (
                <div>
                  <label htmlFor="douyin-duration">最多录制多少秒</label>
                  <Input
                    id="douyin-duration"
                    type="number"
                    min={1}
                    value={durationSeconds}
                    onChange={(event) => setDurationSeconds(event.target.value)}
                    placeholder="例如 300 表示最多 5 分钟"
                  />
                </div>
              ) : null}
              {liveProducts && !grabAllProducts ? (
                <div>
                  <label htmlFor="douyin-limit">最多获取多少个商品</label>
                  <Input
                    id="douyin-limit"
                    type="number"
                    min={1}
                    max={100}
                    value={productLimit}
                    onChange={(event) => setProductLimit(event.target.value)}
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="submit-row">
          <div className="hint">
            {contentMode === "video"
              ? "适合普通视频或分享短链。"
              : liveRecord && liveProducts
                ? `${recordUntilEnd ? "会一直录到直播结束" : "会按秒数录制"}，${grabAllProducts ? "并尽量获取全部商品" : "并按数量获取商品"}。`
                : liveRecord
                  ? (recordUntilEnd ? "会一直录到直播结束。" : "达到设置秒数后会自动停止。")
                  : liveProducts
                    ? (grabAllProducts ? "会自动翻页，尽量获取直播间全部商品。" : "会按设置数量获取商品，最多 100 个。")
                    : "至少勾选一个直播动作。"}
          </div>
          <CollectorButton variant="primary" onClick={submitContentTask} loading={commandLoading.submit}>
            {commandLoading.submit
              ? "创建中..."
              : contentMode === "video"
                ? "开始下载"
                : liveRecord && liveProducts
                  ? "录制并抓商品"
                  : liveRecord
                    ? "开始录制"
                    : liveProducts
                      ? "抓取商品"
                      : "选择后开始"}
          </CollectorButton>
        </div>
      </div>
    </section>
  );
}

export function ContentClipperPanel({
  clipModal,
  closeContentClipper,
  contentClipperRef,
  exportContentClip,
  formatContentClipTime,
  openContentClipper,
  openContentPlayer,
  updateContentClipRange,
}) {
  return (
    <section ref={contentClipperRef} className={`collector-panel content-clipper-panel ${clipModal.open ? "show" : ""}`}>
      <div className="collector-section-head">
        <div>
          <Title level={5}>剪辑台</Title>
          <Text type="secondary">选择一段视频后在这里截取片段。</Text>
        </div>
        <CollectorButton size="small" variant="ghost" onClick={closeContentClipper}>关闭</CollectorButton>
      </div>
      <div className="content-clipper">
        {clipModal.loading ? (
          <div className="collector-note">正在准备视频预览...</div>
        ) : clipModal.previewPath ? (
          <div className="result-item content-clipper-player">
            <strong>预览已在本机播放器中打开</strong>
            <span>剪辑时间轴保留在页面内，视频预览使用本机播放器弹窗。</span>
            <div className="asset-file-path">{clipModal.previewPath}</div>
            <CollectorButton size="small" variant="primary" onClick={() => openContentPlayer(clipModal.previewPath)}>重新打开预览</CollectorButton>
          </div>
        ) : null}
        <div className="content-clipper-head">
          <div>
            <strong>{clipModal.sourcePath || clipModal.path || "选择一段视频后开始剪辑"}</strong>
            <span>{clipModal.duration ? `总时长 ${formatContentClipTime(clipModal.duration)}` : ""}</span>
          </div>
        </div>
        <div className="content-clip-timebar" style={{
          "--start-pct": `${Math.max(0, Math.min(100, (Number(clipModal.start || 0) / Math.max(1, Number(clipModal.duration || 1))) * 100))}%`,
          "--end-pct": `${Math.max(0, Math.min(100, (Number(clipModal.end || 0) / Math.max(1, Number(clipModal.duration || 1))) * 100))}%`,
        }}>
          <div className="content-clip-time-labels">
            <span>片段开始 <strong>{formatContentClipTime(clipModal.start)}</strong></span>
            <span>片段结束 <strong>{formatContentClipTime(clipModal.end)}</strong></span>
          </div>
          <div className="content-dual-range">
            <div className="content-range-bubble start">{formatContentClipTime(clipModal.start)}</div>
            <div className="content-range-bubble end">{formatContentClipTime(clipModal.end)}</div>
            <div className="content-dual-track" />
            <div className="content-range-handle start" />
            <div className="content-range-handle end" />
            <input
              type="range"
              min={0}
              max={Math.max(1, clipModal.duration || 1)}
              step={0.1}
              value={clipModal.start}
              onChange={(event) => updateContentClipRange("start", event.target.value)}
            />
            <input
              type="range"
              min={0}
              max={Math.max(1, clipModal.duration || 1)}
              step={0.1}
              value={clipModal.end}
              onChange={(event) => updateContentClipRange("end", event.target.value)}
            />
          </div>
          <div className="content-clip-selection">
            <span>已选 {formatContentClipTime(Number(clipModal.end || 0) - Number(clipModal.start || 0))}</span>
            <CollectorButton size="small" onClick={() => openContentPlayer(clipModal.previewPath || clipModal.sourcePath)}>打开预览</CollectorButton>
          </div>
        </div>
        <div className="content-clipper-actions">
          <CollectorButton variant="primary" onClick={exportContentClip} loading={clipModal.exporting}>
            {clipModal.exporting ? "导出中..." : "导出片段"}
          </CollectorButton>
        </div>
        {clipModal.output?.clip_path ? (
          <div className="json-preview content-library-preview">
            <div className="result-item">
              <strong>片段已导出{clipModal.output.size_bytes ? ` · ${formatContentAssetSize(clipModal.output.size_bytes)}` : ""}</strong>
              <div className="asset-file-path">{clipModal.output.clip_path}</div>
              <CollectorButton size="small" onClick={() => openContentClipper(clipModal.output.clip_path)}>继续剪</CollectorButton>
            </div>
            <div className="result-item">
              <strong>导出片段可预览</strong>
              <span>点击后在本机播放器中打开。</span>
              <CollectorButton size="small" variant="primary" onClick={() => openContentPlayer(clipModal.output.clip_path)}>打开导出片段</CollectorButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
