# dsh-luoome 纯插件详细设计

> 2026-10-24；基线：`dsh@24e7ee1` 与当前工作树。状态：设计完成，P1a 开发中，尚不可切换生产。
> 产品范围来自本地评审计划 `.tmp/dsh-luoome-audit/plan.md`。该文件被 Git 忽略，本文完整保存实施契约，不要求读者访问临时目录。
> 本文描述独立 DSH 插件的下一阶段；现有 MCP、Bun Web 与消费者仍保留。旧托管系统、内嵌 Host、本地模型栈不恢复。
> 2026-10-24 增补：当前运行形态是「当前 MCP 过渡形态」——Web profile 四个 MCP 实例
> （read / settings / analysis / batch）+ 手动/隔离验收才拉起的 worker；默认部署已退役常驻 worker。
> 本次只补通交互分析写回并退役默认 worker，**不完成纯插件迁移**；下表与各节的「现状」按此口径理解。

## 1. 目标与当前边界

最终业务执行进入 DSH Node 进程，面板不再逐请求启动 Bun CLI；工作台保留首页、持仓、复盘、策略、设置五页。后台工作随所属 DSH 进程退出而停止，切换页面、窗口隐藏和 SSE 断开不影响已启用的盯盘。

已存在的资产包括三个 DSH 只读面板、独立 profile、Web 四个 MCP 实例（`luoome` / `luoome-settings` / `luoome-analysis` / `luoome-batch`）与手动 worker、分析事实包/队列、决策回执、批处理工具与业务租约。Node SQLite 目前只有 spike；已有只读/操作内核、持久确认、无模型预检与 Web 宿主装配。隔离 profile 已接官方认证、SessionController 和审批组件，正式 Node 数据装配尚未完成。实现必须复用这些资产，而不是另造分析任务状态机。

| 现有入口 | 目标 | 退役前要求 |
|---|---|---|
| read/settings/analysis/batch MCP | 插件工具包装与执行边界 | 按工具名、能力、输出逐项对账 |
| worker MCP（默认部署不运行，仅手动/隔离验收） | 同包 worker profile | 固定租约、原子写回及无模型预检验证 |
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
| analysis | read + queue，收窄到 `get_analysis_context` / `record_advice` / `record_analysis_result` | 交互逐次确认（默认 Web 已挂载） |
| batch | write + external | 交互确认或绑定任务的持久授权 |
| worker | read + 独立 queue opt-in | 消费者身份、账户范围、任务 kind、有效 claim token；仅手动/隔离验收 |

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
| 交互建议/研究 | 有独立 `luoome-analysis` 实例（`get_analysis_context` + `record_*`，精确三工具白名单）；普通 settings 仍无 queue | 复用同一共享白名单交插件工具包装；不扩大普通 Agent 权限 |
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

最终包包含 host、client、worker 入口、bundle patch、skills；既有 MCP 前缀（Web 四实例 + 手动 worker）迁移覆盖技能、保存的提醒与可执行脚本。保留用户自改技能。安装升级使用临时 DSH_HOME 验证，无仓库/Bun/CLI 的目标环境能完成完整旅程才进入 P5。

切换先备份配置和事实库、停旧任务/消费者、核对在途写入，再启新入口。回退先停新写入，按数据兼容路线恢复；已送通知和备份后新增事实不能靠代码回退撤销。

## 9. 实施切片与验收

| 切片 | 状态 | 交付与门槛 |
|---|---|---|
| P1a-1 发现与只读执行 | 已通过内核与完整输入 schema 验证 | 共享权限选择；只读内核；HTTP admission/Origin/输入检查；DSH 兼容 schema 的 canonical value 注册验证；所有写拒绝；dispose 后旧入口失效 |
| P1a-2 宿主审批与预检 | 本地隔离验收通过 | 原生/PTC/子 scope、真实 CLI 预检 0/1/2、headless 零模型负例、完整官方 Web 认证/审批/取消/冷恢复通过；不代表 Node 生产数据与目标部署验收 |
| P1a-3 持久确认 | 内核、双仓储与最小表单通过 | operation/grant、CAS、防重、撤销/过期、SQLite 崩溃后核对；真实 owner HTTP 及浏览器表单确认/取消/刷新查询通过；正式 profile 接 Node 持久库仍待 P1b |
| P1b 数据与读面 | M1b/M1c 已落地（Node DB + 生产只读 composition + 可安装空壳包）；其余 P1b 门槛待实施 | 双驱动、全部适用合约、Node/Bun 对账、目标环境验证、正式装配 |
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

### 9.3 P1b M1b 实施记录（2026-10-24）

> 需求来源：`docs/ddd/dsh-interactive-analysis-surface-and-worker-retirement.md` §2/§4.1/§6.2/§9(M1)。本切片只做 M1 的 Node DB + 生产只读 composition，不接 M2 写面。

