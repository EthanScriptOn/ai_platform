import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppstoreOutlined,
  DatabaseOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  ConfigProvider,
  Layout,
  Menu,
  Space,
  Typography,
  message,
  theme,
} from "antd";
import { requestJson } from "./lib/apiClient";
const GroupIntentWorkbench = lazy(() => import("./workbenches/GroupIntentWorkbench.jsx"));
const PersonaDistillWorkbench = lazy(() => import("./workbenches/PersonaDistillWorkbench.jsx"));
const KnowledgeWorkbench = lazy(() => import("./workbenches/KnowledgeWorkbench.jsx"));
const WechatVideoCollector = lazy(() => import("./workbenches/WechatVideoCollector.jsx"));
const ContentAssetsWorkbench = lazy(() => import("./workbenches/ContentAssetsWorkbench.jsx"));
const AiSearchWorkbench = lazy(() => import("./workbenches/AiSearchWorkbench.jsx"));

const { Sider, Header, Content } = Layout;
const { Text, Title } = Typography;
const iconById = {
  flowbot: <MessageOutlined />,
  knowledge: <DatabaseOutlined />,
  "persona-distill": <UserOutlined />,
  "ai-search": <SearchOutlined />,
  "content-assets": <PlayCircleOutlined />,
  "group-intent": <RobotOutlined />,
  "wechat-video": <VideoCameraOutlined />,
};

const workbenchRegistry = {
  "wechat-video": {
    Component: WechatVideoCollector,
  },
  "content-assets": {
    Component: ContentAssetsWorkbench,
    getProps: ({ frameKey }) => ({ frameKey }),
  },
  "persona-distill": {
    Component: PersonaDistillWorkbench,
    getProps: ({ frameKey }) => ({ frameKey }),
  },
  "ai-search": {
    Component: AiSearchWorkbench,
  },
  "group-intent": {
    Component: GroupIntentWorkbench,
  },
  "knowledge-governance": {
    Component: KnowledgeWorkbench,
    getProps: ({ active, frameKey }) => ({ module: active, frameKey }),
  },
};


function normalizeHash(modules) {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (modules.some((item) => item.id === hash)) return hash;
  return modules[0]?.id || "";
}

function ModuleContent({ active, frameKey, refreshRequest, onFrameLoad, onRefreshFallback }) {
  const iframeRef = useRef(null);
  const registryItem = active ? workbenchRegistry[active.id] : null;

  useEffect(() => {
    if (!refreshRequest || !active || registryItem) return;
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      onRefreshFallback?.();
      return;
    }
    frameWindow.postMessage(
      {
        type: "yuebai-module-refresh",
        requestId: refreshRequest.id,
        moduleId: active.id,
      },
      window.location.origin
    );
  }, [active, onRefreshFallback, refreshRequest, registryItem]);

  if (registryItem) {
    const Workbench = registryItem.Component;
    const props = registryItem.getProps?.({ active, frameKey }) || {};
    return (
      <Suspense fallback={<div className="empty-state">模块加载中...</div>}>
        <Workbench {...props} />
      </Suspense>
    );
  }
  if (active) {
    return (
      <iframe
        ref={iframeRef}
        key={`${active.id}-${frameKey}`}
        className="module-frame"
        title={active.name}
        src={active.url}
        onLoad={onFrameLoad}
      />
    );
  }
  return <div className="empty-state">模块加载中...</div>;
}


