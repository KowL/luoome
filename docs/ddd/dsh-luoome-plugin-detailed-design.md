# dsh-luoome 纯插件详细设计

> 2026-10-24；基线：`dsh@24e7ee1` 与当前工作树。状态：设计完成，P1a 开发中，尚不可切换生产。
> 产品范围来自本地评审计划 `.tmp/dsh-luoome-audit/plan.md`。该文件被 Git 忽略，本文完整保存实施契约，不要求读者访问临时目录。
> 本文描述独立 DSH 插件的下一阶段；现有 MCP、Bun Web 与消费者仍保留。旧托管系统、内嵌 Host、本地模型栈不恢复。

## 1. 目标与当前边界

最终业务执行进入 DSH Node 进程，面板不再逐请求启动 Bun CLI；工作台保留首页、持仓、复盘、策略、设置五页。后台工作随所属 DSH 进程退出而停止，切换页面、窗口隐藏和 SSE 断开不影响已启用的盯盘。

已存在的资产包括三个 DSH 只读面板、独立 profile、四个 MCP 实例、分析事实包/队列、决策回执、批处理工具与业务租约。Node SQLite 目前只有 spike；已有只读/操作内核、持久确认、无模型预检与 Web 宿主装配。隔离 profile 已接官方认证、SessionController 和审批组件，正式 Node 数据装配尚未完成。实现必须复用这些资产，而不是另造分析任务状态机。

| 现有入口 | 目标 | 退役前要求 |
|---|---|---|
| read/settings/batch MCP | 插件工具包装与执行边界 | 按工具名、能力、输出逐项对账 |
| worker MCP | 同包 worker profile | 固定租约、原子写回及无模型预检验证 |
| 面板 GET → Bun CLI | 宿主认证路由 → 进程内 tools | 无子进程、输出一致、权限负例 |
| Bun Web | React slots 与专用人工入口 | 所有保留操作有替代入口 |
| CLI/Bun 预检 | DSH 无模型预检生命周期 | 空队列/错误均零模型请求，否则阻止切换 |

模型推理由 DSH 承担；core/tools/workflows/db/adapters 不依赖模型 SDK。`Advice ≠ trade`，不存在自动下单路径。`add_trade` 当前是人工记账 write；`record_decision_trade` 是 trade，只能保留专用人工入口，不能因迁移改变分类。

## 2. 模块与依赖

```text
DSH tools / HTTP / schedule / worker identity
                     ↓
dsh-luoome host: exposure → authority → operation receipt
                     ↓
           tools / batch surface → workflows → tools
                     ↓
              db / adapters → core
```

- `packages/dsh-luoome`：发布名 `dsh-luoome`，初期 private。host 内保存配置、调用包装、HTTP、调度关联与线程生命周期；client 内保存 slots 和视图。
- `packages/tools/src/exposure.ts`：共享名字/能力/私人研究选择策略；MCP 保留环境变量解析，插件使用显式配置。禁止插件依赖 MCP surface 以复用权限代码。
- `packages/core`：新增持久授权/操作的不变量与 repository 接口时集中定义，零 IO。
- `packages/db`：实现持久操作/授权的 memory 与 drizzle 合约；Node 与 Bun 共用 schema/repos/DDL。
- 五个 batch 是 surface 编排，不移入 tools 形成 tools → workflows 循环。P3 搬迁到插件，旧新调度不能并行写同一周期。
- P1a 通过注入 ToolContext 装配 host；服务测试使用临时 SQLite，完整 Web profile 使用合成 memory 业务事实及真实 DSH JSON/JSONL 存储。验收 profile 仅在临时 DSH_HOME 创建，生产 Node 数据装配与分发仍由 P1b/P5 完成。

## 3. 配置、发现与身份

### 3.1 暴露面

配置由受信任部署代码解析，不接受 HTTP、模型参数或 skill 提升权限。每个 surface 有独立 allowlist、denylist、capabilities 和身份。