- **Node DB（task-5 交付）**：`@luoome/db/node` 使用 `node:sqlite`，`createNodeDrizzleRepos(dbPath, {migrate?})` 返回 `{repos, db, close}`，与 Bun 入口共用 `migrations.ts`/`repositories.ts`/schema；`packages/db/package.json` 已加 `./node` export。Node 22/24 合约、WAL/busy_timeout、重开持久化、双连接与二次迁移幂等由 task-5 的 `test:db:node` 验证（**Node 24 证据来自 task-5**；本轮本地复跑运行时为 Node v22.22.2，不能替代 Node 24 门槛）。
- **配置** `src/host/production-config.ts`：zod strict 受信任部署配置，owner 只由部署代码或 `LUOOME_OWNER_USER_ID`/`LUOOME_OWNER_ACCOUNT_ID` 绑定，HTTP/模型/skill 参数不能提升账户；`home` 默认 `env.LUOOME_HOME` 再退回 `~/.luoome`；`automationsEnabled` 与 `exposeResearch` 在 M1 固定 false；adapters env 透传（要求部署显式提供 `LUOOME_MARKET_PROVIDER=real`，沿用既有行情装配语义）。解析结果对象、owner、read 配置、allowlist/denylist 数组和 env 全部 `Object.freeze`。
- **默认只读白名单（45 项，按真实 registry 名核对）**：账户/持仓/交易/看板 `list_accounts`、`get_account`、`get_account_facts`、`list_holdings`、`get_holding`、`list_trades`、`get_investment_workspace`；Advice/复盘 `get_advice`、`get_advice_stats`、`get_confidence_calibration`、`list_decision_reviews`、`get_decision_review_context`、`get_decision_review_snapshot`、`get_decision_loop_review`；交互分析 `get_analysis_context`；Strategy `list_strategies`、`get_strategy`、`get_strategy_dsl_catalog`、`get_strategy_experiment_context`、`compare_strategy_definitions`、`list_strategy_runs`、`get_strategy_run`、`get_strategy_workspace`、`compare_strategy_runs`、`get_strategy_insight_facts`、`strategy_signals_by_stock`、`list_pending_strategy_observations`、`get_signal_observation_stats`、`get_strategy_decision_cycles`、`get_strategy_reliability_summary`；关注/触发 `list_watchlists`、`get_watchlist`、`list_watchlist_changes`、`list_watch_triggers`、`list_alert_plans`、`get_watch_status`；本地市场事实 `get_market_data_status`、`get_stock_universe_status`、`limit_up_ladder`、`limit_up_ladder_compare`、`dragon_tiger_list`、`northbound_flow`、`get_previous_closes`、`search_stocks`、`list_stock_events`。queue/job 查询与私人研究 tool 不在默认名单；allowlist 里出现未知或写/外部/队列/trade 名字时装配直接拒绝（fail closed），显式空数组仍开放零工具。
- **composition** `src/host/production.ts`：`createProductionHost(config)` 在 mkdir/打开 SQLite **之前**完成 `LUOOME_EXPOSE_TRADE=true` 硬卡与 allowlist 只读对账；随后 `createNodeDrizzleRepos(join(home,'luoome.db'))` + `createLocalAdapters`（真实 `*FromEnv` 工厂）+ `buildContext`；owner 账户必须已存在于事实库，缺失时关闭连接并拒绝装配，不回退默认账户；`register(runtime)` 经 `registerReadTools` 注册真实只读工具；`dispose()` 幂等关闭 DB、dispose read surface、撤销注册，之后旧闭包返回 `permission_denied`。
- **apply 入口**：`apply(ctx, config?)` 在打开 DB 前检查 Connection/WebServer/SessionController/ApprovalService/tools，缺失即拒绝装配（不回退无认证路由）；复用 `mountDshWebProfile` 的 Connection 准入与 owner guard 注册只读工具和 `/api/luoome` 前缀（含只读 `POST /api/luoome/call`）。M1 只传 `capabilities:['read']` 与空 policies：未接审批写面，`prepare` 对任何工具都不会成功，也不伪造 `approved`。
- **测试** `src/host/production.test.ts`（Node/vitest，11 项）：临时 `LUOOME_HOME` + 临时 Node SQLite；真实 repo 写入账户/Advice/Strategy 后由真实读工具返回 JSON（Date 已 ISO 化）；dispose 后重开仍读到同一事实；`LUOOME_EXPOSE_TRADE=true`（进程 env 与配置 env 两路）在目录/DB 创建前失败；owner 缺失与 owner 账户不存在均拒绝装配且连接已关闭；配置冻结、strict/越权选项拒绝、空 allowlist=零工具；allowlist 误配在任何 IO 前失败；`dispose` 后旧闭包 `permission_denied`；`apply` 缺依赖拒绝装配，成功路径只注册只读工具 + `/api/luoome` 路由；静态依赖图断言 production 相对导入闭包不含 `bun:sqlite`/`@luoome/mcp`/CLI/Web，且只有 `@luoome/db/node`。
- **依赖接线**：`packages/dsh-luoome/package.json` 在 dependencies 增加 `@luoome/adapters: workspace:*`，并把 `@luoome/db` 从 devDependencies 移入 dependencies（`bun install` 仅更新根 `bun.lock` 的 workspace 接线）。
- **验证（2026-10-24）**：`npx vitest run packages/dsh-luoome` → 47 项中 45 通过、新增 11 项全过；`bun --no-env-file run typecheck`、`bun --no-env-file run lint`（0 error，24 条既有 warning 均在其他文件）、`bun --no-env-file run check:layers` 通过；`build:dsh-luoome`（2.83 MB，target node，SDK external）后用 `node` 直接 import 构建产物装配临时库：owner 缺失先拒绝、真实 `list_accounts` 成功（1 个账户、Date→ISO）、dispose 后拒绝、重开仍 1 个账户，构建产物无 `bun:sqlite` 引用且 `import('bun:sqlite')` 失败。既有 `web-profile.integration.test.ts` 的 2 个 ready 态用例在本日（周六）失败：fixture 以 `new Date()` 造当日 quote，`enqueue_analysis_job` 返回 `context_expired`（非交易日时效规则）；该组与本切片无关，属既有日期相关环境失败，已单独报告。
- **遗留（明确未做）**：M1c 可安装插件包（真实 DSH exports/apply 接线、无仓库 TS 源码安装）未做；M2 market external 面与 Operation/Approval 写面（`record_advice`/`record_analysis_result`/策略发布、`configure_plugin_automation` 的可写策略）未接；M3 四旅程 skills、M4 三面板与打包、M5 默认部署切换均未做；P1b 剩余（Node 24 目标环境、双进程锁竞争、租约回收、磁盘异常）仍待验证；`get_analysis_context` 的“读事实 + 持久化审计快照”语义按需求 §5.4 保留，未改写。自动任务保持默认关闭；不操作真实服务器或个人事实库；未 commit/push。

### 9.4 P1b M1c 实施记录（2026-10-24）

> 需求来源：需求文档 §6.3/§9(M1)/§10.1。M1c 只交付「可安装空壳插件包」：host + Node DB + 真实只读工具；三面板、四旅程 skills、审批写面与 market external 面属于 M2–M4。

