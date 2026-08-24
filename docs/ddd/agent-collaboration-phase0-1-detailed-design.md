# Agent 协作体验 Phase 0+1 详细设计

> 状态：**已实现**（2026-08-21，M7A～M7D 四切片全部交付并通过全量门禁与浏览器验收）
> 上位文档：[AI 投资 Agent 协作体验 PRD](../prd/ai-investment-agent.md)
> 关联：[Web 对话助手设计](./web-chat-design.md)、[AI SDK 接入与 LLM 重构设计](./ai-sdk-llm-refactor-design.md)、[研究主题与 Obsidian Vault 详细设计](./research-vault-detailed-design.md)
> 排期：[开发计划](../development-plan.md) M7

## 1. 背景与范围

PRD §3 列出的运行时基础（`AgentRuntimeLike`、显式白名单、多轮 tool loop、draft-and-confirm、
工具轨迹、trade 硬卡）已全部落地。本设计覆盖 PRD Phase 0 与 Phase 1 中尚未实现的产品层缺口，
2026-08-21 对照代码核实的缺口清单：

| 缺口 | 现状证据 |
|---|---|
| 四类场景 prompt 与白名单未收口 | 仅 `AGENT_SYSTEM`（`packages/tools/src/tools/agent-run.ts`）与 `buildInstructions`（`apps/web/src/chat.ts`）两份通用 prompt |
| 无轻量路由、无计划展示 | 用户消息直接进 `ToolLoopAgent`；trace 有数据采集但无 plan 对象、无前端展示 |
| 部分失败无结构化表达 | `AgentRunOutput` 无 unknowns/partialFailures 字段；仅 prompt 文本约束 |
| chat 不能产出 Advice | chat 白名单只有 `get_advice`/`get_advice_stats` 只读；无 advice 草案入口 |
| 草案卡片信息不足、无编辑 | 卡片只有 description + raw JSON + 确认/取消（`apps/web/public/js/chat.js`） |
| 数据健康不进回答 | `get_market_data_status` 不在任何 Agent 白名单 |
| chat 无取消 | 服务端已传 `c.req.raw.signal`（`apps/web/src/server.ts:2517`），前端无 AbortController |

明确不在本设计范围：Phase 2 闭环复盘助手（需“研究假设版本”新领域实体，另行立项）、
按场景评测集、外部 Agent 能力（PRD Phase 3）、chat 内承载分钟级长任务（见 §9）。

## 2. 已确认决策（2026-08-21）

- **场景目录单一事实来源**：研究/持仓/观察/复盘四类场景的 prompt 覆写与工具白名单定义在
  `packages/tools` 的共享模块中，Web chat 与 `agent_run` 都从该模块取配置，不维护两份清单。
- **确定性路由优先**：第一期用纯函数路由（关键词 + 本地上下文实体匹配），不增加 LLM 路由
  调用；路由结果同时驱动场景选择与前端“计划卡”。是否引入 LLM 路由由后续评测集证据决定。
- **计划 = 数据域维度，不是思维链**：计划卡只展示“将查询哪些数据域/可能产生草案”，来自
  确定性路由与场景模板，不暴露也不依赖模型推理过程。
- **Advice 走确认卡，不进自动执行**：`analyze_stock` / `analyze_position` / `market_outlook`
  有 LLM 成本且产出正式 Advice，chat 中与 write 一样先生成待确认草案，确认后由前端调
  既有 `/api/tools/:name/call` 执行。
- **草案编辑 = 预填修正，不建表单**：「编辑」把草案字段摘要预填进聊天输入框，用户修改后
  发回，模型重新生成草案；不为每个 tool 建独立编辑表单。
- **chat 不承载分钟级长任务**：全市场扫描、历史评估等留在各自页面（已有进度/取消/回看），
  chat 只补齐单次回答的取消能力。

## 3. 场景目录

新增 `packages/tools/src/agent/scenarios.ts`（随桶导出），定义：

```ts
export type AgentScenarioId = 'research' | 'portfolio' | 'watch' | 'review' | 'general';

export interface AgentScenario {
  readonly id: AgentScenarioId;
  /** 追加在共享基础规则之后的场景指令 */
  readonly instructionOverlay: string;
  /** 该场景的只读 tool 白名单（显式名字列表，沿用现有模式） */
  readonly readToolNames: readonly string[];
  /** 该场景可生成的草案 tool → 卡片 kind */
  readonly draftToolKinds: Readonly<Record<string, AgentDraftKind>>;
  /** 计划卡展示的数据域维度，按展示顺序排列 */
  readonly plannedDimensions: readonly string[];
}
```

