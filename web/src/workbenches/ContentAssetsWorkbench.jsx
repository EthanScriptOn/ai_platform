import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, message } from "antd";
import { ContentAssetsWorkbenchView } from "./ContentAssetsWorkbenchView.jsx";
import { createContentAssetRenderers } from "./contentAssetsRenderers.jsx";
import { useContentAssetClipper } from "./useContentAssetClipper";
import { useContentAssetProductMatching } from "./useContentAssetProductMatching";
import { requestJson } from "../lib/apiClient";
import {
  copyTextToClipboard,
  isLocalPlatformOrigin,
  probeCollectorPage,
  requestPublicCollector,
} from "../lib/collectorTools.jsx";
import { formatContentClipTime, pickPrimaryContentAssetItem } from "../lib/contentAssetsTools";
import {
  buildContentAssetInstallCommand,
  contentAssetCollectorTokenStorageKey,
  extractDouyinUrl,
  filterContentJobs,
  filterContentLibrary,
  groupContentLibraryItems,
  isDouyinLiveUrl,
} from "./contentAssetsWorkbenchState";

export default function ContentAssetsWorkbench({ frameKey }) {
  const [platform, setPlatform] = useState("macos");
  const [collectorBaseUrl, setCollectorBaseUrl] = useState("http://127.0.0.1:8767");
  const [localMediaBaseUrl, setLocalMediaBaseUrl] = useState("");
  const [installBaseUrl, setInstallBaseUrl] = useState(window.location.origin);
  const [collectorToken, setCollectorToken] = useState(() => window.localStorage?.getItem(contentAssetCollectorTokenStorageKey) || "");
  const [collectorStatus, setCollectorStatus] = useState({
    connected: false,
    installed: false,
    message: "正在检测抖音本地执行端",
  });
  const [authStatus, setAuthStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [contentWorkspace, setContentWorkspace] = useState("jobs");
  const [contentJobs, setContentJobs] = useState([]);
  const [contentLibrary, setContentLibrary] = useState([]);
  const [jobFilter, setJobFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [librarySearch, setLibrarySearch] = useState("");
  const [expandedContentJobs, setExpandedContentJobs] = useState({});
  const [expandedLibraryGroups, setExpandedLibraryGroups] = useState({});
  const [contentMode, setContentMode] = useState("video");
  const [taskUrl, setTaskUrl] = useState("");
  const [liveRecord, setLiveRecord] = useState(true);
  const [liveProducts, setLiveProducts] = useState(true);
  const [recordUntilEnd, setRecordUntilEnd] = useState(false);
  const [grabAllProducts, setGrabAllProducts] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(30);
  const [productLimit, setProductLimit] = useState(20);
  const [commandLoading, setCommandLoading] = useState({
    submit: false,
    refreshJobs: false,
    refreshLibrary: false,
    loginStart: false,
    loginCancel: false,
    logout: false,
  });
  const installCommandRef = useRef(null);
  const contentClipperRef = useRef(null);
  const contentClipVideoRef = useRef(null);
  const [api, contextHolder] = message.useMessage();

  const installCommand = buildContentAssetInstallCommand({
    collectorToken,
    installBaseUrl,
    platform,
  });

  useEffect(() => {
    const query = collectorToken ? `?token=${encodeURIComponent(collectorToken)}` : "";
    requestJson(`/api/content-assets/config${query}`)
      .then((data) => {
        if (data.collectorBaseUrl) setCollectorBaseUrl(data.collectorBaseUrl);
        if (data.localMediaBaseUrl) setLocalMediaBaseUrl(data.localMediaBaseUrl);
        if (data.installBaseUrl) setInstallBaseUrl(data.installBaseUrl);
        if (data.remoteStatus && !isLocalPlatformOrigin()) {
          setCollectorStatus({
            connected: Boolean(data.remoteStatus.connected),
            installed: Boolean(data.remoteStatus.installed || data.remoteStatus.connected),
            message: data.remoteStatus.message || "等待抖音本地执行端连接平台。",
          });
          setAuthStatus({
            likely_logged_in: Boolean(data.remoteStatus.likelyLoggedIn),
            has_cookie: Boolean(data.remoteStatus.hasCookie),
          });
        }
      })
      .catch(() => {});
  }, [collectorToken]);

  useEffect(() => {
    if (collectorToken) return;
    requestJson("/api/content-assets/client-token", { method: "POST" })
      .then((data) => {
        if (!data.token) return;
        window.localStorage?.setItem(contentAssetCollectorTokenStorageKey, data.token);
        setCollectorToken(data.token);
      })
      .catch((error) => {
        setCollectorStatus({
          connected: false,
          installed: false,
          message: `创建抖音本机绑定失败：${error.message}`,
        });
      });
  }, [collectorToken]);

  const checkCollector = useCallback(async (silent = false) => {
    if (!collectorBaseUrl) return;
    if (!silent) setChecking(true);
    try {
      if (!isLocalPlatformOrigin()) {
        const status = await requestJson(
          collectorToken
            ? `/api/content-assets/client-status?token=${encodeURIComponent(collectorToken)}`
            : "/api/content-assets/status"
        );
        setCollectorStatus({
          connected: Boolean(status.connected),
          installed: Boolean(status.installed || status.connected),
          message: status.message || (status.connected ? "抖音本地执行端已连接平台。" : "抖音本地执行端未连接平台。"),
        });
        setAuthStatus({
          likely_logged_in: Boolean(status.likelyLoggedIn),
          has_cookie: Boolean(status.hasCookie),
        });
        if (!silent) {
          if (status.connected) {
            api.success("抖音本地执行端已连接平台");
          } else {
            api.warning(status.message || "抖音本地执行端未连接平台");
          }
        }
        return;
      }
      const [health, auth] = await Promise.all([
        requestPublicCollector(collectorBaseUrl, "/api/health", {}, "/bridge.html"),
        requestPublicCollector(collectorBaseUrl, "/api/auth/status", {}, "/bridge.html").catch(() => null),
      ]);
      window.localStorage?.setItem("yuebai-douyin-collector-installed", "1");
      setCollectorStatus({
        connected: true,
        installed: true,
        message:
          health?.video_product_mapping_message ||
          "抖音本地执行端已连接，登录、下载和录播都在这台电脑执行。",
      });
      setAuthStatus(auth);
      if (!silent) api.success("抖音本地执行端已连接");
    } catch (error) {
      const installedKnown = window.localStorage?.getItem("yuebai-douyin-collector-installed") === "1";
      setCollectorStatus({
        connected: false,
        installed: installedKnown,
        message: installedKnown
          ? "本机服务可能没启动。启动后点“重新检测”。"
          : "这台电脑还没有接入抖音本地执行端。",
      });
      setAuthStatus(null);
      try {
        await probeCollectorPage(collectorBaseUrl, "/");
        window.localStorage?.setItem("yuebai-douyin-collector-installed", "1");
        setCollectorStatus({
          connected: true,
          installed: true,
          message: "本地执行端页面已响应，检测接口暂时没有返回；先进入工作台继续操作。",
        });
        if (!silent) api.warning("检测接口超时，但本地执行端已经响应，先为你打开工作台。");
      } catch {
        if (!silent) api.error(`连接失败：${error.message}`);
      }
    } finally {
      if (!silent) setChecking(false);
    }
  }, [api, collectorBaseUrl, collectorToken]);

  useEffect(() => {
    if (!collectorBaseUrl) return undefined;
    checkCollector(true);
    const timer = window.setInterval(() => checkCollector(true), 6000);
    return () => window.clearInterval(timer);
  }, [collectorBaseUrl, checkCollector, frameKey]);

  const refreshContentJobs = useCallback(async (silent = false) => {
    if (!silent) setCommandLoading((current) => ({ ...current, refreshJobs: true }));
    try {
      const data = await requestJson("/api/content-assets/jobs?page=1&pageSize=50");
      setContentJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (error) {
      if (!silent) api.error(`任务列表刷新失败：${error.message}`);
    } finally {
      if (!silent) setCommandLoading((current) => ({ ...current, refreshJobs: false }));
    }
  }, [api]);

  const runContentCommand = useCallback(async (path, body = {}, methodOverride = "") => {
    const method = methodOverride || (body === null ? "GET" : "POST");
    const endpoint = collectorToken ? "/api/content-assets/client-command" : "/api/content-assets/command";
    const data = await requestJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: collectorToken,
        path,
        options: {
          method,
          headers: method === "POST" ? { "Content-Type": "application/json" } : {},
          body: method === "POST" ? JSON.stringify(body) : "",
        },
      }),
    });
    if (data.ok === false) throw new Error(data.message || data.error || "本地执行端返回失败");
    return data;
  }, [collectorToken]);

  const refreshContentLibrary = useCallback(async (silent = false) => {
    if (!silent) setCommandLoading((current) => ({ ...current, refreshLibrary: true }));
    try {
      const data = await runContentCommand("/api/library", null, "GET");
      setContentLibrary(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      if (!silent) api.error(`文件库刷新失败：${error.message}`);
    } finally {
      if (!silent) setCommandLoading((current) => ({ ...current, refreshLibrary: false }));
    }
  }, [api, runContentCommand]);

  useEffect(() => {
    refreshContentJobs(true);
    const timer = window.setInterval(() => refreshContentJobs(true), 6000);
    return () => window.clearInterval(timer);
  }, [refreshContentJobs, frameKey]);

  useEffect(() => {
    if (!collectorStatus.connected) return undefined;
    refreshContentLibrary(true);
    const timer = window.setInterval(() => refreshContentLibrary(true), 12000);
    return () => window.clearInterval(timer);
  }, [collectorStatus.connected, refreshContentLibrary, frameKey]);

  const contentMediaUrl = (filePath) => {
    const encodedPath = encodeURIComponent(filePath || "");
    if (localMediaBaseUrl) return `${localMediaBaseUrl.replace(/\/+$/, "")}/api/media?path=${encodedPath}`;
    return `/api/content-assets/media?path=${encodedPath}`;
  };

  const contentPlayerUrl = (filePath) => {
    const encodedPath = encodeURIComponent(filePath || "");
    if (localMediaBaseUrl) return `${localMediaBaseUrl.replace(/\/+$/, "")}/player.html?path=${encodedPath}`;
    return contentMediaUrl(filePath);
  };

  const contentClipperUrl = (filePath) => {
    const encodedPath = encodeURIComponent(filePath || "");
    if (localMediaBaseUrl) return `${localMediaBaseUrl.replace(/\/+$/, "")}/clipper.html?path=${encodedPath}`;
    return "";
  };

  const openContentPlayer = (filePath) => {
    const url = contentPlayerUrl(filePath);
    window.open(url, "yuebai-douyin-player", "popup=yes,width=1040,height=760,noopener,noreferrer");
  };

  const {
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
  } = useContentAssetProductMatching({
    api,
    refreshContentJobs,
    runContentCommand,
    setContentWorkspace,
  });

  const {
    clipModal,
    closeContentClipper,
    exportContentClip,
    openContentClipper,
    updateContentClipRange,
  } = useContentAssetClipper({
    api,
    contentClipperRef,
    contentClipVideoRef,
    contentClipperUrl,
    openContentPlayer,
    refreshContentLibrary,
    runContentCommand,
  });

  const submitContentTask = async () => {
    const url = extractDouyinUrl(taskUrl);
    if (!url) {
      api.warning("先粘贴一个抖音视频或直播链接。");
      return;
    }

    if (contentMode === "video" && isDouyinLiveUrl(url)) {
      setContentMode("live");
      api.info("这是直播链接，已切换到处理直播。请选择录制、抓商品或录制+商品。");
      return;
    }

    let path = "/api/video/download";
    let payload = { url };
    if (contentMode === "live") {
      if (!liveRecord && !liveProducts) {
        api.warning("请至少勾选一个直播动作。");
        return;
      }
      const duration_seconds = recordUntilEnd ? 0 : Number(durationSeconds || 30);
      const limit = Number(productLimit || 20);
      if (liveRecord && liveProducts) {
        path = "/api/live/record-with-products";
        payload = { url, duration_seconds, limit, all_products: grabAllProducts };
      } else if (liveRecord) {
        path = "/api/live/record";
        payload = { url, duration_seconds };
      } else {
        path = "/api/live/products";
        payload = { url, limit, all_products: grabAllProducts };
      }
    }

    setCommandLoading((current) => ({ ...current, submit: true }));
    try {
      await runContentCommand(path, payload);
      api.success("任务已创建");
      setTaskUrl("");
      await refreshContentJobs(true);
      await refreshContentLibrary(true);
      setContentWorkspace("jobs");
    } catch (error) {
      api.error(`创建失败：${error.message}`);
    } finally {
      setCommandLoading((current) => ({ ...current, submit: false }));
    }
  };

  const toggleContentJob = (jobId) => {
    setExpandedContentJobs((current) => ({ ...current, [jobId]: !current[jobId] }));
  };

  const cancelContentJob = async (jobId) => {
    if (!jobId) return;
    try {
      await runContentCommand(`/api/jobs/${encodeURIComponent(jobId)}/cancel`);
      api.success("任务已暂停");
      refreshContentJobs(true);
      refreshContentLibrary(true);
    } catch (error) {
      api.error(`暂停失败：${error.message}`);
    }
  };

  const deleteContentJob = (jobId) => {
    if (!jobId) return;
    Modal.confirm({
      title: "删除这个任务？",
      content: "会删除任务记录，并尝试删除关联的本机文件。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await runContentCommand(`/api/jobs/${encodeURIComponent(jobId)}`, null, "DELETE");
        await refreshContentJobs(true);
        await refreshContentLibrary(true);
      },
    });
  };

  const deleteLibraryFile = (filePath) => {
    if (!filePath) return;
    Modal.confirm({
      title: "删除这个文件？",
      content: "只删除当前文件，不会连带删除同源文件。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await runContentCommand("/api/library/delete", { path: filePath });
        await refreshContentLibrary(true);
      },
    });
  };

  const { renderContentJobResult, renderLibraryFile } = createContentAssetRenderers({
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
  });

  const toggleLibraryGroup = (groupKey) => {
    setExpandedLibraryGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  };

  const visibleContentJobs = useMemo(
    () => filterContentJobs(contentJobs, jobFilter),
    [contentJobs, jobFilter],
  );
  const visibleLibraryItems = useMemo(
    () => filterContentLibrary(contentLibrary, libraryFilter, librarySearch),
    [contentLibrary, libraryFilter, librarySearch],
  );
  const visibleLibraryGroups = useMemo(() => {
    return groupContentLibraryItems(visibleLibraryItems);
  }, [visibleLibraryItems]);

  const copyInstallCommand = async () => {
    try {
      await copyTextToClipboard(installCommand);
      api.success("安装命令已复制");
    } catch {
      const textArea = installCommandRef.current?.resizableTextArea?.textArea;
      if (textArea) {
        textArea.focus();
        textArea.select();
      }
      api.warning("已选中安装命令，请按 ⌘C 或 Ctrl+C 复制");
    }
  };

  const startDouyinLogin = async () => {
    if (authStatus?.likely_logged_in && !authStatus?.auth_issue) {
      api.info("当前账号已登录，无需重复登录。");
      return;
    }
    setCommandLoading((current) => ({ ...current, loginStart: true }));
    try {
      await runContentCommand("/api/auth/login/start", {
        url: "https://www.douyin.com/",
        fresh: Boolean(authStatus?.auth_issue),
      });
      api.success(authStatus?.auth_issue ? "已打开抖音登录窗口" : "已打开抖音窗口");
      await checkCollector(true);
    } catch (error) {
      api.error(`打开抖音失败：${error.message}`);
    } finally {
      setCommandLoading((current) => ({ ...current, loginStart: false }));
    }
  };

  const cancelDouyinLogin = async () => {
    setCommandLoading((current) => ({ ...current, loginCancel: true }));
    try {
      const data = await runContentCommand("/api/auth/login/cancel", {});
      if (data.status) setAuthStatus(data.status);
      api.success("抖音窗口已关闭");
    } catch (error) {
      api.error(`关闭失败：${error.message}`);
    } finally {
      setCommandLoading((current) => ({ ...current, loginCancel: false }));
    }
  };

  const logoutDouyin = () => {
    Modal.confirm({
      title: "退出当前抖音账号？",
      content: "退出后需要重新登录。",
      okText: "退出登录",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setCommandLoading((current) => ({ ...current, logout: true }));
        try {
          const data = await runContentCommand("/api/auth/logout", {});
          if (data.status) setAuthStatus(data.status);
          api.success(data.backup_path ? `已退出登录，备份在 ${data.backup_path}` : "已退出登录");
        } catch (error) {
          api.error(`退出失败：${error.message}`);
        } finally {
          setCommandLoading((current) => ({ ...current, logout: false }));
        }
      },
    });
  };

  const loginTone = authStatus?.likely_logged_in ? "ready" : authStatus?.has_cookie ? "warning" : "neutral";
  const loginLabel = authStatus?.likely_logged_in ? "已登录" : authStatus?.has_cookie ? "待确认" : "未登录";

  return (
    <ContentAssetsWorkbenchView
      authStatus={authStatus}
      cancelContentJob={cancelContentJob}
      cancelDouyinLogin={cancelDouyinLogin}
      checking={checking}
      checkCollector={checkCollector}
      clipModal={clipModal}
      closeContentClipper={closeContentClipper}
      collectorBaseUrl={collectorBaseUrl}
      collectorStatus={collectorStatus}
      commandLoading={commandLoading}
      contentClipperRef={contentClipperRef}
      contentMode={contentMode}
      contentWorkspace={contentWorkspace}
      contextHolder={contextHolder}
      copyInstallCommand={copyInstallCommand}
      deleteContentJob={deleteContentJob}
      durationSeconds={durationSeconds}
      expandedContentJobs={expandedContentJobs}
      expandedLibraryGroups={expandedLibraryGroups}
      exportContentClip={exportContentClip}
      formatContentClipTime={formatContentClipTime}
      grabAllProducts={grabAllProducts}
      installCommand={installCommand}
      installCommandRef={installCommandRef}
      jobFilter={jobFilter}
      libraryFilter={libraryFilter}
      librarySearch={librarySearch}
      liveProducts={liveProducts}
      liveRecord={liveRecord}
      loginLabel={loginLabel}
      loginTone={loginTone}
      logoutDouyin={logoutDouyin}
      openContentClipper={openContentClipper}
      openContentPlayer={openContentPlayer}
      pickPrimaryContentAssetItem={pickPrimaryContentAssetItem}
      productLimit={productLimit}
      recordUntilEnd={recordUntilEnd}
      refreshContentJobs={refreshContentJobs}
      refreshContentLibrary={refreshContentLibrary}
      renderContentJobResult={renderContentJobResult}
      renderLibraryFile={renderLibraryFile}
      setContentMode={setContentMode}
      setContentWorkspace={setContentWorkspace}
      setDurationSeconds={setDurationSeconds}
      setGrabAllProducts={setGrabAllProducts}
      setJobFilter={setJobFilter}
      setLibraryFilter={setLibraryFilter}
      setLibrarySearch={setLibrarySearch}
      setLiveProducts={setLiveProducts}
      setLiveRecord={setLiveRecord}
      setPlatform={setPlatform}
      setProductLimit={setProductLimit}
      setRecordUntilEnd={setRecordUntilEnd}
      setTaskUrl={setTaskUrl}
      startDouyinLogin={startDouyinLogin}
      submitContentTask={submitContentTask}
      taskUrl={taskUrl}
      toggleContentJob={toggleContentJob}
      toggleLibraryGroup={toggleLibraryGroup}
      updateContentClipRange={updateContentClipRange}
      visibleContentJobs={visibleContentJobs}
      visibleLibraryGroups={visibleLibraryGroups}
      platform={platform}
    />
  );
}