| surface | 能力上限 | 授权方式 |
|---|---|---|
| read | read，私人研究默认关闭 | 宿主认证及精确白名单 |
| settings | 显式 write；按工具额外 external | 交互逐次确认 |
| batch | write + external | 交互确认或绑定任务的持久授权 |
| worker | read + 独立 queue opt-in | 消费者身份、账户范围、任务 kind、有效 claim token |

准入公式：名字在 allowlist 且不在 denylist，所有 requiredCapabilities 已开启，且 sideEffect/requiredCapabilities 均不含 trade。缺少 allowlist 是配置错误，显式空数组开放零工具。私人研究通过共享拒绝清单控制，allowlist 不覆盖研究 opt-in。

`LUOOME_EXPOSE_TRADE=true` 在装配任何 IO 前失败。原环境变量不得扩大插件配置。注册与执行共用同一快照；dispose 后旧闭包拒绝调用。不能只限制 discovery 而允许直接按名字执行。

初始只读内核即使 allowlist 包含 write/external/queue/trade，也不得注册或执行它们。写授权尚未接好时直接返回 permission_denied，不把 `approved:true` 当作确认。

### 3.2 调用身份

身份由入口适配器生成，含 userId、accountId、来源、profile/surface 与授权版本。DSH agent/session/task 关联从宿主执行对象读取；HTTP 使用宿主认证上下文。账户不承担登录语义。

子 Agent 不继承父级权限；除 `restrict` 可见性掩码外还需硬拒绝 guard 与实际执行检查。shell、网络、文件和动态插件能力必须在部署 scope 单独收口，工具策略不是 OS 沙箱。

## 4. 调用协议

### 4.1 DSH canonical value

输入沿用 tools 的完整 Zod → JSON Schema（input 模式）。仅序列化移除不可枚举的 `~standard` 方法，保留 `$schema`、`$defs`、范围、字典等全部 JSON 字段，直接交给 DSH 原生 `ToolRuntime.register()`；执行仍调用原工具 `execute`，由原 Zod 校验长度、范围、strict、refinement、default 和 transform。

此前把 SDK 的 `assertObjectJsonSchema` 用于工具输入，错误地将输出/定义 DSL 的有限子集当成原生注册要求。本轮已移除该误用，没有删除或降级领域约束。全量选中读工具的输入 schema 逐项与 MCP JSON 比较通过，真实调用覆盖约束拒绝、默认值、日期转换及跨字段 refinement。PTC 的 SDK 类型生成可能将复杂输入显示为 `unknown`/`Any`，这只是上游的提示类型投影；真实 Node PTC 子调用仍走同一执行/审批管线，不能绕过领域校验。

输出保留 `ToolResult`，以一次 JSON 序列化将 Date 转 ISO string，与现有 MCP 口径对齐。成功携带 data，业务失败携带 error；render 只投影 JSON，不改变 canonical value，也不把业务失败写成成功事实。输出 schema 使用宿主支持的 oneOf 来描述两个分支。

DSH 传输错误/取消与领域业务错误分别呈现。原生模式与 PTC 都必须经过执行边界；模型自报 callId 不能作为业务幂等键。

### 4.2 HTTP

`mountDshWebProfile` 在现有 WebServer 上注册 `/api/luoome` 前缀，每次请求先调用真实 `Connection.admit` 校验浏览器 cookie、Host/Origin，并只允许 owner Peer；没有 Connection/WebServer/SessionController/ApprovalService 时拒绝装配。当前单机 owner 由受信任装配绑定业务账户，HTTP 不接受身份或账户提升。POST 还必须提供匹配监听器协议及已准入 Host 的 Origin，不信任 X-Forwarded-*。所有响应 no-store，错误不返回路径、凭据或原始异常。