- **可安装包**：`packages/dsh-luoome/package.json` 改为真实插件形态——`main`/`exports` 指向 `./dist/host.js`，`files: ["dist/host.js"]`（`bun pm pack` 只含 `dist/host.js` + `package.json`），保持 `private` 与固定版本依赖；包内新增 `build` 脚本，根 `package.json` 的 `build:dsh-luoome` 改为从包内构建 `src/host/plugin.ts`（target=node、format=esm、external `@deepseek-ai/*`），产物 `dist/host.js` 约 2.82 MB；新增根脚本 `test:plugin-install`。
- **生产插件入口** `src/host/plugin.ts`：`inject` 声明 connection/webServer/sessionController/approval/tools，`apply(ctx)` 复用 task-6 的 production apply；额外导出 `createProductionHost`/`DEFAULT_READ_TOOL_ALLOWLIST` 供隔离验收预置事实库。宿主服务缺失时插件不激活（fail-loud），不降级为无认证入口。
- **隔离安装/加载验收** `infra/dsh/plugin-install-acceptance.ts`（`bun --no-env-file run test:plugin-install`）：`bun pm pack` 产出 `dsh-luoome-0.1.0.tgz`（2 文件、约 0.55 MB），解包到临时 profile 的 `node_modules/dsh-luoome`，profile manifest 以 `file:` 依赖指向同一 tarball，bundles 仅 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`cordis.patch.yml` insert `{id:'luoome-plugin', name:'dsh-luoome'}`；用真实 DSH CLI（node v22.22.2 执行）启动，走官方登录 + 宿主认证 `POST /api/luoome/call`。结果：插件激活；`/api/luoome/profile` 返回 45 个只读工具、空 policies、`automationsEnabled:false`、owner 账户绑定；`list_accounts` 返回 `ok:true,total:1`；进程退出后重启仍读到同一事实（Node SQLite 持久化）；DSH 子进程数 0，无 MCP/Bun CLI/analysis worker/queue probe；退出后旧 HTTP origin 不可达。该验收明确标注为「协议/装配验收，非真实模型质量」。
- **产物证据**：`dist/host.js` 与 tarball 内 bundle 对 `bun:sqlite`/`@luoome/mcp`/`packages/{db,tools,dsh-luoome}/src` 的 grep 命中均为 0，无 `/Users/...` 仓库绝对路径；tarball 无 `.ts` 条目。
- **验证（2026-10-24，仓库根目录）**：`bun --no-env-file run test:dsh-luoome` → Vitest 8 文件 47 项 + Bun e2e 12 项全部通过（§9.3 记录的 3 个 fixture 墙钟失败已由后续 fixture 修复消除）；`bun --no-env-file run test:plugin-install` 通过并输出上述 JSON；`typecheck`、`lint`（0 error，24 条既有 warning 均不在本次改动文件）、`check:layers`、`build`（含 `build:dsh-luoome`）、`git diff --check` 通过。DSH CLI 本地实跑为 Node v22.22.2；Node 24 双驱动 DB 合约证据仍来自 task-5。
- **本轮修正**：M1c 验收暴露 `resolveProductionConfig` 直接 parse Node `process.env` 会被 zod 4 的 `z.record` 拒绝（`expected record`），已在 `production-config.ts` parse 前把显式 env 归一化为普通对象快照，并在 `production.test.ts` 增加 `process.env` 回归断言；只读边界、allowlist 与 trade 硬卡未变。
- **未覆盖/遗留**：M1c 仍是空壳——无三面板 client、无四旅程 skills、无 native Operation/Approval 写面、无 market external 面（M2–M4）；tarball 的 `@luoome/*` 仍是 `workspace:*` 声明（运行时已 inline 进 bundle），真正 registry 发布需在 M4/P5 改为固定版本并声明 `@deepseek-ai/*` 安装依赖；安装验收是本地 tarball + 手动解包，不是 registry 安装；插件 `inject` 要求 DSH Web 服务，headless profile 不在 M1c 门槛内；Node 24 目标环境、双进程锁竞争/租约回收/磁盘异常仍属 P1b 剩余。

### 9.5 M3a 事实时效修正与 fixture 时钟（2026-10-24）

> 需求来源：需求文档 §5-1/§5-2/§8。修正旧规则「所有 kind 统一 15:00 截断 + 30 分钟 stale」对盘后研究与市场分析的误伤；不取消真正的时效约束。MVP 交互 record 路径不创建 job，但队列 claim 路径也已对齐，避免两套规则漂移。

- **唯一来源**：`packages/core/src/entity/analysis-context.ts` 新增 `AnalysisTimingRule`、`analysisTimingRules`、`analysisContextTiming`、`isAnalysisContextStale`、`analysisContextTimingError`；`record.ts` / `publication.ts` / `context.ts` / `jobs.ts` 与 db repository claim 全部改为调用同一策略，`context_expired` / `stale_context` 错误词表与 ToolError 结构不变。
- **规则表**（Shanghai 时区）：

  | kind | `writeUntil` | `dataAsOf` 过期 |
  |---|---|---|
  | `advice_stock` / `advice_position` / `advice_strategy_candidate` | `min(现在+30 分钟, 当日 15:00)`（保持不变） | 超过 30 分钟 |
  | `advice_market` | `min(现在+24 小时, dataAsOf+7 天)` | 超过 7 天 |
  | `research_directions` / `strategy_version_proposal` / `strategy_insight_narrative` | `min(现在+24 小时, dataAsOf+30 天)` | 超过 30 天 |

  15:00 截断只属于明确的盘中行动上下文；研究/策略类按 StrategyRun/dataAsOf 与研究成果有效期判断；超过 writeUntil/expiresAt → `context_expired`，超过数据有效期 → `stale_context`。
- **repository claim 对齐**：`packages/db/src/repository/{memory,drizzle}/analysis.ts` 的 claim 数据新鲜度判断由 `> 30 分钟` 硬编码改为 `isAnalysisContextStale(job.kind, job.dataAsOf, now)`；返回契约不变（job 置 `failed`，`error.code='stale_context'`、`retryable:false`），租约/CAS/去重/原子发布不动。合约测试（memory/drizzle 同套）覆盖盘中行动类 31min stale、research/strategy 1d 可 claim 与 31d stale、advice_market 1d 可 claim 与 8d stale，以及既有 claim/complete/refresh 负例。
- **测试**：新增 `packages/core/src/entity/analysis-context.test.ts`（9 项，逐 kind/边界）；`packages/tools/src/queue/analysis.test.ts` 扩到 12 项（收盘后 research/strategy 可写回、24h 写窗口、30d stale、advice_market 盘后可写、盘中行动回归、jobs refresh/complete）。
- **fixture 时钟修复**：分 kind 时效落地后暴露 `packages/dsh-luoome` 验收 fixture 用 `new Date()` 造当日 Quote 再 enqueue `advice_stock`，在非交易时段会 `context_expired`（`web-profile.integration.test.ts` probe/worker ready 与 `dsh-authority.e2e.test.ts` preflight 项）。已把 `src/testing/web-fixture.ts` 的 `applyProbe`/`applyWorker` 固定到合成交易日 2026-10-22 10:00，并在 preflight e2e 用固定 clock 的 seed context 种队列；断言未放宽，修的是 fixture 时间来源。随后 `test:dsh-luoome` 47 + 12 项全绿。
- **未覆盖/遗留**：`advice_market` 的端到端仍依赖 §5-3 的 market external 事实进入 context（M2a 处理）；24h 写回窗口从 context 装配时刻起算，若产品希望按研究生成/审批时刻起算需另定；db claim 的 `expiresAt = now + 30d` 属审计保留，不参与 stale 判断。

