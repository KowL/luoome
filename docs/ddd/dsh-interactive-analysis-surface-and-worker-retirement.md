# dsh-luoome 纯插件 MVP 实施设计

> 日期：2026-10-24。状态：产品路线已确认，待实施。
> 本文取代同文件此前的“先补 MCP 过渡形态”方案。最终验收路径不包含 MCP、Bun CLI、旧 Bun Web 或常驻 analysis worker。
> 目标：直接在 DSH Node 进程中运行 `dsh-luoome`，通过 AI 对话完成策略制定、策略结果研究、复盘和每日市场分析，并提供看板、策略、复盘三块核心面板。

## 1. 路线决定

1. **只做纯插件形态，不再为 MCP 过渡形态增加产品能力。**
2. DSH 是唯一用户入口和唯一模型宿主；luoome 领域层继续只负责事实、规则、校验和持久化。
3. MVP 走交互式分析，不创建 `analysis_job`，不部署 worker，不新增生产 workflow 入队。
4. 默认部署移除 `dsh-worker`。队列实体和已有测试可以保留作历史/未来能力，但不进入 MVP 运行路径，也不为删除它们扩大本次改动。
5. 不重写领域业务。复用 `core / db / tools / workflows / adapters` 和已有 `dsh-luoome` P1a 的只读、Operation、Approval、HTTP 准入与调度身份内核。
6. MVP 先覆盖四个对话场景和三块面板。五个 batch 全自动迁移、完整五页、设置中心和旧 Web 全部功能承接不属于本次完成门槛。
7. 不修改生产服务器、不执行 live deploy、不读取或修改真实个人事实库。所有自动验收使用临时 DSH_HOME、临时 SQLite 和合成事实。

如果工作树已按上一版 MCP 文档产生改动，停止继续扩大该路线；不要擅自回滚用户或其他 Agent 的改动。纯插件 MVP 不得依赖那些 MCP 新增文件才能运行。

## 2. 目标架构

```text
DSH Node 进程
└─ dsh-luoome
   ├─ native read surface       只读事实
   ├─ native market surface     精确 external 白名单，刷新市场事实
   ├─ native analysis surface   交互 context + 经原生审批的 record
   ├─ native operation surface  策略、DecisionReview、用户反馈的确认写入
   ├─ React slots               看板 / 策略 / 复盘
   └─ packaged skills           四类投研对话流程
          ↓
       tools → core
          ↓
       db / adapters → core
          ↓
   $LUOOME_HOME/luoome.db（Node SQLite）
```

边界：

- 模型只存在于 DSH；领域包不得导入 AI SDK 或 DSH SDK。
- host 只调用 tools/既有操作服务，不直接访问 repository 或复制领域规则。
- 面板只投影 ToolResult，不在浏览器重算 PnL、统计、发布资格或复盘口径。
- `record_advice` / `record_analysis_result` 只能用于无 job 的交互 context；claim/complete/fail 等 queue 管理工具不注册到 MVP。
- Advice、策略发布、DecisionReview 和用户反馈必须经 DSH 原生审批；模型自报的 approved、callId、taskId 或 prompt 都不是授权。
- trade 永不注册；`record_decision_trade` 也不因“人工记账”而进入 MVP。

## 3. MVP 用户旅程

### 3.1 策略制定

用户在 DSH 对话中描述策略，系统完成：

1. 读取现有 Strategy、版本、DSL catalog 和必要数据健康事实；
2. AI 生成可解释的 StrategyVersion 草案，不直接发布；
3. 使用既有确定性 schema/validation 校验；
4. 在显式、有限样本上执行 `trial_strategy_version` 或既有非持久化试跑，不污染 current operational run；
5. 展示 definition diff、规则解释、样本范围、数据缺口和试跑结果；
6. 用户通过原生审批确认后创建/发布；
7. 策略面板可以回读同一 Strategy 和版本。

MVP 允许的最小操作策略：

- `create_strategy`
- `create_strategy_version`
- `validate_strategy_version`
- `publish_strategy_version`

`trial_strategy_version` 走独立 market/research external 面，不因为它能访问外部数据就获得写权限。自动 schedule、autonomy、全市场正式运行和自动发布不在 MVP 门槛内。

### 3.2 策略结果研究

用户询问“这个策略最近跑得怎样/为什么选出这些股票/该怎么改”：