固定 SDK 的 Fetch bridge 会把 URL 改成 `http://dsh.internal`，且 streaming GET 会构造非法请求。因此使用官方 WebServer 原生路由及 Connection 准入，不复制认证。POST 流式读取最多 64 KiB；超限或提前拒绝时先完成响应，再关闭未读入站流，避免取消请求流把 413 响应套接字一起销毁。GET 不构造请求体。当前验收覆盖 loopback HTTP 直连；TLS/跨协议反代仍需目标环境验收，不从转发头猜测 origin。

| 路由 | 输入/输出 | 限制 |
|---|---|---|
| POST `/api/luoome/call` | `{tool,input}` → ToolResult | 只读；strict envelope，不能附加 surface/approved；JSON body ≤64 KiB |
| POST `/api/luoome/operations/prepare` | `{id,tool,input}` → 冻结输入、operationId、确认凭据 | 已接真实 Web 路由；UUID、显式操作策略、账户绑定 |
| POST `/api/luoome/operations/:id/confirm` | `{token}` | 不接受替换输入/身份；CAS 认领 |
| POST `/api/luoome/operations/:id/cancel` | `{token}` | 仅取消未认领操作 |
| POST `/api/luoome/operations/:id/reconcile` | `{}` | 只核对已有业务回执，不重新执行业务 |
| GET `/api/luoome/operations/:id` | 公开状态与业务结果引用 | 身份与账户必须匹配，URL 解码后仍只接受原允许的 ID 字符集 |
| GET `/api/luoome/profile` | 当前账户、操作策略及调度启用状态 | owner 只读元数据，不返回凭据 |
| GET `/api/luoome/state` | 工作台状态 | 不存授权到 localStorage |
| GET `/api/luoome/stream` | 游标 + SSE 事件 | 认证、去重、重连补取、受控缓冲 |

HTTP 始终保留 ToolResult；认证/能力拒绝 403、方法错误 405、媒体类型错误 415、超大输入 413、格式错误 400。操作服务不可用返回 503，未知路由 404；已持久化的操作状态及其业务结果返回 200，客户端须读取 state 和嵌套结果。默认 no-store。取消后不启动 handler；已启动请求不以 Promise.race 假装业务已经停止。

## 5. 确认、持久授权与原子回执

### 5.1 Operation（已实现内核与双仓储）

`PluginAuthorityRepository` 接入 `RepositoryRegistry`；memory/drizzle 复用 contract tests。物理表 `plugin_operations` 为 `id` 主键、`user_id`、`account_id`、`state`、`claim_token`、`updated_at` 与 `record_json`，另建 `(state, updated_at)` 索引。JSON 保存 tool、绑定后的 inputJson/inputHash、policyVersion、所需能力、授权类型、过期时间与业务结果；时间为 epoch 毫秒。schema 与 `ensureSchema` DDL 同步，重复启动不改写既有事实。

人工 prepare 绑定账户与 UUID 请求 ID，冻结排序后的 JSON 入参；原工具 Zod 仍在准备和执行时校验，保留其转换语义。凭据由服务端随机生成，只有 hash 持久化；首次 prepare 才返回原文，重复 prepare 不旋转凭据。同键异参拒绝，丢失首次凭据时不猜测或自动确认。当前人工业务策略只接 `save_decision_review`，其 requestId 绑定 operationId；新增账户、add_trade 等尚不开放。

```text
pending ─confirm + CAS→ executing ─业务成功 + 保存操作回执→ succeeded
   └─cancel/reject→ cancelled         └─失败/结果不明→ unknown
executing / unknown ─核对匹配的业务回执→ succeeded
```

过期或授权版本失效后拒绝新认领；过期 pending 可读但不自动变成成功/失败。`failed` 保留在模型中，本轮不推测副作用已撤销。Drizzle 通过 IMMEDIATE 事务读取权限并 CAS 认领，claimToken 对结果写入 fencing；并发调用只有一条执行，其他调用读取状态。业务事务和操作回执不是同一事务，不声称通用 exactly-once。