### 9.6 M2a native market external surface 实施记录（2026-10-24）

> 需求来源：需求文档 §4.2、§9(M2)、§10.3。M2a 只加「对话主动刷新市场事实」的精确 external 面；写操作/审批策略仍属 M2b。

- **独立 surface**：新增 `packages/dsh-luoome/src/host/market-surface.ts`：只允许 `sideEffect==='external'` 且 requiredCapabilities 仅含 external 的工具；未知名字、read/queue/write/trade 与 external+write 混合能力在装配期 fail-closed 拒绝；显式空数组=零工具；配置对象/数组解析后冻结，注册与执行共用同一快照；私人研究名仍由共享 denylist 拒绝，allowlist 不能覆盖研究 opt-in；按名调用未暴露工具返回 `permission_denied`。
- **默认 market 白名单**（按真实 registry 对账，6 项）：`fetch_index_quotes`、`get_ashare_sentiment`、`fetch_quote`、`batch_quote`、`trial_strategy_version`、`fetch_news`。`sync_quotes`/`send_notification` 等虽满足能力规则，但不在精确名单内，默认不暴露；`fetch_sector_quotes` 仍为 read（§4.2 未点名、市场宽度由 `get_ashare_sentiment` 覆盖），若产品把它纳入每日分析再单独评审分类。
- **执行语义**：保留原 ToolResult（`adapter_error` 原样返回，不伪造空成功；合法空结果仍是成功）；结果 JSON 化（Date→ISO）；`timeoutMs` 默认 30s、上限 300s，超时返回 `adapter_error{adapter:'market-surface', cause:'timeout after <n>ms', recoverable:true}` 并立即停止等待；调用方 AbortSignal 取消返回 `permission_denied{required:'active request'}`；异常脱敏为 internal。
- **配置与接线**：`production-config.ts` 新增独立 `market` 配置块（allowlist/denylist/timeoutMs，exposeResearch 固定 false），与 read allowlist 分离且冻结；`production.ts` 在任何 IO 前做 market 能力对账，`ProductionHost` 暴露 `market`/`registerMarket`/`invokeMarket`；`apply` 分开注册/撤销 read 与 market 并复用 owner/top-level guard，装配失败回滚已注册工具、路由与 DB 连接。`/api/luoome/call` 仍只读（对 `fetch_quote` 返回 403）。
- **测试/验收**：新增 `market-surface.test.ts` 19 项；`production.test.ts` 扩到 15 项（read/market 独立配置、误配 IO 前拒绝、空名单、分开注册、注册失败回滚、dispose 拒绝、静态依赖图）。`test:dsh-luoome` → 10 文件 77 项 + Bun e2e 12 项通过；`test` 277 文件/2602 项通过；`test:plugin-install` 扩展断言 read 45 / market 5、market 配置冻结、HTTP `/call` 调 external 返回 403、无 MCP/Bun CLI/worker/queue probe、产物无 forbidden needle。
- **M2a-followup（同日完成）**：`fetch_news` 的 handler 只调用第三方新闻源、不写库/不发通知，按既有副作用语义由 `read` 修正为 `external`；MCP 默认 read 面不再包含它（需 `LUOOME_EXPOSE_EXTERNAL=true` opt-in），dsh-luoome market 面默认名单补入（5→6 项）。`fetch_sector_quotes` 保持 read 并记录后续条件。同步更新 registry/MCP 默认暴露面测试、market-surface/skills-content 断言与 plugin-install 验收。
- **未覆盖/遗留**：market 工具的模型侧真实调用需随 M2b/M3 的真实 Agent + 审批链路验收；`skills/luoome/references/tools.md` 中 fetch_news 的 “Pure read-only” 措辞可在文档清理轮改为 “read-only, external opt-in”。

### 9.7 M3 四旅程技能内容实施记录（2026-10-24）

> 需求来源：需求文档 §3、§8。本切片只产出技能内容与内容校验；注册/打包接线在后续 M3/M4 切片完成。

- `packages/dsh-luoome/skills/` 新增四个纯插件投研技能：`strategy-lab`（读策略/版本/DSL/数据健康 → 未持久化草案 → 确定性校验 → 有限样本试跑 → 展示 diff/规则/样本/缺口/试跑结果 → 逐项原生审批 create/version/validate/publish，创建与校验不隐含发布）、`strategy-result-review`（published operational run/结果/信号/观察/insight facts 分层解释，结论引用真实 run/version/fact id，不把观察称严格回测、不承诺收益；只解释不落库；改版走 strategy-lab；可选经审批保存 proposal）、`post-close-review`（Advice 快照、DecisionReview、显式 Trade、观察、绩效、校准分写；不按同股/同日/后市涨跌推断跟随、不伪造盈亏；复盘笔记经原生 Operation，仅用户明确反馈后经 record_advice_outcome 审批，AI 不代填 outcome）、`daily-market-analysis`（经精确 market external 刷新指数/情绪/要闻/行情 + 本地事实，保留 source/dataAsOf/unavailable/partial；个人上下文不推断全市场；日常留会话不伪造 Report；形成 Advice 需另取有效 AnalysisContext 并审批）。
- **内容约束**：四技能不含 `mcp__`/`luoome-worker`/队列管理工具，工具名与 `packages/tools/src/registry.ts` 对账；所有写入统一经 `luoome_confirmed_operation` 原生审批；模型自报 approved/callId/taskId 不构成授权；context 失效重取一次并重新核对、不重放；trade 永不调用。
- **校验**：`packages/dsh-luoome/src/host/skills-content.test.ts`（7 项）验证四目录/frontmatter/工具名副作用对账/无 MCP 前缀/审批与 outcome 约束/四旅程覆盖点/context 与 trade 边界。`bun --no-env-file x vitest run packages/dsh-luoome` 10 文件 77 项通过；typecheck/lint/`git diff --check` 通过。
- **未覆盖/遗留**：技能注册（`ctx.skills.register`）、`package.json files` 与安装路径纳入后续 M3 接线/M4 打包；`fetch_news` 分类修正后每日市场分析技能需确认其可达性；旧 `.dsh/skills` 保留至 P5 退役。

### 9.8 P1b M2b-1 实施记录（2026-10-24）