1. 读取确切 Strategy、StrategyVersion、published operational StrategyRun、Result/Signal、SignalObservation 和 `get_strategy_insight_facts`；
2. AI 区分执行事实、数据缺口、事后观察和推断，不把观察称为严格回测，不承诺收益；
3. 结论引用真实 run/version/fact id；
4. 如果只是解释，对话完成，不强制落库；
5. 如果形成版本修改，复用 3.1 的草案、校验、试跑和确认路径；可选通过 `record_analysis_result` 保存带来源的 proposal，不得直接发布。

### 3.3 复盘

用户询问“当时的判断如何/我实际怎么做了/错在哪里”：

1. 分别读取 Advice 当时快照、DecisionReview 修订、显式关联 Trade、SignalObservation、账户绩效和 confidence calibration；
2. AI 不根据同股、同日或后市涨跌推断用户跟随，不伪造盈亏；
3. 用户可以保存复盘笔记，使用已有 `save_decision_review` Operation；
4. 只有用户明确说明跟随/部分跟随/忽略及实际结果时，才允许通过原生审批调用 `record_advice_outcome`；
5. AI 的事后判断质量分析与用户 outcome 是两类信息，不得混写；
6. 复盘面板展示同一统计口径，并保留样本数、未知和数据缺口。

### 3.4 每日市场分析

用户要求“今天市场怎么样/给我今日分析”：

1. 通过精确 market external 白名单刷新需要的指数、市场宽度、情绪、要闻和行情状态；
2. 每项保留 source、observedAt/dataAsOf、完整性和 unavailable/partial 原因；
3. 读取本地持仓、关注、策略和既有建议作为个人上下文，但不把有限样本推断成全市场事实；
4. DSH 生成市场分析，明确事实、反证、风险、未知和有效期；
5. MVP 的日常市场分析可以先保存在 DSH 会话中，不强行为它新建领域实体或伪造 Report；
6. 如果用户进一步要求形成 Advice，必须另取有效 AnalysisContext，经原生审批调用 `record_advice`，不能直接把聊天文本当 Advice。

晨报自动持久化、`save_report` 开放和定时推送不属于本次 MVP 门槛，另立后续任务。

## 4. Native surface 设计

### 4.1 Read

基于 `createReadSurface` 和 `registerReadTools` 扩展生产配置，不复制一套 registry。

Read 至少覆盖四场景和三面板需要的现有只读工具，包括：

- 账户、持仓、Advice、Watchlist/Trigger；
- Strategy、版本、运行视图、结果、信号、观察、insight facts；
- DecisionReview、Advice stats、confidence calibration、账户绩效；
- `get_analysis_context`；
- 市场状态和必要的本地市场事实。

私有研究读取默认关闭，只有产品明确开启时才按精确名单暴露。Read surface 不得因为 allowlist 误配而注册 write/external/queue/trade。

### 4.2 Market external

新增独立、精确白名单的 native surface，用于对话主动刷新事实。候选工具按实际 schema 对账后选择：

- `fetch_index_quotes`
- `get_ashare_sentiment`
- `fetch_news`
- `fetch_quote` / `batch_quote`（仅场景需要时）
- `trial_strategy_version`

要求：

- 不把 `send_notification`、远程研究导入、同步写库或任意 external 工具一并开放；
- 注册与执行使用同一配置快照；
- 保留 ToolResult、数据来源和失败语义，不能把 external 失败包装成成功空数据；
- DSH 调用有超时、取消和有界输入，长试跑不得阻塞普通只读请求。

### 4.3 Interactive analysis

共享名单固定为：

```ts
[
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
]
```

但 host 不直接把两个 record 当成无保护普通工具暴露：

- `get_analysis_context` 可通过 read surface 调用；
- record 由 DSH 原生 confirmed operation 包装；
- prepare 冻结 account、contextId、result、provenance 和 requestId；
- ApprovalService 展示将保存的结论、证据、反证、风险、有效期和策略影响；
- 执行时再次读取 context，由领域工具校验 contextHash、factIds、写回窗口和不变量；
- response loss 只核对 context.recordedResult/业务结果，不自动再次推理或写库；
- 不开放 claim、complete、fail、requeue、cancel、metrics 或任意 job 查询。

`AnalysisProvenance` 必须记录真实 generator/model/skillVersion/contextId；未知模型字段保持未知，不编造。

### 4.4 用户与策略 Operation

在现有 `decisionReviewOperation` 之外，按最小范围增加显式 policy：

- `record_advice_outcome`：只允许用户明确反馈，skill 不得自动填写；
- 策略创建、版本创建、校验和发布：各自独立 policy，发布不能被创建或校验隐含批准；
- 不把整个 settings registry 交给通用 `/call`；
- 每个 policy 绑定 owner/account、冻结输入、过期时间和业务回执；
- scheduled 默认 false，AutomationGrant 默认不参与 MVP。