成功后响应丢失可查询持久结果；若进程在业务提交后、操作回执保存前退出，复用决策复盘的事务 receipt 核对 requestHash，再恢复 succeeded。该 hash 从原工具中提取共享，没有复制两份计算规则。没有匹配业务回执时保留 unknown，绝不再次调用 handler。已有 external 结果不明同样不自动重发。

### 5.2 AutomationGrant（已实现，执行默认关闭）

物理表 `plugin_automation_grants` 保存 id、用户/profile/session/task、version 与 record_json；唯一约束为 `(user_id, profile, session_id, task_id)`。JSON 中保存 enabled、policyVersion、scheduleHash、精确 allowedCalls、createdAt/updatedAt/expiresAt。每条 allowedCall 包含 tool、accountId、可供预览的完整 inputJson、inputHash 和组合能力，不使用任意输入通配符。

`configure_plugin_automation` 是操作服务内部策略，不进入领域 registry。启用/更新授权也先 prepare，再经人工确认执行 expectedVersion CAS。没有宿主 validateGrant 回调时拒绝启用；真实接线核对宿主任务、会话/账户归属和任务定义指纹。停用不要求任务仍存在，过期/已删除任务的授权仍可撤销。撤销与 claim 在同一个权限库中裁决，已认领业务允许收尾并记录真实结果。

`force:true` 在授权预览及执行时拒绝。当前不启用 queue/trade，也不把普通 settings 或消费者权限扩大。业务操作 ID 由可信 identity + scheduledAt + tool + account 构成；相同提醒重复调用/重新投递复用同一个 key，新的计划发生时间才产生新的操作。

### 5.3 真实 DSH 调度身份

`dsh-identity.ts` 适配已安装的 `@deepseek-ai/dsh-schedule@0.2.1-rc.2`：

1. 检查执行对象的 Agent 是 registry 中同一活实例、session 一致、delegationDepth 为零；用户/profile 与账户归属由受信任装配提供。
2. 只读取当前未结束、非 fork 继承的 turn 中已进入模型的 `user/message`；要求输入源均为 schedule。普通用户后续 turn、混入用户消息及历史提醒均不能获得自动权限。
3. 通过持久 grant 选择任务，再将这些消息 ID 与 `schedule.history` 的真实投递回执关联；不用 prompt 文本、模型参数中的 taskId 或 callId 作证据。合并提醒中多个任务共享消息 ID，仍按各自 task/receipt 核对。
4. `scheduleHash` 绑定任务 id/kind/title/prompt/时间规则；重复任务排除会自动推进的 next scheduledAt，单次任务保留 scheduledAt。编辑任务定义后必须重新确认授权。
5. 发生时间取回执的 scheduledAt，并须在授权有效窗口内；回执须已持久化、投递不晚于当前时间且至多十分钟前。历史查询有界，缺失、被裁剪或不唯一均拒绝。

DSH 会先 followup 唤醒 Agent，再 flush 会话并持久化投递回执；适配器订阅真实 `schedule/changed`，最多等两秒完成关联。等待中没有副作用；取消、超时或卸载均拒绝。真正执行前再次核验宿主元数据，操作认领事务再检查最新 grant 版本、启停、账户、输入摘要与组合能力。

### 5.4 真实 DSH 审批与执行

`createDshOperationHost` 注册 `luoome_confirmed_operation` 与 `luoome_scheduled_operation`，这两个是宿主包装入口，不是新增领域 registry 工具。前者接收 `{id,tool,input}`，后者只接 `{grantId,grantVersion,tool,accountId,input}`，拒绝客户端携带任务身份或发生标识。

