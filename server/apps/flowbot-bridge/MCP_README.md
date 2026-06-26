# WeCom Flowbot MCP

这个 MCP 服务把 `wecom-flowbot` 已有的 HTTP 能力封装成标准 MCP tools。

## 运行方式

```bash
node scripts/flowbot_mcp_server.js
```

可选环境变量：

- `FLOWBOT_MCP_BASE_URL`
  默认 `http://127.0.0.1:3010`
- `FLOWBOT_MCP_TIMEOUT_MS`
  默认 `30000`

知识库统一检索依赖的可选环境变量：

- `FLOWBOT_MAXKB_BASE_URL`
  默认 `http://47.104.81.250:8080`
- `FLOWBOT_MAXKB_USERNAME`
  默认 `admin`
- `FLOWBOT_MAXKB_PASSWORD`
  MaxKB 管理账号密码
- `FLOWBOT_MAXKB_WORKSPACE_ID`
  默认 `default`
- `FLOWBOT_MAXKB_KNOWLEDGES`
  可选，逗号分隔的知识库名称或 ID，用于限制检索范围

## 当前暴露的 tools

- `search_messages`
  按群、发送人、关键词、内容、时间范围、消息类型、媒体标记搜索已加工消息
- `search_case_messages`
  按 Case、群、发送人、关键词、内容、时间范围搜索已归档 Case 中的原始消息
- `search_message_context`
  搜索消息并返回命中消息前后文，适合机器人回答“刚才那条前后在说什么”
- `search_memory`
  统一搜索“记忆”，默认同时搜索已加工群消息与已归档 Case 消息
  支持 `source=all|messages|cases`
- `get_message`
  按 `traceId` 获取单条已加工消息
- `list_room_messages`
  读取某个群最近的已加工消息
- `get_room_summary`
  根据房间和过滤条件构建消息摘要
- `get_date_summary`
  构建按天或按周的消息摘要
- `get_history_summary`
  构建按天或按月的历史汇总，支持 `last_month`、`last_30_days`、`YYYY-MM`
- `search_cases`
  搜索已归档 Case
- `find_related_cases`
  按 Case 或问题描述找相关 Case，并返回支撑消息
- `get_case`
  获取单个 Case 详情、进度与工件
- `get_case_timeline`
  获取单个 Case 的原始时间线和活动流
- `search_knowledge`
  统一搜索知识库片段，默认同时搜索本地 `flowbot-knowledge` 与 MaxKB
  支持 `source=all|local|maxkb`
- `send_group_reply`
  通过 `wecom-flowbot` 往群里发消息

## 设计定位

- `wecom-flowbot`
  负责接收、存储、加工、检索、发送
- `MCP`
  负责把这些能力暴露为标准工具接口
- `light agent worker`
  直连模型，自行决定何时调用“消息上下文 / 记忆 / 知识库 / 激活状态”能力，并直接产出最终答案