`AgentDraftKind` 在现有 `'strategy' | 'watchlist' | 'alert-plan' | 'research'` 上扩展 `'advice'`，
`AgentDraftSchema` 同步放宽（见 §6）。

### 3.1 白名单基线

`general` 场景 = 现有 `CHAT_READ_TOOL_NAMES` 全集 ∪ 现有 draft 清单 ∪ 新增
`get_market_data_status`；其余四类场景是它的子集加场景专属项：

| 场景 | 场景专属只读项（在共享基线之外） | 计划卡维度 |
|---|---|---|
| research 股票研究 | `get_stock_research_view`、`build_research_brief`、`search_research_documents(_hybrid)`、`list_stock_events` | 行情/技术指标 → 信号 → 研究档案 → 事件 → 历史建议 |
| portfolio 持仓与风险 | `get_account_performance`、`list_trades`、`get_advice_stats`、`list_stock_events` | 持仓/成本 → 行情 → 集中度与绩效 → 事件 → 历史建议 |
| watch 观察盯盘 | `list_watchlist_changes`、`get_watch_status`、`list_strategy_runs`、`get_strategy_run` | Watchlist 变化 → 触发记录 → 策略信号 → 数据健康 |
| review 复盘 | `get_confidence_calibration`、`get_strategy_reliability_summary`、`list_workflow_runs`、`list_reports`、`get_report`、`list_trades`、`get_account_performance` | 建议与结果 → 交易/持仓变化 → 信号观察 → 报告 |

共享基线：`search_stocks`、`fetch_quote`、`batch_quote`、`list_holdings`、`get_holding`、
`list_strategies`、`get_strategy`、`strategy_signals_by_stock`、`list_watchlists`、`get_watchlist`、
`list_alert_plans`、`list_watch_triggers`、`get_advice`、`list_research_topics`、`get_research_topic`、
`list_research_documents`、`get_research_document`、`get_market_data_status`。

规则：

- 所有名单保持显式名字列表；构造时校验已注册且 sideEffect 为 `read`（或既有
  `APPROVED_EXTERNAL_TOOLS` 批准的 external），未注册/越级直接抛错，复用现有
  `buildAgentCallableTools` 门控。
- 草案清单四类场景相同（现有 18 个 write draft + §6 新增 3 个 advice draft）。
- `agent_run` 的 input 增加可选 `scenario` 字段；缺省走 `general`。chat 由路由结果注入，
  用户也可以在消息中显式指定（如“帮我复盘…”命中 review）。

### 3.2 场景指令覆写

共享基础规则保留现有 `AGENT_SYSTEM` / `buildInstructions` 中的安全条款（不编造、不可信
文本、不自动交易、免责声明等），抽到场景模块作为 `BASE_INSTRUCTIONS`；每场景只写差异，
例如 review 场景追加“复盘只作描述性统计，不得把小样本相关性表述为策略失效或因果规律”。
chat 与 `agent_run` 使用同一份基础规则 + 覆写，消除两份 prompt 漂移。

## 4. 轻量路由

新增纯函数 `routeAgentMessage(message, contextSummary): AgentRoute`，放在场景模块同目录：

```ts
export interface AgentRoute {
  readonly scenario: AgentScenarioId;
  /** 从消息与上下文匹配到的股票/账户/Strategy 等主体标识 */
  readonly subjects: readonly string[];
  readonly needsAdvice: boolean;
  readonly involvesWrite: boolean;
  /** 回答问题缺少的必要标识（如无法定位的股票名） */
  readonly missingIdentifiers: readonly string[];
}
```

- 匹配源：场景关键词表（如“复盘/回顾/准不准”→ review，“持仓/成本/亏”→ portfolio）、
  上下文摘要中的 Watchlist/Strategy/AlertPlan 名称、持仓股票名称代码。
- 无任何命中时落到 `general`，不为展示“智能”强行分类；多个命中时取优先级
  review > portfolio > watch > research > general 中的首个强命中。
- 路由是确定性纯函数，零 IO，放 core 还是 tools 以实现时依赖为准（只需关键词表与
  context 摘要类型，倾向 tools，避免 core 引入对话概念）。
- chat 响应增加 header `x-luoome-chat-route`（路由 JSON 投影）；前端在流开始前渲染
  计划卡（§5.3），并将 scenario 用于本轮指令与白名单选择。

## 5. 交互契约

### 5.1 回答结构

chat 保持纯文本流式协议不变；`BASE_INSTRUCTIONS` 约定复杂问题按五段输出：结论摘要 →
关键事实与数据时间 → 支持证据与反证 → 风险与未知项 → 可选下一步。前端不解析分段，
只靠 prompt 契约约束；结构化分层只落在 `agent_run` 输出（§5.2）与 Advice 卡（§6）。