人工入口在 `tools/pre-execute` 中准备持久操作，直接调用真实 `ApprovalService.request`，保留 asked/decided 会话审计及精确 callId 关联。审批理由包含服务器冻结后的账户、完整参数、操作 ID 与到期时间。只有 allowed-once 才签发本次 execution token 对应的私有凭据；凭据不返回模型。采用显式请求而非仅返回 ask，是为了让单调 `tools.guard` 和最终 handler 都能校验自己的凭据，避免后续 waterfall listener 将 ask 改成 allow 后绕过确认。其他 deny/cancel 继续生效；已有 ask 的理由合并进当前确认。

拒绝、无答复渠道、never 策略、取消和审批审计失败均无业务写入，结束的未过期准备记录尝试取消。官方 Web transport 在没有附着审批客户端时可继续等待答复，此时保持 pending；HTTP 测试经官方 SessionController.cancel 取消，不能把等待当成批准。批准绑定被冻结的入参与账户；切换账户、子 Agent、无 Agent、卸载后的旧入口和晚到答复不能执行。取消后不以 Promise.race 掩盖仍在运行的业务。

自动入口还要求显式 `automationsEnabled=true`，默认 false，值在装配时冻结；开启标记不替代 grant 或投递证明。宿主生命周期结束会撤销凭据并取消未决审批。**本轮只在临时测试宿主开启验证，没有修改生产 profile、现有提醒或部署启用状态。**

原生模式与真实 Node PTC 内层调用共用这些入口和 guard。PTC 实际使用 SDK 的 Node 执行器及只读文件策略，未通过删除权限或切换宽松模式取得测试通过。另有完整官方 Web profile 验收，直接使用 SessionController、Connection、Remote Events 和官方审批组件，不注入审批 answerer 或会话解析替身。

## 6. 调度与分析生产/消费

DSH schedule 是会话提醒服务，不是业务回调。链路为：创建/核对宿主提醒 → 人工确认该任务的持久授权 → 恢复指定会话 → Agent 调受控包装入口 → 投递/授权校验 → batch/领域租约与周期键 → WorkflowRun。提醒成功不代表业务成功，补跑看业务回执，不能仅看 schedule_list。

五个 batch 当前仅声明 write，迁移时 wrapper、profile、权限测试一起补 write + external。时间统一 Asia/Shanghai。盘中 batch 的既有 09:05 cron 在 09:30 开市前必跳过，需要改为合法盘中时间并明确与周期盯盘分工，禁止靠 force 绕过。

| 分析入口 | 当前实现 | 迁移处理 |
|---|---|---|
| 交互建议/研究 | 有 get_analysis_context 和 record_*，但普通 settings 无 queue | 可信消费者 scope 按显式授权执行，不扩大普通 Agent 权限 |
| 自动分析 | 内部 enqueue 已有，但未找到生产 workflow 调用 | 按 kind 列生产者和数据门槛；未接种类显式不可用，不冒充自动上线 |
| 消费既有 job | claim → facts → 推理 → complete/fail | 复用 token/原子发布，不能先 record 再 complete |
| 队列运维 | requeue/cancel 是 write，不在消费者白名单 | 独立人工操作，不随消费授权开放 |

分析租约默认 300 秒、上限 1800 秒，没有续租接口。refresh 仅在有效 token 下刷新一次事实，不延长租约；超时后旧消费者不得提交。策略任务已有 heartbeat/fencing，不能混同为分析续租。

无模型预检已实现两种真实生命周期接线：

- `installQueueProbe` 等待 DSH `appReady.onReady`，仅经 read surface 调用原 `get_analysis_metrics`，用 `appExit` 返回 ready/empty/error 对应 0/1/2。不创建 Agent、不解析模型，不需要模型凭据或消费者写权限。
- `installWorkerPreflight` 在可信 worker 的 `agent/pre-step` 中，每 turn 首次模型步骤前读取指标；empty/error 返回 reject，ready 继续，并允许本 turn 后续消费步骤结束。真实 headless profile 中 ready 发起 1 次脚本模型请求，empty/error 均 0 次；无适配器测试还断言 `prepareCall` 没有发生。

