# 账户绩效与组合归因详细设计

> 状态：首个竖向切片、审计快照、周报区间指标、缺价语义与真实后台浏览器边界验收已实现
> （截至 2026-08-14）；真实长区间与持续快照审计仍在 v0.10 计划中。
> 本设计回答账户“实际表现如何、收益来自哪里、哪些指标因缺数据不可用”，不定义交易执行或调仓建议。

## 1. 边界与事实源

账户事实继续由 `Account`、`Holding`、`Trade` 和 `AdviceOutcome` 拥有。本模块只新增：

- `PortfolioCashFlow`：入金、出金、分红、费用、税费和账户间转入/转出；金额始终为正数，方向由 `kind` 决定；
- `PortfolioCorporateAction`：账户持仓范围内的拆股、送转、每股现金分红；
- `get_account_performance`：按账户读取交易、直接录入持仓、现金流、公司行动和 qfq 日线，调用 core 纯计算器。

行情缺失是 `partial/unavailable` 事实，不允许用 0 或上一日价格填补。生产默认 benchmark 为 `000300.SH`（沪深300），可用环境变量覆盖；只有真实日线覆盖整个估值区间时才标记 `available`。

## 2. 计算口径

1. 日历只生成 A 股交易日；交易、现金流和公司行动按发生时间及 id 稳定排序。
2. 入金、出金、转入、转出使用 signed amount 进入现金余额，并从当日 TWR 分子中剔除；分红、费用和税费是投资内部现金变动，必须影响 TWR；交易手续费进入买入成本或卖出已实现 PnL。
3. 拆股/送转按 ratio 调整数量和单位成本；分红同时进入现金和持仓贡献。
4. TWR 从前一完整估值日开始计算；任一估值日缺价时，整段收益率与最大回撤保持 unavailable，但仍返回已知日的估值事实。
5. 持仓贡献拆分为已实现 PnL、未实现 PnL、分红和当前市值；没有交易事实的直接录入持仓作为期初仓位，并从期初现金中扣除成本。
6. benchmark TWR 使用 benchmark 日线首末有效收盘，`excessTwrPct = portfolioTwrPct - benchmarkTwrPct`；覆盖不足时只返回状态和 warning。

## 3. 契约与存储

`packages/core/src/entity/portfolio-performance.ts` 定义现金流、公司行动、估值日、贡献和汇总 schema；`packages/core/src/portfolio/performance.ts` 为无 IO 的纯计算器。

`packages/db` 同时提供 Drizzle SQLite 与 in-memory 实现：

- `portfolio_cash_flows`：按 account/occurredAt 索引；
- `portfolio_corporate_actions`：按 account/occurredAt 索引；
- 两类 repository 通过同一 contract tests 验证 upsert、范围查询、账户隔离和删除。

`portfolio_performance_snapshots` 按账户、区间和输入事实指纹保存结果、`dataAsOf` 与计算时间；同一指纹幂等复用。快照不能取代原始账本和行情事实，输入变化会产生新的快照。绩效读取不会把“本地已有部分日线”误当作完整缓存：缺交易日时继续向真实行情 adapter 请求，并将 provider 返回与本地事实合并；provider 失败则保留已有日线，计算结果明确为 `partial/unavailable`。

## 4. Surface 约束

- Web：`GET /api/account/performance` 使用当前账户，`GET /api/accounts/:id/performance` 显式指定账户；均要求 `LUOOME_EXPOSE_EXTERNAL=true`。
- 审计：`list_account_performance_snapshots` 与 `GET /api/accounts/:id/performance/snapshots` 只读已持久化快照摘要；`audit_account_performance_snapshots` 与 `GET /api/accounts/:id/performance/snapshot-audit` 通过账户+区间重叠查询汇总交易日覆盖、缺失日期、partial 原因和 `dataAsOf`，不会被最新的非重叠快照遮蔽。这些读取均不重新请求行情或重算绩效；摘要保留区间、输入指纹、完整度、benchmark 状态、估值天数和收益字段。
- Web 复盘页展示估值日、现金流、日 TWR、回撤、完整度、TWR/benchmark/超额收益和 PnL；缺失原因原样可见。
- 开盘/收盘报告的账户区块和 Agent v1 查询白名单复用 `get_account_performance`，不复制计算逻辑。
- Tool 的现金流与公司行动写入仍受 `write` 闸口约束；任何绩效结果都不自动创建 Advice、AlertPlan 或 Trade。

## 5. 验收矩阵

已覆盖：外部入金排除 TWR、分红/费用内部现金流、拆股调整成本、缺价不填 0、直接录入持仓、默认 benchmark/超额收益、输入指纹快照、memory/Drizzle 合约、Web external 闸口和报告/Agent 接线。

已完成：真实 SQLite 与真实行情源 31 个交易日 smoke、停牌缺价、多账户隔离、浏览器绩效页与
周报回归，以及空临时 SQLite + Sina 真实日线的 3 日生产装配 smoke；部分本地日线触发行情 provider
补齐和快照审计摘要/区间审计 Tool/Web 端点的回归测试也已覆盖。独立真实 Sina 3 日 smoke 进一步确认绩效
持久化 1 条 `complete`/`available` 快照后可直接读取审计摘要，区间审计返回 3/3 complete、无
`missingDates`/`gaps`，且未重新请求行情；仍待真实行情源更长区间和连续生产快照证据。

明确不在本设计：自动交易、券商账户同步、费用/滑点/可交易性齐备前的严格回测净值、年化、Sharpe 或收益承诺。
