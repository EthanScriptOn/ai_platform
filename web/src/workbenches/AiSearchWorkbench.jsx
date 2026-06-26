import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Drawer, Empty, Input, Select, Skeleton, Space, Spin, Switch, Typography, message } from "antd";
import { requestJson } from "../lib/apiClient";

const { Paragraph, Text, Title } = Typography;
const { TextArea } = Input;
const FIXED_PREFERENCE_CHIPS = [
  "综合",
  "最新",
  "基本情况",
  "投资",
  "技术",
  "产品",
  "商业化",
  "产业链",
  "人物",
  "争议",
  "政策",
  "竞品",
];

const DEFAULT_CONFIG = {
  writer: {
    provider: "qwen",
    model: "",
  },
  searchCenter: {
    baseUrl: "",
    apiKey: "",
    webSearchModel: "",
    queryExpandModel: "",
    sslVerify: false,
    apiKeyConfigured: false,
  },
};

function CitationLinks({ ids, references }) {
  if (!ids?.length) return null;
  const refMap = new Map((references || []).map((item) => [item.id, item]));
  return (
    <span className="ai-search-citations">
      {ids.map((id) => {
        const ref = refMap.get(id);
        if (!ref?.url) return null;
        return (
          <a key={id} href={ref.url} target="_blank" rel="noreferrer" title={ref.title}>
            [{id}]
          </a>
        );
      })}
    </span>
  );
}

function pickDefaultConfig(payload) {
  return {
    writer: {
      provider: payload?.defaults?.writer?.provider || "qwen",
      model: payload?.defaults?.writer?.model || "",
    },
    searchCenter: {
      baseUrl: payload?.defaults?.searchCenter?.baseUrl || "",
      apiKey: "",
      webSearchModel: payload?.defaults?.searchCenter?.webSearchModel || "",
      queryExpandModel: payload?.defaults?.searchCenter?.queryExpandModel || "",
      sslVerify: Boolean(payload?.defaults?.searchCenter?.sslVerify),
      apiKeyConfigured: Boolean(payload?.defaults?.searchCenter?.apiKeyConfigured),
    },
  };
}

function formatProviderStats(providerStats) {
  return Object.entries(providerStats || {})
    .map(([name, stats]) => {
      const items = Number(stats?.items || 0);
      const errors = Number(stats?.errors || 0);
      return `${name} ${items}条${errors ? ` / ${errors}错` : ""}`;
    })
    .join(" · ");
}

async function readNdjsonStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onEvent(JSON.parse(trimmed));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer.trim()));
}