只看 readyPending 和未回收过期租约，不把未来任务当 ready，不 claim/recycle。默认十秒超时，异常、取消及卸载均不放行模型。测试分别覆盖真实 DSH CLI 退出和 headless 生命周期，以及临时 SQLite 队列读取不写入、不调用模型。正式 Node 数据接线、部署 shell/bootstrap 替换仍在 P1b/P3；旧 Bun 预检保留，不能把构建验收配置依赖 Bun 误称为已完成无 Bun 分发。

后台盯盘采用唯一负责人及账户周期租约；页面隐藏继续评估。SSE 事件持久 ID 来自触发/操作事实，重连补取去重，过期事件披露真实发生时间。

## 7. Node 数据库与线程

P1b 新增 `@luoome/db/node`，保留 Bun 默认入口。Node shim 唯一负责 node:sqlite 创建与 pragma；抽取共享 schema-ddl，两个入口共用 repository。Node 入口依赖图不得经 barrel 引入 bun:sqlite。

空库与旧库副本各跑两次迁移；personal、report automation、watch delivery 等附属 DDL 同验。Node/Bun/memory 运行同套合约；迁移仅单一负责人执行，其他进程等待版本就绪。WAL/busy_timeout 之外还需真实双进程锁竞争、租约回收和磁盘异常验证。

线程只传序列化参数、授权关联、operationId；worker 重建独立连接/context 并复核权限。长任务返回 ID，状态查询与取消另走受控入口。DSH timeoutMs 需 timeout policy 执行；exec.signal 传播到线程与 adapter 检查点。取消不覆盖已提交成功，强制终止后的不明结果进入核对。

固定 DSH/Node/drizzle 版本，目标 Linux 和 Desktop 分别验证。当前 CI Node 22 + Bun 不能替代 Node 24 DB 合约。SQLite 一致性备份后在副本演练升级/恢复，不能复制活跃 WAL 主文件当完整备份；不自动 VACUUM 或回退覆盖新事实。

## 8. UI、分发与功能承接

V1 五页保留风险、免责声明、反证、事实时间与有效期。图表与已有 DSH React 面板按需复用；新 client 目标原始 bundle ≤800 KB、React external。人工成交、市场源/通知凭据、研究/Vault、导入导出、历史聊天/草案清理分别列专用入口，不能用通用 /call 掩盖差异。

P1a 新增 DSH「操作确认」slot：prepare 后显示冻结的账户、完整参数、操作编号和到期时间，再确认或取消；可查询已有操作，executing/unknown 可核对业务回执。确认凭据只在组件内存中，sessionStorage 仅记操作编号；发送 prepare 前先保存编号，响应丢失仍可查询。刷新/卸载不重建凭据，过期不再提供确认，未决操作不覆盖成新的准备记录。错误不自动重试，完整回执默认折叠。该最小 JSON 表单覆盖当前开放策略，五页专用业务表单仍属于 P2。

模型入口的人工答复使用官方审批卡，展示冻结后的参数；浏览器实际点击允许一次/拒绝。隔离 profile 使用只读文件策略和空工具 preset，自动执行固定 false，无真实供应商或生产任务。新 client 原始 CJS 约 13 KB（React external），不是 V1 五页最终 bundle 体积。

client 接 no-store API 与 SSE，账户切换后的旧表单必须拒绝；输入不明/unknown 提示核对，不自动重试。凭据只显示 configured。核心操作必须已有替代入口才能删旧 Web，延期独立页面不等于删功能。

最终包包含 host、client、worker 入口、bundle patch、skills；既有四种 MCP 前缀迁移覆盖技能、保存的提醒与可执行脚本。保留用户自改技能。安装升级使用临时 DSH_HOME 验证，无仓库/Bun/CLI 的目标环境能完成完整旅程才进入 P5。

