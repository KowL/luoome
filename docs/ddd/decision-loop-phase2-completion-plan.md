# AI 投资决策闭环 Phase 2 完成计划

> 状态：P2-0～P2-4 核心代码切片已完成；P2-5 全链路真实数据证据仍待积累（2026-08-21）
> 上位文档：[AI 投资决策闭环产品总纲](../prd/ai-investment-decision-loop.md)
> 关联：[AI 投资 Agent 协作体验](../prd/ai-investment-agent.md)、[Agent 协作体验 Phase 0+1 详细设计](./agent-collaboration-phase0-1-detailed-design.md)、[账户绩效与组合归因详细设计](./account-performance-detailed-design.md)、[Strategy 严格回测详细设计](./strategy-strict-backtest-detailed-design.md)
> 说明：本文件只冻结 Phase 2 的实现边界和验收顺序，不修改上位 PRD 的状态。只有代码、测试、浏览器和真实数据证据全部满足门禁后，主线程才更新 PRD 状态。

## 1. 目标、现状与完成定义

Phase 2 的目标是把“建议—行动—结果—后续观察—研究迭代”做成可追溯的真实复盘闭环，而不是增加自动交易能力。Phase 0+1 的 Agent 场景目录、路由、计划卡、Advice 草案和确认链路已经交付；Phase 2 仍需独立立项，不能因为底层 `AdviceOutcome`、`SignalObservation` 或周报已有代码就宣称闭环完成。

当前可复用的事实源：

- `AdviceOutcome` 已统一 `followed / partially_followed / ignored`，并补充 `tradeIds`、`holdingHours` 和 `notes`；`record_advice_outcome`、CLI、Web、统计和数据传输均保留“未提供盈亏”，不再以默认零值代替 unknown。
- `SignalObservation` 已支持 `watch-trigger` / `strategy-signal`、T+1/T+3/T+5/T+20、`pending / complete / unavailable`、benchmark 状态和按 `stock-day-horizon` 的描述性聚合；生产样本覆盖和 benchmark 可用率仍是证据项。
- `weekly-report` 已接入真实 AdviceOutcome 与 SignalObservation 区块，并保留小样本、缺失和能力不可用披露；跨账户研究版本变化仍因缺少可靠的全局查询能力而显式 unavailable。
- `Trade` 已支持可空的研究假设、Advice、`StrategyVersion` 关联并在写入边界验证；`ResearchHypothesisVersion` 已有 core、双仓储、迁移、Tool 和 Agent 草案链路。跨 repository 原子事务、全局研究变化投影及生产样本仍属于 P2-5 收口项。

Phase 2 完成必须同时满足四个产品条件：

1. 用户可以从 Advice、信号、持仓或周报进入一次复盘，并看到事实、未知项和来源。
2. 实际交易可以显式关联当时的研究假设版本、Advice 和来源 `StrategyVersion`，历史未关联交易保持可读且不被猜测补链。
3. AdviceOutcome、SignalObservation、交易变化和周报使用稳定、可重跑、可解释的统计口径。
4. 系统只能生成 Strategy、提醒规则或研究假设新版本的待确认草案；用户确认后才写入，任何路径都不自动下单。

## 2. 目标用户旅程

```text
发现/研究
  → 用户主动生成 Advice
  → 确认 Advice 并记录依据快照
  → 外部券商行动，手工或安全导入 Trade
  → 用户回填 AdviceOutcome
  → T+1/T+3/T+5/T+20 补全 SignalObservation
  → 周报汇总行为、结果和数据质量
  → 用户确认 Strategy / AlertPlan / 研究假设新版本草案
```

### 2.1 从变化到 Advice

1. 用户从股票研究档案、Watchlist 变化、StrategySignal、持仓风险或周报进入复盘入口。
2. Agent 只读取已注册 facts，展示 `dataAsOf`、来源、反证、风险和缺失维度；需要建议时由用户主动触发 Advice。
3. Advice 先以 draft 返回，确认后才调用已有 Advice 写入路径。确认只授权当前草案，不授权后续同类写入。
4. Advice 保存 `basedOn` 快照和有效期，后续复盘引用 Advice 原始事实，不依赖当前行情重写历史。

### 2.2 从 Advice 到实际行动