export default function AiSearchWorkbench() {
  const [api, contextHolder] = message.useMessage();
  const [query, setQuery] = useState("");
  const [directionLoading, setDirectionLoading] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [directions, setDirections] = useState([]);
  const [selectedDirectionIds, setSelectedDirectionIds] = useState([]);
  const [previousDirections, setPreviousDirections] = useState([]);
  const [previousSelectedDirections, setPreviousSelectedDirections] = useState([]);
  const [recommendedChips, setRecommendedChips] = useState([]);
  const [selectedPreferenceChips, setSelectedPreferenceChips] = useState(["综合"]);
  const [chipSearch, setChipSearch] = useState("");
  const [searchCount, setSearchCount] = useState(2);
  const [searchDepth, setSearchDepth] = useState(2);
  const [report, setReport] = useState(null);
  const [lastError, setLastError] = useState("");
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [streamState, setStreamState] = useState({ stage: "", message: "", focusedPlan: null, searchResult: null });
  const [searchConfig, setSearchConfig] = useState(DEFAULT_CONFIG);
  const [defaultConfig, setDefaultConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    setConfigLoading(true);
    requestJson("/api/ai-search/config")
      .then((payload) => {
        const nextConfig = pickDefaultConfig(payload);
        setSearchConfig(nextConfig);
        setDefaultConfig(nextConfig);
      })
      .catch((error) => {
        setLastError(error.message);
      })
      .finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    if (!directionLoading && !reportLoading) {
      setLoadingSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setLoadingSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [directionLoading, reportLoading]);

  const selectedDirections = useMemo(
    () => directions.filter((item) => selectedDirectionIds.includes(item.id)),
    [directions, selectedDirectionIds]
  );
  const allPreferenceChips = useMemo(() => {
    const merged = [...FIXED_PREFERENCE_CHIPS, ...recommendedChips];
    return Array.from(new Set(merged.map((item) => String(item || "").trim()).filter(Boolean)));
  }, [recommendedChips]);
  const filteredPreferenceChips = useMemo(() => {
    const keyword = chipSearch.trim().toLowerCase();
    if (!keyword) return allPreferenceChips;
    return allPreferenceChips.filter((item) => item.toLowerCase().includes(keyword));
  }, [allPreferenceChips, chipSearch]);
  const preferenceChipText = useMemo(() => {
    const picked = selectedPreferenceChips.filter((item) => item && item !== "综合");
    return picked.join("、");
  }, [selectedPreferenceChips]);
  const providerSummary = formatProviderStats(report?.searchResult?.providerStats || {});
  const searchTraceQueries = streamState?.searchResult?.queryPlan?.queries || report?.searchResult?.queryPlan?.queries || [];

  const requestDirections = async () => {
    const nextQuery = query.trim();
    if (!nextQuery) {
      api.warning("先输入一个搜索词");
      return;
    }
    setDirectionLoading(true);
    setLastError("");
    setReport(null);
    try {
      const currentDirections = directions;
      const currentSelected = selectedDirections;
      const data = await requestJson("/api/ai-search/directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: nextQuery,
          config: searchConfig,
          previousDirections: currentDirections,
          preferenceChip: preferenceChipText,
        }),
      });
      const nextDirections = data.directions || [];
      setPreviousDirections(currentDirections);
      setPreviousSelectedDirections(currentSelected);
      setDirections(nextDirections);
      setRecommendedChips(Array.isArray(data.chips) ? data.chips : []);
      setSelectedDirectionIds([]);
    } catch (error) {
      setLastError(error.message);
      api.error(`生成方向失败：${error.message}`);
    } finally {
      setDirectionLoading(false);
    }
  };

  const togglePreferenceChip = (chip) => {
    setSelectedPreferenceChips((current) => {
      if (chip === "综合") return ["综合"];
      const withoutDefault = current.filter((item) => item !== "综合");
      const next = withoutDefault.includes(chip)
        ? withoutDefault.filter((item) => item !== chip)
        : [...withoutDefault, chip];
      return next.length ? next : ["综合"];
    });
  };

  const buildReport = async () => {
    const nextQuery = query.trim();
    if (!nextQuery) {
      api.warning("先输入一个搜索词");
      return;
    }
    if (!selectedDirections.length) {
      api.warning("至少选择一个方向");
      return;
    }
    setReportLoading(true);
    setReport(null);
    setLastError("");
    setStreamState({ stage: "starting", message: "正在启动检索", focusedPlan: null, searchResult: null });
    try {
      const response = await window.fetch("/api/ai-search/report-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: nextQuery,
          directions: selectedDirections,
          searchCount,
          searchDepth,
          config: searchConfig,
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`请求失败：HTTP ${response.status}`);
      }
      let finalResult = null;
      await readNdjsonStream(response, (event) => {
        if (event.type === "progress") {
          setStreamState((current) => ({
            stage: event.stage || current.stage,
            message: event.message || current.message,
            focusedPlan: event.focusedPlan || current.focusedPlan,
            searchResult: event.searchResult || current.searchResult,
          }));
        }
        if (event.type === "error") {
          throw new Error(event.error || "生成文章失败");
        }
        if (event.type === "result") {
          finalResult = event;
        }
      });
      if (!finalResult?.ok) {
        throw new Error("未拿到最终结果");
      }
      setReport(finalResult);
    } catch (error) {
      setLastError(error.message);
      api.error(`生成文章失败：${error.message}`);
    } finally {
      setReportLoading(false);
    }
  };

  const resetAll = () => {
    setDirections([]);
    setSelectedDirectionIds([]);
    setPreviousDirections([]);
    setPreviousSelectedDirections([]);
    setRecommendedChips([]);
    setSelectedPreferenceChips(["综合"]);
    setChipSearch("");
    setReport(null);
    setStreamState({ stage: "", message: "", focusedPlan: null, searchResult: null });
    setLastError("");
  };

  const renderSearchTrace = () => {
    if (!reportLoading) return null;
    const focusedQuery = streamState?.focusedPlan?.focusedQuery;
    const searchTerms = streamState?.focusedPlan?.searchTerms || [];
    const providerStats = formatProviderStats(streamState?.searchResult?.providerStats || {});
    return (
      <section className="ai-search-panel ai-search-progress-panel">
        <div className="ai-search-progress-head">
          <div>
            <strong>{streamState.message || "正在处理"}</strong>
            <span>{loadingSeconds > 0 ? `已等待 ${loadingSeconds} 秒` : "请求已发出"}</span>
          </div>
          <Spin />
        </div>
        {focusedQuery ? (
          <div className="ai-search-progress-block">
            <label>当前检索表达</label>
            <p>{focusedQuery}</p>
          </div>
        ) : null}
        {searchTerms.length ? (
          <div className="ai-search-progress-block">
            <label>扩展词</label>
            <div className="ai-search-chip-row">
              {searchTerms.map((item) => (
                <span key={item} className="ai-search-chip">{item}</span>
              ))}
            </div>
          </div>
        ) : null}
        {searchTraceQueries.length ? (
          <div className="ai-search-progress-block">
            <label>规划出的搜索支线</label>
            <div className="ai-search-query-list">
              {searchTraceQueries.slice(0, 8).map((item, index) => (
                <div key={`${item.query}-${index}`} className="ai-search-query-item">
                  <strong>{item.query}</strong>
                  {item.why ? <span>{item.why}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {providerStats ? (
          <div className="ai-search-progress-block">
            <label>已完成来源汇总</label>
            <p>{providerStats}</p>
          </div>
        ) : null}
      </section>
    );
  };

  if (report) {
    const article = report.article || {};
    const references = article.references || [];
    return (
      <div className="ai-search-workbench ai-search-article-mode">
        {contextHolder}
        <section className="ai-search-panel ai-search-article">
          <div className="ai-search-article-head">
            <div>
              <Title level={3}>{article.title || query}</Title>
              <Space wrap size={8}>
                <span className="header-pill header-pill-accent">AI搜索</span>
                {report.searchResult?.timeWindow?.date_from ? (
                  <span className="header-pill">
                    {report.searchResult.timeWindow.date_from} ~ {report.searchResult.timeWindow.date_to}
                  </span>
                ) : null}
                <span className="header-pill">{selectedDirections.map((item) => item.label).join(" / ")}</span>
              </Space>
            </div>
            <Space>
              <Button onClick={() => setReport(null)}>返回搜索</Button>
              <Button type="primary" onClick={resetAll}>重新搜索</Button>
            </Space>
          </div>

          {article.lead ? <Paragraph className="ai-search-lead">{article.lead}</Paragraph> : null}

          <div className="ai-search-article-meta">
            <div>
              <strong>原始查询</strong>
              <span>{report.query}</span>
            </div>
            <div>
              <strong>已选方向</strong>
              <span>{selectedDirections.map((item) => item.label).join(" / ")}</span>
            </div>
            <div>
              <strong>搜索预算</strong>
              <span>{`搜索次数 ${report.budget?.searchCount || searchCount} · 搜索深度 ${report.budget?.searchDepth || searchDepth}`}</span>
            </div>
            <div>
              <strong>检索来源</strong>
              <span>{providerSummary || "暂无来源统计"}</span>
            </div>
          </div>

          <div className="ai-search-article-body">
            {(article.sections || []).map((section) => (
              <section key={section.heading} className="ai-search-article-section">
                <Title level={4}>{section.heading}</Title>
                {(section.paragraphs || []).map((paragraph, index) => (
                  <Paragraph key={`${section.heading}-${index}`}>
                    {paragraph.text} <CitationLinks ids={paragraph.citations} references={references} />
                  </Paragraph>
                ))}
              </section>
            ))}
          </div>

          {article.closing ? <Paragraph className="ai-search-closing">{article.closing}</Paragraph> : null}

          <section className="ai-search-reference-block">
            <Title level={5}>参考来源</Title>
            {references.length ? (
              <div className="ai-search-reference-list">
                {references.map((item) => (
                  <a key={item.id} className="ai-search-reference-item" href={item.url} target="_blank" rel="noreferrer">
                    <strong>[{item.id}] {item.title}</strong>
                    <span>{[item.source, item.publishedAt, item.searchProvider].filter(Boolean).join(" · ")}</span>
                  </a>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可展示来源" />
            )}
          </section>
        </section>
      </div>
    );
  }

  return (
    <div className="ai-search-workbench ai-search-home">
      {contextHolder}
      <section className="ai-search-hero">
        <div className="ai-search-hero-copy">
          <Title level={2}>AI搜索</Title>
          <Text>输入一个词，先给方向，再深挖成文。</Text>
        </div>

        <section className="ai-search-panel ai-search-hero-shell">
          <div className="ai-search-input-shell ai-search-hero-input-shell">
            <TextArea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoSize={{ minRows: 2, maxRows: 4 }}
              className="ai-search-query-input ai-search-query-input-hero"
              placeholder="试试：SpaceX / 味之素 ABF膜 / 木头姐 / 量子计算"
            />
            <div className="ai-search-hero-toolbar">
              <div className="ai-search-toolbar-group">
                <button type="button" className="ai-search-toolbar-chip" onClick={() => setConfigOpen(true)}>
                  搜索配置
                </button>
                <span className="ai-search-toolbar-meta">{`搜索次数 ${searchCount} · 搜索深度 ${searchDepth}`}</span>
              </div>
              <div className="ai-search-input-actions">
                <Button size="large" onClick={resetAll}>清空</Button>
                <Button type="primary" size="large" loading={directionLoading} onClick={requestDirections}>
                  搜索
                </Button>
              </div>
            </div>
          </div>
        </section>
      </section>

      {lastError ? <Alert type="error" showIcon message={lastError} className="ai-search-inline-alert" /> : null}

      {directionLoading ? (
        <div className="ai-search-loading-state">
          <Spin />
          <span>正在生成方向...</span>
        </div>
      ) : null}

      {directions.length ? (
        <section className="ai-search-panel ai-search-direction-stage">
          <div className="ai-search-direction-head">
            <div>
              <Title level={5}>选择方向</Title>
            </div>
            <Button onClick={requestDirections}>换一批方向</Button>
          </div>

          <div className="ai-search-chip-panel">
            <div className="ai-search-chip-panel-head">
              <div>
                <strong>检索偏好</strong>
                <span>{preferenceChipText ? `当前偏向 ${preferenceChipText}` : "当前未偏向单一视角"}</span>
              </div>
              <Input
                value={chipSearch}
                onChange={(event) => setChipSearch(event.target.value)}
                placeholder="筛选标签"
                allowClear
                className="ai-search-chip-search"
              />
            </div>
            {recommendedChips.length ? (
              <div className="ai-search-chip-hint">
                <label>推荐标签</label>
                <div className="ai-search-chip-row">
                  {recommendedChips.map((item) => (
                    <button
                      key={`recommended-${item}`}
                      type="button"
                      className={`ai-search-chip ai-search-chip-action ${selectedPreferenceChips.includes(item) ? "active" : ""}`}
                      onClick={() => togglePreferenceChip(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="ai-search-chip-row">
              {filteredPreferenceChips.map((item) => (
                <button
                  key={`chip-${item}`}
                  type="button"
                  className={`ai-search-chip ai-search-chip-action ${selectedPreferenceChips.includes(item) ? "active" : ""}`}
                  onClick={() => togglePreferenceChip(item)}
                >
                  {item}
                </button>
              ))}
              {!filteredPreferenceChips.length ? <span className="ai-search-chip-empty">没有匹配的标签</span> : null}
            </div>
          </div>

          <div className="ai-search-direction-grid">
            {directions.map((item) => {
              const checked = selectedDirectionIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ai-search-direction-card ${checked ? "active" : ""}`}
                  onClick={() =>
                    setSelectedDirectionIds((current) =>
                      current.includes(item.id)
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id]
                    )
                  }
                >
                  <div className="ai-search-direction-card-top">
                    <span className={`ai-search-direction-check ${checked ? "active" : ""}`}>{checked ? "✓" : ""}</span>
                    <strong>{item.label}</strong>
                  </div>
                  <span>{item.reason}</span>
                  {item.keywords?.length ? <small>{item.keywords.join(" / ")}</small> : null}
                </button>
              );
            })}
          </div>

          {previousSelectedDirections.length ? (
            <div className="ai-search-previous-block">
              <label>上一批已选方向</label>
              <div className="ai-search-chip-row">
                {previousSelectedDirections.map((item) => (
                  <button
                    key={`previous-${item.id}-${item.label}`}
                    type="button"
                    className="ai-search-chip ai-search-chip-action"
                    onClick={() => {
                      const syntheticId = `carry-${item.label}`;
                      const exists = directions.some((direction) => direction.label === item.label);
                      if (!exists) {
                        setDirections((current) => [...current, { ...item, id: syntheticId }]);
                        setSelectedDirectionIds((current) => Array.from(new Set([...current, syntheticId])));
                        return;
                      }
                      const matched = directions.find((direction) => direction.label === item.label);
                      if (matched) {
                        setSelectedDirectionIds((current) => Array.from(new Set([...current, matched.id])));
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="ai-search-tuning-bar">
            <div className="ai-search-tuning-item">
              <strong>搜索次数</strong>
              <Select
                value={searchCount}
                onChange={setSearchCount}
                disabled={reportLoading}
                options={[1, 2, 3, 4, 5, 6].map((value) => ({ value, label: `${value} 次` }))}
              />
            </div>
            <div className="ai-search-tuning-item">
              <strong>搜索深度</strong>
              <Select
                value={searchDepth}
                onChange={setSearchDepth}
                disabled={reportLoading}
                options={[1, 2, 3, 4, 5].map((value) => ({ value, label: `${value} 轮` }))}
              />
            </div>
            <div className="ai-search-tuning-submit">
              <Button type="primary" size="large" loading={reportLoading} onClick={buildReport}>
                生成文章
              </Button>
            </div>
          </div>
        </section>
      ) : (
        !directionLoading && (
          <div className="ai-search-empty-placeholder">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先输入搜索词。" />
          </div>
        )
      )}

      {reportLoading ? (
        <>
          {renderSearchTrace()}
          <div className="ai-search-report-loading">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        </>
      ) : null}

      <Drawer
        title="搜索配置"
        placement="right"
        width={420}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      >
        {configLoading ? (
          <div className="ai-search-loading-state">
            <Spin />
            <span>正在加载配置...</span>
          </div>
        ) : (
          <div className="ai-search-config-panel">
            <div className="ai-search-config-group">
              <Title level={5}>方向与成文模型</Title>
              <label>模型</label>
              <Input
                value={searchConfig.writer.model}
                onChange={(event) =>
                  setSearchConfig((current) => ({
                    ...current,
                    writer: { ...current.writer, model: event.target.value },
                  }))
                }
                placeholder="例如：qwen-plus / qwen-max"
              />
            </div>

            <div className="ai-search-config-group">
              <Title level={5}>搜索中心</Title>
              <label>Base URL</label>
              <Input
                value={searchConfig.searchCenter.baseUrl}
                onChange={(event) =>
                  setSearchConfig((current) => ({
                    ...current,
                    searchCenter: { ...current.searchCenter, baseUrl: event.target.value },
                  }))
                }
                placeholder="例如：https://myclaudeproxy.xyz/"
              />
              <label>API Key</label>
              <Input.Password
                value={searchConfig.searchCenter.apiKey}
                onChange={(event) =>
                  setSearchConfig((current) => ({
                    ...current,
                    searchCenter: { ...current.searchCenter, apiKey: event.target.value },
                  }))
                }
                placeholder={searchConfig.searchCenter.apiKeyConfigured ? "留空则继续使用服务端默认 Key" : "输入新的 Key"}
              />
              <label>Web Search 模型</label>
              <Input
                value={searchConfig.searchCenter.webSearchModel}
                onChange={(event) =>
                  setSearchConfig((current) => ({
                    ...current,
                    searchCenter: { ...current.searchCenter, webSearchModel: event.target.value },
                  }))
                }
                placeholder="例如：gpt-5.4-mini"
              />
              <label>Query Expand 模型</label>
              <Input
                value={searchConfig.searchCenter.queryExpandModel}
                onChange={(event) =>
                  setSearchConfig((current) => ({
                    ...current,
                    searchCenter: { ...current.searchCenter, queryExpandModel: event.target.value },
                  }))
                }
                placeholder="例如：gpt-5.4-mini"
              />
              <div className="ai-search-config-switch">
                <span>启用 SSL 校验</span>
                <Switch
                  checked={searchConfig.searchCenter.sslVerify}
                  onChange={(checked) =>
                    setSearchConfig((current) => ({
                      ...current,
                      searchCenter: { ...current.searchCenter, sslVerify: checked },
                    }))
                  }
                />
              </div>
              <Paragraph className="ai-search-config-help">
                这部分适用于支持 OpenAI 兼容 Responses / Web Search 的服务。留空时继续走当前服务端默认配置。
              </Paragraph>
            </div>

            <Space>
              <Button
                onClick={() => {
                  setSearchConfig(defaultConfig);
                }}
              >
                恢复默认
              </Button>
              <Button type="primary" onClick={() => setConfigOpen(false)}>完成</Button>
            </Space>
          </div>
        )}
      </Drawer>
    </div>
  );
}