切换先备份配置和事实库、停旧任务/消费者、核对在途写入，再启新入口。回退先停新写入，按数据兼容路线恢复；已送通知和备份后新增事实不能靠代码回退撤销。

## 9. 实施切片与验收

| 切片 | 状态 | 交付与门槛 |
|---|---|---|
| P1a-1 发现与只读执行 | 已通过内核与完整输入 schema 验证 | 共享权限选择；只读内核；HTTP admission/Origin/输入检查；DSH 兼容 schema 的 canonical value 注册验证；所有写拒绝；dispose 后旧入口失效 |
| P1a-2 宿主审批与预检 | 本地隔离验收通过 | 原生/PTC/子 scope、真实 CLI 预检 0/1/2、headless 零模型负例、完整官方 Web 认证/审批/取消/冷恢复通过；不代表 Node 生产数据与目标部署验收 |
| P1a-3 持久确认 | 内核、双仓储与最小表单通过 | operation/grant、CAS、防重、撤销/过期、SQLite 崩溃后核对；真实 owner HTTP 及浏览器表单确认/取消/刷新查询通过；正式 profile 接 Node 持久库仍待 P1b |
| P1b 数据与读面 | 待实施 | 双驱动、全部适用合约、Node/Bun 对账、目标环境验证、正式装配 |
| P2 V1 五页 | 待实施 | 账户/成交/策略/设置操作闭环、浏览器与 bundle 门槛 |
| P3 自动化与消费 | 待实施 | batch 搬迁与组合能力、定时授权、生产入口映射、固定租约、取消/线程崩溃 |
| P4 迁移演练 | 待实施 | 隐藏后台继续、断线补取、恢复/回退、多实例、重活时轻读 p95 ≤1s |
| P5 分发退役 | 待实施 | 无源码/Bun/CLI 全旅程通过，再删旧面；文档、skills、CI 同步 |

第一切片不引入“暂时信任 approved”的写权限，也不以 memory fake 持久化冒充 P1a 完成。后续所有新 repository 都需要 memory/drizzle 同一合约。测试使用临时库和合成事实，不接触私人库/真实供应商。

### 9.1 本轮实现与验证记录

- 共享 exposure 与只读内核保留；完整输入 schema 原样注册，原生执行校验及 PTC 类型投影验证通过。
- `plugin-authority` core/repository、memory/drizzle、Drizzle schema 与启动 DDL 同步。合约覆盖并发认领、同键冲突、fencing、账户/用户/过期/能力/版本拒绝、撤销、两连接与重开后二次迁移。
- `plugin-operations.ts` 实现 prepare/confirm/cancel/get/reconcile、精确 grant 与定时去重；`decision-review-operation.ts` 接原业务回执。HTTP handler 复用有界 JSON/Origin 校验，认证 principal 必须由宿主提供。
- `dsh-identity.ts` 与 `dsh-authority.ts` 接真实 ScheduleService/ApprovalService/ToolRuntime；审批私有凭据、投递历史关联、任务定义指纹及默认关闭行为均有端到端负例。
- `test:dsh-luoome` 运行 Node/Vitest 组及 Bun 端到端组；`test:all` 纳入端到端入口。Bun SQLite 测试由 Bun 执行；SDK Node PTC 依赖 `node:module.stripTypeScriptTypes`，因此 PTC 集成由真正的 Node/Vitest 执行，不对 Bun 打补丁。
- `dsh-authority.e2e.test.ts` 使用真实 AgentLoop、SessionStore、ScheduleService、ApprovalService、JSON 调度存储、JSONL 会话持久化和临时 SQLite 业务库；覆盖投递、合并提醒、回执竞态、防重、拒绝/取消、定义变更/撤销、子 Agent、跨会话、重启和响应丢失恢复。
- `dsh-ptc.integration.test.ts` 使用真实只读 Node PTC 执行器与同一宿主链路，覆盖批准、重复定时内调用、普通会话重放和拒绝。该组业务仓储使用 memory，不能替代 Node SQLite 合约；SQLite 及双实现语义由 Bun 合约和持久化端到端组验证。
- 底层 Bun/PTC 服务组继续使用脚本模型、测试 answerer 和活 Agent 解析门面，单独承担 SQLite/权限并发验证。新增 `web-profile.integration.test.ts` 启动真实 DSH CLI、base + web-app bundle、Connection 与 SessionController，覆盖 cookie 登录、Host/Origin/体积负例、并发确认、原生 Web 取消及进程重启冷恢复。该组业务仓储是 memory，不能替代 Node SQLite。
- `preflight.test.ts` 覆盖未来任务、过期租约、异常/超时/取消及模型解析前阻断；profile 集成组实际运行 probe/headless，Bun 原生组验证同一个预检读取临时 SQLite，均不调用 Bun CLI 子进程作为预检实现。
- Chrome 实际浏览器验收使用完整 Web profile 和官方审批组件，不挂测试 answerer：允许一次写入一条复盘，拒绝不增加修订；旧 contextHash 仍被原业务校验拒绝；操作表单确认/取消、刷新后查询且不可重建凭据通过。去敏记录保存在本地 `.tmp/dsh-luoome-audit/`，不含启动令牌或 cookie。模型仍为脚本 adapter，不宣称验证真实供应商。

