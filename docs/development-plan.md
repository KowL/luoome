# luoome 开发计划

> 状态：当前执行计划
> 基线日期：2026-08-13；Strategy 可靠性复核：2026-08-13
> 事实来源：[领域语言](../CONTEXT.md)、[架构说明](./ARCHITECTURE.md)、
> [产品需求](./README.md#产品需求prd)、[技术设计](./README.md#技术设计ddd) 与当前代码、测试

## 1. 目标与排序原则

后续开发分为四层，按以下顺序推进：

1. 对已编码但尚未完成生产验收的能力，先补故障测试、可观测和真实运行证据；
2. 完成详细设计中已经部分落地的竖向功能，消除半成品和架构偏差；
3. 实现已有详细设计、但尚未开始或只具备底层支撑的新功能；
4. 对只有 PRD 或方向草案的新需求先立项并补详细设计，再进入编码。

所有计划以当前代码和测试为实现事实。文档顶部状态与代码冲突时，不以“待实施”等旧状态
机械排期；先修正文档，再按本计划执行。

## 2. 当前基线

### 2.1 验证结果

2026-08-13 在 `main` 当前工作树完成基线验证；Strategy publication、模板和 Web 历史评估相关
改动仍未提交，按 §3 的 S0 收口，不把工作树状态提前视为已交付版本：

| 验证项 | 结果 |
|---|---|
| Vitest | 153 个文件、1107 项测试通过 |
| DB Bun tests | 259 项测试通过 |
| Web Bun tests | 215 项测试通过 |
| TypeScript | 所有 workspace `tsc --noEmit` 通过 |
| Biome | 517 个文件检查通过 |
| Build | 所有含入口的 workspace Bun 构建通过 |

本轮合计 1581 项测试通过。这组数字只是本计划建立时的基线，不作为长期维护的固定测试库存；
后续验收以 `package.json` 中的当前脚本和测试发现结果为准。Web 历史评估入口尚需在 S0/S2
完成真实浏览器和长任务验收。

### 2.2 实现状态矩阵

| 领域 | 当前真实状态 | 主要缺口 |
|---|---|---|
| 行情底座 | StockUniverse、qfq DailyBar、Quote 新鲜度、capability registry 已完成 | 优先消费已有能力，不继续横向扩底层 |
| Strategy / Watchlist | 旧 Tactic、StockGroup、StockPool 已移除，目标模型已落地 | PRD/DDD 状态和部分架构示例滞后 |
| Strategy Workspace | Phase A～C 已完成；publication、fencing lease、daily cycle、checkpoint、PIT replay、edge signal 和观察统计的核心实现已落地 | 缺长运行故障矩阵、日期级作业体验、真实全市场性能预算和连续 30 个交易日生产证据 |
| Research Vault | Phase A/B、Phase C、M3 managed 创建/导入与 M4 FTS/ResearchBrief 已完成 | embedding、跨模型评测扩展和远端同步仍暂缓 |
| Market View | Phase 1/2 已完成；Phase 3 的事实关联、markers 和日期深链接已落地 | 账户/事实详情的更细粒度页面联动仍可增强 |
| Report / 信号复盘 | Report、三类简报、SignalObservation、benchmark/excess return、MFE/MAE 与分组描述统计已落地 | benchmark 真实数据可用率和样本去相关仍需生产验证；历史评估仍不是严格收益回测 |
| 账户绩效 | 当前持仓 PnL、集中度、Trade 与 AdviceOutcome 已落地 | 缺现金流/公司行动口径、每日估值、TWR、回撤、benchmark 和持仓贡献归因，列为 v0.10 |
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
- [ROADMAP](./ROADMAP.md) v0.8 以前内容是历史快照，不作为当前功能 backlog；v0.9 起才是当前版本计划。
- SignalObservation 是真实事后观察，point-in-time replay 也是历史规则回放；即使已有 PIT universe、
  DailyBar revision 和 benchmark 事实，在费用、滑点、停牌/涨跌停可交易性、公司行动和代码版本
  门禁满足前，仍不展示净值、年化、Sharpe、胜率或严格回测曲线。

## 3. 依赖关系

```text
M0～M6 已完成能力基线
  │
  ▼
S0 当前改动收口 ──► S1 可靠性测试/可观测 ──► S2 历史评估作业化
                                                   │
                                                   ▼
                                      S3 连续 30 个交易日生产验证
                                                   │
                                                   ▼
                              S4 / v0.10 账户绩效与组合归因

S3 观察期内可以推进 S4 的 PRD/DDD，不提前扩大自动推荐、通知或外部数据源。
```

以下工期按单人或单 Agent 串行开发估算，表示有效开发日，不包含外部数据源审批、产品等待和
真实市场数据等待时间。

### 3.1 当前优先级覆盖（2026-08-13）

M0～M6 已完成，不再重复排期。[Strategy 日运行与评估可靠性开发计划](./strategy-reliability-development-plan.md)
中的 R0～R7 已从“待编码”进入“核心实现已落地、验收和运营证据未完成”的阶段。下一步按以下
顺序推进：

| 顺序 | 里程碑 | 目标 | 预计 |
|---|---|---|---:|
| P0 | S0 当前改动收口 | 分离安全修复、模板升级与历史评估 UI，消除半完成工作树 | 1～2 日 |
| P0 | S1 可靠性测试与可观测 | 用故障矩阵证明 publication、fencing、daily cycle 和降级行为 | 5～8 日 |
| P0 | S2 历史评估作业化 | 把同步长请求改为可进度、可续跑、可取消的 evaluation job | 4～6 日 |
| Gate | S3 生产验证 | 连续 30 个交易日收集真实运行、数据覆盖、观察补全和 AI 降级证据 | 30 个交易日 |
| P1 | S4 账户绩效与组合归因 | 先冻结 DDD，再实现现金流口径估值、TWR、回撤和贡献归因 | 3～5 日设计 + 8～12 日实现 |

### 3.2 Strategy 可靠性实现复核

| 原里程碑 | 当前代码状态 | 下一验收动作 |
|---|---|---|
| R0 publication | Summary V4、scope、publication 和 current 查询已落地；手工运行绕过 acceptance 的修正位于当前工作树 | 合入安全修复，验证低覆盖 manual/scheduled 均 withheld，evaluation 永不污染 current |
| R1 fencing lease | run/schedule heartbeat、fencing token 和 fenced commit 已落地 | 补三小时 fake-clock、owner 接管、旧 fence 提交失败和幂等 release 测试 |
| R2 daily cycle | `strategy-daily-cycle` 已成为 Web scheduler 主路径，facts-only 已落地 | 增加 workflow 端到端故障矩阵；阶段耗时、计数和 providerStatuses 写入 WorkflowRun |
| R3 规则语义 | crossing、AST 三值短路、实际读取路径和 RuleEvaluation V2 已落地 | 固定 evaluator 兼容测试并核对真实 incomplete 分布 |
| R4 数据准备 | 有界并发、checkpoint、revision 和提前质量门已落地 | 配置化并发/超时，做连接重置、限流、fallback 风暴和 5198 股票性能验收 |
| R5 早期突破 v2 | draft、edge/cooldown、exit/risk signal 能力已落地 | 用户确认后发布试验版本，进入完整 T+20 真实观察期 |
| R6 PIT 历史评估 | universe snapshot、DailyBar revision、evaluation session/day 和 range replay 已落地 | 完成 Web 作业化、真实区间 smoke、续跑和 vintage unavailable 展示 |
| R7 观察统计 | benchmark/excess return、分位数、MFE/MAE 和行业/score/edge 分组已落地 | 稳定同步 benchmark，验证去重口径、样本完整率和跨 Tool/Web/AI 一致性 |

### 3.3 v0.9 执行切片

#### S0：当前改动收口

1. publication acceptance 与 `dataAsOf` 修正作为安全切片，不能与产品 UI 混在同一交付中。
2. 均线多头模板 revision 独立交付，保留 definitionHash identity 测试。
3. replay 输出汇总与 Web 入口独立交付；在 S2 完成前，不把“31 日全市场同步 HTTP 请求”作为正式
   产品形态。
4. 每个切片分别跑最小测试；合并交付前跑全量门禁。Web 改动必须真实浏览器验收。

#### S1：可靠性测试与可观测

1. 新增 `strategy-daily-cycle` 独立测试，覆盖 checkpoint 拒绝、withheld、观察失败、facts-only、
   推荐/通知失败以及 schedule lease 丢失。
2. 证明 lease 丢失后旧 owner 不能提交 run bundle、创建观察、生成 Advice 或发送通知。
3. WorkflowRun 保存阶段、耗时、计数、publication 原因、checkpoint 和 providerStatuses；后阶段失败
   不回滚已发布事实。
4. 将数据准备的并发、单请求超时、有限重试和错误聚合纳入可观测配置。
5. 对 5198 股票真实全市场运行记录数据准备 P95、纯求值 P95、覆盖率和 provider 失败分布。

#### S2：历史评估作业化

1. Web 创建 evaluation session 后快速返回，由日期级 job 后台推进；页面轮询 session/day 状态。
2. 支持失败日重试、断点续跑和明确的取消状态；取消不删除已完成日期事实。
3. 全市场与显式子集使用独立预算，展示预计范围、进度、partial/failed 和 vintage 状态。
4. 结果固定称为“历史评估/历史回放”，只展示求值、入选、信号、覆盖与观察事实。
5. 用真实数据验收 2026-07-01～2026-08-11，记录总耗时、版本可用率和重复运行幂等性。

#### S3：生产验证门禁

连续 30 个交易日记录：每个 schedule 的正式运行数、lease 续期、checkpoint 覆盖、publication、
到期观察补全、facts-only 降级和通知结果。每周形成可靠性汇总。观察期间只允许扩大诊断和修复，
不扩大自动推荐/通知默认范围。

### 3.4 v0.10：账户绩效与组合归因

S3 观察期间可先完成 PRD/DDD；实现必须遵守“契约与存储 → Tool → Report/Web/Agent”的竖向顺序：

1. 冻结现金流、分红、拆股、费用、转入转出和公司行动口径。
2. 建立按账户隔离的每日估值事实，缺失价格必须进入 completeness，不得填 0。
3. 实现 TWR、最大回撤、benchmark 和持仓贡献归因，明确已实现/未实现 PnL 与收益率边界。
4. 接入账户复盘页、周报和 Agent 只读事实；复盘结果不自动生成调仓或交易。
5. 用入金、出金、分红、停牌、缺价和多账户 fixture 验证确定性与隔离性。

## 4. 第一优先级：完成部分实现

> M0～M2 为已完成阶段记录，保留用于追溯，不再作为当前排期。

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

> M3～M6 均为已完成阶段记录，用于保留决策和验收上下文，不属于当前排期。

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

## 6. 后续产品立项

N1 已排入 v0.10；N2～N4 仍只有 PRD 或方向草案。每项在编码前先产出 PRD 决策补充、DDD、
Tool/API schema、迁移与测试矩阵。

### N1：账户绩效与组合归因

**状态：已排入 v0.10；S3 期间完成 PRD/DDD，生产实现依赖 Strategy 可靠性门禁。**

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

- **严格收益回测**：PIT universe、DailyBar revision replay 和 benchmark 事实已经具备基础能力，但
  费用、滑点、停牌/涨跌停可交易性、公司行动和代码版本仍未满足门禁；v0.9 只称历史评估。
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
| 低覆盖或 evaluation run 覆盖当前股票池 | 持久化 publication；current 只查 published operational run |
| 固定租约短于全市场运行 | heartbeat + fencing token + 同事务 fenced commit |
| 观察 cron 与长运行竞态 | daily cycle 在运行终态后补观察；独立 cron 只作幂等补偿 |
| AI 结构化输出失败导致周期无结果 | 一次有界修复；再失败返回确定性 facts-only 并标 partial |
| Web 全市场历史评估阻塞单个请求 | evaluation session 后台作业化；日期级进度、续跑、取消和范围预算 |
| 图表 marker 混淆事实与建议 | Trade、Advice、Trigger、Signal 使用不同类型和文案，不统一成买卖信号 |
| 新数据源扩张导致 provider 语义泄漏 | capability registry + provenance + Tool 契约隔离 |

## 11. 计划完成判定

M0～M6 已完成并退出当前排期。v0.9 完成必须同时满足：

- S0～S2 全部交付且 Web 历史评估已作业化；
- 连续 30 个交易日每个 schedule 至多一次正式运行；
- 低覆盖/evaluation 发布污染为 0，长运行不失租或越权提交；
- 到期观察最迟在下一次成功周期补齐，AI 故障仍有 facts-only 输出；
- 全市场数据准备和求值进入设计性能预算，所有阶段都有 WorkflowRun 审计。

v0.10 只有在账户绩效 DDD、数据完整度规则、端到端场景和测试矩阵冻结后进入实现。N2～N4
继续作为候选方向，不与 v0.9/v0.10 并行扩张生产能力。
