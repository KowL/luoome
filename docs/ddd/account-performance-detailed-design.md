# 账户绩效与组合归因详细设计

> 状态：竖向切片、盘后持续快照 workflow/scheduler、修订审计、周报区间指标、缺价语义与 Web
> 审计入口与一年真实长区间 smoke 已实现（截至 2026-08-20）；跨交易日生产样本和大账户预算仍持续积累。
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

`portfolio_performance_snapshots` 按账户、区间和输入事实指纹保存结果、`dataAsOf` 与计算时间；同一指纹
幂等复用。快照不能取代原始账本和行情事实，交易、持仓、现金流、公司行动或日线变化会产生新指纹和
新快照，旧快照仍可按 id 和账户历史读取。快照内审计元数据记录交易、持仓、现金流、公司行动、价格
序列、日线数量及计算耗时，作为长区间和大账户性能预算的真实运行事实。

绩效读取不会把“本地已有部分日线”误当作完整缓存：缺交易日时继续向真实行情 adapter 请求，并将
provider 返回与本地事实合并；provider 失败则保留已有日线，计算结果明确为 `partial/unavailable`。
账户内不同价格序列以最多 8 路有界并发读取；同一 benchmark 与持仓标的只读取一次。并发只缩短 IO
等待，不改变缺价、停牌或 benchmark 覆盖语义。

`snapshot-account-performance` workflow 通过 `ctx.tools.list_accounts`、
`ctx.tools.get_account_performance` 和 `ctx.tools.record_workflow_run` 编排全部或显式账户。默认生成截至目标
交易日的 365 个自然日滚动区间，允许显式扩大到 3,660 日，单次最多 1,000 个账户。每完成一个账户即已
通过原 Tool 保存快照；进程中断后重跑会复用已完成账户的同指纹快照，因此不需要绕过 Tool 另建检查点。
输入事实变化则只为受影响账户创建修订快照。WorkflowRun 只保存账户总数、完整/部分/失败数、新建/复用
数、价格序列、日线数和耗时，不把私人账本或持仓明细写入运行审计。

Web 长期进程每 5 分钟检查一次，A 股交易日 16:00（Asia/Shanghai）后每进程至多触发一次盘后 workflow；
重启后的重复触发仍由快照指纹幂等收敛。手动 CLI 可用
`luoome workflow run snapshot-account-performance --input '{...}'` 重跑指定区间或账户。

## 4. Surface 约束

- Web：`GET /api/account/performance` 使用当前账户，`GET /api/accounts/:id/performance` 显式指定账户；均要求 `LUOOME_EXPOSE_EXTERNAL=true`。
- 审计：`list_account_performance_snapshots` 与 `GET /api/accounts/:id/performance/snapshots` 只读已持久化快照摘要；`audit_account_performance_snapshots` 与 `GET /api/accounts/:id/performance/snapshot-audit` 通过账户+区间重叠查询汇总交易日覆盖、缺失日期、partial 原因和 `dataAsOf`，不会被最新的非重叠快照遮蔽。这些读取均不重新请求行情或重算绩效；摘要保留区间、输入指纹、完整度、benchmark 状态、估值天数和收益字段。
- 当前账户也提供 `/api/account/performance/snapshots` 与
  `/api/account/performance/snapshot-audit`；复盘页直接展示快照版本、输入指纹、`dataAsOf`、预算事实及逐交易日
  审计，不需要开启 external 才能读取已持久化审计。
- 同一估值日存在多个输入修订时，区间审计按 `calculatedAt + snapshot id` 选择最新快照作为当前事实，并
  返回 `revisionCount`。旧的 `complete` 不能遮蔽更新后的 `partial`，旧版本仍保留在快照历史中可追溯。
- Web 复盘页展示估值日、现金流、日 TWR、回撤、完整度、TWR/benchmark/超额收益和 PnL；缺失原因原样可见。
- 开盘/收盘报告的账户区块和 Agent v1 查询白名单复用 `get_account_performance`，不复制计算逻辑。
- Tool 的现金流与公司行动写入仍受 `write` 闸口约束；任何绩效结果都不自动创建 Advice、AlertPlan 或 Trade。

## 5. 验收矩阵

已覆盖：外部入金排除 TWR、分红/费用内部现金流、拆股调整成本、缺价不填 0、直接录入持仓、默认 benchmark/超额收益、输入指纹快照、memory/Drizzle 合约、Web external 闸口和报告/Agent 接线。

已完成：真实 SQLite 与真实行情源 31 个交易日 smoke、停牌缺价、多账户隔离、浏览器绩效页与
周报回归，以及空临时 SQLite + Sina 真实日线的 3 日生产装配 smoke；部分本地日线触发行情 provider
补齐和快照审计摘要/区间审计 Tool/Web 端点的回归测试也已覆盖。独立真实 Sina 3 日 smoke 进一步确认绩效
持久化 1 条 `complete`/`available` 快照后可直接读取审计摘要，区间审计返回 3/3 complete、无
`missingDates`/`gaps`，且未重新请求行情。

2026-08-20 的确定性验收补充覆盖：全账户 workflow 首轮逐账户保存、重跑全部复用、单账户账本事实变化
只创建该账户的新修订；缺失账户不阻断其它账户并以 WorkflowRun `partial` 收敛；最新 partial 修订不会被
旧 complete 快照掩盖；价格序列有界并发及输入事实/耗时预算进入快照和 WorkflowRun 审计；Web 当前账户与
显式账户审计端点、盘后调度防重均有回归测试。

同日还在独立文件 SQLite、真实 Sina 日线和真实 Chrome 中验收了 2025-08-21～2026-08-20：盘后
scheduler 自动写入 `partial` WorkflowRun 和 1 条长区间快照，计算 2 个价格序列、242 条持仓日线和
242 条 benchmark 日线，首跑约 3.46 秒；同事实 CLI 重跑为 `created=0/reused=1`，约 0.57 秒，且
WorkflowRun 正确记录 `manual`。复盘页显示 2 个可追溯版本、251 个日历预期交易日和 9 个 partial
缺口，缺失标的保持 `600519.SH`，没有填 0。9 个缺口包含真实市场休市日，说明内置交易日历与真实交易所
休市事实仍需校准；在权威日历证据补齐前保持 partial。跨真实交易日连续调度及大账户生产规模仍必须使用
真实 provider/SQLite 继续留证，不得以 mock、当前快照或 0 值关闭证据缺口。

明确不在本设计：自动交易、券商账户同步、费用/滑点/可交易性齐备前的严格回测净值、年化、Sharpe 或收益承诺。