当前 P1a 的无模型预检和 Web/审批最小旅程已有本地证据，整阶段仍未通过：功能/分析生产者映射、真实业务 batch 承接尚未闭环。Node 生产数据库属于 P1b，五 batch 正式切换属于 P3，均未完成。自动任务保持默认关闭；不变更生产配置、不删除旧入口、不自动 commit/push。

### 9.2 交付验证（2026-10-24）

| 检查 | 本地结果 |
|---|---|
| `bun --no-env-file run test` | 269 文件、2277 项通过，含真实 Node PTC 和完整 CLI profile 集成 |
| `bun --no-env-file run test:db` | 13 文件、599 项通过，含权限双仓储和启动 DDL 对账 |
| `bun --no-env-file run test:web` | 29 文件、549 项通过 |
| `bun --no-env-file run test:dsh-luoome:e2e` | 12 项通过；临时 SQLite、真实 DSH 服务、预检与持久存储 |
| `bun --no-env-file run typecheck` | 全 workspace 通过 |
| Biome 定向检查 | 新执行内核、schema、仓储、测试及命令配置通过 |
| `build:dsh-luoome` / Node 导入与拒绝调用冒烟 | 通过；target node、SDK external，host 约 1.91 MB |
| `check:layers` / Markdown 链接 / `git diff --check` | 通过 |

共 3437 项测试执行通过；Node PTC 和 CLI profile 项已经包含在 Vitest 总数中，不另加计。输入摘要验证同时覆盖对象键的跨 locale 稳定排序和数组顺序保留。运行时为 Bun 1.3.14、Node v22.22.2、固定 DSH SDK/CLI 0.2.1-rc.2；这不替代目标 Node 24 数据库及完整生产部署验收。测试未启用生产任务，未修改真实事实库。

定向复现：`bun --no-env-file run test:dsh-luoome`。完整 CLI profile 组可单跑 `bun --no-env-file x vitest run packages/dsh-luoome/src/host/web-profile.integration.test.ts`（8 项）。`bun --no-env-file infra/dsh/acceptance.ts web` 仅生成临时 profile；输出目录内 `launch.json` 保存 CLI、工作目录和参数，使用该目录作为 DSH_HOME/DSH_AGENTS_HOME 启动，绝不覆盖用户 profile。`probe ready|empty|error` 和 `worker ready|empty|error` 同理只生成隔离配置。构建工具使用 Bun，启动后的宿主预检不启动 luoome CLI 或 Bun。