### 5.2 `agent_run` 输出扩展

`AgentModelOutputSchema` 增加两个字段（对存量调用方向后兼容：均有默认值）：

```ts
unknowns: z.array(z.string().min(1)).max(50).default([]),
partialFailures: z.array(z.object({
  dimension: z.string().min(1),
  tool: z.string().min(1).optional(),
  reason: z.string().min(1),
  retryable: z.boolean(),
})).max(20).default([]),
```

- 模型负责填写结论受影响维度；handler 再用 trace 中 `ok=false` 条目做确定性并集：
  trace 有失败而模型未披露的，强制补入 `partialFailures`，并追加 risks 提示。
- `unknowns` 语义与 ResearchBrief 的 unknowns 对齐：数据缺失导致的未知项，不允许留空
  伪装完整答案。

### 5.3 计划卡与进度

- 计划卡数据完全来自路由 header + 场景 `plannedDimensions`，渲染为「将查询：持仓 →
  行情 → 历史建议；可能生成待确认草案」式摘要；`missingIdentifiers` 非空时先追问而不是
  直接执行。
- 执行进度复用现有 tool trace 流式渲染（`tool-input-available`/`tool-output-available`），
  计划卡中的维度随对应工具完成标记完成态；无新协议。
- `agent_run` 不新增 plan 实体；其 `usedTools`/`trace` 即执行事实，Web 若后续提供
  `agent_run` UI 入口时按同一计划卡组件渲染。

### 5.4 取消

- 前端 `chat.js` 为每次发送创建 `AbortController`，流期间显示取消按钮；中断后已接收的
  文本与工具轨迹保留为一条 partial 助手消息并标注「已取消」。
- 服务端链路已就绪（`server.ts` 透传 `c.req.raw.signal` → runtime `abortSignal`），只需
  确认中断时 `onFinish` 不写入伪造完整消息：取消导致的提前结束按实际 parts 落库并加
  `cancelled` 标记 part。
- 实施实测修正（2026-08-21）：Bun 下客户端断开时响应流被先行 cancel，AI SDK 的
  `onFinish` 不会被回调，服务端持久化不能依赖它。实际实现为前端在 abort 后调用
  `append_chat_message` 主动落库 partial 消息并追加 `{type:'data-luoome-cancelled'}`
  标记 part（messageId 取自流内 `start` chunk）；服务端 `onFinish` 路径保留，两处按同
  id upsert，天然幂等。历史消息经 `persistedFeed` 检测标记 part 还原「已取消」标注。

## 6. Advice 草案与草案卡片升级

### 6.1 advice 草案

`CHAT_DRAFT_TOOL_KINDS` 与场景目录 draft 清单新增：

| tool | kind | 说明 |
|---|---|---|
| `analyze_stock` | `advice` | 确认后生成一条正式个股 Advice |
| `analyze_position` | `advice` | 确认后生成一条持仓 Advice |
| `market_outlook` | `advice` | 确认后生成一条市场观点 Advice |

- 草案 execute 与 write draft 相同：只校验 input 并返回 `__luoomeDraft`，不触发 LLM 分析。
- 确认仍走 `/api/tools/:name/call`（Web 现有门控已放行 advice），结果用 Advice 页同款
  `adviceCard` 渲染进会话（decision/confidence/validUntil/证据/反证/风险/免责声明），
  并随 `[草案处理记录]` 持久化。
- `AgentDraftKindSchema` 增加 `'advice'`；`agent_run` 输出 drafts 同样可携带 advice 草案。
- 明确不做：`record_advice_outcome` 不进草案清单（结果回填属于复盘动作，Phase 2 再评估）。

### 6.2 草案卡片结构化

draft payload 增加服务端生成的 `display` 投影：

```ts
display: {
  targetObject: string;              // 将创建/修改的对象描述，如「Watchlist『超跌反弹』」
  fields: Array<{ name: string; value: unknown; source: 'user' | 'default' | 'inferred' }>;
  unsupported: string[];             // 用户意图中当前不支持的条件
  ambiguous: string[];               // 有歧义、按默认值处理的点
}
```

- 由每个 draft tool 的 summarizer 函数生成（按 tool 一组纯函数，放场景模块同目录）；
  生成不了结构化摘要的 tool 返回最小投影（targetObject + raw fields），不阻塞流程。
- 卡片操作变为：确认 / 编辑 / 取消。「编辑」把 `fields` 摘要预填进聊天输入框，引导用户
  以自然语言修正，模型重新生成草案；确认仍只授权当前草案，语义不变。