> 需求来源：需求文档 §4.3、§5-5、§9(M2)、§10.2/§10.3。把交互分析写回接成 DSH 原生确认操作；策略/outcome 写面属 M2b-2。

- **能力门控**：`createPluginOperationService` 允许受信任装配显式开启 `queue`，仅用于精确 analysis policy；含 queue 的 policy 在装配未开启 queue 时直接拒绝，trade 永久拒绝；通用 `/api/luoome/call` 仍是 read surface，不因 policies 变成写入口。core `PluginCapabilitySchema` 增加 `queue`，使 record_* 的 `['queue']` 能力可持久化（不含 trade）。
- **两条 policy**：`analysis-operations.ts` 新增 `recordAdviceOperation`（`record_advice`）与 `recordAnalysisResultOperation`（`record_analysis_result`）。prepare 用 principal.accountId 覆盖并冻结 accountId，requestId 强制等于 operationId，冻结 contextId/result/provenance；confirm 时领域 record 工具以账户重新读取 context，自行校验 contextHash、证据引用、时效与不变量；reconcile 只凭 `context.recordedResult.hash/ref` 核对业务回执（Advice 或 publication resultRef），不重放 handler/不重新推理；重放返回既有结果且不重复写库。
- **Provenance**：generatorKind 由生产装配固定 `dsh-chat` 并强制覆盖；客户端自报的 model/skillVersion/promptHash/sessionRef 全部丢弃，宿主无可信元数据时保持未知。模型自报的 approved/callId/taskId 不作为授权或来源；生成时间与 jobId/contextId 由领域工具填写。审批 reason 展示冻结账户、operation id、有效期与完整冻结参数（结论/证据/反证/风险），无伪造 approved。
- **生产接线**：`createProductionOperationPolicies()` = DecisionReview + 两条 record policy，与 `capabilities: ['read','write','external','queue']` 一起传入 `mountDshWebProfile`；写工具只经 `luoome_confirmed_operation` 原生审批执行，不注册 claim/complete/fail/queue 管理/settings/batch/trade。
- **测试/验收**：`analysis-operations.test.ts` 10 项（冻结/防旋转/同键异参、confirm 写一次、重放与 reconcile 幂等、过期 context 不写、取消/跨账户/过期 operation 不写、response-loss 恢复且 handler 只执行一次、publication 成功/失败/重放、queue 门控与 trade 拒绝）；`production.test.ts` 16 项；审批层拒绝/子 Agent/晚到审批仍由既有 `dsh-authority.e2e.test.ts` 覆盖。`test:dsh-luoome` 88 项 + 12 e2e、`test` 278 文件/2613 项、`test:db` 601 项、typecheck/lint/check:layers/test:plugin-install/git-diff 全通过。plugin-install 扩展为 policies 非空且与安装产物一致、`automationsEnabled:false`、`/call` 对 record/decision/market/queue 管理工具全部 403、未审批 prepare 保持 pending 且无 Advice 写入、取消后仍无写入。
- **未覆盖/遗留**：M2b-2（`record_advice_outcome`、策略 create/validate/publish、`configure_plugin_automation` 可写策略与定时授权、真实 DSH 审批 UI 端到端）、market 工具模型侧真实调用验收、M3b 技能注册、M4 三面板、M5 默认部署切换。

### 9.9 P1b M2b-2 实施记录（2026-10-24）

> 需求来源：需求文档 §3.1/§3.2/§3.3、§4.4、§9(M2)、§10.2/§10.3。补齐策略生命周期与用户反馈的原生确认写面；M2b-1 的 record policies 保持不变。

- **新增 5 条独立 policy**（`packages/dsh-luoome/src/host/strategy-operations.ts`）：`create_strategy`（无显式 id 时冻结为 `strategy-<operationId>` 便于回执核对）、`create_strategy_version`、`validate_strategy_version`、`publish_strategy_version`、`record_advice_outcome`。全部 `scheduled:false`、`sideEffect:'write'`、`requiredCapabilities:['write']`，只经一次性人工原生审批执行；prepare 冻结 owner/account/输入/过期，剥离客户端 `approved/callId/taskId`，拒绝替换 accountId/requestId。
- **审批语义**：create/version/validate/publish 各自独立审批，create 或 validate 通过不隐含 publish；publish 的 token 不能用于其他操作；对未 validate 版本 publish 被领域拒绝；`record_advice_outcome` 缺 outcome 无法 prepare（模型不能省略再让工具推断），用户反馈的「明确性」由宿主 allowed-once 审批保证，policy 只保证输入显式冻结 + 人工批准。
- **回执/恢复**：publish response loss 按 `publishedAt + currentVersionId` 核对恢复 succeeded 且只执行一次；`record_advice_outcome` 按 decision review write receipt 恢复，commit 只一次；重复 confirm 不重复 revision。策略 create/version/validate/copy 回执亦纳入核对。
- **接线与隔离**：`createProductionOperationPolicies()` = DecisionReview + 2 条 analysis record + 5 条策略/outcome = 8 条 policies，`capabilities:['read','write','external','queue']`；read/market 只读边界、generic `/api/luoome/call` 只读、queue 管理工具与 trade 不可达不变。策略回读用 `get_strategy` 等只读工具（M4 面板再补 diff/样本预览展示）。
- **测试/验收**：`strategy-operations.test.ts` 12 项（四段独立审批 + 回读、create/validate 不隐含 publish、token/操作不串用、冻结/CAS、跨账户/取消/过期/错误 token 无写入、scheduled 不可达、publish/outcome response-loss reconcile 不重放、禁止名单）；`plugin-install-acceptance.ts` 期望更新为 8 条 policies 并扩 `/call` 403 面。`test` 279 文件/2625 项、`test:dsh-luoome` 100 + 12 e2e、`test:db` 601、typecheck/lint/check:layers/test:plugin-install/git-diff 全通过。
- **未覆盖/遗留**：M4 三面板（diff/样本预览、浏览器验收）；M5 默认部署切换；策略删除/暂停/归档/调度与自主管理动作、settings registry 通用暴露（明确不做）；真实 DSH 审批 UI 的完整浏览器端到端在 M4 一并验收。

### 9.10 P1b M3b 实施记录（2026-10-24）

> 需求来源：需求文档 §6.3/§8、§9(M3/M4)。把四旅程技能注册进插件并随包分发，安装后由真实 DSH skills catalog 可见。

