# 前端架构约定

这个前端是悦拜 AI 工具平台的统一入口。它承载多个内部工具模块，优先保持模块接入清晰、页面逻辑可测试，而不是把所有逻辑堆进 `App.jsx` 或单个 workbench。

## 模块入口

平台模块来自后台 `/api/modules`。`src/App.jsx` 只负责：

- 读取模块清单。
- 渲染侧边栏和平台 shell。
- 通过 `workbenchRegistry` 把内部模块 id 映射到 React workbench。
- 对没有注册为内部 workbench 的模块，使用 iframe 打开 `module.url`。

新增内部模块时，优先在 `workbenchRegistry` 里注册组件和 props 生成函数。不要继续在主 JSX 里追加长条件链。

```jsx
const workbenchRegistry = {
  "content-assets": {
    Component: ContentAssetsWorkbench,
    getProps: ({ frameKey }) => ({ frameKey }),
  },
};
```

## Workbench 拆分

复杂 workbench 按职责拆开。推荐结构：

```text
FeatureWorkbench.jsx          组装层，只连接 hook 和 view
FeatureWorkbenchView.jsx      展示层，只接收 props 和事件
useFeatureWorkbench.js        状态、请求、轮询、localStorage、副作用
featureRules.js               纯规则、分类、计算逻辑
featureParser.js              解析、格式化、训练/提交 payload 构造
```

`GroupIntentWorkbench` 是当前示例：

```text
GroupIntentWorkbench.jsx
GroupIntentWorkbenchView.jsx
useGroupIntentWorkbench.js
groupIntentRules.js
groupIntentParser.js
```

规则和解析函数应尽量保持纯函数，方便用 Vitest 锁住行为。

## API 调用

统一通过 `src/lib/apiClient.js` 的 `requestJson` 调后台接口。除非必须处理流式响应或浏览器兼容分支，不要在组件里直接散落 `fetch`。

流式接口可以保留在 hook 中，例如群聊意图样本生成的 SSE 读取逻辑。

## 状态与副作用

- UI 展示状态放在 view props 中传递。
- 网络请求、轮询、草稿持久化放在 hook。
- 纯计算不要依赖 React，不要读取 DOM 或 localStorage。
- 输入草稿这类浏览器状态可以由 hook 管理。

## 测试

前端使用 Vitest。`npm run check` 会执行：

```bash
vite build && vitest run
```

优先给这些代码补测试：

- 纯规则函数。
- parser/formatter。
- payload 构造。
- 有业务判断的工具函数。

不急着给所有 UI 组件补渲染测试。先把最容易回归出错、又不依赖浏览器环境的逻辑测稳。

## 不建议的做法

- 不要把一个 workbench 写成包含规则、请求、状态和 UI 的大组件。
- 不要在 `App.jsx` 中继续追加模块渲染条件链。
- 不要为了复用而过早抽通用组件；先让模块边界清楚，再看重复是否真实存在。
- 不要把后台接口返回结构在多个组件里各自手工修正；需要适配时放进 hook 或 parser。
