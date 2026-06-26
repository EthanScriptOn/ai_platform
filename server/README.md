# 悦拜AI工具平台后台

这是悦拜 AI 工具平台的总后台工程。目标是支持多语言、多项目的统一接入：

- 可以单独部署某个子项目。
- 也可以由总平台共同部署多个子项目。
- 总平台提供统一入口、统一反代、统一配置和部署脚本。

## 当前结构

```text
server.js                         公共后台入口
config/platform.json              前端模块和路由配置
config/modules.json               可托管子项目清单
apps/flowbot-bridge               群机器人后台主服务
apps/flowbot-agent-skills         群机器人技能
apps/flowbot-knowledge            群机器人内置知识
apps/content-assets-console       内容资产本地控制台和 Python 服务
apps/intel-api-service            AI 搜索 / 情报检索 Python 服务
apps/content-assets-shared        内容资产共享下载内核
apps/knowledge-governance         文档治理流水线
collector                         Go 写的本机视频号采集后台包
data                              本地运行数据占位
deploy                            systemd/nginx/env 模板
scripts                           本地开发和部署脚本
```

## 公共后台职责

- 模块注册和 `/api/modules`
- 统一反向代理，例如 `/flowbot/*`
- 知识候选审核 API
- AI 搜索方向生成与文章整合 API
- 微信视频号采集后台包控制
- 内容资产服务反代，例如 `/content-assets-service/*`
- Linux 部署脚本和 systemd 模板

## 本地启动公共后台

```bash
npm install
npm start
```

默认端口：

```text
http://127.0.0.1:8788
```

默认会读取兄弟目录前端构建产物：

```text
../yuebai-ai-tool-platform-web/dist
```

如果要改前端 dist 路径：

```bash
FRONTEND_DIST=/path/to/dist npm start
```

## 环境配置

所有机器相关配置都应通过配置文件注入，不要直接改代码里的绝对路径。

本地默认读取：

```text
config/ai-admin.local.json
config/flowbot.local.json
config/content-assets.local.json
```

部署环境默认读取：

```text
shared/ai-admin.json
shared/flowbot.json
shared/content-assets.json
```

旧的 `.env` / `*.local.env` 只作为兼容兜底，主流程不再依赖它们。

LaunchAgent 请用脚本按当前环境生成，不要直接复制仓库里的 plist 模板：

```bash
bash scripts/install-ai-admin-launchagent.sh
```

这个脚本会根据你当前机器的项目目录、`node` 路径、以及本地 env 配置生成并加载：

```text
com.yuebai.ai-admin-platform
com.yuebai.flowbot
com.yuebai.flowbot-worker
com.yuebai.content-assets-console
```

## 本地共同启动

同时启动公共后台、Flowbot 主服务、Flowbot worker：

```bash
npm run dev:all
```

单独启动 Flowbot：

```bash
npm run dev:flowbot
npm run dev:flowbot-worker
npm run dev:content-assets
```

## 模块说明

“群机器人后台”现在已经是 managed module：

```text
apps/flowbot-bridge
```

浏览器访问：

```text
/flowbot/dashboard?roomId=154085252767863
```

公共后台会转到本机托管的 Flowbot：

```text
http://127.0.0.1:3010/flowbot/*
```

如果生产环境需要单独部署 Flowbot，只需把 `FLOWBOT_BASE_URL` 改成独立服务地址即可。

Flowbot runtime 存储支持两种模式：

```text
FLOWBOT_STORAGE_BACKEND=file   # 本地默认，读写 data/customer-bot-data
FLOWBOT_STORAGE_BACKEND=mysql  # 生产兼容，读写 MySQL runtime 表
```

MySQL 模式需要配置 `FLOWBOT_MYSQL_HOST`、`FLOWBOT_MYSQL_PORT`、`FLOWBOT_MYSQL_DATABASE`、`FLOWBOT_MYSQL_USER`、`FLOWBOT_MYSQL_PASSWORD`。从文件数据迁移到 MySQL 可执行：

```bash
FLOWBOT_STORAGE_BACKEND=mysql node apps/flowbot-bridge/scripts/import_runtime_data_to_mysql.js data/customer-bot-data
```

如果本地 MySQL 跑在 Docker 容器里，可把 `FLOWBOT_MYSQL_BIN` 指到：

```text
scripts/mysql-via-docker.sh
```

“内容资产工作台”后台现在也是 managed module：

```text
apps/content-assets-console
```

本地启动：

```bash
npm run dev:content-assets
```

该命令会启动当前实际使用的 `content-assets-console` 服务；也可以直接用：

```bash
bash scripts/dev-content-assets-console.sh
```

内容资产 Python 测试可从根目录统一触发；运行前请先在对应 Python 环境安装
`apps/content-assets-console/pyproject.toml` 的 `dev` 依赖：

```bash
npm run test:python
```

公共后台访问：

```text
/content-assets-service/docs
/content-assets-service/api/v1/health
```

生产环境如果单独部署内容资产服务，只需把 `CONTENT_ASSET_BASE_URL` 改成独立服务地址。

“知识候选审核”由公共后台直接提供 API，治理脚本在：

```text
apps/knowledge-governance
```

默认审核数据目录：

```text
data/knowledge-governance/review-runs/current
```

RAGFlow 是大型三方知识库服务，当前作为 external service 纳入统一模块清单和部署配置，由 `RAGFLOW_BASE_URL`、`RAGFLOW_CHAT_URL` 控制入口。
