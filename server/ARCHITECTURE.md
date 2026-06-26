# 后台架构约定

这个后台是悦拜 AI 工具平台的公共后台。它负责统一入口、模块配置、反向代理、内部 API、采集器控制和部分工作台服务。架构目标是：入口清楚、模块边界稳定、外部系统通过 adapter/client 隔离。

## 启动入口

`server.js` 是 composition root。它可以负责：

- 加载运行时配置。
- 创建 clients、repositories、services、routes。
- 组装 HTTP server。
- 注册顶层路由顺序。

不要把大量 env/path 推导直接写回 `server.js`。这类逻辑属于 `lib/runtime_config.js`。

## 运行时配置

`lib/runtime_config.js` 统一负责：

- 读取 `config/ai-admin.local.json`。
- 读取兼容 env file。
- 合成默认端口、路径、模型、采集器地址、RAGFlow 地址。
- 派生 `REVIEW_STATE_PATH`、`GROUP_INTENT_*_PATH` 等运行路径。

新增配置时优先放到这里，并补一条 `lib/runtime_config.test.js` 覆盖默认值、env 覆盖或派生路径。

## 分层方式

推荐按这些角色命名和组织：

```text
*_routes.js       HTTP route handler，只处理路径、方法、payload、响应
*_service.js      业务流程、外部动作编排
*_clients.js      外部系统或本机 agent 的 adapter/client
*_repo.js         持久化读写
*_store.js        文件或业务对象存储
*_schema.js       数据库 schema/migration 管理
```

典型流向：

```text
request -> route -> service -> client/repo/store -> response
```

Route 层不要直接承载复杂业务规则。Service 层不要直接关心 HTTP response。Repo/store 不要读取 request。

## 外部系统隔离

RAGFlow、Qwen、Flowbot、内容资产服务、微信/抖音采集器都视为外部系统。通过 client/service 包起来，不要在 route 或 `server.js` 中散落调用细节。

适合使用的模式：

- Adapter：包外部 HTTP、本机 agent、三方系统。
- Repository：包 MySQL 或文件存储。
- Factory function：`createXxxService({ deps })` 注入依赖。
- Strategy：文件/MySQL、本地/远端采集、不同模型等可替换行为。

## Route 注册

当前 `server.js` 仍保留显式路由顺序。新增模块时，应优先创建独立 `createXxxRoutes`，再在入口挂载。只有平台级别的通用路由才应直接写在 `server.js`。

路由顺序本身是行为，改动时要注意：

- agent/legacy proxy 类路由通常需要靠前。
- `/api/modules`、`/api/health` 是平台公共 API。
- 静态文件和模块反代应放在最后兜底。

## 测试策略

后台使用 Node 内置 `node:test`。`npm run check` 会执行语法检查和单测。

优先测试：

- route 是否匹配正确路径和方法。
- service 的业务分支。
- repo/store 的读写映射。
- client 对外部响应的解析和错误处理。
- runtime config 的默认值、env 覆盖和派生路径。

避免只测“函数被调用一次”这类低价值测试。更关心输入输出、边界条件和失败路径。

## 暂时不做的事

- 不引入复杂 DI 容器；当前 factory function + 显式依赖注入足够。
- 不为了“目录更漂亮”移动大量文件；只有当模块变大或职责混杂时再拆。
- 不把多语言子项目强行合成一个框架。Node 公共后台、Python 内容资产、Go 采集器可以保持各自生态，通过配置和协议连接。
- 不把运行数据、生成数据和源码混在一起新增依赖；运行态数据继续留在 `data/`、`runtime/` 等目录。
