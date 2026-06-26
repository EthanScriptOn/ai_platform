# Intel API

把目前验证过可用的 A / B / C 三类信息源先统一成一个本地 HTTP 接口。

## 覆盖范围

- A：确定性硬源
  - SEC / 财报 / 结构化披露
  - 公司 IR 页面 / earnings webcast 模式
  - 白宫 / OFAC / BIS / USTR / FTC / DOJ / Fed / Treasury 这类官方政策宏观源目录
- B：公共情报
  - 按关键词发现新闻 URL
  - 按公司发现新闻 URL
  - 官网 / 产品页 / 公司资讯页补充召回
  - A 股公告 / 年报 / 季报 / PDF 直链补充召回
  - 单篇文章抽取
  - 批量文章抽取
  - RSS 拉取
- C：实验态 / 账号态 / 专业付费源目录
  - X / Twitter 登录态源
  - AlphaSense / GLG / Tegus / FactSet 这类专业研究工作流入口

## 安装

```bash
cd "/Users/yuebuy/Documents/New project/intel_api"
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 配置文件

现在支持直接改本地配置文件：

`/Users/yuebuy/Documents/New project/intel_api/config.json`

里面可以配：

- LLM base URL / API key / 模型
- 循环预算
- X profile / proxy
- SEC identity

默认规则：

- `config.json` 提供默认配置
- 环境变量优先级更高，可覆盖同名配置

如果需要自定义 SEC identity：

```bash
export INTEL_API_SEC_IDENTITY="Your Name your@email.com"
```

如果要启用 OpenAI `web_search` demo，再补这两个环境变量：

```bash
export OPENAI_API_KEY="sk-..."
export INTEL_API_OPENAI_BASE_URL="https://myclaudeproxy.xyz/"
```

可选：

```bash
export INTEL_API_OPENAI_WEB_MODEL="gpt-5.4-mini"
export INTEL_API_OPENAI_SSL_VERIFY=false
export INTEL_API_DEFAULT_MAX_EXPANSION_QUERIES=2
export INTEL_API_DEFAULT_MAX_FOLLOWUP_QUERIES=1
export INTEL_API_DEFAULT_MAX_ROUNDS=2
export INTEL_API_DEFAULT_ROUND1_PER_QUERY_LIMIT=4
export INTEL_API_DEFAULT_FOLLOWUP_PER_QUERY_LIMIT=3
```

如果你本机外网访问要走代理，启动前也一并带上，不然 B 类新闻源可能会超时或空结果：

```bash
export https_proxy=http://127.0.0.1:17890
export http_proxy=http://127.0.0.1:17890
export all_proxy=socks5://127.0.0.1:17890
export no_proxy=127.0.0.1,localhost
```

## 启动

```bash
uvicorn app:app --host 127.0.0.1 --port 8010 --reload
```

## 接口

### 1. 健康检查

```bash
curl http://127.0.0.1:8010/health
```

### 1.1 查看当前源目录

```bash
curl "http://127.0.0.1:8010/api/b/source-catalog"
```

这里能看到：

- A 类硬源目录
- 通用 source pool
- 政策 / 政治 source pool
- 半导体 / 韩国 / 台湾 source pool
- 量子 / 物理 AI&机器人 / 商业航天 / 生物医药 / 自动驾驶 source pool
- 官方站点适配器
- 官方披露适配器（当前已接 `巨潮资讯`）
- 官方政策源目录
- 专业研究平台目录
- 已经过可访问性和命中测试的赛道豪华源池

### 1.2 OpenAI Web Search Demo

这个接口走 OpenAI `Responses API + web_search`，但不会直连 OpenAI 官方地址，而是走你配置的中转站 base URL。

```bash
curl -G "http://127.0.0.1:8010/api/web/search" \
  --data-urlencode "q=木头姐减持特斯拉转向 SpaceX" \
  --data-urlencode "days=7" \
  --data-urlencode "limit=5"
```

如果想看上游原始返回：

```bash
curl -G "http://127.0.0.1:8010/api/web/search" \
  --data-urlencode "q=SpaceX" \
  --data-urlencode "include_raw=true"