1. 用户在外部券商自行决定是否行动；luoome 不提供订单执行和自动调仓。
2. 用户手工录入或通过显式授权的导入能力写入 Trade/Holding。
3. 录入 Trade 时可以选择研究假设版本、Advice、来源 `StrategyVersion`；无法确定的关系保持空值，并在复盘中显示“未关联”。
4. 用户按实际行动回填 AdviceOutcome。没有实际交易、结果尚未到期或基准不可用时，分别使用明确状态，不写入推断收益。

### 2.3 从信号到稳定观察

1. 只有真正 emitted 的 `StrategySignal` 或 `WatchTrigger` 建立观察记录；持续 matched、草案和未发布运行不创建样本。
2. 每个 `sourceKind + sourceId + horizon` 幂等生成一条观察；历史兼容的 `tactic-signal` 只用于读取，不恢复旧实体。
3. 观察任务按 A 股交易日计算 due time，补齐 qfq 日线和 benchmark；不足时保持 `pending`，不可取得时标记 `unavailable` 并说明原因。
4. 统计只描述样本数、收益、MFE/MAE、benchmark/excess return、缺失率和状态，不表述因果、未来收益概率或策略必然有效。

### 2.4 从周报到版本迭代

1. 周报按同一上海自然周汇总 AdviceOutcome、关联/未关联 Trade、SignalObservation、账户绩效摘要和数据质量。
2. 样本不足、观察未到期、benchmark 缺失、现金流不完整等均进入 `unknowns`/`dataQuality`，不折算为 0 或“无问题”。
3. Agent 可以根据事实提出规则、Strategy 或研究假设的修改草案，并携带证据 ID、反证、影响范围和待确认项。
4. 用户确认后创建新版本；旧版本不可变，原 Advice、Trade 和 Observation 仍指向当时的版本。

## 3. 冻结契约

以下契约是进入编码前的冻结基线。新增字段必须同步 core schema、Drizzle/memory、Tool schema、数据导入导出和测试；不得在 surface 层另造一套语义。

### 3.1 AdviceOutcome

存量 `AdviceOutcome` 字段保留：`adviceId`、`outcome`、可选 `pnl`、可选 `benchmarkPnl`、`recordedAt`；Phase 2 增加可选的显式 `tradeIds`、`holdingHours` 和 `notes`。Phase 2 收口规则：

- `outcome` 允许 `followed`、`partially_followed`、`ignored`；`followed=false` 不能再隐式等同于 `ignored`，部分采纳必须显式表达。
- 盈亏和基准盈亏是“已知结果”，未计算、未平仓或基准不可用时保持缺省并带质量原因；不得用 `0` 表达 unknown。
- 同一个 Advice 只有一个当前 outcome，重复回填采用幂等 upsert；修改必须保留 `recordedAt` 和审计事件，不能生成重复样本。
- 不从持仓、Trade 或行情反推用户是否采纳 Advice；只有用户回填或可信导入事实可以改变 outcome。
- 统计按 Advice 创建时间、结果记录时间和观察到期时间分别标注，避免把尚未到期的建议计为失败或成功。

`record_advice_outcome` 仍是显式 `write`，不进入 Agent 只读白名单和 MCP 默认暴露清单；如需要导入，必须使用同一领域 schema 和 provenance。

### 3.2 SignalObservation

继续使用现有 `SignalObservation` 契约：

| 字段组 | 冻结语义 |
|---|---|
| 身份 | `sourceKind + sourceId + stockId + horizon`；`t1/t3/t5/t20` 按交易日而非自然日计算 |
| 状态 | `pending` = 尚未到期或事实不足；`complete` = 后续价格齐全；`unavailable` = 已知无法取得并有 `unavailableReason` |
| 表现 | qfq 基准/收盘、return、MFE、MAE；benchmark return 单独受 `benchmarkStatus` 约束 |
| 证据 | `provenance.provider/observedAt/fetchedAt/freshness` 以及数据集版本；不把当前快照冒充历史事实 |
| 聚合 | 统一按 `stock-day-horizon` 去重，选择代表性 observation id 可回溯；重复运行不扩大样本 |

`complete` 只表示事实观察完成，不表示策略回测、可交易收益或 Advice 正确。所有 Tool、Report、Web 和 Agent facts 使用同一聚合函数；benchmark 缺失时展示 unavailable/partial 和影响。

### 3.3 Trade 依据关联

在 `Trade` 上新增可空、只引用既有对象的关系字段（精确命名在 P2-0 schema PR 中锁定，语义不得改变）：

