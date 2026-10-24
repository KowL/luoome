# DSH 开发运行底座

本目录固定首批 Node Host、原生 Cordis 业务代理与官方网页插件的开发组合。
依赖版本和完整性见 [artifacts.json](./artifacts.json)，完整解析图由 [bun.lock](../../bun.lock) 固定。
DSH `0.2.1-rc.2`、Cordis `4.0.5` 的安装产物已经在 Node `22.22.3` 加载验证。
未修改或 fork 上游，不使用 MCP。

## 构建与验证

从仓库根目录执行：

```sh
bun --no-env-file run build:dsh
bun --no-env-file run test:dsh
```

构建生成 `apps/agent-runtime/dist/index.js` 与 `packages/dsh-bridge/dist/plugin.js`；
两个产物面向 Node，纯协议与 Zod 打入构建，DSH 原生包保持外部依赖。
必须在已安装本仓库依赖的目录运行。普通 workspace build 也会生成这两个 Node 产物。

协议消费使用 `@luoome/dsh-bridge/protocol`；启动配置使用纯
`@luoome/dsh-bridge/runtime-config` 的 `HostConfigSchema`。两个入口都不加载 SDK、Cordis 或 Bun DB。
官方网页声明直接使用 `WEB_FETCH_MANIFEST_ENTRY`，避免猜测已发布插件的 inputSchema。

## Web 受控验证

托管形态的独立验证服务（`apps/web/src/dsh/integration-fixture.ts`）随托管层一起下线：
它依赖真实托管认证与费用账本，单机形态没有对应设施。

Web 侧的 DSH Chat 运行时（`apps/web/src/dsh/`）随模型对话一起下线：单机形态不再有请求级
Chat 入口，DSH 侧能力经 MCP 实例与只读面板接入。

当前 Web 原生网页能力仅开放显式 fixture。详细状态见[开发任务](../../docs/archive/dsh-plugin-platform-development-plan.md)。

## Host 控制

请求级 Host 运行时（`apps/agent-runtime/`）随托管形态下线，当前只保留 DSH 侧 MCP 实例与只读面板接入。
不要把真实供应商 key 交给 DSH 侧插件。

Host 的 stdin 接收版本化 NDJSON `run/cancel/shutdown` 命令，stdout 只输出
`ready/binding/event/error/closed` 协议帧。一次只接受一个活动 run；busy、过期、配置错误、重复 run ID
均拒绝。Host 生命周期最多接受 128 个 run；应用须限制同时启动的 Host 数。
Host 可以顺序复用，每轮保守地建立新的 DSH Session 和 run 绑定；历史接续由可信 Bun 层构建。

工具代理向固定 loopback Gateway POST `ToolCall`，保留其 `ToolReply.ok/output`、草案标记和业务错误。
跨进程 callId 由插件按 DSH registry 的执行 token 分配，Gateway、原生授权与 UI 事件使用同一身份；
模型提供的调用 ID 只留在 DSH 内部，重复的模型 ID 不会合并不同执行或混用回执。
模型适配器只向固定 loopback Chat Completions SSE 代理发送请求，使用独立凭证和 run 绑定。
该代理须复用现有费用账本，先准入再发送，流结束后处理供应商 usage/unknown；Host 的调用上限不是账本。
所有内部 HTTP 请求禁止重定向。控制凭证不放入模型参数或 prompt。

原生能力只允许官方 `web_fetch`。每次调用都重新向独立授权端点 POST `ToolCall`，要求
`{allowed:true}`、清单声明、来源、固定工具实例与 URL origin 均匹配。官方 HTTP provider 保留
DNS/连接 IP 校验、内容/大小/超时限制，当前组合不跟随重定向。
受控测试显式选择 fixtures provider；官方 tool-web 仍负责 canonical output 与 HTML 渲染，
HTTP provider 仍真实加载。fixture 不是网络失败的 fallback。

## 生命周期与证据

每轮使用私有临时 DSH_HOME、工作目录和 Profile，子进程环境不继承个人 home、.env、模型 key 或代理变量。
桥接插件构建产物在 run 启动时复制进私有 Profile，其内容 SHA256 纳入 profileHash，避免共享构建覆盖在途绑定。
启动先检查真实 dump-config 的完整插件名清单，再在 `agent/created` 检查实际工具库存、schema 和作用域。
Profile 不加载 Shell、通用文件写工具、动态插件管理、MCP、子 Agent、session-log 上传或额外模型调用插件。
原生 `tools.guard` 是最终拒绝边界；通用工具的超时信号传给官方 provider。

文本事件来自真实 `agent/assistant-stream`；durable `session/event` 使用同一 attempt/message 身份校正。
仅转发可见文本，不转发隐藏推理。事件有来源序号、认证、大小/数量/排队上限。

停止关闭该 Host 独占的 DSH；SDK close 完成并确认进程退出后才发送 `runtimeStopped:true`。
停止无法证明时标 unresolved，保留私有目录并拒绝继续运行。正常结束、停止和失败均先完成 SDK 关闭，
再关闭事件监听并清理目录。异常退出不自动重跑模型、工具或另一 Runtime。
Host 的停止事实不证明 Bun closure 或供应商请求已排空；调用方仍须完成 Gateway drain、费用收尾、
消息保存与租约释放。

测试分为纯 JSON 契约与真实 Node/DSH 子进程两类；后者使用本地模型/Gateway 和合成网页。
真实供应商、生产 OS/网络隔离、多租户容量、持久恢复及浏览器产品链路不由这些测试证明。
Cordis scope 和私有目录不构成恶意插件沙箱；本组合只接纳固定、受信的部署代码，生产路径仍未开放。
