# luoome 开发计划

> 状态：当前执行计划
> 基线日期：2026-08-08
> 事实来源：[领域语言](../CONTEXT.md)、[架构说明](./ARCHITECTURE.md)、
> [产品需求](./README.md#产品需求prd)、[技术设计](./README.md#技术设计ddd) 与当前代码、测试

## 1. 目标与排序原则

后续开发分为三层，按以下顺序推进：

1. 完成详细设计中已经部分落地的竖向功能，先消除半成品和架构偏差；
2. 实现已有详细设计、但尚未开始或只具备底层支撑的新功能；
3. 对只有 PRD 或方向草案的新需求先立项并补详细设计，再进入编码。

所有计划以当前代码和测试为实现事实。文档顶部状态与代码冲突时，不以“待实施”等旧状态
机械排期；先修正文档，再按本计划执行。

## 2. 当前基线

### 2.1 验证结果

2026-08-08 在 `main`、干净工作树上完成基线验证：

| 验证项 | 结果 |
|---|---|
| Vitest | 138 个文件、963 项测试通过 |
| DB Bun tests | 228 项测试通过 |
| Web Bun tests | 147 项测试通过 |
| TypeScript | 所有 workspace `tsc --noEmit` 通过 |
| Biome | 460 个文件检查通过 |

这组数字只是本计划建立时的基线，不作为长期维护的固定测试库存。后续验收以
`package.json` 中的当前脚本和测试发现结果为准。

本轮 M0～M3 验收结果：Vitest 140 个文件、986 项通过；DB Bun tests 228 项通过；Web Bun
tests 155 项通过；TypeScript 与 Biome 均通过。另以真实浏览器检查了研究页的索引状态、三步
写入预览、默认 write/external permission gate，以及行情页日期深链接。

### 2.2 实现状态矩阵

| 领域 | 当前真实状态 | 主要缺口 |
|---|---|---|
| 行情底座 | StockUniverse、qfq DailyBar、Quote 新鲜度、capability registry 已完成 | 优先消费已有能力，不继续横向扩底层 |
| Strategy / Watchlist | 旧 Tactic、StockGroup、StockPool 已移除，目标模型已落地 | PRD/DDD 状态和部分架构示例滞后 |
| Strategy Workspace | Phase A～C 已完成，包括调度、运行租约、SignalObservation、事实洞察、定义 diff、草案审计与 persist=false 试算 | 后续只做体验增强，不改变确认边界 |
| Research Vault | Phase A/B、Phase C、M3 managed 创建/导入与 M4 FTS/ResearchBrief 已完成 | embedding、跨模型评测扩展和远端同步仍暂缓 |
| Market View | Phase 1/2 已完成；Phase 3 的事实关联、markers 和日期深链接已落地 | 账户/事实详情的更细粒度页面联动仍可增强 |
| Report / 复盘 | Report、三类简报、SignalObservation 描述统计已落地 | benchmark 仍 unavailable，不能称为回测 |
| 连板天梯 | Phase 1～3 已完成，包括 Tool、CLI/TUI/Web、daily-review、市场观点、行情/研究个股事实 | 后续仅补历史数据源能力与体验增强 |
| Workflow 架构 | 生产 workflow 已通过 workflow-only tools 编排，并有静态边界测试 | 后续新增 workflow 继续遵守同一边界 |

### 2.3 文档冲突处理

开发前统一遵守以下覆盖关系：

- `ResearchNote` 需求已被 [ResearchTopic / ResearchDocument 设计](./ddd/research-vault-detailed-design.md)
  替代，不恢复旧 ResearchNote CRUD。
- 旧 Watchlist PRD 中的自动 Strategy source 同步，不覆盖较新的 Strategy Workspace 决策；未来只能
  以显式 opt-in、complete sync 结束缺失来源的方式重新设计。
- [Agent Loop 技术选型分析](./ddd/agent-loop-tech-selection.md) 中“当前没有 agent loop”的描述已被
  AI SDK 和 Web chat 实现取代，不再按旧方案重复建设 loop。
- [ROADMAP](./ROADMAP.md) v0.8 以前内容是历史快照，不作为当前功能 backlog。
- SignalObservation 是真实事后观察，不是严格回测；benchmark、费用、滑点和 point-in-time
  universe 未满足前，不展示年化、胜率或回测曲线。

## 3. 依赖关系

```text
M0 事实源与 Workflow 边界收口
├─ M1 Research Phase C ──► M3 Research 导入 ──► M4 Agent 检索 ──► M5 Strategy AI 迭代
└─ M2 Market View Phase 3 ────────────────────────────────► M6 连板天梯 Phase 3
```

以下工期按单人或单 Agent 串行开发估算，表示有效开发日，不包含外部数据源审批、产品等待和
真实市场数据等待时间。

## 4. 第一优先级：完成部分实现

### M0：事实源与 Workflow 边界收口

**状态：已完成（2026-08-08）**

**预计：3～5 日**

#### 目标

在新增业务能力前修正文档事实，消除 workflow 绕过 tool 的架构偏差，为后续编排建立稳定边界。

#### 任务

1. 更新 Research、Market View、Strategy/Watchlist、Strategy Workspace、Vibe Report、Limit-up
   DDD 的实施状态与剩余范围。
2. 清理维护文档中的 ResearchNote、StockGroup、Tactic 等过期目标语言。
3. 将已被实现取代的 Agent Loop 选型结论标记为历史分析。
4. 将以下生产 workflow 的 repository 操作收进 workflow-only 原子 tools：
   - `sync-stock-events` 的 WorkflowRun 生命周期；
   - `evaluate-event-rules` 的 Watchlist 成员解析、事件查询、去重、Trigger 保存和送达回写；
   - `intraday-watch` 的 cooldown、WatchRuleState、Trigger 保存和送达回写。
5. 优先复用现有 `record_workflow_run`、`save_watch_trigger` 等内部 tool；确实缺失时新增最小原子
   tool，不把整个 workflow 包装成一个大 tool。
6. 增加静态架构测试，禁止生产 workflow 出现 `ctx.repos` 或 `ctx.adapters`。

#### 验收

- `packages/workflows/src` 非测试代码不再直接访问 repository 或 adapter；
- 事件提醒去重、盘中冷却、每日上限和送达状态行为不变；
- WorkflowRun 和 WatchRun 审计不丢字段；
- 全量测试、typecheck、lint 通过。

### M1：完成 Research Vault Phase C

**状态：已完成（2026-08-08）**

**预计：5～8 日；依赖：M0**

#### 目标

将现有“可同步、可搜索”的 Research Vault 补成可日常使用的研究工作台，不提前引入远程导入
和 AI 写入。

#### 任务

1. Repository 增加 Topic/Document 的 SubjectLink、TopicDocument 关系查询，并保持
   Drizzle、memory 和 contract tests 一致。
2. `get_research_topic` 返回真实 subjects、当前 thesis、资料关系和索引状态；不再固定返回空
   subjects。
3. 扩展 `get_stock_research_view`，聚合：
   - Topic、Document；
   - StockEvent；
   - StrategySignal、WatchTrigger；
   - Advice；
   - 当前账户范围内的 Trade；
   - 类型化时间线。
4. Web 研究首页增加 kind 筛选、最近资料、未分类 Inbox、Vault/index 状态和手动同步入口。
5. Topic 详情增加显式股票、资料关系、证据/反证、未解决问题、类型化时间线和 Obsidian
   跳转。
6. 明确展示 fresh、stale、missing、invalid、conflict；索引不可用不能显示成正常空结果。
7. 手动同步继续经过 write opt-in、token 和 Origin 闸口。

#### 验收场景

1. 无股票关联的宏观 Topic 可以独立浏览。
2. 一个产业 Topic 显式关联多只股票，相关股票研究投影都能看到。
3. 一个 Document 可以属于多个 Topic，关系稳定且不复制正文。
4. Vault 离线时仍展示上次索引并标记 stale。
5. StockEvent 不依赖 Vault，事件提醒无回归。
6. Web 自动测试和真实浏览器验收通过。

### M2：完成 Market View Phase 3

**状态：已完成（2026-08-08）**

**预计：4～6 日；依赖：M0，可与 M1 独立实施**

#### 目标

让行情页成为研究、建议、交易与触发事实的统一查看入口，而不是孤立的 K 线页面。

#### 任务

1. Watchlist、AlertPlan、WatchTrigger、Trade、Advice、Report、Research 页面统一使用股票身份
   链接组件。
2. 为 Market View 提供当前账户范围内的 Trade、Advice、WatchTrigger 关联查询。
3. 将关联事实转换为图表 markers；marker 点击可回到事实详情。
4. Marker 必须保持语义：Trade 是用户行动，Advice 是建议，Trigger/Signal 是事实，不能混成统一
   买卖标记。
5. 支持 `date` 深链接，复盘场景可以定位历史日期并保留 `stockId/range`。
6. 所有 marker 按账户、股票和图表时间范围过滤。
7. 评估将 `get_stock_market_view` 加入 Agent external 白名单；默认建议继续要求 external
   opt-in。

#### 验收

- 从持仓、研究、Advice、Strategy、WatchTrigger 和 Trade 均可进入同一个 Market View；
- 图表 marker 与真实对象一一对应，跨账户数据不泄漏；
- 历史日期深链接可复制、刷新和浏览器返回；
- 页面离开后 timer、chart 和事件监听正常释放；
- Web tests 与真实浏览器验收通过。

## 5. 第二优先级：实现已有详细设计的新功能

### M3：Research managed 创建与导入

**状态：已完成（2026-08-08）**

**预计：8～12 日；依赖：M1**

拆为两个可独立交付的阶段。

#### M3A：本地 managed 创建，4～6 日

**状态：已完成（2026-08-08）**

- `create_research_topic`；
- `create_research_document`；
- `link_research_document`；
- `archive_research_topic`；
- Markdown/TXT 或已提供 Markdown 内容导入；
- `expectedContentHash` 乐观并发控制；
- 只允许写 managed root，不修改 unmanaged 文件；
- Web 使用“内容预览 → 路径与关系确认 → 写入”三步交互。

已实现：managed root 原子创建、Markdown/TXT 规范化、本地关系与归档 Tool、
expectedContentHash 更新校验、索引失败可重建，以及 Web 写入门控和确认预览。

#### M3B：外部资料导入，4～6 日

**状态：已完成（2026-08-08）**

- `import_remote_research_document` 单独声明为 external；
- URL/HTML/PDF 抽取；
- SSRF、重定向、媒体类型、大小和超时限制；
- 原件与附件 hash 去重；
- 外部内容始终作为 untrusted data，不进入 system instructions；
- 导入完成不自动生成 Advice。

已实现：独立 `external` tool、原件 hash 去重、HTML/纯文本/PDF 安全抽取、SSRF/重定向/媒体
类型/大小/超时限制，以及 Web/MCP 的 external opt-in 门控。

#### 验收

- 取消确认不会留下文件或索引半成品；
- 文件写入成功、SQLite apply 失败时，下次同步可确定性修复；
- unmanaged 文件写入返回 permission_denied；
- 本地 write 与远程 external 的 sideEffect、MCP/Web 门控明确分离。

### M4：Research Agent 检索

**状态：已完成（2026-08-09）**

**预计：6～9 日；依赖：M1，推荐在 M3 后实施；实际于 2026-08-09 完成**

#### 任务

1. 已落地真正的 FTS5；启动和查询失败时正式降级为 metadata 搜索，并保留 capability。
2. `search_research_documents` 已如实返回 `capability='fts' | 'metadata'`，命中附带 chunk ordinal。
3. 已新增结构化 `ResearchBrief`：
   - scope、conclusion；
   - facts 与 EvidenceRef；
   - inferences；
   - counterEvidence、risks、unknowns；
   - dataAsOf、sourceStatus、suggestedFollowUps。
4. EvidenceRef 已指向 Document chunk、StockEvent、StrategySignal、WatchTrigger、Advice 等真实
   对象。
5. Agent 已只能产生 SubjectLink 或研究写入草案，用户确认前不写文件。
6. 已建立确定性评测用例，覆盖引用完整率、部分失败、越权门控和 prompt injection。

#### 验收

- 自由文本不能伪装成引用；
- 正文窗口、snippet 和引用长度都有上限；
- 资料中的工具调用指令不能改变 Agent 行为；
- 数据缺失进入 unknowns/sourceStatus，不生成伪完整答案。

### M5：Strategy Workspace Phase C

**状态：已完成（2026-08-09）**

**预计：8～12 日；依赖：M0，推荐在 M4 后实施**

#### 任务

1. 增加 definition diff 纯函数和 Tool，支持基线版本与草案比较。
2. AI 输入只允许 run diff、规则解释、provider/data health、SignalObservation 和 Research facts。
3. AI 输出创建普通 StrategyVersion draft：
   - `parentVersionId` 指向分析基线；
   - `changeSummary` 保存用户可读摘要；
   - definition 必须通过同一 DSL schema。
4. 使用同一股票样本执行 `persist=false` 试算，对比基线与草案，不产生正式 StrategyRun。
5. 保存 agent 调用、事实引用和工具轨迹。
6. 用户依次查看 definition diff、试算、静态校验，再确认发布；每一步独立确认。

#### 禁止行为

- AI 自动发布、激活或正式运行；
- score 或 SignalObservation 被表述为收益概率；
- Strategy 洞察自动生成 Advice、通知或交易；
- 修改已发布的 StrategyVersion。

#### 验收

- 相同事实输入产生可审计草案；
- 所有修改都有 parentVersionId、changeSummary 和 fact references；
- 样本不足或观察缺失时显示 unavailable；
- 发布仍必须经过用户确认。

本轮实现对应 `compare_strategy_definitions`、`propose_strategy_version_draft`、
`trial_strategy_version`、`run_strategy(persist=false)` 和 StrategyVersion 的 `factReferences/agentTrace` 审计字段；草案
Tool 本身不落库，确认后复用既有 `create_strategy_version` 写入，再由用户独立触发校验和发布。

### M6：连板天梯 Phase 3

**状态：已完成（2026-08-09）**

**预计：3～5 日；依赖：M2**

#### 本期范围

- `market_outlook` 消费结构化天梯事实；
- 个股页面展示可获得范围内的近期涨停日期和当日梯队；
- 报告、行情和研究页面提供事实跳转；
- 上游不支持历史日期时明确 unavailable，不伪造正常空结果。

#### 延后范围

“天梯 level 作为 Strategy 字段”需要先补字段 registry、历史可获得时间、缺失语义和测试数据
设计，不直接把临时 mapping 塞进表达式上下文。

本轮实现对应 `market_outlook` 的结构化摘要、行情与研究视图的 `limitUp` facts、涨停 marker
和研究时间线；单日历史拉取失败进入 `status=unavailable/warnings`，不伪造正常空结果。

## 6. 第三优先级：新需求立项

以下需求目前只有 PRD 或方向草案。每项先产出 PRD 决策补充、DDD、Tool/API schema、迁移与测试
矩阵，再决定实施排期。

### N1：账户绩效与组合归因

优先冻结：

- 现金流、分红、拆股和公司行动；
- 每日估值与缺失价格处理；
- TWR、回撤、benchmark 和贡献归因；
- 已实现/未实现 PnL 与收益率的边界；
- 数据完整度和降级为估值曲线的条件。

这是新需求中优先级最高的一项，因为它直接补齐 Advice、Trade、Outcome 后的真实复盘。

### N2：Agent 协作体验 Phase 0～2

- 统一研究、持仓、观察和复盘场景提示词与白名单；
- 展示公开计划、工具轨迹、部分失败和长任务状态；
- 串联 Research、Advice、Trade、Outcome、SignalObservation；
- 用户确认后生成 Strategy、Watchlist 或 AlertPlan 修改草案；
- 不新增平行 Agent 数据库或角色实体。

### N3：Watchlist 自动 Strategy source

- 必须显式 opt-in；
- 只有 complete sync 可以结束缺失来源；
- partial/failed 只标 stale，不制造全量退出；
- 不影响 manual、AI、Portfolio 等其它来源；
- 先解决旧 Watchlist PRD 与新 Strategy Workspace 决策冲突。

### N4：基本面、资金流和 A 股短线事件雷达

每类 Evidence Adapter 先定义：

- provider、coverage、dataAsOf 和发布时间；
- fresh/stale/unavailable/partial；
- 成本、限速、缓存和降级；
- 与 Report、Research、Strategy、Advice 的消费边界；
- 不把数据接入等同于自动生成 Advice。

## 7. 明确暂缓或不做

- **严格回测**：benchmark、费用、滑点、停牌/涨跌停、point-in-time universe、代码和数据版本
  尚未满足门禁。
- **分钟行情**：需要独立 MinuteBar 详细设计，不能复用 PriceSnapshot。
- **继续扩多市场**：当前优先保障沪深 A 股目录、qfq 日线、策略和复盘闭环完整。
- **Research 远端同步**：Git workflow 或 Obsidian Headless 只有在本地工作台稳定且有真实需求后
  再设计。
- **自动交易**：永久不做；Strategy、AlertPlan、WatchTrigger、Advice 均不得自动下单。

## 8. PR 与实施节奏

每个里程碑按以下顺序形成可独立合入的竖向 PR，不跨多个核心 schema 大爆炸修改：

1. Core schema、不变量、纯函数和失败测试；
2. repository interface、Drizzle/memory 双实现、SQLite DDL 与 contract tests；
3. Tool schema、实现、registry、sideEffect 和 MCP/Agent 分类；
4. Workflow 仅通过 `ctx.tools.*` 编排；
5. Web/API/CLI/MCP/Skill 消费同一 Tool 契约；
6. 自动测试、真实浏览器验收和文档同步。

同一里程碑需要多个 PR 时，优先使用“契约与存储 → Tool/Workflow → Web/Agent”的切分；每个 PR
合入后必须保持现有路径可用，不维护长期半迁移状态。

## 9. 统一交付门槛

### 9.1 架构

- core 零 IO，不依赖 db、tools、workflows 或 surface；
- 新 repository 同时提供 Drizzle 和 memory 实现；
- Drizzle schema 与 `ensureSchema` SQLite DDL 同步，迁移幂等；
- Tool 使用 Zod 派生输入输出并始终返回 ToolResult；
- Workflow 只通过 `ctx.tools.*`；
- Web 不复制 core 派生规则或直接访问 repository。

### 9.2 安全

- write、external 必须显式 opt-in；
- Web mutation 保留 token 和 Origin 校验；
- 私人研究、持仓、交易按当前账户和暴露策略隔离；
- Agent 写入、发布、正式运行和同步必须先确认；
- Advice 保留证据、反证、风险、免责声明和有效期；
- trade 永不通过 MCP 暴露，不新增自动交易路径。

### 9.3 测试与验收

开发中先跑最小相关测试。交付前按改动范围运行：

```bash
bun run test:all
bun run typecheck
bun run lint
bun run build
```

纯文档改动至少检查 Markdown 相对链接和 `git diff --check`。Web UI 改动除自动测试外必须真实
启动并用浏览器验证；外部数据源 smoke 独立执行，不因公网波动阻塞确定性测试。

## 10. 主要风险

| 风险 | 控制措施 |
|---|---|
| 文档状态落后导致重复开发 | M0 先修状态；代码和测试为实现事实 |
| Workflow 继续绕过 Tool | 静态架构测试 + workflow-only 原子 tools |
| Research 导入引入 SSRF/提示注入 | 本地 write 与远程 external 分离；严格 URL/媒体/大小限制；内容视为不可信数据 |
| FTS5 在交付平台不可用 | 启动能力检测；metadata 搜索作为正式降级并显式返回 capability |
| SignalObservation 被误称为回测 | 强制展示样本、缺失率、benchmarkStatus 和免责声明 |
| Strategy AI 迭代越权 | 只创建 draft；校验、发布、激活、正式运行逐步确认 |
| 图表 marker 混淆事实与建议 | Trade、Advice、Trigger、Signal 使用不同类型和文案，不统一成买卖信号 |
| 新数据源扩张导致 provider 语义泄漏 | capability registry + provenance + Tool 契约隔离 |

## 11. 计划完成判定

完成 M0～M2 后，详细设计中当前最明显的“半成品”全部收口，可以进入已有详细设计的新功能。
完成 M3～M6 后，Research、Strategy、Market View 和连板事实形成完整的研究—观察—复盘链路。
N1～N4 只有在各自 DDD 冻结、端到端场景和验收门槛明确后，才进入新的实施计划。