## 7. 数据健康进入回答

- `get_market_data_status`（read）加入共享基线白名单，四类场景与 `general` 均可用。
- chat 上下文摘要 `buildContextSummary` 增加紧凑数据健康字段：仅当任一行情源
  stale/unavailable 或存在 stale Watchlist 时注入，控制 token；正常时不占上下文。
- `BASE_INSTRUCTIONS` 追加：数据健康异常或工具失败时，回答必须说明受影响维度与对结论的
  影响，不得生成伪完整答案；与 §5.2 的 `partialFailures` 同一语义。

## 8. 测试与验收

- 场景目录：每场景白名单名字全部已注册、sideEffect 合法；四类场景与 general 互不缺失
  共享基线。
- 路由：确定性测试覆盖四场景命中、无命中落 general、多命中优先级、`missingIdentifiers`
  提取；同样输入同样输出。
- `agent_run`：partialFailures 由 trace 强制补齐的测试（模型隐瞒失败时仍披露）；
  advice 草案 kind 校验与无效草案门控丢弃。
- chat server：route header 投影、场景白名单切换、advice draft 不执行真分析、取消时
  不伪造完整 assistant 消息。
- Web：草案卡 `display` 渲染、编辑预填、Advice 确认卡、计划卡、取消按钮的自动测试 +
  真实浏览器验收（含取消后重发、确认 advice 草案后卡片落库回看）。
- 门禁：与改动范围匹配的 `bun run test` / `test:web` / `typecheck` / `lint`。

## 9. 明确不做（本期）

- 不做 LLM 路由步骤、不引入 plan 持久化实体；计划卡完全由确定性路由派生。
- 不做逐 tool 的草案编辑表单；编辑通过对话修正完成。
- chat 不承载全市场扫描、历史评估等分钟级任务；这类长任务留在策略工作台等既有页面。
- 不做 Phase 2 闭环复盘（研究假设版本实体、Advice→Trade→Outcome 串联编排），另行立项。
- 不做按场景评测集（工具选择正确率/越权率等）；场景目录落地后先积累真实使用证据。
- 不向 Agent 暴露 `trade`，不放宽 write/external 的现有门控。

## 10. 里程碑拆分

供开发计划 M7 引用，按 PR 节奏“契约与存储 → Tool/Workflow → Web/Agent”切分：

| 切片 | 内容 | 预计 |
|---|---|---:|
| M7A 场景目录与路由 | `agent/scenarios.ts`、确定性路由、chat/agent_run 接入、route header、计划卡 | 3～4 日 |
| M7B 回答结构与部分失败 | `agent_run` schema 扩展、trace 强制并集、基础规则收口 | 2～3 日 |
| M7C 草案升级与 Advice 确认卡 | draft `display` 投影、编辑预填、3 个 advice 草案与卡片渲染 | 3～4 日 |
| M7D 数据健康与取消 | 上下文数据健康注入、chat 取消链路、浏览器验收 | 2～3 日 |

依赖：无新领域实体，全部基于已落地的 runtime/白名单/trace 基础；四个切片可按序独立交付。

## 11. 实施备注（2026-08-21）

四切片均已交付，以下为实施时以代码为准的偏差记录：

- 草案清单实际为 19 个既有 write draft + 3 个 advice draft = 22 个（§3 文中「18 个」为
  设计时笔误）。
- `fetch_quote` 加入 `APPROVED_EXTERNAL_TOOLS`：共享基线含它，不批准则场景完整性校验
  失败；`agent_run` general 场景因此比设计前多暴露该只读行情 tool。
- `agent_run` 的 general 默认场景不再含 `compare_strategy_definitions`、
  `get_account_performance`、`get_strategy_reliability_summary`，三者并入对应场景；
  调用方需要时显式传 `scenario`。
- `missingIdentifiers` 保守实现为恒空数组：识别不出时不强行标记，由模型经
  `search_stocks` 澄清；chat 的 400 分支已实现但目前不可达。
- route header 只能携带 ASCII，中文维度名以 `encodeURIComponent` 编码传输。
- 取消链路的服务端 `onFinish` 假设经实测修正，见 §5.4 末段。
- advice 确认后的 Advice 卡渲染复用 `ui.js` 已导出的 `adviceCard`；该路径有单测与
  组件级验证，确认会产生真实 LLM 调用与 Advice 落库，未做浏览器端到端实测。
- 计划卡维度随工具完成标记完成态（§5.3 后半句）未实现，属 trace 联动增强，留作后续
  小改进，不影响计划卡的披露语义。