```

说明：

- 默认 base URL 取 `https://myclaudeproxy.xyz/`
- 默认模型取 `INTEL_API_OPENAI_WEB_MODEL`，未设置时是 `gpt-5.4-mini`
- 默认 tool type 是 `web_search`
- 当前默认关闭 SSL 证书校验（`INTEL_API_OPENAI_SSL_VERIFY=false`），因为这个中转站在本机环境下用标准校验可能会报证书链错误
- 返回会尽量整理成：
  - `summary`
  - `items`
  - `citations`
  - `output_text`

### 1.3 统一检索入口

这是现在推荐的新主入口：

- `Round 1`：先做第一轮广搜
- `Round 2 Planner`：让 LLM 读第一轮结果，决定最值得追的支线
- `Round 2`：按支线做第二轮定向补搜
- 内部不再是单纯 `web search -> 再补外挂`
- 现在是一个 `search center` 按查询把多个 provider 一起分发
- 当前 provider 主要包括：
  - `web_search`
  - `B news`
  - `A policy`
  - `B company`
- 同一条查询在不同 provider 上会使用不同的 provider-specific query 改写

```bash
curl -G "http://127.0.0.1:8010/api/search/unified" \
  --data-urlencode "q=木头姐减持特斯拉转向 SpaceX" \
  --data-urlencode "days=7" \
  --data-urlencode "limit=8"
```

如果你有明确公司目标，希望顺手补官方/结构化证据：

```bash
curl -G "http://127.0.0.1:8010/api/search/unified" \
  --data-urlencode "q=海力士最近发生了什么" \
  --data-urlencode "ticker=SKHYNIX" \
  --data-urlencode "company_name=SK hynix" \
  --data-urlencode "aliases=海力士,SK海力士,하이닉스" \
  --data-urlencode "days=14" \
  --data-urlencode "limit=10"
```

如果想把 X 也并进来：

```bash
curl -G "http://127.0.0.1:8010/api/search/unified" \
  --data-urlencode "q=SpaceX" \
  --data-urlencode "mode=deep" \
  --data-urlencode "include_x=true"
```

返回重点字段：

- `items`
- `query_plan`
- `branches`
- `selected_branches`
- `provider_runs`
- `provider_stats`
- `web_queries_run`
- `section_status`
- `source_strategy`
- `errors`

说明：

- 统一入口默认会先调用大模型做查询扩展
- 统一入口默认会进行多轮小循环：先搜，再读结果，再按 LLM 动态挑选支线继续搜
- 比如输入 `木头姐`，会自动扩成 `Cathie Wood / ARK Invest / latest comments / buys sells holdings` 这类检索计划
- 比如输入 `SpaceX`，第二轮可能会根据第一轮结果自动追 `资本市场 / FAA监管 / NASA-DoD合同 / 技术验证`
- 对公司类对象，如果 LLM 没主动给出政策/监管线，系统也会保底补一条小预算的 `policy / regulation / White House / FAA / NASA / DoD` 外生影响支线
- `branches` 会返回 LLM 识别出的候选支线
- `selected_branches` 会返回本轮真正被选中继续追的支线
- `round_traces` 会记录每轮跑了哪些查询、这些查询属于哪条支线
- `provider_runs` 会告诉你每条查询实际调用了哪些 provider
- `provider_stats` 会汇总各 provider 的查询次数、返回条数和报错次数
- 返回里会直接给：
  - `time_window.days`
  - `time_window.date_from`
  - `time_window.date_to`
  例如 `最近14天` 会明确展开成 `2026-06-05 ~ 2026-06-18`
- 如果想关掉这层，可以传：

```bash
--data-urlencode "include_query_expansion=false"
```

也可以控制循环强度：

```bash
--data-urlencode "max_expansion_queries=3"
--data-urlencode "max_followup_queries=2"
--data-urlencode "max_rounds=3"
--data-urlencode "round1_per_query_limit=4"
--data-urlencode "followup_per_query_limit=3"
```

默认预算现在偏保守：

- `max_expansion_queries=2`
- `max_followup_queries=1`
- `max_rounds=2`
- `round1_per_query_limit=4`
- `followup_per_query_limit=3`

如果你要更全，就手动放大这些参数。

其中 `source_strategy` 会明确告诉你：

