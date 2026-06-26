# WeCom Flowbot 轻量 Agent 部署说明

这套架构现在不再依赖 OpenClaw。

当前运行链路：

- `server.js`
  负责企微回调接收、消息落库、过滤、任务入队、消息检索、知识检索、回复发送、dashboard
- `scripts/agent_task_worker.js`
  负责 claim 待处理任务，直连模型，按需调用轻量工具，再把最终回复回写给 `server.js`
- `scripts/light_agent_runtime.js`
  负责 prompt、tool loop、回复决策

## 目录建议

推荐部署目录：

```bash
/opt/wecom-flowbot/flowbot-bridge
```

需要一并带上的目录：

- `flowbot-bridge/`
- `flowbot-agent-skills/`
- `flowbot-knowledge/`
- `customer-bot-data/`

如果是全新部署，`customer-bot-data/` 可以为空目录，由服务自行写入。

## 运行环境

- Node.js 18 及以上
- 可访问上游企微回调源
- 可访问你的模型兼容接口
- 如启用知识检索增强，可访问 MaxKB
- 如启用语音转写，需要本机有可用 Python 环境

## 关键环境变量

### server.js

常用最小配置：

```bash
PORT=3010
FLOWBOT_DATA_DIR=/opt/wecom-flowbot/customer-bot-data
FLOWBOT_LLM_API_URL=https://your-proxy.example.com/v1
FLOWBOT_LLM_API_KEY=your-key
FLOWBOT_LLM_MODEL=your-tool-capable-model
FLOWBOT_AGENT_ID=flowbot
FLOWBOT_AGENT_WAKE_NAMES=小智
FLOWBOT_TARGET_ROOM_IDS=
FLOWBOT_FEISHU_TARGET_CHAT_IDS=
FLOWBOT_ARCHIVE_PYTHON=/usr/bin/python3.11
FLOWBOT_UPSTREAM_WECOM_API_BASE=http://upstream-host:23789
FLOWBOT_DASHBOARD_PUBLIC_URL=http://47.104.81.250
FLOWBOT_DEFAULT_NOTIFY_URL=http://47.104.81.250/flowbot/callback
FEISHU_VERIFICATION_TOKEN=your-feishu-verification-token
```

常见可选项：

- `FLOWBOT_AGENT_LANE_ENABLED`
  默认 `1`
- `FLOWBOT_AGENT_SESSION_KEY_STRATEGY`
  默认 `wake`
- `FLOWBOT_MAXKB_BASE_URL`
- `FLOWBOT_MAXKB_USERNAME`
- `FLOWBOT_MAXKB_PASSWORD`
- `FLOWBOT_TRANSCRIBE_ENABLED`
- `FLOWBOT_TRANSCRIBE_PYTHON`

### agent worker

对应 systemd 模板见：

- [wecom-flowbot-agent-worker.service](/Users/yuebuy/Documents/New%20project/flowbot-bridge/scripts/wecom-flowbot-agent-worker.service)

关键变量：

```bash
FLOWBOT_AGENT_BASE_URL=http://127.0.0.1:3010/flowbot/agent
FLOWBOT_LLM_API_URL=https://your-proxy.example.com/v1
FLOWBOT_LLM_API_KEY=your-key
FLOWBOT_LLM_MODEL=your-tool-capable-model
FLOWBOT_LLM_TIMEOUT_MS=45000
FLOWBOT_AGENT_NAME=小智
FLOWBOT_AGENT_ID=flowbot
FLOWBOT_AGENT_TOOL_MAX_STEPS=4
FLOWBOT_AGENT_HANDLER=wecom-flowbot-agent-worker
FLOWBOT_AGENT_POLL_INTERVAL_MS=1000
FLOWBOT_AGENT_MAX_CONCURRENCY=4
```

说明：

- 模型必须支持 OpenAI 兼容 `chat/completions` + tool calling
- `FLOWBOT_AGENT_TOOL_MAX_STEPS` 建议先保持 `4`
- `FLOWBOT_AGENT_MAX_CONCURRENCY` 建议从 `2` 或 `4` 起步

## 启动方式

### 1. 启动主服务

```bash
cd /opt/wecom-flowbot/flowbot-bridge
node server.js
```

生产环境建议自己配一个 `wecom-flowbot.service`，指向：

```bash
/usr/bin/node /opt/wecom-flowbot/flowbot-bridge/server.js
```

也可以直接使用模板：

- [wecom-flowbot.service](/Users/yuebuy/Documents/New%20project/flowbot-bridge/scripts/wecom-flowbot.service)

### 2. 启动 agent worker

复制模板：

```bash
cp /opt/wecom-flowbot/flowbot-bridge/scripts/wecom-flowbot.service /etc/systemd/system/
cp /opt/wecom-flowbot/flowbot-bridge/scripts/wecom-flowbot-agent-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wecom-flowbot.service
systemctl enable --now wecom-flowbot-agent-worker.service
```

查看状态：

```bash
systemctl status wecom-flowbot-agent-worker.service
journalctl -u wecom-flowbot-agent-worker.service -f
```

## 飞书直推配置

`server.js` 已支持飞书服务器回调入口：

```text
POST /feishu/callback
POST /flowbot/feishu/callback
```

在飞书开放平台配置：

```text
事件与回调 -> 订阅方式 -> 将事件发送至开发者服务器
请求地址: http://47.104.81.250/feishu/callback
事件: im.message.receive_v1
Encrypt Key: 先不要开启
```

服务器环境变量建议设置：

```bash
FLOWBOT_DASHBOARD_PUBLIC_URL=http://47.104.81.250
FLOWBOT_FEISHU_TARGET_CHAT_IDS=飞书 chat_id，多个用逗号分隔，留空表示飞书全部群放行
FEISHU_VERIFICATION_TOKEN=飞书后台的 Verification Token
```

## 升级步骤

推荐顺序：

1. 停止 `wecom-flowbot-agent-worker.service`
2. 更新 `flowbot-bridge/` 与 `flowbot-agent-skills/`
3. 如有配置变更，更新环境变量或 service 文件
4. 启动 `server.js`
5. 启动 `wecom-flowbot-agent-worker.service`
6. 用 dashboard 做一轮验收

## 验收清单

至少检查这些：

1. dashboard 可打开
2. 群消息能正常进回调
3. 明确 `@小智` 或带 `小智` 的消息能入 agent 任务
4. worker 能 claim task
5. 纯文本问题可直接回复
6. 需要查知识的问题能调用 `search_knowledge`
7. `清理状态 / 清除会话 / 清除记忆 / 清除归档` 四个按钮可用

## 旧组件处理

这套架构已经不需要：

- OpenClaw gateway
- OpenClaw session/transcript
- 任何依赖 OpenClaw 的 systemd 服务

迁移完成后，建议：

1. 停掉旧 OpenClaw 相关服务
2. 从开机启动中移除
3. 保留旧目录一段时间做观察
4. 确认无回滚需求后再删除

## 当前已知边界

- 新 worker 是无长会话主导的轻编排方案，不依赖 OpenClaw 的 session transcript
- 代码仍保留 `AGENT_SESSION_KEY_STRATEGY`，主要是为了 room 级或 sender 级任务归类、dashboard 展示和状态一致性
- 如果模型本身 tool calling 不稳定，回复质量会受影响，优先换支持函数调用更稳的模型，而不是继续加重本地规则
