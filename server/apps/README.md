# Managed Apps

这个目录放“悦拜AI工具平台”的可托管子项目。

约定：

- 子项目可以是 Node、Go、Python、Java 等任意语言。
- 子项目可以单独运行，也可以由总平台部署脚本一起发布。
- 子项目运行数据不要放在 `apps/`，统一放到 `data/` 或生产环境的 `/opt/yuebai-ai-platform/data/`。
- 子项目对外页面/API 优先通过总后台做同源入口，例如 `/flowbot/*`。

当前模块：

- `flowbot-bridge`：群机器人后台主服务。
- `flowbot-agent-skills`：群机器人归档技能。
- `flowbot-knowledge`：群机器人内置知识。

`flowbot-bridge` 的 runtime 存储默认走文件，设置 `FLOWBOT_STORAGE_BACKEND=mysql` 后走 MySQL，便于本地代码和线上 Flowbot 架构保持一致。