- **注册**：新增 `packages/dsh-luoome/src/host/skills.ts` 作为随包技能单一事实来源——`BUNDLED_SKILL_NAMES`、`resolveBundledSkillsRoot`（从 `import.meta.url` 向上解析包根 `skills/`，源码 `src/host` 与产物 `dist/host.js` 都命中，找不到 fail-loud）、严格 frontmatter 解析（name=目录名且 kebab、description/whenToUse/正文非空、256KB 上限）、`readBundledSkills`（缺目录/缺技能/多出未声明技能/坏文件全部抛错）、`registerBundledSkills`（提交 source='bundled'、provider='dsh-luoome'、path、content；失败回滚；幂等 disposer；缺 skills 服务 fail-loud）。`plugin.ts` 的 `inject` 增加 `skills`，`apply` 用 `ctx.effect` 挂注册，插件 teardown 时撤销。
- **打包**：`packages/dsh-luoome/package.json` `files` 增加 `skills`，并固定 `@deepseek-ai/dsh-skill` 依赖；`bun pm pack` tarball = package.json + dist/host.js + 四个 `skills/<name>/SKILL.md`（561,745 B，无 `.ts`/源码/仓库绝对路径）。
- **安装验收**：profile 内注入只读 probe 插件，用真实 DSH `ctx.skills.list()/get()` 落盘 catalog，断言四技能名称/描述/whenToUse 与安装文件 frontmatter 逐字一致、source=bundled、provider=dsh-luoome、正文含 `## 流程` 且长度 >500，catalog 恰为四技能且无旧技能；M2b 的 8 policies、read 45/market 6、`/call` 全 403、未审批 prepare 不写等断言保持。
- **测试/验收**：`skills.test.ts` 8 项（解析/产物布局/坏目录坏 frontmatter fail-loud/真实 registry catalog/dispose 幂等与不泄漏/高优先级 project 技能不被覆盖/缺服务 fail-loud/tarball 清单）。`test` 280 文件/2633 项、`test:dsh-luoome` 108 + 12 e2e、`test:plugin-install`、typecheck/lint/check:layers/build/git-diff 全通过。
- **优先级修正（M3b-fix，同日完成）**：初次用 `ctx.skills.register()`（runtime rank≈250）会覆盖 rank 300–600 的用户/custom 文件技能，与「保留用户自改技能」不符。已改用 `ctx.skills.registerProvider()`，provider 名 `dsh-luoome`，candidate `rank=BUNDLED_SKILL_RANK(600)`、source='bundled'、provider='dsh-luoome'：project(100/200)、runtime(250)、custom(300)、用户(400/500) 同名技能优先，本地 bundled 根(600)按注册顺序先于插件；插件只提供默认技能、不覆盖用户自改技能，dispose 时 provider 随 fiber 撤销。真实 SkillRegistry 11 项用例覆盖优先级矩阵/dispose/坏文件 fail-loud。注意：DSH web profile 的本地技能根位于 agent preset scoped layer，host 级全局 `ctx.skills.list()` 只看到插件 provider，验证用户覆盖需带 `ScopeKey` 读取。
- **未覆盖/遗留**：M4 三面板/client bundle/浏览器验收、M5 默认部署切换；`propose_strategy_version_draft` 未在 market 默认名单，strategy-lab 已写「不可用则退回对话 diff」降级，后续按需补面。

### 9.11 P1b M4 实施记录（2026-10-25）

> 需求来源：需求文档 §7、§9(M4)、§10.4。三块核心面板迁移为 dsh-luoome 正式 client slots，数据经宿主认证的 in-process read/market surface，旧「逐请求启动 Bun CLI」面板不再运行。

- **宿主数据通道**：新增 `packages/dsh-luoome/src/host/panels.ts`，在 `/api/luoome` prefix 下注册 `GET /api/luoome/state?panel=overview|strategies|review`。固定服务端 panel→工具映射（HTTP 只接受 panel，拒绝额外 query/tool/命令参数）：overview = 账户/持仓/触发/关注/Advice/市场状态 + sentiment/index quotes；strategies = 策略目录/健康/operational published runs/待补观察 + 每策略 workspace（≤20）；review = Advice stats/confidence calibration/DecisionReview/Advice 反馈/decision loop/待补观察。响应 `{panel, asOf, tools:[{name, ok, data|error}], strategies?}`，只投影 ToolResult（不重算 PnL/统计/发布资格），全部 no-store；未知 panel 404、非法参数 400、非 GET 405+Allow、认证/Host/Origin 沿用 `Connection.admit`（未登录 401、非 owner 403）；market 调用 4s 有界取消。
- **Client**：`packages/dsh-luoome/src/client/` 迁移旧面板展示资产（overview/strategies/review/primitives/format/theme），运行时不再依赖 dsh-bridge；数据层同源 `fetch('/api/luoome/state?panel=…', {credentials:'same-origin', cache:'no-store'})`，无 localStorage 授权。`index.js` 以 `{name:'dsh-luoome', inject:['slots','layout']}` 注册 `luoome-overview/strategies/review` main keyed slots + `sidebar.panellist`。策略面板增加当前版本/最近 published operational run/数据健康/结果信号摘要/待补观察与「在对话中研究此策略」（`data-strategy-id`/`data-run-id`，点击经官方 layout 导航到对话并记录研究请求，不自动提交/发布）；复盘面板增加真实 confidence calibration 分桶、DecisionReview 最近记录与来源、逐条用户反馈（未回填不推断）、样本数/未知/限制；保留事实时点/source/反证/风险/免责声明/有效期、loading/error、窄屏可读。
- **打包**：package.json 增加 `exports['./client']`、`dsh.client={platform:'web',inject:[layout,sidebar]}`、`files` 含 `dist/client.js`；`scripts/build-client.ts` 产出 CJS + `window.__ModuleLoader__.load` 包装、React external，client.js = 98,996 B（≤800 KiB），断言 external/包装/体积。tarball = package.json + host.js + client.js + 四技能 SKILL.md（585,867 B）。
- **验收**：`test` 282 文件/2651 项、`test:dsh-luoome` 126 + 12 e2e、`test:plugin-install`（client 经 boot graph 真实提供、state 三面板 200/no-store/401/404、无 MCP/Bun CLI/worker/probe）、`test:panels-browser`（本机 Chrome 155 headless + CDP、官方 token 登录；三侧栏/三面板 DOM 与 state/DB 一致、刷新一致、390×844 无横向溢出；截图/JSON 存临时目录）、typecheck/lint/check:layers/build/git-diff 全通过。
- **未覆盖/遗留**：五页其余页面与 SSE/stream 重连补取；真实供应商成功路径与真实模型质量；tarball 仍是本地安装且 `@luoome/*` 为 workspace:*（P5 registry/固定版本）；真实 DSH 审批 UI 写操作完整浏览器端到端沿用 M2b 证据；405/Allow 在 handler 级单测覆盖（HTTP carrier 对提前拒绝 POST 的传输层限制已记录）。