## 5. 必须同步修正的事实契约

仅开放 surface 不能算跑通，需要完成以下最小修正：

1. 策略研究使用的 `strategy_version_proposal` / `strategy_insight_narrative` 不应被统一的“事实距现在 30 分钟”规则误伤；其时效应根据 StrategyRun/dataAsOf 和研究有效期判断，不能拿旧实时 Quote 的规则套策略历史事实。
2. `writeUntil` 的 15:00 截断只适用于明确的盘中行动上下文，不能让所有非盘中研究在收盘后恒过期。按 AnalysisKind/结果 horizon 明确规则，不为通过测试统一取消时效。
3. 每日市场分析所需的 external 事实必须真实可达；缺少新闻、宽度或财报时保留 unavailable，不从模型记忆补齐。
4. `get_analysis_context` 当前声明 read 却保存审计 context。保留并明确“读业务事实 + 持久化审计快照”的语义，或经评审调整分类；不得隐藏这次写入。
5. 所有 AI 写回仍使用既有 record 工具，不在 host 里构造 Advice、Report 或 StrategyVersion 绕过领域校验。

## 6. Node DB 与生产插件装配

### 6.1 Node DB

完成设计中的 P1b，而不是用 memory fixture 冒充生产：

- 新增 `@luoome/db/node`，使用 `node:sqlite`；
- Bun 默认入口保留，Node 入口的依赖图不得经 barrel 引入 `bun:sqlite`；
- 抽取共享 DDL/schema，Bun/Node 不维护两份漂移定义；
- memory、Bun、Node 运行同一套适用 contract tests；
- 空库和旧库副本各执行两次迁移，验证幂等、WAL、busy_timeout、重开持久化；
- 验证两个 Node 连接的锁竞争、Operation CAS、fencing 和响应丢失后的回执核对；
- 目标运行时按 Node 24 验证；Node 22 的现有测试不能替代该门槛。

### 6.2 Host composition root

在 `packages/dsh-luoome` 新增生产装配，不从 CLI/MCP/Web surface 偷取 context：

- 创建 Node DB、repository registry、真实 adapters 和 ToolContext；
- owner principal 由受信任部署配置绑定账户，HTTP/模型参数不能提升账户或权限；
- 配置在装配时冻结，dispose 后旧闭包全部拒绝；
- `LUOOME_EXPOSE_TRADE=true` 在任何 IO 前失败；
- 真实供应商失败按 ToolError 返回，不使用 mock 生产数据。

### 6.3 可安装插件包

`packages/dsh-luoome/package.json` 和构建产物必须具备真实 DSH 插件声明、host/client exports 和版本固定依赖。

提供生产 `apply()`/profile 装配，不再只有 `src/testing/web-fixture.ts` 能启动。最终包包含：

- Node host；
- 三块 client slots；
- MVP skills；
- 必要样式和静态资源；
- 安装/升级所需的补丁。

验收安装包不引用仓库 TS 源码，不要求目标机器存在 Bun、luoome CLI 或 MCP server。

## 7. 三块核心面板

复用 `dsh-bridge/src/panels` 的展示资产，但迁移为 `dsh-luoome` 的正式 client，不在运行时依赖旧面板插件。

数据通道使用宿主认证的原生 HTTP/read surface，禁止逐请求启动 Bun CLI。

### 7.1 看板

保留现有市场、持仓、触发、关注和建议卡；显示事实时间、来源、反证、风险、免责声明和有效期。刷新只读事实，不触发模型。

### 7.2 策略

至少包含策略目录、当前版本、最近 published operational run、数据健康、结果/信号摘要和待补观察。提供“在对话中研究此策略”的明确入口，携带 strategyId/runId，而不是让用户复制标识。

### 7.3 复盘

在现有 stats/pending 基础上，至少增加：

- `get_confidence_calibration` 的真实分桶校准；
- DecisionReview 最近记录与来源；
- 逐条建议的用户反馈和后续观察；
- 样本数、未知盈亏和时间范围过滤。

不得继续只显示平均信心却宣称完成“信心校准”。AI 归因在对话中完成，面板不生成模型内容。

## 8. Skills 与默认 worker

将 MVP skills 随 `dsh-luoome` 打包，至少形成四个明确入口：