- 哪些 A/C 源是核心保留
- 哪些 B 源只是专门补充
- 哪些 B 入口已经降级为 `web search` 之后的兜底

### 2. 查公司 filings

```bash
curl "http://127.0.0.1:8010/api/a/company/AAPL/filings?form=10-K&limit=3"
```

### 3. 查 income statement

```bash
curl "http://127.0.0.1:8010/api/a/company/AAPL/financials/income-statement?rows=10"
```

### 4. 查最新 filing URL

```bash
curl "http://127.0.0.1:8010/api/a/company/AAPL/latest-filing-urls?forms=10-K,10-Q,8-K"
```

### 4.1 查最新财报电话会索引

第一版优先返回：

- IR 页面候选
- 最新 event / webcast / transcript / presentation / press release 链接
- 如果公司 IR 页面匿名抓不到，会尽量回退到最近 `8-K` 的公开线索

推荐显式给 `company_name`；如果你已经知道官方 IR 页面，也建议直接给 `ir_url`：

```bash
curl -G "http://127.0.0.1:8010/api/a/company/AAPL/earnings-call-latest" \
  --data-urlencode "company_name=Apple Inc." \
  --data-urlencode "ir_url=https://investor.apple.com/"
```

### 4.2 查近几次财报电话会 / IR 事件列表

```bash
curl -G "http://127.0.0.1:8010/api/a/company/AAPL/earnings-calls" \
  --data-urlencode "company_name=Apple Inc." \
  --data-urlencode "ir_url=https://investor.apple.com/" \
  --data-urlencode "limit=8"
```

### 4.3 查最新政策 / 政治官方更新

这个接口优先拉官方政策列表页，适合看：

- 白宫总统行动
- OFAC 制裁更新
- BIS 出口管制更新
- USTR 关税/贸易动作
- FTC / DOJ 反垄断
- Fed / Treasury 宏观动作

查全部：

```bash
curl -G "http://127.0.0.1:8010/api/a/policy/latest" \
  --data-urlencode "source=all" \
  --data-urlencode "limit_per_source=5"
```

只查某一个源：

```bash
curl -G "http://127.0.0.1:8010/api/a/policy/latest" \
  --data-urlencode "source=bis_news_updates" \
  --data-urlencode "limit_per_source=5"
```

返回里会尽量补：

- `published_hint`
- `signal_tags`
  - 例如 `sanctions` / `export_control` / `tariff` / `antitrust` / `macro_policy`

也支持进一步筛选：

```bash
curl -G "http://127.0.0.1:8010/api/a/policy/latest" \
  --data-urlencode "source=all" \
  --data-urlencode "signal_tag=export_control" \
  --data-urlencode "limit_per_source=5"
```

```bash
curl -G "http://127.0.0.1:8010/api/a/policy/latest" \
  --data-urlencode "source=all" \
  --data-urlencode "signal_tag=sanctions,geopolitics" \
  --data-urlencode "keyword=china"
```

### 5. 按关键词发现新闻 URL

```bash
curl "http://127.0.0.1:8010/api/b/news/search?query=Apple%20AI&days=7&limit=5"
```

如果只想偏某个来源：

```bash
curl "http://127.0.0.1:8010/api/b/news/search?query=Apple&source=Reuters&days=7&limit=5"
```

### 6. 按公司发现新闻 URL

```bash
curl "http://127.0.0.1:8010/api/b/news/company?ticker=AAPL&company_name=Apple%20Inc&days=7&limit=5"
```

### 6.1 按公司做事件级召回

这个接口现在支持三种模式：

- `fast`
  - 只跑官网适配器 + `巨潮资讯`
  - 适合工业长尾 / A 股节点的快返
- `news`
  - 只跑 Google News / GDELT
  - 每个外部源都有显式 timeout，失败会进 `errors`
- `deep`
  - 全量召回
  - 包括 broad recall + source pool + direct adapters + 官方站点 + `巨潮资讯` + 动态扩展
  - 最全，但也最慢

```bash
curl -G "http://127.0.0.1:8010/api/b/news/company-events" \
  --data-urlencode "ticker=SKHYNIX" \
  --data-urlencode "company_name=SK hynix" \
  --data-urlencode "aliases=海力士,하이닉스" \
  --data-urlencode "days=7" \
  --data-urlencode "limit_per_alias=3" \
  --data-urlencode "mode=news" \
  --data-urlencode "dynamic_rounds=1"
```

