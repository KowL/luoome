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

完成构建后，从仓库根目录启动独立验证服务：

```sh
bun --no-env-file apps/web/src/dsh/integration-fixture.ts
```

打开 `http://127.0.0.1:5187/fixture-login`。服务使用临时 SQLite、真实托管认证与费用账本、
真实 Node/DSH/Cordis，以及受控模型流、行情和网页响应；不会调用真实供应商。退出进程会清理临时数据。
可依次输入“查 002594 行情并读取网页来源”“创建一个观察清单草案”，检查工具结果与确认卡；
“慢速查 002594 行情”用于停止测试，“失败查 002594 行情”用于供应商失败测试。

托管开发入口的装配开关由 [config.ts](../../apps/web/src/dsh/config.ts) 校验：

| 配置 | 要求 |
|---|---|
| `LUOOME_CHAT_RUNTIME=dsh` | 显式启用；默认仍为 `ai-sdk` |
| `HOSTED_ENVIRONMENT=development`、`LUOOME_DSH_DEVELOPMENT=true` | 两项同时满足；生产环境拒绝启动 DSH Chat |
| `LUOOME_DSH_NODE_PATH` | Node 可执行文件的绝对路径，不能使用 Bun |
| `LUOOME_DSH_HOST_ENTRY` | 可选，Host 构建产物的绝对路径；默认使用仓库内产物 |
| `LUOOME_DSH_ALLOW_WEB_FIXTURES=true`、`LUOOME_DSH_WEB_FIXTURES_FILE` | 可选且必须成对配置；文件为绝对路径、URL 到 HTML 字符串的 JSON 映射 |

当前 Web 原生网页能力仅开放显式 fixture。每轮使用已保存的完整可信历史重建临时 DSH Session，
超过历史上限会明确拒绝，不静默截断。停止后可以用“核对会话状态”读取已保存结果；
断线不会自动重跑，也未实现跨进程重启后的执行恢复。详细状态见[开发任务](../../docs/dsh-plugin-platform-development-plan.md)。

## Host 控制

用明确的 Node 绝对路径启动 `apps/agent-runtime/dist/index.js`，通过进程环境
`LUOOME_DSH_HOST_CONFIG` 注入 JSON 配置。配置含 configRef、认证工具 Gateway、认证模型代理、
可选原生网页授权/出口以及资源上限；完整 schema 位于
[runtime-config.ts](../../packages/dsh-bridge/src/runtime-config.ts)。不要把真实供应商 key 交给 Host。

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