- `strategy-lab`：策略制定、校验、试跑、确认发布；
- `strategy-result-review`：运行/结果/观察研究与版本草案；
- `post-close-review`：当时依据、用户行动、后来事实分开；
- `daily-market-analysis`：真实市场事实与个人上下文分析。

修正现有技能语义：

- 不再出现 `mcp__luoome*` 工具名；
- 不引用 `luoome-worker`；
- `record_advice_outcome` 只在用户明确反馈后使用；
- `save_decision_review` 走原生 Operation；
- 写 Advice/发布策略前展示冻结内容并等待原生审批；
- context 失效时重取一次并重新核对，不重放旧结果。

默认安装不包含 `analysis-worker`，默认 compose/profile 不包含 `dsh-worker`、queue probe、worker interval/prompt。已有队列代码和手动测试可保留，但不属于 MVP 产品路径。

## 9. 实施顺序

按可验证竖向切片执行，不并行重写所有层：

1. **M1 Node DB + 生产 composition**：Node 合约、迁移、真实只读工具、可安装空壳插件。
2. **M2 Native read/market/operations**：权限、Approval、回执、取消和超时；先跑通 DecisionReview 与策略草案。
3. **M3 四条对话旅程**：skills、交互 record、事实时效修正和负例。
4. **M4 三面板与打包**：宿主数据路由、对话下钻、浏览器验收、无 Bun/MCP 安装包。
5. **M5 默认部署切换**：移除 worker 和旧生产入口；备份/回退只写方案与隔离演练，不操作真实服务器。

每个阶段都保持现有测试通过；不得删除旧测试来掩盖新路线不兼容。

## 10. MVP 验收

### 10.1 运行形态

在干净临时环境安装构建后的插件：

- DSH 能加载生产 host 和三块 client；
- 业务数据来自临时 Node SQLite，重开后仍存在；
- 没有 MCP client/server、Bun CLI、Bun Web、analysis worker 和 queue probe 进程；
- 面板刷新和空队列不触发模型；
- 插件卸载后旧工具闭包失效。

### 10.2 四条真实旅程

用真实 DSH AgentLoop 和官方审批组件执行：

1. 对话创建策略草案 → 校验 → 有限试跑 → 用户批准发布 → 策略面板可见；
2. 对话读取指定策略运行 → 输出带 run/version/fact 引用的研究 → 形成草案时仍需独立审批；
3. 对话复盘 → 用户确认保存 DecisionReview → 明确反馈后才保存 outcome → 复盘面板口径一致；
4. 对话请求每日市场分析 → 真实或受控外部适配器返回带来源事实 → 回答保留 dataAsOf/partial/unavailable，不编造新闻和数字。

脚本模型可用于确定性自动验收，但要明确标注。最终产品验收还需一次使用真实 DSH 模型配置的人工 smoke；密钥不进入仓库、日志或测试输出。

### 10.3 负例与恢复

- read/market 不能调用 record、策略发布或 queue 管理；
- 未审批、拒绝、取消、子 Agent、跨账户和晚到审批均无业务写入；
- AI 不得自动填写用户 outcome；
- 未授权 publish 不会仅因 create/validate 被连带执行；
- record 重放不重复产生 Advice/publication；response loss 只核对不重复写；
- evaluation/trial 不污染 current operational run；
- external 失败不显示为正常空结果；
- trade 永不注册，`LUOOME_EXPOSE_TRADE=true` 启动即失败。

### 10.4 浏览器

实际启动完整 DSH Web profile，验证三面板、对话下钻、审批、刷新恢复和移动端基本可读性。截图不是唯一证据，必须核对页面数据与 ToolResult、数据库和回执一致。

### 10.5 回归

```bash
bun --no-env-file run test:all
bun --no-env-file run test:dsh-luoome
bun --no-env-file run typecheck
bun --no-env-file run lint
bun --no-env-file run build
bun --no-env-file run check:layers
```

另跑 Node 24 DB 合约、构建产物安装、无 Bun/MCP 运行检查和 `git diff --check`。

## 11. 非目标与完成口径

本 MVP 不承诺：

- 五个 batch、自动晨报、自动复盘、通知和持久 AutomationGrant 全部迁移；
- 完整五页、设置中心、导入导出、Vault 管理和旧 Web 全功能替代；
- 常驻 analysis worker 或自动分析生产者；
- 严格收益回测、自动交易或真实券商接入；
- 真实生产服务器已经切换。

只有第 10 节全部通过，才能宣称“纯插件 MVP 跑通”。仅有 P1a 测试、memory fixture、MCP discovery、脚本模型回答或三面板截图，都不能单独作为完成依据。