| 关系 | 用途 | 约束 |
|---|---|---|
| `researchHypothesisVersionId` | 交易当时采用的研究假设版本 | 只能指向 active（已确认）版本；不能在读取时按股票或日期猜测 |
| `adviceId` | 交易前/当时的 Advice | 只能指向现存 Advice；历史 Trade 可为空 |
| `strategyVersionId` | 产生依据的来源 StrategyVersion | 只能指向发布过且可审计的版本；不等于自动授权 |

一个 Trade 可同时关联三类依据，也可以全部为空。导入的 broker id、执行时间、数量、价格、费用和 source 仍是交易事实；关联只是决策 provenance，不改变持仓计算。删除或归档依据对象时保留 Trade，并返回“依据不可用/已归档”，不得级联删除交易。

### 3.4 研究假设与版本

研究正文和来源继续由 `ResearchTopic/ResearchDocument` 拥有；Phase 2 只增加可审计的 `ResearchHypothesisVersion` 元数据，不复制正文：

- `id`、`topicId`、`documentId`、`documentContentHash`、单调 `version`、`active / superseded / archived` 状态、可选 `supersedesId`、可选 `summary` 和 `createdAt`。
- 新版本必须在同一 Topic 内严格递增，并在同一事务中 supersede 旧 active 版本；版本正文变化通过新的 `documentContentHash` 指向 ResearchDocument/Vault 内容。
- 版本创建后不可变；反馈草案先在对话/审计中存在，用户确认后才创建 active 版本。确认前不得创建或切换 active 版本。
- `ResearchDocument` 继续负责正文、来源、全文检索和 provenance；研究假设版本只保存可复盘的判断版本引用，不复制全文、行情或私人账本。
- 如果后续需要更丰富的陈述、反证或失效条件，先扩展版本 schema 和 contract tests；不要在 `ResearchTopic` 上堆叠无版本的可变字段。

### 3.5 周报复盘区块

周报新增或扩展只读区块，建议稳定为：

- `advice-outcomes`：Advice 数量、已回填/待回填、采纳分布、已知 PnL/benchmark 样本和有效期覆盖；不把命中率写成收益承诺。
- `trade-attribution`：关联率、未关联交易列表摘要、按研究假设/Advice/StrategyVersion 的事实计数；无关联不是失败。
- `signal-outcomes`：沿用现有 T+N 描述性统计和代表性 observation id。
- `behavior-patterns`：例如“周内回填集中在某些日期”或“部分采纳比例变化”，只在达到最小样本后出现，使用描述性措辞。
- `data-quality`：缺价、benchmark、观察未到期、现金流/公司行动、provider freshness 和 provenance 缺口。

每个区块携带 `factsAsOf`、样本数、缺失数和 warnings。样本不足时返回结构化 unavailable，而非空数组伪装“没有行为”。

### 3.6 草案与确认

Phase 2 只允许三种反馈目标：

1. 新建或修改 `StrategyVersion` 草案；
2. 新建或修改 `AlertPlan/AlertRule` 草案；
3. 新建 `ResearchHypothesisVersion` 草案。

草案必须包含目标对象、字段来源（user/default/inferred）、证据 ID、反证、未支持条件和数据截止时间。确认接口只提交当前草案，并写入审计；取消、过期或重新生成的草案不可执行。Workflow 只能通过 `ctx.tools.*` 编排，不能直接调用 repository。

## 4. 竖向切片与实施顺序

按“契约与存储 → Tool/Workflow → Web/Agent”切分，每个切片独立可验收并保持旧路径可用：