export default function App() {
  const searchParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const standaloneMode = searchParams.get("embed") || "";
  const [modules, setModules] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(null);
  const [flowbotView, setFlowbotView] = useState("list");
  const refreshTimerRef = useRef(null);

  const finishRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setRefreshRequest(null);
    setRefreshing(false);
  }, []);

  const fallbackReloadFrame = useCallback(() => {
    setFrameKey((value) => value + 1);
  }, []);

  useEffect(() => {
    requestJson("/api/modules")
      .then((data) => {
        const nextModules = data.modules || [];
        setModules(nextModules);
        setActiveId(normalizeHash(nextModules));
      })
      .catch((error) => message.error(`加载模块失败：${error.message}`));
  }, []);

  useEffect(() => {
    const onHash = () => setActiveId(normalizeHash(modules));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [modules]);

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "yuebai-flowbot-view") {
        setFlowbotView(event.data.view === "detail" ? "detail" : "list");
        return;
      }
      if (event.data?.type !== "yuebai-module-refresh-done") return;
      if (!refreshRequest || event.data.requestId !== refreshRequest.id) return;
      if (event.data.ok === false) {
        message.error(`刷新失败：${event.data.error || "未知错误"}`);
      }
      finishRefresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finishRefresh, refreshRequest]);

  const active = useMemo(
    () => modules.find((item) => item.id === activeId) || modules[0],
    [modules, activeId]
  );

  useEffect(() => {
    if (active?.id !== "flowbot") {
      setFlowbotView("list");
    }
  }, [active?.id]);

  const menuItems = modules.filter((item) => !item.hidden).map((item) => ({
    key: item.id,
    icon: iconById[item.id] || <AppstoreOutlined />,
    label: (
      <div className="menu-label">
        <span>{item.name}</span>
        {item.description ? <small>{item.description}</small> : null}
      </div>
    ),
  }));

  const selectModule = ({ key }) => {
    window.location.hash = `/${key}`;
    setActiveId(key);
  };

  const refreshActiveModule = () => {
    if (refreshing) return;
    setRefreshing(true);

    const request = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}` };
    setRefreshRequest(request);

    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    if (active && workbenchRegistry[active.id]) {
      setFrameKey((value) => value + 1);
      refreshTimerRef.current = window.setTimeout(finishRefresh, 700);
      return;
    }

    refreshTimerRef.current = window.setTimeout(fallbackReloadFrame, 8000);
  };

  const showHeaderRefresh = !(active?.id === "flowbot" && flowbotView === "detail");

  if (standaloneMode === "knowledge-governance") {
    const standaloneModule = {
      ...(modules.find((item) => item.id === "knowledge-governance") || {
        id: "knowledge-governance",
        name: "知识候选审核",
      }),
      url: "/ragflow-chat-bridge.html",
    };

    return (
      <ConfigProvider
        theme={{
          algorithm: theme.defaultAlgorithm,
          token: {
            borderRadius: 6,
            colorPrimary: "#2f1f3a",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
          },
        }}
      >
        <div className="standalone-shell">
          <Suspense fallback={<div className="empty-state">模块加载中...</div>}>
            <KnowledgeWorkbench module={standaloneModule} frameKey={frameKey} />
          </Suspense>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          borderRadius: 6,
          colorPrimary: "#2f1f3a",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        },
      }}
    >
      <Layout className="app-shell">
        <Sider className="app-sider" width={280}>
          <div className="brand">
            <div className="brand-mark">
              <img src="/logo.webp" alt="悦拜" />
            </div>
            <div>
              <Title level={4}>悦拜AI工具平台</Title>
              <Text>悦拜内部 AI 工具平台</Text>
            </div>
          </div>
          <Menu
            className="module-menu"
            mode="inline"
            selectedKeys={active ? [active.id] : []}
            items={menuItems}
            onClick={selectModule}
          />
          <div className="sider-footer" />
        </Sider>
        <Layout>
          <Header className="app-header">
            <div className="header-main">
              <Space size={10} wrap>
                <Title level={4}>{active?.name || "模块加载中"}</Title>
                {active?.category ? <span className="header-pill header-pill-accent">{active.category}</span> : null}
                {active?.status ? <span className="header-pill">{active.status}</span> : null}
              </Space>
              <Text className="module-description">{active?.description || ""}</Text>
            </div>
            <Space>
              {showHeaderRefresh ? (
                <button
                  className="app-header-button"
                  type="button"
                  onClick={refreshActiveModule}
                  disabled={refreshing}
                  aria-busy={refreshing}
                >
                  <ReloadOutlined className={refreshing ? "app-header-button-spin" : ""} />
                  <span>{refreshing ? "刷新中..." : "刷新"}</span>
                </button>
              ) : null}
            </Space>
          </Header>
          <Content className="app-content">
            <ModuleContent
              active={active}
              frameKey={frameKey}
              refreshRequest={refreshRequest}
              onFrameLoad={finishRefresh}
              onRefreshFallback={fallbackReloadFrame}
            />
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
