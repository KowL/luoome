# luoome 文档导航

本文是 `docs/` 的统一入口。长期有效的说明放在根层，产品需求放在 `prd/`，技术设计放在 `ddd/`，运维操作放在 `runbooks/`，已完成/过期的计划与验收记录放在 `archive/`。

当前形态是**单机版**：DSH 是唯一入口，luoome 以插件接入 DSH，`$LUOOME_HOME/luoome.db` 是唯一事实库。
独立 CLI / TUI / stdio MCP / 旧单机 Web（`apps/web`）与多租户托管形态都已删除，
相关文档不再保留在当前目录：仍有效的说明见[仓库根 README](../README.md)、
[dsh-luoome 纯插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md)与[架构说明](./ARCHITECTURE.md)。

## 阅读顺序与能力状态

先读[领域语言](../CONTEXT.md)理解六组日常业务概念，再读[架构说明](./ARCHITECTURE.md)了解当前插件与
工具契约；只有修改具体能力时才进入对应详细设计。算法、存储、兼容与阶段记录不作为领域入门前提。

| 能力 | 当前定位 | 进一步阅读 |
|---|---|---|
| 行情、策略、关注提醒、计划、账本、复盘 | 当前日常领域；实际调用仍受能力开关和数据资格约束 | [领域语言](../CONTEXT.md)、[插件说明](../packages/dsh-luoome/README.md) |
| 研究资料与 GoalRun | 已实现，按明确研究需求使用 | [研究库设计](./ddd/research-vault-detailed-design.md)、[目标式研究长跑](../packages/dsh-luoome/README.md#目标式研究长跑) |
| AnalysisJob | 已实现的可选后台执行，不是交互分析前提；默认不开放模型入队 | [可选后台模型](../packages/dsh-luoome/README.md#可选后台分析模型) |
| 方向共识与跟踪 | core/tools 已实现，默认插件只接部分读取，完整旅程待接通 | [方向研究与共识契约](./ddd/ai-investment-workspace-detailed-design.md#方向研究与共识契约) |
| 严格组合回测 | 已实现，按目标区间逐项披露事实门槛与公司行动限制 | [组合回测设计](./ddd/strategy-strict-backtest-detailed-design.md) |
| 严格 PIT 财务因子与评分 | 实验；当前仅显式 mock，真实数据未通过，未接 Strategy DSL | [基本面实验设计](./ddd/fundamental-factor-scoring-phase3-detailed-design.md) |

“已有详细设计”“有代码”“默认入口可用”与“真实数据已验收”分别记录，不互相推定。

## 快速入口

| 读者 | 从这里开始 |
|---|---|
| 产品用户 | [用户手册](./USER_GUIDE.md) |
| DSH 插件安装 | [dsh-luoome 安装说明](../packages/dsh-luoome/README.md) |
| 编码 Agent | [仓库开发规范](../AGENTS.md) |
| 贡献者 | [贡献者指南](./CONTRIBUTING.md) |
| 架构与领域开发者 | [领域语言](../CONTEXT.md) → [架构说明](./ARCHITECTURE.md) → [实体关系图](./ENTITY-MAP.md) → [工具库存](./TOOL-INVENTORY.md) |

## 长期维护文档

| 文档 | 用途 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 模块边界、领域模型、数据流、暴露面判定和 workflow 约束 |
| [ENTITY-MAP.md](./ENTITY-MAP.md) | core 实体关系图：子域分组、引用字段、repository、物理表与守护测试 |
| [TOOL-INVENTORY.md](./TOOL-INVENTORY.md) | 工具库存：按域分组、sideEffect 与不暴露清单，数量以 registry 输出为准 |
| [USER_GUIDE.md](./USER_GUIDE.md) | 安装、DSH 插件、面板、批处理、多账户与复盘 |
| [ROADMAP.md](./ROADMAP.md) | 版本演进、已交付能力和后续方向（v0.8 以前为历史快照） |
| [SECURITY.md](./SECURITY.md) | 副作用分级、鉴权、密钥与审计要求 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发环境、测试、代码规范和贡献流程 |
| [BACKLOG.md](./BACKLOG.md) | 文档一致性、测试盲区和工程债 |

## 产品需求（PRD）

| 文档 | 范围 |
|---|---|
| [MVP 2.0：AI 股票投研自动化工作流](./prd/mvp2-ai-stock-research-automation.md) | 盘后计划、账户报告、基于实时市场证据的确定性盘中提醒与仓位约束（2026-09-28 验收通过；后续决定以 CONTEXT.md 为准） |
| [连板天梯产品文档](./prd/limit-up-ladder-product.md) | 涨停梯队快照的页面、tool、与下游联动边界 |
| [ruo 能力迁移产品设计](./prd/ruo-feature-migration-product-design.md) | 研究档案、公司事件、数据新鲜度与真实复盘 |
| [AI 投资决策闭环产品总纲](./prd/ai-investment-decision-loop.md) | 发现、研究、观察、Advice、行动与复盘的整体对象关系 |
| [MVP3 决策与复盘产品计划](./prd/mvp3-product-plan.md) | 当时依据、用户实际行动与后来结果的账户级回看 |
| [Strategy DSL](./prd/strategy-dsl.md) | 版本化 Strategy、运行结果与信号模型；Tactic 迁移属于已执行历史 |
| [策略工作台](./prd/strategy-v2.md) | Strategy 的执行记录、派生股票池/候选池、运行 Diff、真实信号观察与版本迭代 |
| [统一 Watchlist](./prd/watchlist.md) | 统一手工、Strategy、AI 与 Portfolio 来源的机会观察和生命周期 |
| [策略自动化与 AI 管理](./prd/strategy-ai-managed-automation.md) | 报告中心（收盘行动清单、周报复盘）与策略生命周期管理（提议、门禁发布、自动暂停） |
| [DSH 插件整合 PRD](./prd/dsh-plugin-consolidation.md) | M2–M5 的需求编号、替换路径与验收口径；附录 A 是运行时事实快照（`bun run check:docs` 校验） |

## 技术设计（DDD）

| 文档 | 范围 |
|---|---|
| [dsh-luoome 纯插件详细设计](./ddd/dsh-luoome-plugin-detailed-design.md) | 当前唯一交付面的设计：Node 插件、宿主服务依赖、操作与回执、面板与读取投影、逐任务授权；自动执行默认关闭 |
| [Luoome × DSH 插件能力平台设计](./ddd/dsh-plugin-platform-design.md) | 投资能力插件化、SDK/Cordis 接口与 Run/Tool Manifest 契约；对应研发计划已归档 |
| [DSH 交互分析与 worker 退役设计](./ddd/dsh-interactive-analysis-surface-and-worker-retirement.md) | 交互分析读面/写回面切分与 worker 退役的需求来源 |
| [账户事实、逐股计划与方向研究实现契约](./ddd/ai-investment-workspace-detailed-design.md) | 已实现的账户账本、计划算法/预算/监控及方向共识契约；旧 Web 首页方案已移除，完整方向跟踪未接默认插件入口 |
| [研究主题与 Obsidian Vault 详细设计](./ddd/research-vault-detailed-design.md) | Topic/Document 多主体研究、Obsidian 正文源、SQLite 投影、全文检索与研究时间线 |
| [ruo 能力迁移详细设计](./ddd/ruo-feature-migration-detailed-design.md) | StockEvent、WorkflowRun 与事件规则；旧 ResearchNote 设计已被替代 |
| [连板天梯详细设计](./ddd/limit-up-ladder-detailed-design.md) | A 股涨停梯队快照的 schema、东方财富涨停池 adapter、缓存与端到端集成 |
| [个股行情查看详细设计](./ddd/stock-market-view-detailed-design.md) | Market View Tool、日 K 数据契约、面板图表与降级语义 |
| [MinuteBar 详细设计](./ddd/minute-bar-detailed-design.md) | 独立分钟 OHLCV schema、Tencent 当前会话能力、缺口/保留与面板状态 |
| [同花顺 fuyao 行情适配器设计](./ddd/fuyao-market-adapter-design.md) | 同花顺 fuyao API 行情能力映射、envelope 错误转译与 factory 接线 |
| [Fuyao 扩展与 Tushare 退役设计](./ddd/fuyao-data-expansion-and-tushare-retirement-design.md) | Fuyao 分域扩展、离线 dump、公司行动、实时/PIT 门禁，以及 Tushare 全量退役与迁移验收 |
| [数据源可插拔与统一观测设计](./ddd/source-pluggability-and-observation-design.md) | 通用 SourceRegistry、单一 EastmoneySource、非行情域源可插拔与全域源健康观测（评审中） |
| [行情数据源设置与状态展示优化设计](./ddd/market-source-settings-status-design.md) | 设置页源 × capability 配置态 + 运行态视图、静态能力 manifest 与 `get_market_data_status` 聚合 |
| [行情数据底座详细设计](./ddd/market-data-and-stock-universe-detailed-design.md) | 多源规范化、盘后日线归档、本地股票目录同步与严格 adapter 替换 |
| [Vibe A 股报告与策略研究迁移详细设计](./ddd/vibe-ashare-report-and-strategy-research-detailed-design.md) | Report、A 股情绪证据、三类简报 workflow 与策略研究映射 |
| [Strategy 与统一 Watchlist 详细设计](./ddd/strategy-watchlist-unification-detailed-design.md) | Strategy、Watchlist、AlertPlan 的领域模型、存储、迁移与跨端契约 |
| [策略工作台详细设计](./ddd/strategy-workspace-detailed-design.md) | Strategy 规则解释、派生股票池/候选池、运行 Diff、Tool 契约与面板设计 |
| [Strategy 日运行与历史评估可靠性详细设计](./ddd/strategy-daily-cycle-and-replay-detailed-design.md) | publication、fencing lease、daily cycle、行情 checkpoint、AI 降级与 point-in-time replay |
| [账户绩效与组合归因详细设计](./ddd/account-performance-detailed-design.md) | 现金流、公司行动、每日估值、TWR、回撤、benchmark、贡献归因与缺失语义 |
| [Strategy 组合回测详细设计](./ddd/strategy-strict-backtest-detailed-design.md) | 独立 backtest scope、数据门禁、可复现身份、费用/滑点/可交易性与指标可用性 |
| [AI 投资决策闭环 Phase 2 完成计划](./ddd/decision-loop-phase2-completion-plan.md) | 真实复盘目标用户旅程、冻结契约、竖向切片、迁移/安全/测试与外部数据门禁 |
| [MVP3 决策与复盘详细设计](./ddd/mvp3-decision-review-detailed-design.md) | 账户记录、成交关联、幂等账本、聚合、报告补充与跨端验收 |
| [Phase 3 基本面 PIT 因子与横截面评分详细设计](./ddd/fundamental-factor-scoring-phase3-detailed-design.md) | 实验设计：财务 vintage、因子、横截面评分与版本审计；当前仅显式 mock，真实数据门槛未通过 |
| [Strategy 实验、晋级与反馈闭环详细设计](./ddd/strategy-experiment-feedback-detailed-design.md) | 组合能力门禁、评分分解、DSL Catalog、实验上下文、人工晋级和 RecommendationPolicy V2 |
| [Strategy AI 生命周期管理详细设计](./ddd/strategy-ai-lifecycle-detailed-design.md) | StrategyAutonomyAction 实体、自动暂停阈值、提议/验证/晋级门自动发布编排 |

## 运维手册

| 文档 | 用途 |
|---|---|
| [Strategy 生产可靠性运维手册](./runbooks/strategy-reliability-operations.md) | 调度参数、fencing/checkpoint/provider/baseline/T+1/T+3/T+5 日检、P50/P95/max 周报与真实 provider smoke |

## 历史归档

`archive/` 保存已完成阶段的计划、任务规格和验收快照，仅用于追溯，不作为当前实现契约。当前行为以代码、长期维护文档及对应 PRD/DDD 为准。

**已完成的阶段计划**（2026-11-04 从根层移入）：

- [luoome 开发计划](./archive/development-plan.md) — 单机形态的执行计划与历史验收基线
- [Strategy 日运行与评估可靠性开发计划](./archive/strategy-reliability-development-plan.md) — P0/P1/P2 实施顺序与验收记录
- [Strategy 实验、晋级与反馈闭环开发计划](./archive/strategy-experiment-feedback-development-plan.md) — Wave A–E 波次与完成记录
- [Strategy 与统一 Watchlist 开发计划](./archive/strategy-watchlist-development-plan.md) — Tactic/StockGroup/StockPool 到目标模型的迁移计划

**多租户托管形态（已下线）**——登录、订阅计费、支付渠道、管理后台、托管站点、内嵌 DSH Host 与用量计量：

- [个人订阅托管版开发改造计划](./archive/hosted-personal-subscription-development-plan.md) — 原页面复用改造切片、旧工程证据与新业务验收
- [个人订阅托管版详细设计](./archive/hosted-personal-subscription-detailed-design.md) — 增量登录、单默认账户、用户隔离、支付订阅与后台恢复契约
- [个人订阅托管版运行与恢复](./archive/hosted-personal-subscription-runbook.md) — 显式启动、私有存储、provider 装配、写屏障、备份恢复与生产门禁
- [个人订阅托管版隔离验收](./archive/hosted-personal-subscription-fixture-acceptance.md) — 工程测试、浏览器、100 Tenant fixture 压测与尚未通过的真实渠道门禁
- [运营管理页面 v1](./archive/admin-console-v1.md) — 用户列表、额度、标记收款与服务期管理
- [订阅定价与套餐设计 v1](./archive/subscription-pricing-v1.md) — 首期单档套餐、试用与续费、AI 额度口径
- [支付渠道接入调研](./archive/payment-channel-research.md) — 微信/支付宝直连路径、合规前置与成本
- [托管版每日自动服务 v1](./archive/hosted-daily-auto-service-v1.md) — 按租户的预警、报告、Strategy 日循环与成本闭环

**DSH 插件平台与首页开发阶段（已归档）**：

- [DSH 插件平台开发任务](./archive/dsh-plugin-platform-development-plan.md) — 四线程交付、D01–D07 统一集成与验收结果、后续 D08–D10 范围
- [DSH 插件平台详细研究与验证计划](./archive/dsh-plugin-platform-research-plan.md) — 固定上游基线、插件候选评估、启动/流式/确认/计量/隔离实验与逐项验收证据
- [AI 投资协作首页开发任务](./archive/ai-investment-workspace-development-plan.md) — PRD 任务拆分、依赖、并行线程文件边界与验收交接

**已退役数据源（仅用于历史追溯，不作为当前配置指南）**：

- [Tushare 行情适配器设计](./ddd/tushare-market-adapter-design.md) — 保留退役前协议、字段映射与历史数据兼容依据
- [Tushare 集成手册（已退役）](./runbooks/tushare-integration.md) — 旧部署排查记录；当前配置迁移见 [Fuyao 扩展与退役设计](./ddd/fuyao-data-expansion-and-tushare-retirement-design.md#13-配置与迁移)

**早期 MVP 阶段**：

- [v0.1 实施计划](./archive/plan.md)
- [v0.1 Agent 任务规格](./archive/MVP-TASK.md)
- [v0.2 + v0.3 实施计划](./archive/plan-v0.2-v0.3.md)
- [v0.8.0 MVP 开发计划](./archive/MVP-PLAN-BOARD-HOLDINGS-GROUPS-WATCH.md)
- [v0.8.0 MVP 验收记录](./archive/MVP-ACCEPTANCE.md)
- [Adshare smoke 跳过记录（2026-07-23）](./archive/adshare-smoke-skip-20260723.md)

## 维护约定

- 新增产品需求放入 `prd/`，新增实现设计放入 `ddd/`，可重复执行的操作流程放入 `runbooks/`。
- 完成且不再维护的阶段计划、一次性报告和验收快照移入 `archive/`；**已删除形态**（CLI/TUI/MCP/旧 Web/托管）的实现设计不再保留，只保留当前形态的设计与仍生效的领域契约。
- 新增、移动或归档文档时同步更新本页；README 只保留高频入口，避免维护两份完整目录。
- 实体或物理表变化时同步 [ENTITY-MAP.md](./ENTITY-MAP.md)；tool 增删改名时同步 [TOOL-INVENTORY.md](./TOOL-INVENTORY.md)。
- 文档与实现冲突时，以当前代码和测试为准，并及时修正文档状态或记录到 [BACKLOG.md](./BACKLOG.md)。