| 切片 | 范围 | 依赖 | 关闭条件 |
|---|---|---|---|
| P2-0 契约与迁移基线 | 冻结 outcome 语义、Trade 关联、ResearchHypothesisVersion 最小 schema、Report 投影；Drizzle/memory、`ensureSchema`、data-transfer | 无 | schema/不变量/索引/版本兼容测试通过，旧数据可读 |
| P2-1 行动与结果 | outcome write tool 语义收口、Trade 关联写入/读取、provenance 和审计 | P2-0 | 用户显式回填可幂等重跑；未关联历史交易不被补链；账户隔离和 sideEffect 测试通过 |
| P2-2 信号观察统计 | observation 创建/补全/去重、benchmark 与缺失状态、按 Strategy/Watchlist/Advice 查询 | P2-0 | 重跑不增样本；T+N 交易日测试、provider 失败和 unavailable 证据可回看 |
| P2-3 周报复盘 | Advice/Trade/Signal/账户事实聚合、行为模式最小样本门槛、data-quality 区块 | P2-1、P2-2 | 周报可重跑、区间和 `factsAsOf` 稳定；部分失败不伪造完整答案 |
| P2-4 反馈到版本 | ResearchHypothesisVersion repository/tool、Strategy/AlertPlan/ResearchHypothesisVersion 草案投影与确认、旧版本不可变 | P2-1、P2-3 | 确认前零写入；确认后只创建一个版本；取消、重复确认和过期草案幂等 |
| P2-5 端到端复盘 | 股票档案/周报/Agent 入口、证据链导航、浏览器 golden path、运行审计和运维说明 | P2-3、P2-4 | 真实浏览器走完“Advice→Trade→Outcome→Report→新版本”，失败与未知项可见 |

推荐顺序为 P2-0 → P2-1/P2-2 并行 → P2-3 → P2-4 → P2-5。P2-1 与 P2-2 可由不同 Agent 开发，但共享 schema 先由 P2-0 冻结，避免各自扩展重复关系或状态枚举。

## 5. 迁移与兼容

- 所有 schema 变更遵守 Drizzle schema 与 `ensureSchema` SQLite DDL 同步，启动迁移幂等；新增 Trade 关联字段先 nullable，不能阻塞历史交易读取。
- 存量 AdviceOutcome 保留原记录；不根据旧 Trade、Advice 时间或股票代码推断关联。旧 `tactic-signal` observation 只读兼容，新增样本使用 `strategy-signal`。
- 新增 `research_hypothesis_versions` 表和索引采用 additive migration；删除/重命名由单独迁移决策处理，不能在 Phase 2 混入破坏性清理。
- memory repository 与 Drizzle repository 必须同时实现，复用 contract tests；新增字段需同步 CLI、Web API、Tool 输出和 data-transfer validator。
- 导入/导出保存版本、provenance、缺失状态和关系 ID；导入无法解析的外部关系必须拒绝或明确标记，不静默丢失。
- Report/WorkflowRun 只保存统计、计数、时间和错误 kind，不落原始私人账本、LLM token 或凭证；运行中断重跑要依赖已有事实幂等收敛。

## 6. 安全与副作用门禁

- `Advice` 永远不是 `Trade`；任何 Agent、报告、WatchTrigger 或反馈草案都不得自动下单。`trade` tool 继续不通过 MCP 暴露，并保留 `LUOOME_EXPOSE_TRADE=true` 硬卡。
- outcome、Trade 关联、ResearchHypothesisVersion 确认和外部导入均是显式 `write` 或 `external`；草案生成是无副作用，确认是一次性授权，不继承未来权限。
- 当前账户选择不能冒充认证。每个读取和写入都要验证 account scope；Web 账户级鉴权仍是独立安全项，未闭合时不能把“请求带 accountId”写成已完成权限。
- 外部研究/行情文本是不可信输入：保留 provider、发布时间、抓取时间和数据版本，清理 prompt injection；不得让外部文本改变工具白名单、sideEffect 或确认状态。
- Advice 和复盘回答必须保留证据、反证、风险、免责声明、有效期和未知项；禁止把小样本相关性、SignalObservation 或 score 描述为未来收益概率。
- 日志与审计只记录对象 ID、运行 ID、状态、错误 kind 和数据质量摘要；不输出 API key、token、完整账户账本或私人研究正文。

## 7. 测试与验收矩阵

### 7.1 自动测试

| 层 | 必测内容 |
|---|---|
| Core | outcome 状态/金额缺失不变量；Trade 关联可空与版本状态；ResearchHypothesisVersion 版本单调、不可变；周报样本门槛与未知项 |
| Repository | Drizzle/in-memory upsert、唯一性、账户隔离、关系对象删除/归档、迁移幂等和旧数据读取 contract tests |
| Tool/Registry | input/output Zod、sideEffect、registry 导出、MCP/Agent 白名单、确认前草案零写入、重复确认幂等 |
| Workflow | 只通过 `ctx.tools.*`；中断/重试/部分失败可恢复；同一周报与观察任务不重复计样本；审计不含私人明细 |
| API/Web | account scope、Origin/能力门控、部分响应、证据导航、历史未关联 Trade 和 unavailable 文案 |
| Browser | 真实启动 Web，走完 Advice 确认、Trade 关联、Outcome 回填、观察待处理、周报、生成并确认新版本；刷新后状态和审计仍可回看 |