### 9.12 P1b M5 默认部署切纯插件与切换/回退演练（2026-10-25）

> 需求来源：需求文档 §9(M5)、§10.1、§11；plugin 详细设计 §8 切换/回退。本切片把**默认部署**切到纯插件做隔离演练，不操作真实服务器/个人库；**未在真实生产执行切换**，旧 MCP/Bun 源码未删除（P5）。

- **默认部署切换**：`deploy/dsh/compose.yaml` 只剩 `dsh-web`（Node + DSH + dsh-luoome）与 `caddy`；移除 MCP 实例、worker/queue probe、`LUOOME_MCP_*` 与 worker 专属地址。新增 `deploy/dsh/profile-seed.mjs`（Node ESM）：把构建产物 tarball 安装进 `$DSH_HOME/profiles/<name>/node_modules/dsh-luoome`、按包链接 DSH `@deepseek-ai/*` 模块、写 profile manifest/补丁层；重复执行幂等，只重写插件文件与补丁，不改会话目录与事实库。`entrypoint.sh` 先 seed 再用 Node `dsh --profile` 启动，owner 缺失在 shell 层 fail-closed，另留 `seed` 角色只装配不启动。`Dockerfile` 改为两阶段：Bun 仅构建/打包插件，运行阶段 Node + 全局 DSH，不再复制旧源码/旧 `.dsh` 技能。`production.env.example` 用 `LUOOME_OWNER_*`/`LUOOME_HOME`/`LUOOME_MARKET_PROVIDER` 替换 `LUOOME_MCP_*`；Caddy 路由不变（basic auth + 反代 dsh-web）。旧 `deploy/dsh/bootstrap.ts` 保留并标注 LEGACY，默认部署不再调用。
- **隔离切换/回退演练**：新增 `infra/dsh/plugin-switch-acceptance.ts`（`bun --no-env-file infra/dsh/plugin-switch-acceptance.ts`）。临时 DSH_HOME/workspace/profile + 本地 tarball，用真实 DSH CLI（Node v22.22.2）启动完整 Web；结果：插件激活（read 45 工具、8 条 policy、`automationsEnabled=false`）；client bundle 经 boot graph 提供；三面板 `/api/luoome/state` 200/no-store 且 panel→工具映射匹配；四条技能经真实 `ctx.skills` catalog 可见、无旧技能；`list_accounts` 返回隔离库真实账户；一条 `create_strategy` 确认写入（prepare 冻结输入 → 一次性 confirmation token → confirm，production 操作表单路径）成功、可经 read 工具回读、通用 `/api/luoome/call` 对写工具 403；Node SQLite 重开并在再次启动 DSH 后仍读到同一事实；运行进程 descendant=0，无 MCP client/server、Bun CLI、旧 Bun Web、analysis worker、queue probe，启动 env 无 `LUOOME_MCP_*`/`DSH_WORKER_*`。
- **一致性备份与回退**：用 `node:sqlite` 的 backup API 在 DSH 运行时取在线快照（不复制活跃 WAL 主文件），快照单文件复制到独立目录后可独立打开且 `integrity_check=ok`。回退演练先停新写入（停 Web、旧 origin 不可达），恢复切换前副本（account 1 / strategy 0），再把切换后快照中的新增策略按业务键合并进回退副本（账户行指纹不变、新事实保留，`noNewFactOverwrite=true`）；备份后新增事实不能靠代码回退撤销。
- **部署静态断言**：`docker compose config --format json` 断言 services=`caddy,dsh-web`、运行环境无 MCP/worker 变量、`BUN_IMAGE` 只在 build args、owner/basic-auth 变量保持 fail-closed；`deploy/dsh/deployment-config.test.ts`（16 项）静态守卫 compose/env/entrypoint/Dockerfile/Caddyfile/profile-seed，并确认旧 `bootstrap.ts`/`queue-*` 源码仍在（P5 再删）。
- **验证（2026-10-25，仓库根目录）**：`bun --no-env-file run test` 283 文件/2669 项通过；`test:dsh-luoome` 16 文件/137 项通过；`test:plugin-install` 通过（read 45 / market 6 / 8 policies / 四技能 / 无 MCP/Bun/worker/queue probe）；`infra/dsh/plugin-switch-acceptance.ts` 输出完整 JSON 证据；`typecheck`、`lint`（0 error，24 条既有 warning 均不在本次改动文件）、`check:layers`、`build`、`git diff --check` 通过。DSH 实跑为 Node v22.22.2，构建用 Bun 1.3.14；Node 24 完整运行证据来自 MVP journeys 切片。
- **未覆盖/遗留**：**未在真实生产服务器执行切换，未删除旧 MCP/Bun 源码**（P5）；纯插件默认部署不承接五个 batch 与自动任务（P3，默认不启用自动任务）；回退合并演练只覆盖 strategy 一类业务键，真实运营需按 Advice/DecisionReview/策略版本等逐类核对；脚本/合成事实非真实模型质量与真实供应商成功路径；tarball 仍是本地安装、`@luoome/*` 为 workspace:*（P5 registry/固定版本）；模型侧 allowed-once 审批由 `dsh-authority.e2e.test.ts`/MVP journeys 覆盖，本演练不驱动模型。

### 9.13 MVP 最终验收记录（2026-10-25，M1–M5 汇总）

> 需求来源：需求文档 §10.1–§10.5。本记录只证明「协议/装配/审批/事实链路 + 隔离浏览器验收」，不证明真实模型质量、真实供应商成功路径或生产切换。

