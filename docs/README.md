# luoome 文档导航

本文是 `docs/` 的统一入口。长期有效的说明放在根层，产品需求放在 `prd/`，技术设计放在 `ddd/`，运维操作放在 `runbooks/`，已完成的计划与验收记录放在 `archive/`。

## 快速入口

| 读者 | 从这里开始 |
|---|---|
| 产品用户 | [用户手册](./USER_GUIDE.md) |
| 外部 Agent / MCP 使用者 | [luoome Skill](../skills/luoome/SKILL.md) |
| 编码 Agent | [仓库开发规范](../AGENTS.md) |
| 贡献者 | [贡献者指南](./CONTRIBUTING.md) |
| 架构与领域开发者 | [架构说明](./ARCHITECTURE.md) |

## 长期维护文档

| 文档 | 用途 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 模块边界、领域模型、数据流和 workflow 约束 |
| [USER_GUIDE.md](./USER_GUIDE.md) | 安装、CLI、TUI、Web、MCP 与日常使用 |
| [ROADMAP.md](./ROADMAP.md) | 版本演进、已交付能力和后续方向 |
| [SECURITY.md](./SECURITY.md) | 副作用分级、鉴权、密钥与审计要求 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发环境、测试、代码规范和贡献流程 |
| [HANDOFF.md](./HANDOFF.md) | 当前能力、关键决策和跨会话交接信息 |
| [BACKLOG.md](./BACKLOG.md) | 文档一致性、测试盲区和工程债 |

## 产品需求（PRD）

| 文档 | 范围 |
|---|---|
| [策略预警产品文档](./prd/strategy-alert-product.md) | 策略预警闭环、用户流程、产品边界与实施分期 |
| [连板天梯产品文档](./prd/limit-up-ladder-product.md) | 涨停梯队快照的页面、tool、与下游联动边界 |
| [ruo 能力迁移产品设计](./prd/ruo-feature-migration-product-design.md) | 研究档案、公司事件、数据新鲜度与真实复盘 |
| [AI 投资决策闭环产品总纲](./prd/ai-investment-decision-loop.md) | 发现、研究、观察、Advice、行动与复盘的整体对象关系 |
| [AI 投资 Agent 协作体验](./prd/ai-investment-agent.md) | Agent 场景、工具编排、权限确认与外部能力边界 |
| [Strategy DSL](./prd/strategy-dsl.md) | 将现有 Tactic 重构为版本化 Strategy、运行结果与信号模型 |
| [统一 Watchlist](./prd/watchlist.md) | 统一手工、Strategy、AI 与 Portfolio 来源的机会观察和生命周期 |

## 技术设计（DDD）

| 文档 | 范围 |
|---|---|
| [策略预警详细设计](./ddd/strategy-alert-detailed-design.md) | schema 演进、状态机、送达矩阵与迁移 |
| [ruo 能力迁移详细设计](./ddd/ruo-feature-migration-detailed-design.md) | ResearchNote、StockEvent、WorkflowRun 与事件规则 |
| [盘中盯盘设计](./ddd/intraday-watch-design.md) | 股票池、盘中求值、冷却与 `luoome watch` |
| [股票分组设计](./ddd/stock-group-design.md) | StockGroup、成员快照与动态 resolver |
| [连板天梯详细设计](./ddd/limit-up-ladder-detailed-design.md) | A 股涨停梯队快照的 schema、东方财富涨停池 adapter、缓存与端到端集成 |
| [个股行情查看详细设计](./ddd/stock-market-view-detailed-design.md) | Market View Tool、日 K 数据契约、Web 图表与降级语义 |
| [Tushare 行情适配器设计](./ddd/tushare-market-adapter-design.md) | Tushare 作为 `MarketDataManager` 第三真实源的契约、字段映射与抑制窗口 |
| [行情数据底座详细设计](./ddd/market-data-and-stock-universe-detailed-design.md) | 多源规范化、盘后日线归档、本地股票目录同步与严格 adapter 替换 |
| [Vibe A 股报告与策略研究迁移详细设计](./ddd/vibe-ashare-report-and-strategy-research-detailed-design.md) | Report、A 股情绪证据、三类简报 workflow 与策略研究映射 |
| [Web 对话助手设计](./ddd/web-chat-design.md) | `/api/chat` 与 draft-and-confirm 交互 |
| [Agent Loop 技术选型分析](./ddd/agent-loop-tech-selection.md) | chat / workflow 升级为真 agent loop 前的库选型与契约设计分析 |
| [AI SDK 接入与 LLM 重构设计](./ddd/ai-sdk-llm-refactor-design.md) | 用 AI SDK v6 重构 LLM adapter 并实现 agent loop 的落地设计 |
| [Strategy 与统一 Watchlist 详细设计](./ddd/strategy-watchlist-unification-detailed-design.md) | Strategy、Watchlist、AlertPlan 的领域模型、存储、迁移与跨端契约 |

## 当前开发计划

| 文档 | 范围 |
|---|---|
| [Strategy 与统一 Watchlist 开发计划](./strategy-watchlist-development-plan.md) | 从 Tactic/StockGroup/StockPool 迁移到目标模型的阶段、依赖与验收门槛 |

## 运维手册

| 文档 | 用途 |
|---|---|
| [Tushare 集成手册](./runbooks/tushare-integration.md) | 配置、启动顺序、验证和故障排查 |

## 历史归档

`archive/` 保存已完成阶段的计划、任务规格和验收快照，仅用于追溯，不作为当前实现契约。当前行为以代码、长期维护文档及对应 PRD/DDD 为准。

- [v0.1 实施计划](./archive/plan.md)
- [v0.1 Agent 任务规格](./archive/MVP-TASK.md)
- [v0.2 + v0.3 实施计划](./archive/plan-v0.2-v0.3.md)
- [v0.8.0 MVP 开发计划](./archive/MVP-PLAN-BOARD-HOLDINGS-GROUPS-WATCH.md)
- [v0.8.0 MVP 验收记录](./archive/MVP-ACCEPTANCE.md)
- [Adshare smoke 跳过记录（2026-07-23）](./archive/adshare-smoke-skip-20260723.md)

## 维护约定

- 新增产品需求放入 `prd/`，新增实现设计放入 `ddd/`，可重复执行的操作流程放入 `runbooks/`。
- 完成且不再维护的阶段计划、一次性报告和验收快照移入 `archive/`。
- 新增、移动或归档文档时同步更新本页；README 只保留高频入口，避免维护两份完整目录。
- 文档与实现冲突时，以当前代码和测试为准，并及时修正文档状态或记录到 [BACKLOG.md](./BACKLOG.md)。