### 7.2 代码完成与证据完成分离

以下三类证据不能互相替代：

1. **契约证据**：schema、不变量、repository contract、Tool/Workflow/API 自动测试。
2. **装配证据**：独立 SQLite、真实 Web/浏览器、确认/取消/重跑/权限行为和运行审计。
3. **生产数据证据**：真实 provider、交易日覆盖、benchmark、现金流/公司行动和跨日连续运行；fixture、mock、当前快照不能关闭此门禁。

Phase 2 的代码可以在生产数据不足时返回 `partial/unavailable` 并交付；但不能将这种代码完成写成“真实复盘统计已经稳定”。

## 8. 外部数据门禁

完成代码不等于完成真实数据验收。进入 Phase 2 生产证据阶段前，按下表逐项记录 provider、coverage、dataAsOf、freshness、content/revision 标识和失败原因：

| 闭环环节 | 外部事实门禁 | 缺失时的合法结果 |
|---|---|---|
| AdviceOutcome | 用户实际采纳/部分采纳/忽略事实；实际成交或平仓金额；同期 benchmark 与有效期 | 待回填、部分可用或 benchmark unavailable；不能从行情推断采纳，不填 0 伪完整 |
| SignalObservation | qfq 日线、A 股权威交易日历、T+N 覆盖、版本化 benchmark `000300.SH:qfq:daily:v1`、provider freshness | `pending`/`unavailable`，保留原因、尝试次数和 provenance；不输出收益指标 |
| Trade/Portfolio | 交易、持仓、入出金、分红、费用、拆股/送转、价格覆盖、benchmark；现金流完整性和账户范围 | 估值事实可读但 TWR/归因为 partial/unavailable；不把旧 complete 快照覆盖新 partial |
| 反馈版本 | Strategy/AlertPlan 可审计版本与可执行字段；研究来源和发布时间；若引用基本面，必须 PIT/发布时点一致 | 只生成草案或列为 unsupported；不得用当前快照回填历史假设 |
| 运行运营 | 跨真实交易日的 schedule/lease/checkpoint/publication/观察补全、长区间和大账户预算 | 记录 partial/failed 和可观测数据；不能用一次 smoke 宣称持续生产闭合 |

严格回测的八项门禁（PIT universe、DailyBar revision、费用、滑点、可交易性、公司行动、benchmark、evaluator identity）仍由[严格回测详细设计](./strategy-strict-backtest-detailed-design.md)单独拥有。Phase 2 的 SignalObservation 和账户绩效不得绕过这些门禁改称严格回测或收益回测。

## 9. 开发顺序与退出条件

1. 先合并 P2-0 的领域契约和迁移测试，再拆 P2-1/P2-2，避免先做 Web 造成半迁移数据。
2. P2-3 只消费已落库 facts，不在报告层复制 Advice、Observation 或绩效计算逻辑。
3. P2-4 先实现草案投影和拒绝路径，再接确认写入；确认成功必须能用对象 ID 回看证据和新版本。
4. P2-5 通过自动化和真实浏览器后，再执行独立 SQLite + 真实 provider smoke；生产证据由 runbook/WorkflowRun 留存。
5. 每个切片交付时同步更新本计划的状态、测试命令和未关闭门禁；不在本文件或实施 PR 中修改上位 PRD 的“方向草案”状态。

Phase 2 的退出条件是：四项产品目标均有代码、契约测试、真实装配和可复核证据；所有外部数据缺口都显式标记，且没有用 mock、当前快照、零值或因果语言关闭缺口。未满足时保持“实现完成/生产证据未闭合”的双状态。

## 10. 明确不做

- 不做券商自动交易、自动调仓、自动生成 Advice 或用户未确认的版本发布。
- 不在 Phase 2 引入基本面因子扩展、严格收益回测或可移植策略 DSL；这些属于总纲 Phase 3，按开发计划的状态和外部数据门禁推进。
- 不复制 `ResearchDocument` 正文、账户账本或完整行情到 ResearchHypothesisVersion/Report；只保存引用、快照摘要和 provenance。
- 不以一次真实 smoke、固定交易日数量、测试 fixture 或浏览器截图替代连续生产数据证据。