- **实现切片**：M1 Node DB（`@luoome/db/node`，Node 22/24 合约）→ M1 生产 composition（Node SQLite + 真实 adapters + 真实只读工具）→ M1 可安装插件空壳；M2a market external 面（含 `fetch_news` 分类修正）；M2b 8 条原生审批 policies（DecisionReview + record_advice/record_analysis_result + 策略 create/version/validate/publish + record_advice_outcome）；M3 四旅程技能 + provider/rank 注册（保留用户自改技能优先）；M3a 分 kind 事实时效；M4 三面板正式 client slots + 宿主 `/api/luoome/state` + Chrome CDP 浏览器验收 + client bundle（98,996 B）；M5 默认部署切纯插件（compose 仅 caddy/dsh-web、Node 运行插件、profile-seed 安装）+ 隔离切换/回退演练。
- **四旅程真实 Agent/审批 E2E**（`packages/dsh-luoome/src/host/mvp-journeys.e2e.test.ts`，真实 AgentLoop/SessionStore/ApprovalService + `@luoome/db/node`，脚本模型）：①策略制定 create/version/validate + v1 独立发布 + v1↔v2 有限样本 trial（不落 run）+ v2 独立发布 + 读路径/面板回读；②结果研究 run/version/fact 引用 + proposal 经审批保存但不发布；③复盘 DecisionReview 审批 + AI 代填负例无写入 + 用户明确反馈后 outcome revision 2；④每日市场分析 market external 刷新保留 source/dataAsOf/partial/unavailable，形成 Advice 需另取 context 并经审批、可读回。
- **负例/恢复矩阵**：未审批/拒绝/取消/子 Agent/跨账户/过期无写入；create/validate 不隐含 publish；record 重放不重复；response loss 只 reconcile 不重放；trial 不污染 operational run；external 失败不冒充空成功；trade 不在 read/market allowlist/policy/ToolRuntime，`LUOOME_EXPOSE_TRADE=true` 在 IO 前失败。审批 wrapper 层的晚到审批/无 Agent 等负例仍由既有 `dsh-authority.e2e.test.ts` 覆盖（同一生产 guard 路径）。
- **Node 24**：`test:mvp-journeys` 使用真实 Node v24.22.1 跑通 11 项 journeys；构建后插件安装到临时 DSH profile，由 Node24 启动真实 DSH CLI（Web profile），45 项只读工具、`list_accounts`、`prepare→confirm` 原生确认 `record_advice` 写回并读回成功，exit 0。
- **浏览器**：`test:panels-browser` 使用本机 Chrome 155 headless + CDP、官方 token 登录，验证三侧栏/三面板、DOM 与 `/api/luoome/state`/数据库一致、刷新后一致、390×844 无横向溢出；截图/JSON 存临时目录。`test:plugin-install` 验证安装产物含 host+client+四技能、45 read/6 market/8 policies、`/call` 写工具 403、未审批 prepare 不写、无 MCP/Bun CLI/worker/queue probe。
- **M5 部署**：默认 compose 仅 `caddy`+`dsh-web`、运行环境无 `LUOOME_MCP_*`/`DSH_WORKER_*`、Bun 仅构建阶段；`infra/dsh/plugin-switch-acceptance.ts` 在临时 DSH_HOME 完成插件安装、真实 DSH Web 启动、三面板/四技能/只读工具/一次原生确认写入/重开持久，并验证 `node:sqlite backup` 在线快照、回退演练按业务键合并（pre 1/0 → post 1/1），进程无 MCP/Bun CLI/旧 Web/worker/probe。
- **验收命令**：`bun --no-env-file run test`（283 文件/2669 项）、`test:db`（601）、`test:db:node`（Node 22/24）、`test:dsh`、`test:dsh-luoome`（137 + 12 e2e）、`test:plugin-install`、`test:panels-browser`、`test:mvp-journeys`、`typecheck`、`lint`（0 error）、`check:layers`、`build`、`docker compose config`、`git diff --check` 全通过；未 commit/push，未触碰真实个人库/生产服务器。
- **已知缺口（不能据此宣称 §10 全部完成）**：① 真实模型质量与真实供应商/真实 DSH 模型人工 smoke 未做；② `get_analysis_context` 对 `advice_market` 仍不收集非空市场事实（目前可用既有持久化/合成事实构造 context 走审批；装配器补强另立任务）；③ 五页其余页面、SSE/stream 重连补取、图表未做；④ 五个 batch/自动任务未迁入纯插件（P3）；⑤ 真实 DSH 审批 UI 写操作的完整浏览器端到端沿用 M2b 证据；⑥ registry 发布/固定版本、旧 MCP/Bun 源码删除（P5）；⑦ `record_advice_outcome` 只落 DecisionReview revision（读面派生 outcome），是否同步旧表需领域再评审；⑧ `get_advice` 过期过滤使用墙钟而非 `ctx.clock`，固定时钟测试需 `includeExpired`。

### 9.14 M6 收尾修正（2026-10-25）

> 需求来源：需求文档 §3.4/§5-3 与 §9.13 已知缺口。只修事实装配/时钟语义/历史表口径，不扩大写面。

- **`advice_market` 事实装配**：`get_analysis_context` 对 `subject.kind==='market'` 现在只读本地持久化事实装配，不引入外部 IO：涨停天梯 PIT 快照（最近 7 个交易日回查）、`computeRelevantStockIds` 对应股票的最新已保存行情、未来 7 天已持久化公司事件；`dataAsOf` 取事实中最新可验证时点，写回窗口仍为 `analysisTimingRules.advice_market`（24h/7d）；缺少指数/宽度/情绪/新闻/财报时只写 limitations/unavailable，无任何可验证事实时 context 不可写（不伪造 now）。因此「每日市场分析 → 形成 Advice」可走正常 `get_analysis_context → record_advice` 链路，不再依赖合成 context。
- **`get_advice` 时钟**：过期过滤由 `new Date()` 改为 `ctx.clock()`；为保持「先过滤过期、后 limit」语义，仓储查询改为 `includeExpired:true` 取全量后按 `validUntil > now` 过滤再 slice，输入默认值/含义不变。
- **`record_advice_outcome` 历史表评审**：AdviceOutcome 读面已完全由 DecisionReview 派生（`get_advice`/stats/calibration/weekly report），`advice_outcomes` 表仅历史/审计用途，生产读路径不依赖；结论为**不双写、不改 DDL**，仅在工具/决策复盘代码注释中标注持久化口径。若未来删除该表需单独立项迁移。
- **测试/验收**：新增 4 项（有事实时装配/写回、无事实不可写、固定 clock 早于/晚于 validUntil 的默认与 includeExpired、过期过滤先于 limit）；`test` 283 文件/2673 项、`test:db` 601 项、typecheck/lint/check:layers/git diff 全通过。
- **残余缺口**：对话中刷新的 external 市场事实（指数/新闻等）仍未进入 context（market snapshot/news 无 repo 持久化，装配禁止外部 IO）——若要 Advice 引用刚刷新证据，需后续决定持久化 market snapshot/news 或给 context 增加受控 facts 输入；`computeRelevantStockIds` 当前为市场级（所有账户持仓 ∪ 全局 Watchlist），若要求严格 account-scoped 个人上下文需另改。