返回里会多出：

- `mode`: 本次使用的召回模式
- `partial`: 是否有外部源失败但接口仍然返回了部分结果
- `errors`: 失败源明细
- `recall_plan`: 每一轮实际打了哪些 query
- `source_pool_used`: 这次启用了哪些定向源池
- `recall_sources`: 每条结果来自哪些召回源
- `matched_aliases`: 这条结果是被哪个公司别名 / 扩展词命中的
- `trigger_term`: 如果是第二轮扩出来的，会标出触发词

例如海力士这类韩国公司，结果里可能会直接看到：

- `direct:businesskorea`
- `direct:thelec`
- `google_news_kr`

而像工业母机、丝杠、磨床这类长尾制造节点，结果里也可能直接看到：

- `official:hengerda_official`
- `official:qinchuan_official`
- `official:huachen_official`
- `official:cninfo`

如果命中 `巨潮资讯`，返回里通常会直接给出：

- `url`: 公告 PDF 直链
- `detail_url`: 巨潮公告详情页

如果你更想先看“源池扩充后的宽召回”，可以先把第二轮扩展关掉：

```bash
curl -G "http://127.0.0.1:8010/api/b/news/company-events" \
  --data-urlencode "ticker=TSMC" \
  --data-urlencode "company_name=TSMC" \
  --data-urlencode "aliases=台积电,台積電" \
  --data-urlencode "days=14" \
  --data-urlencode "mode=deep" \
  --data-urlencode "limit_per_alias=2" \
  --data-urlencode "dynamic_rounds=0"
```

### 7. 抽取单篇新闻

```bash
curl -X POST "http://127.0.0.1:8010/api/b/article/extract" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.cnbc.com/2025/06/11/stock-market-today-live-updates.html"}'
```

### 8. 批量抽取新闻

```bash
curl -X POST "http://127.0.0.1:8010/api/b/articles/extract" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://www.cnbc.com/2025/06/11/stock-market-today-live-updates.html","https://apnews.com/"]}'
```

### 9. 拉 RSS

```bash
curl "http://127.0.0.1:8010/api/b/rss?feed_url=https://feeds.a.dj.com/rss/RSSMarketsMain.xml&limit=5"
```

如果还想顺手抽正文：

```bash
curl "http://127.0.0.1:8010/api/b/rss?feed_url=https://feeds.a.dj.com/rss/RSSMarketsMain.xml&limit=3&extract_articles=true"
```

## 现阶段限制

- Reuters 直接文章页容易 401，不保证抽取成功。
- `news/search` 目前走 Google News RSS 搜索，返回的是候选新闻 URL 列表，更适合“发现链接”；不是全文数据库。
- `news/search` 和 `company-events` 现在都带显式超时；如果外部源失败，会尽量返回 `partial=true` 和 `errors`，而不是整段挂住。
- `company-events` 比旧版召回更广，但现在仍然不是完整专业终端；它只是把公开新闻、垂直媒体、官网/产品页/资讯页尽量统一到一个召回层。
- `company-events` 的 `deep` 模式会主动补高价值 source pool，并优先打赛道垂直源，再补泛财经媒体；由于外站质量参差，这个模式仍可能明显慢于 `fast/news`。
- A 股公司如果 `ticker` 是 6 位数字，`company-events` 会尝试补 `巨潮资讯` 最近公告；这层非常适合工业长尾节点。
- X/Twitter 没有并入这个版本，因为匿名抓取不稳；后续如果你提供账号 / cookies，可以把 `twscrape` 再包一层接口。
- 现在已经加入实验态 `X / Twitter` 接口：
  - `/api/c/x/status`
  - `/api/c/x/search`
  - 当前走本机 Chrome 登录态 + `twscrape` 运行时 patch，适合继续迭代调试。
- AlphaSense / GLG / Tegus / FactSet 目前只作为 `source-catalog` 里的专业研究源目录，不作为匿名全文抓取源。
- B 类目前偏“公开网页 / RSS / 官网页 / 单篇抽取”，还不是完整新闻情报中台。
