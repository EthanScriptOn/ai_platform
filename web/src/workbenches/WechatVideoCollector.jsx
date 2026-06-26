import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadOutlined, EyeOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { Input, Progress, Select, Space, Typography, message } from "antd";
import { requestJson } from "../lib/apiClient";
import {
  CaptureListPreview,
  CollectorButton,
  CollectorPill,
  CollectorPreviewModal,
  WECHAT_LOCAL_DIRECT_BASE_URL,
  buildUrl,
  captureListSignature,
  downloadStatusLabel,
  formatBytes,
  isLocalPlatformOrigin,
  normalizeWechatCaptureForView,
  requestCollectorJson,
  resourceTitle,
  resourceTypeLabel,
  shortResourceUrl,
} from "../lib/collectorTools.jsx";

const { Text, Title } = Typography;
const { TextArea } = Input;

export default function WechatVideoCollector() {
  const tokenStorageKey = "yuebai-wechat-collector-token";
  const [platform, setPlatform] = useState("macos");
  const [listening, setListening] = useState(false);
  const [captures, setCaptures] = useState([]);
  const [captureType, setCaptureType] = useState("all");
  const [collectorLocalDirectUrl, setCollectorLocalDirectUrl] = useState(WECHAT_LOCAL_DIRECT_BASE_URL);
  const [installBaseUrl, setInstallBaseUrl] = useState(window.location.origin);
  const [collectorToken, setCollectorToken] = useState(() => window.localStorage?.getItem(tokenStorageKey) || "");
  const [packageControlEnabled, setPackageControlEnabled] = useState(isLocalPlatformOrigin());
  const [previewItem, setPreviewItem] = useState(null);
  const installCommandRef = useRef(null);
  const [collectorStatus, setCollectorStatus] = useState({
    connected: false,
    proxy: false,
    installed: false,
    certificateTrusted: false,
    certificatePath: "",
    message: "采集服务未接入",
  });
  const [actionLoading, setActionLoading] = useState({
    refresh: false,
    startPackage: false,
    stopPackage: false,
    trust: false,
    startListening: false,
    stopListening: false,
    clear: false,
  });
  const [api, contextHolder] = message.useMessage();
  const installScriptPath =
    platform === "macos"
      ? "/install/yuebai-wechat-collector-macos.sh"
      : "/install/yuebai-wechat-collector-windows.ps1";
  const installScriptUrl = new URL(buildUrl(installBaseUrl, installScriptPath));
  if (collectorToken) installScriptUrl.searchParams.set("token", collectorToken);
  const installCommand =
    platform === "macos"
      ? `/bin/bash -c "$(curl -fsSL '${installScriptUrl.toString()}')"`
      : `powershell -ExecutionPolicy Bypass -Command "irm '${installScriptUrl.toString()}' | iex"`;

  const visibleCaptures = useMemo(() => {
    if (captureType === "all") return captures;
    return captures.filter((item) => item.classify === captureType);
  }, [captures, captureType]);

  const renderedCaptures = useMemo(() => visibleCaptures.slice(0, 80), [visibleCaptures]);
  const latestCaptureAt = renderedCaptures[0]?.capturedAt || visibleCaptures[0]?.capturedAt || "";

  const setCapturesIfChanged = useCallback((nextCaptures = []) => {
    const normalizedCaptures = nextCaptures.map(normalizeWechatCaptureForView);
    setCaptures((currentCaptures) =>
      captureListSignature(currentCaptures) === captureListSignature(normalizedCaptures)
        ? currentCaptures
        : normalizedCaptures
    );
  }, []);

  const applyCaptureListIfPresent = useCallback((data) => {
    if (Array.isArray(data?.captures)) {
      setCapturesIfChanged(data.captures);
    }
  }, [setCapturesIfChanged]);

  const setCollectorStatusIfChanged = useCallback((nextStatus) => {
    setCollectorStatus((currentStatus) =>
      JSON.stringify(currentStatus) === JSON.stringify(nextStatus) ? currentStatus : nextStatus
    );
  }, []);

  useEffect(() => {
    requestJson("/api/wechat-video/config")
      .then((data) => {
        if (data.localDirectBaseUrl) {
          setCollectorLocalDirectUrl(data.localDirectBaseUrl);
        }
        if (data.installBaseUrl) setInstallBaseUrl(data.installBaseUrl);
        setPackageControlEnabled(Boolean(data.packageControlEnabled) && isLocalPlatformOrigin());
      })
      .catch(() => {
        setPackageControlEnabled(isLocalPlatformOrigin());
      });
  }, []);

  useEffect(() => {
    if (collectorToken) return;
    requestJson("/api/wechat-video/client-token", { method: "POST" })
      .then((data) => {
        if (!data.token) return;
        window.localStorage?.setItem(tokenStorageKey, data.token);
        setCollectorToken(data.token);
      })
      .catch((error) => {
        setCollectorStatusIfChanged({
          connected: false,
          proxy: false,
          installed: false,
          certificateTrusted: false,
          certificatePath: "",
          message: `创建本机绑定失败：${error.message}`,
        });
      });
  }, [collectorToken, setCollectorStatusIfChanged]);

  const requestWechatRemoteStatus = async () => {
    if (!collectorToken) {
      return {
        ok: false,
        connected: false,
        installed: false,
        captures: [],
        message: "正在创建本机绑定，请稍后再刷新。",
      };
    }
    return requestJson(`/api/wechat-video/client-status?token=${encodeURIComponent(collectorToken)}`);
  };

  const requestWechatRemoteCommand = (path, options = {}) =>
    requestJson("/api/wechat-video/client-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: collectorToken, path, options }),
    });

  const requestWechatLocalDirect = (path, options = {}) => {
    if (!collectorLocalDirectUrl) {
      throw new Error("本机直连地址未配置，请重新安装/启动后台包。");
    }
    if (!isLocalPlatformOrigin()) {
      if (path === "/api/status") {
        return requestWechatRemoteStatus();
      }
      return requestWechatRemoteCommand(path, options);
    }
    const targetUrl = buildUrl(collectorLocalDirectUrl, path);
    return requestJson(targetUrl, options);
  };

  const offlineWechatStatus = (messageText = "未连接到本机后台包，请复制安装/启动命令并在这台电脑的终端里运行。") => ({
    connected: false,
    proxy: false,
    installed: false,
    certificateTrusted: false,
    certificatePath: "",
    message: messageText,
  });

  const checkCollector = async (silent = false) => {
    if (!silent) {
      setActionLoading((current) => ({ ...current, refresh: true }));
    }
    try {
      const data = await requestWechatLocalDirect("/api/status");
      const proxy = Boolean(data.listening);
      if (data.installed || data.connected) {
        window.localStorage?.setItem("yuebai-wechat-collector-installed", "1");
      }
      setCollectorStatusIfChanged({
        connected: Boolean(data.connected),
        proxy,
        installed: Boolean(data.installed || data.connected),
        certificateTrusted: Boolean(data.certificateTrusted),
        certificatePath: data.certificatePath || "",
        message: data.message || "采集服务状态未知",
      });
      setListening(proxy);
      setCaptureType(data.selectedType || "all");
      applyCaptureListIfPresent(data);
      if (silent) return;
      if (data.ok) {
        api.success("采集服务已连接");
      } else {
        api.warning(data.message || "采集服务未接入");
      }
    } catch (error) {
      const messageText = "未连接到本机后台包，可能是服务未启动、证书未信任或本地域名未配置。请运行下方安装/更新命令。";
      setListening(false);
      setCollectorStatusIfChanged(offlineWechatStatus(messageText));
      if (!silent) api.error(messageText);
    } finally {
      if (!silent) {
        setActionLoading((current) => ({ ...current, refresh: false }));
      }
    }
  };

  useEffect(() => {
    if (!collectorLocalDirectUrl) return undefined;
    checkCollector(true);
    const timer = window.setInterval(() => checkCollector(true), 5000);
    return () => window.clearInterval(timer);
  }, [collectorLocalDirectUrl]);

  const applyCollectorState = (data, fallbackMessage) => {
    setListening(Boolean(data.listening));
    setCollectorStatus((status) => {
      const nextStatus = {
        ...status,
        connected: Boolean(data.connected),
        proxy: Boolean(data.listening),
        installed: Boolean(data.installed || data.connected || status.installed),
        certificateTrusted: Boolean(data.certificateTrusted),
        certificatePath: data.certificatePath || status.certificatePath || "",
        message: data.message || fallbackMessage,
      };
      return JSON.stringify(status) === JSON.stringify(nextStatus) ? status : nextStatus;
    });
    if (data.selectedType) setCaptureType(data.selectedType);
    applyCaptureListIfPresent(data);
  };

  const startPackage = () => {
    if (!packageControlEnabled) {
      api.info("当前是线上页面，不能远程启动你电脑上的后台包；请安装后由系统自启动。");
      return;
    }
    setActionLoading((current) => ({ ...current, startPackage: true }));
    requestJson("/api/wechat-video/package-start", { method: "POST" })
      .then((data) => {
        applyCollectorState(data, "后台包已启动");
        if (data.ok) {
          api.success("后台包已启动");
        } else {
          api.warning(data.message || "后台包启动失败");
        }
      })
      .catch((error) => api.error(`后台包启动失败：${error.message}`))
      .finally(() => {
        setActionLoading((current) => ({ ...current, startPackage: false }));
      });
  };

  const stopPackage = () => {
    if (!packageControlEnabled) {
      api.info("当前是线上页面，不能远程关闭你电脑上的后台包。");
      return;
    }
    setActionLoading((current) => ({ ...current, stopPackage: true }));
    requestJson("/api/wechat-video/package-stop", { method: "POST" })
      .then((data) => {
        applyCollectorState(data, "后台包进程已退出");
        api.info(data.message || "后台包进程已退出");
      })
      .catch((error) => api.error(`后台包退出失败：${error.message}`))
      .finally(() => {
        setActionLoading((current) => ({ ...current, stopPackage: false }));
      });
  };

  const ensurePackageOnline = async () => {
    if (collectorStatus.connected) return true;
    const data = await requestWechatLocalDirect("/api/status");
    applyCollectorState(data, "后台包已启动");
    if (!data.ok) {
      throw new Error(data.message || "当前没有连接到本机后台包，请先复制安装/启动命令并在这台电脑的终端里运行。");
    }
    return true;
  };

  const syncCaptureType = (nextType) =>
    requestWechatLocalDirect("/api/set-type", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: nextType }),
    }).then((data) => {
      applyCollectorState(data, "采集类型已更新");
      return data;
    });

  const startListening = () => {
    setActionLoading((current) => ({ ...current, startListening: true }));
    syncCaptureType(captureType)
      .then(() => requestWechatLocalDirect("/api/start", { method: "POST" }))
      .then((data) => {
        applyCollectorState(data, "采集监听已开启");
        if (data.ok) {
          api.success("已开启采集监听");
        } else {
          api.warning(data.message || "采集服务未接入");
        }
      })
      .catch((error) => {
        api.error(`开启失败：${error.message}`);
      })
      .finally(() => {
        setActionLoading((current) => ({ ...current, startListening: false }));
      });
  };

  const stopListening = () => {
    setActionLoading((current) => ({ ...current, stopListening: true }));
    requestWechatLocalDirect("/api/stop", { method: "POST" })
      .then((data) => {
        applyCollectorState(data, "采集监听已停止");
        if (data.ok) {
          api.info("已停止监听");
        } else {
          api.warning(data.message || "采集服务未接入");
        }
      })
      .catch((error) => {
        api.error(`停止失败：${error.message}`);
      })
      .finally(() => {
        setActionLoading((current) => ({ ...current, stopListening: false }));
      });
  };

  const trustCertificate = () => {
    setActionLoading((current) => ({ ...current, trust: true }));
    ensurePackageOnline()
      .then(() => requestWechatLocalDirect("/api/trust-cert", { method: "POST" }))
      .then((data) => {
        applyCollectorState(data, "证书信任操作已完成");
        if (data.ok && data.certificateTrusted) {
          api.success("证书已信任");
        } else {
          api.warning(data.message || "证书信任未完成");
        }
      })
      .catch((error) => {
        const messageText = "证书信任失败：未连接到本机后台包，请先运行下方安装/更新命令。";
        api.error(messageText);
      })
      .finally(() => {
        setActionLoading((current) => ({ ...current, trust: false }));
      });
  };

  const downloadCapture = (item) => {
    Promise.resolve()
      .then(() =>
        requestWechatLocalDirect("/api/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id }),
        })
      )
      .then((data) => {
        applyCaptureListIfPresent(data);
        api.success("已开始下载");
      })
      .catch((error) => api.error(`下载失败：${error.message}`));
  };

  const revealCapture = (item) => {
    Promise.resolve()
      .then(() =>
        requestWechatLocalDirect(`/api/reveal?id=${encodeURIComponent(item.id)}`, {
          method: "POST",
        })
      )
      .catch((error) => api.error(`打开位置失败：${error.message}`));
  };

  const clearCaptures = () => {
    setCaptures([]);
    setActionLoading((current) => ({ ...current, clear: true }));
    requestWechatLocalDirect("/api/clear", { method: "POST" })
      .then((data) => {
        applyCollectorState(data, "捕获列表已清空");
        api.success(data.message || "捕获列表已清空，采集保持开启");
      })
      .catch((error) => api.error(`清空失败：${error.message}`))
      .finally(() => {
        setActionLoading((current) => ({ ...current, clear: false }));
      });
  };

  const changeCaptureType = (value) => {
    setCaptureType(value);
    if (!collectorStatus.connected) return;
    syncCaptureType(value).catch((error) => api.error(`切换采集类型失败：${error.message}`));
  };

  const copyInstallCommand = async () => {
    const text = installCommand;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        api.success("安装命令已复制");
        return;
      }
      throw new Error("clipboard_unavailable");
    } catch {
      const textArea = installCommandRef.current?.resizableTextArea?.textArea;
      if (textArea) {
        textArea.focus();
        textArea.select();
        try {
          if (document.execCommand("copy")) {
            api.success("安装命令已复制");
            return;
          }
        } catch {
          // Fall through to the manual copy hint below.
        }
      }
      api.warning("已选中安装命令，请按 ⌘C 或 Ctrl+C 复制");
    }
  };

  return (
    <div className="wechat-video-workbench">
      {contextHolder}
      <CollectorPreviewModal
        open={Boolean(previewItem)}
        item={previewItem}
        collectorBaseUrl={collectorLocalDirectUrl}
        collectorToken={collectorToken}
        onClose={() => setPreviewItem(null)}
      />
      <section className="collector-grid">
        <div className="collector-panel">
          <Title level={5}>按顺序操作</Title>
          <div className="collector-status">
            <div>
              <strong>{listening ? "正在采集中" : collectorStatus.connected ? "准备就绪" : collectorStatus.installed ? "还差一步" : "需要先安装"}</strong>
              <span>
                {listening
                  ? "现在去刷微信视频号，下面会自动出现图片和视频。"
                  : collectorStatus.connected
                    ? "按下面顺序点一下就能开始采集。"
                    : collectorStatus.message}
              </span>
            </div>
            <CollectorPill tone={listening ? "active" : collectorStatus.connected ? "ready" : "warning"}>
              {listening ? "采集中" : collectorStatus.connected ? "可启动" : collectorStatus.installed ? "待处理" : "未安装"}
            </CollectorPill>
          </div>
          <div className="collector-steps">
            <div>
              <strong>第1步：启动后台包</strong>
              <span>{collectorStatus.connected ? "已启动，可以继续下一步。" : "复制下面的安装/启动命令，在这台电脑的终端里运行。"}</span>
              <div className="collector-inline-actions">
                {collectorStatus.installed && packageControlEnabled ? (
                  <CollectorButton onClick={startPackage} disabled={collectorStatus.connected || actionLoading.startPackage}>
                    {collectorStatus.connected ? "后台包已启动" : actionLoading.startPackage ? "启动中..." : "启动后台包"}
                  </CollectorButton>
                ) : collectorStatus.connected ? (
                  <CollectorPill tone="ready">后台包已启动</CollectorPill>
                ) : (
                  <CollectorButton onClick={copyInstallCommand}>
                    复制安装/启动命令
                  </CollectorButton>
                )}
              </div>
            </div>
            <div>
              <strong>第2步：信任证书</strong>
              <span>{collectorStatus.certificateTrusted ? "已信任，可以继续下一步。" : "点一下，输入电脑密码。只需要做一次。"}</span>
              <div className="collector-inline-actions">
                {collectorStatus.certificateTrusted ? (
                  <CollectorPill tone="ready">证书已信任</CollectorPill>
                ) : (
                  <CollectorButton onClick={trustCertificate} disabled={actionLoading.trust}>
                    {actionLoading.trust ? "处理中..." : "信任证书"}
                  </CollectorButton>
                )}
              </div>
            </div>
            <div>
              <strong>第3步：开始采集</strong>
              <span>{listening ? "已经在采集了，现在去刷视频号。" : "选好抓取类型后，点击启动采集服务。"}</span>
              <div className="collector-inline-actions collector-inline-toolbar">
                <div className="capture-filter-buttons" role="group" aria-label="采集类型">
                  {[
                    { value: "all", label: "全部" },
                    { value: "image", label: "图片" },
                    { value: "video", label: "视频" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`capture-filter-button ${captureType === option.value ? "active" : ""}`}
                      onClick={() => changeCaptureType(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <CollectorButton
                  variant="primary"
                  onClick={startListening}
                  loading={actionLoading.startListening}
                  disabled={listening || actionLoading.startListening}
                >
                  {listening ? "采集中" : actionLoading.startListening ? "启动中..." : "启动采集服务"}
                </CollectorButton>
                <CollectorButton variant="secondary" onClick={stopListening} disabled={!listening || actionLoading.stopListening}>
                  {actionLoading.stopListening ? "停止中..." : "停止采集"}
                </CollectorButton>
              </div>
            </div>
          </div>
          <div className="collector-actions">
            <CollectorButton variant="ghost" onClick={() => checkCollector(false)} disabled={actionLoading.refresh}>
              {actionLoading.refresh ? "刷新中..." : "刷新状态"}
            </CollectorButton>
          </div>
        </div>
        <div className="collector-panel">
          <Title level={5}>当前状态</Title>
          <div className="collector-status compact">
            <div>
              <strong>{collectorStatus.installed ? "这台电脑已安装后台包" : "这台电脑还没安装后台包"}</strong>
              <span>
                {collectorStatus.installed
                  ? "负责本机采集、下载和预览。"
                  : "后台包安装后静默运行，用户后续只在网页上操作。"}
              </span>
            </div>
            <CollectorPill tone={collectorStatus.installed ? "ready" : "warning"}>
              {collectorStatus.installed ? "已安装" : "待安装"}
            </CollectorPill>
          </div>
          <div className="collector-runtime">
            <div>
              <span>后台包进程</span>
              <CollectorPill tone={collectorStatus.connected ? "ready" : "danger"}>
                {collectorStatus.connected ? "在线" : "离线"}
              </CollectorPill>
            </div>
            <div>
              <span>采集监听</span>
              <CollectorPill tone={listening ? "active" : "neutral"}>
                {listening ? "已开启" : "已停止"}
              </CollectorPill>
            </div>
            <div>
              <span>本地证书</span>
              <CollectorPill tone={collectorStatus.certificateTrusted ? "ready" : "warning"}>
                {collectorStatus.certificateTrusted ? "已信任" : "未信任"}
              </CollectorPill>
            </div>
          </div>
          {collectorStatus.installed && packageControlEnabled ? (
            <div className="collector-actions package-actions">
              <CollectorButton variant="danger" onClick={stopPackage} disabled={!collectorStatus.connected || actionLoading.stopPackage}>
                {actionLoading.stopPackage ? "退出中..." : "退出后台包"}
              </CollectorButton>
            </div>
          ) : null}
          {collectorStatus.installed && !packageControlEnabled && collectorStatus.connected ? (
            <div className="collector-note">
              这是线上页面。网页只负责连接你本机的后台包，不会远程控制服务器。
            </div>
          ) : null}
          <label>
            <span>{collectorStatus.connected ? "更新后台包" : "系统"}</span>
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
          <div className="collector-actions">
            <CollectorButton onClick={copyInstallCommand}>
              {collectorStatus.connected ? "复制更新/重装命令" : "复制安装/启动命令"}
            </CollectorButton>
          </div>
          {collectorStatus.connected ? (
            <div className="collector-note">
              如果后台包已启动但本机直连不可用，复制这条命令重新运行一次，会自动替换旧进程并配置本地域名。
            </div>
          ) : null}
        </div>
      </section>
      <section className="collector-panel">
        <div className="collector-section-head">
          <div>
            <Title level={5}>捕获列表</Title>
            <Text>
              {visibleCaptures.length} 条记录
              {latestCaptureAt ? ` · 最近捕获 ${latestCaptureAt}` : ""}
              {visibleCaptures.length > renderedCaptures.length ? ` · 当前展示最近 ${renderedCaptures.length} 条` : ""}
            </Text>
          </div>
          <CollectorButton
            variant="ghost"
            size="small"
            onClick={clearCaptures}
            disabled={!captures.length || !collectorStatus.connected || actionLoading.clear}
          >
            {actionLoading.clear ? "清空中..." : "清空列表"}
          </CollectorButton>
        </div>
        {actionLoading.clear ? (
          <div className="collector-note">正在清空列表，采集不会停止。</div>
        ) : null}
        {actionLoading.startListening ? (
          <div className="collector-note">正在启动采集服务，请稍等几秒。</div>
        ) : null}
        <div className="collector-jobs">
          {renderedCaptures.length ? renderedCaptures.map((item, index) => (
            <div className="collector-job" key={item.id}>
              <div className="resource-preview">
                <CaptureListPreview
                  item={item}
                  collectorBaseUrl={collectorLocalDirectUrl}
                  collectorToken={collectorToken}
                  prioritize={index < 12}
                />
              </div>
              <div className="resource-main">
                <div className="resource-title-row">
                  <strong title={resourceTitle(item)}>{resourceTitle(item)}</strong>
                  <Space size={6} wrap>
                    <CollectorPill tone={item.classify === "video" ? "active" : item.classify === "image" ? "ready" : "neutral"}>
                      {resourceTypeLabel(item)}
                    </CollectorPill>
                    <CollectorPill>{item.suffix || "resource"}</CollectorPill>
                    <CollectorPill tone={item.downloadStatus === "downloaded" ? "ready" : item.downloadStatus === "error" ? "danger" : "neutral"}>
                      {downloadStatusLabel(item)}
                    </CollectorPill>
                  </Space>
                </div>
                <div className="resource-meta">
                  <span>{item.id}</span>
                  <span>{formatBytes(item.size || item.downloaded)}</span>
                  <span>{item.domain || "unknown"}</span>
                  <span>{item.capturedAt || ""}</span>
                </div>
                <p className="resource-url" title={item.url}>{shortResourceUrl(item.url)}</p>
                {item.downloadStatus === "downloading" || item.downloadStatus === "downloaded" || item.downloadStatus === "error" ? (
                  <div className="resource-progress">
                    <Progress
                      percent={item.downloadStatus === "downloaded" ? 100 : Number(item.progress || 0)}
                      size="small"
                      status={item.downloadStatus === "error" ? "exception" : item.downloadStatus === "downloaded" ? "success" : "active"}
                    />
                    {item.error ? <Text type="danger">{item.error}</Text> : null}
                  </div>
                ) : null}
                <div className="resource-path">
                  <span>保存位置</span>
                  <code>{item.savePath || "尚未下载"}</code>
                </div>
                <div className="collector-actions resource-actions">
                  <CollectorButton
                    size="small"
                    variant="primary"
                    icon={<DownloadOutlined />}
                    onClick={() => downloadCapture(item)}
                    disabled={item.downloadStatus === "downloading"}
                  >
                    {item.downloadStatus === "downloaded" ? "重新下载" : "下载"}
                  </CollectorButton>
                  <CollectorButton
                    size="small"
                    variant="secondary"
                    icon={<FolderOpenOutlined />}
                    onClick={() => revealCapture(item)}
                    disabled={!item.savePath}
                  >
                    打开位置
                  </CollectorButton>
                  <CollectorButton
                    size="small"
                    variant="secondary"
                    icon={<EyeOutlined />}
                    onClick={() => setPreviewItem(item)}
                  >
                    预览
                  </CollectorButton>
                </div>
              </div>
            </div>
          )) : (
            <div className="collector-empty">
              当前还没有捕获到视频号资源。点击启动采集服务后，在微信客户端里正常刷视频号，捕获到的资源会显示在这里。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
