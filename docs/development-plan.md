# luoome 开发计划

> 状态：当前执行计划
> 基线日期：2026-08-15；Strategy 可靠性复核：2026-08-20
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

2026-08-20 在当前工作树完成复核；Strategy 可靠性、历史评估作业化与账户绩效首片均已通过本地
门禁，仍把全市场性能、历史评估长任务和连续生产证据保留为后续验收；账户绩效的 31 个交易日
浏览器页 smoke 已通过：

| 验证项 | 结果 |
|---|---|
| Vitest | 165 个文件、1186 项测试通过 |
| DB Bun tests | 276 项测试通过 |
| Web Bun tests | 224 项测试通过 |
| TypeScript | 所有 workspace `tsc --noEmit` 通过 |
| Biome | 545 个文件检查通过 |
| Build | 所有含入口的 workspace Bun 构建通过 |
| MCP stdio smoke | 12/12 通过（`LUOOME_MARKET_PROVIDER=real` + `LUOOME_MARKET_SOURCES=sina`，独立空库、不注入样例数据；AI profile 仅完成启动装配，smoke 未发起 LLM 请求） |

本轮合计 1686 项测试通过。这组数字只是本计划建立时的基线，不作为长期维护的固定测试库存；
后续验收以 `package.json` 中的当前脚本和测试发现结果为准。Web 历史评估入口已接入后台
session；真实 500 只股票 × 3 个交易日浏览器任务已完成 2/3 天并保留 1 天 `not_found` 事实。

真实链路记录：`LUOOME_MARKET_PROVIDER=real` 下 Eastmoney 本次运行出现远端 socket 关闭；已修正
Tencent 对明确指数代码使用真实 `day` 日线，并完成 2026-07-01～2026-08-12 的 31 个交易日
真实行情 + 文件 SQLite smoke：账户绩效 `complete`、benchmark `available`、快照持久化并在重开
数据库后复用。随后用真实 Tencent 日线在独立文件 SQLite 中验证两个账户隔离、账户范围拆股行动和
缺行情区间的 `partial` 语义；浏览器仍验证空数据库不注入样例，可靠性汇总 API 明确
`trading-days-below-target`。

全市场性能证据已通过真实 Sina 数据源完成：Sina 沪深目录返回 5,207 只，独立文件 SQLite
中 `sync_stock_universe` 创建 5,207 只；`sync_daily_bars` 请求 5,207 只、5,207/5,207 成功，
无 mock/fallback。数据准备阶段请求 5,207 只、5,205 可用、2 只因最新交易日陈旧而保留缺口，
provider failures=0、fallbackUsed=false，耗时约 8 分 41 秒；checkpoint 上的纯策略求值
5,205 只耗时约 2.27 秒，运行结果覆盖率 99.9616%。第二次真实数据准备保持同一覆盖和失败分布，
成员请求延迟 P50=1,880.23ms、P95=2,222.19ms、max=4,842.13ms，整体耗时 521.10 秒；
首个显式 schedule 周期也已落库，data-prep=521.089 秒、run=1.695 秒、leaseRenewals=2，
publication=published，观察无 pending；第二个真实交易日周期 data-prep=521.103 秒、run=3.059 秒，
同样 leaseRenewals=2、leaseLost=0、coverage=99.94%。AI 未配置时按 facts-only partial 收敛；调度外层已保持
`partial` 状态，不把已发布事实误报为 failed。另用真实陈旧/停牌证券 `600984.SH` 验收账户绩效：
缺价估值日明确为 `partial`，`holdingsValue`、`totalValue` 与当日收益字段为 unavailable，未填 0。
当前可靠性汇总已聚合 2026-08-13/14 两个正式真实交易日的 phase P50/P95/max；daily cycle 现在会在
正式数据准备前通过已发布 operational run 的真实事实阻止同一 schedule/交易日的重复 cron tick；另一次 2026-08-11
显式历史尝试因缺少 PIT universe 诚实失败并保留审计，`historicalRunCount=1` 且不计入正式生产门禁，
不能算作成功生产周期，也不以默认值掩盖缺口。
可靠性汇总的 `since`/`until` 区间现在按运行实际 `dataAsOf` 过滤，而不是仅按进程启动时间过滤，避免
历史补跑在启动时间落入区间时污染生产门禁。
同时返回 `scheduleTradingDayKeys` 并支持 `scheduleId` 过滤；多 schedule 汇总不会把不同 schedule
的交易日拼成目标天数，任一 schedule 未达目标时保留 `schedule-days-below-target` 阻塞。
这里不把 2 个成功样本冒充 30 日 P95，仍需跨更多交易日 schedule 样本。

本轮继续用 `LUOOME_MARKET_PROVIDER=real` 在同一独立 SQLite 强制同步真实目录：Sina 返回并原子
写入 5,207 只，`syncId=e549123f-b30b-4237-bfd1-28389a29e1d6`，观测时间
`2026-08-13T19:39:27.414Z`；随后按 `asOf=2026-08-14T00:00:00Z` 查询 PIT，仍返回 5,207
个成员及稳定 checksum `df1360553c4c026c15d04170b3287334312f1a0d6f97c92e196419380c4d6ab8`。
Eastmoney 的失败被记录为真实 provider warning，最终成功源为 Sina；没有 mock 或静态样例回退。

同日补充验证真实连板天梯链路：`LUOOME_MARKET_PROVIDER=real` 下 Eastmoney `getTopicZTPool`
对 2026-08-13 返回 59 条原始记录，manager 按默认板块/ST 过滤后返回 57 条、5 个层级、最高 5 板，
`source=eastmoney`、`asOf` 为实际抓取时间；未注入 fetch stub 或 mock。全市场宽度使用的另一条
`push2.eastmoney.com` clist 端点仍发生 `ECONNRESET`；现已接入真实 Tencent 批量快照作为 fallback，
按 Sina 实时完整目录分 11 批请求，5,207/5,207 条返回、missing=0、envelope=`complete`、
`dataAsOf=2026-08-13T08:15:00Z`，因此不把涨停池成功误当作全市场快照，也不以 mock 补齐。
同一真实 Tencent snapshot 通过 `get_ashare_sentiment` 复核宽度：`status=complete`、
`advancing=1,083`、`declining=4,041`、`unchanged=83`、`total=5,207`，warnings 为空。
Registry 健康状态同步记录 `lastSuccessAt` 与同一 `dataAsOf`，可用于后续跨日门禁汇总。

Strategy DSL 的天梯字段也完成了真实端到端验收：同一独立文件 SQLite 使用 Sina 目录和
Eastmoney 涨停池，5,207 个候选的 `limit-up-ladder` coverage 为 5,207/5,207，规则
`meta.limitUpLevel >= 3 && meta.limitUpToday === true` 实际选出 9 只；因本次验证未准备
quote/daily-bars，运行仍诚实标记 `incomplete` 并拒绝 publication，不以 mock 或默认值掩盖数据缺口。

真实历史评估验收也已做边界验证：使用真实 SQLite 中 500 只股票请求 2026-07-01～2026-08-11
的 30 个交易日，30/30 天均因库中没有对应日期的真实 PIT universe 返回 `not_found`，没有降级为
当前快照或 mock 数据。后续必须在真实日运行中逐日保留 universe snapshot，再重跑该区间。
已有 PIT 数据的区间已扩大到 2026-08-13～14、500 只真实股票：2/2 天 complete，累计 evaluated=1,000、
failed=0；逐日 StrategyRun 约 1 秒，vintage 按日期分别为 unavailable/available。随后对同一真实 SQLite
执行 5,207 只全市场回放：2026-08-13～14 两日均 complete，累计 evaluated=10,414、selected=10,410、
failed=0；两日全市场回放的 vintage 均为 `unavailable`（8/14 的 `available` 证据仅来自既有 1 只/500 只
子集回放）。期间修复了 replay 以交易日日终
选中 PIT snapshot、但数据准备又按 UTC 午夜查目录的时点分叉；现在通过独立 `universeAsOf` 传递日终查找时点，
仍保持 checkpoint `dataAsOf` 为目标交易日，不回退当前目录或 mock。

本轮再次以 `LUOOME_MARKET_PROVIDER=real` 启动独立临时 SQLite 的 Web：静态入口、空库账户读取和
`/api/strategy/reliability-summary` 均返回 200；空库仍为零账户、零运行，没有注入样例或 mock。
同时验证浏览器账户通过 `X-Luoome-Account-Id` 形成 request-scoped context，不同 tab 并发读取不会
串账户；该 header 只做上下文选择，不替代账户级鉴权。

用户入口的真实行情 smoke 也已复现：在空的临时 `LUOOME_HOME` 中执行
`LUOOME_MARKET_PROVIDER=real LUOOME_MARKET_SOURCES=eastmoney bun packages/cli/src/index.ts market limit-up --date 2026-08-13 --json`，返回 `source=eastmoney`、`total=57`、`maxLevel=5`、`levels=5`；未配置 AI 只产生配置 warning，不写入样例账户或 mock 行情。

账户绩效生产装配也已复现：空临时 SQLite 中只建立最小 `kind=real` 账户、持仓和基准股票事实，
`LUOOME_MARKET_PROVIDER=real LUOOME_MARKET_SOURCES=sina` 请求 2026-08-11～13，3/3 估值日
`completeness=complete`、benchmark=`available`、`dataAsOf=2026-08-13`，持仓与 benchmark 日线均
实际来自 `sina`；未使用行情 fixture 或 mock fallback。

同一真实装配进一步复核快照审计：`get_account_performance` 持久化 1 条快照后，
`list_account_performance_snapshots` 在不重新请求行情的情况下返回该摘要，3 个估值日保持
`complete`、benchmark=`available`、`dataAsOf=2026-08-13`；未注入测试 fixture 或 mock 数据。
随后调用区间审计 Tool，2026-08-11～13 的 `expectedTradingDays=3`、`observedTradingDays=3`、
`completeDayCount=3`、`missingDates=[]`、`gaps=[]`；这证明审计闭环可读真实持久化事实。跨交易日
样本继续作为运营观测与性能基线积累，但不再设置固定天数的完成门禁。

### 2.2 本轮执行决策（2026-08-20）

当前不再新增横向产品能力，按以下顺序推进：

1. **S3 是持续生产观测项，不是固定天数门禁**：每个可用真实交易日运行 daily cycle，并记录 schedule、
   lease、checkpoint、publication、观察补全、AI facts-only 与阶段 P50/P95/max；运行证据用于运营监控和
   性能基线，不因交易日数量阻塞代码与功能交付。
2. **真实数据优先**：PIT snapshot、全市场回放或 provider smoke 缺数据时保留 `not_found` / `partial` /
   `failed` 事实，不回退当前快照、静态样例或 mock 数据。
3. **S3 观察期内只做收口工作**：允许修复可靠性缺陷、补测试、补可观测和补文档；R5 早期突破 v2 只有在
   用户确认后才发布试验，schema 迁移生成和 Web 账户级鉴权先保留为独立决策项。
4. **v0.10 只补验收证据**：继续做更长历史任务、持续快照审计和多账户隔离回归；不把 request-scoped
   账户上下文误称为认证，也不把历史评估误称为收益回测。
5. **市场宽度只认完整信封**：`MarketSnapshot` 的批次完整性、来源与抓取时间必须可审计；Eastmoney
   clist 失败时优先使用真实 Tencent 批量快照，真实行情源全部不可用时保留 unavailable/partial，
   不以本地旧快照或 mock 推算全市场宽度。

### 2.3 实现状态矩阵

| 领域 | 当前真实状态 | 主要缺口 |
|---|---|---|
| 行情底座 | StockUniverse、qfq DailyBar、Quote 新鲜度、capability registry 已完成 | 优先消费已有能力，不继续横向扩底层 |
| Strategy / Watchlist | 旧 Tactic、StockGroup、StockPool 已移除；统一 Watchlist、多来源与 Strategy → Watchlist 持久显式订阅、取消、published operational 投影和 complete/partial/failed 同步语义已落地 | 持续积累真实生产日验收样本与订阅来源的产品观测 |
| Strategy Workspace | Phase A～C 已完成；publication、fencing lease、daily cycle、checkpoint、PIT replay、edge signal、观察统计和独立故障矩阵已落地；生产日 daily cycle 会先同步真实 StockUniverse PIT snapshot，启动前自动收敛 stale WorkflowRun，并阻止同一 schedule/交易日重复正式 cycle；5,207 只真实 Sina 全市场重复运行与首个 schedule 审计已记录 | 跨交易日阶段 P50/P95/max 与持续真实运行观测 |
| Research Vault | Phase A/B、Phase C、M3 managed 创建/导入与 M4 FTS/ResearchBrief 已完成 | embedding、跨模型评测扩展和远端同步仍暂缓 |
| Market View | Phase 1/2 已完成；Phase 3 的事实关联、markers 和日期深链接已落地 | 账户/事实详情的更细粒度页面联动仍可增强 |
| Report / 信号复盘 | Report、三类简报、SignalObservation、benchmark/excess return、MFE/MAE、分组描述统计和真实历史 VaR 风险报告已落地；观察聚合统一按 `stock-day-horizon` 去重并可回溯代表性 observation id | benchmark 真实数据可用率、去重分布和跨 Tool/Web/AI 的真实样本稳定性仍需验证；历史评估仍不是严格收益回测 |
| 账户绩效 | 现金流/公司行动 schema、双仓储、绩效 Tool、Web/报告/Agent、输入指纹快照、默认 benchmark、31 交易日真实 SQLite、双账户/拆股/缺价、周报区间 TWR/回撤、周报浏览器回归、真实 `600984.SH` 缺价验收和 3 日后台评估边界已落地 | 全市场长区间性能、更长历史任务与持续快照审计 |
| 连板天梯 | Phase 1～3 已完成；`meta.limitUpLevel`/`meta.limitUpToday` 已接入真实 manager，scan/scheduled 写入 PIT，replay 优先读取历史快照，缺失仍保持 unknown | 炸板/断板历史语义与跨交易日真实快照积累 |
| Workflow 架构 | 生产 workflow 已通过 workflow-only tools 编排，并有静态边界测试 | 后续新增 workflow 继续遵守同一边界 |

### 2.4 文档冲突处理

开发前统一遵守以下覆盖关系：

- `ResearchNote` 需求已被 [ResearchTopic / ResearchDocument 设计](./ddd/research-vault-detailed-design.md)
  替代，不恢复旧 ResearchNote CRUD。
- 旧 Watchlist PRD 中“自动绑定”的 Strategy source 同步已按较新的 Strategy Workspace 决策收敛为持久
  显式 opt-in 订阅：只有 published operational run 可投影，complete sync 才结束缺失来源，partial/failed
  只标 stale；没有订阅时不产生 Watchlist source。
- [Agent Loop 技术选型分析](./ddd/agent-loop-tech-selection.md) 中“当前没有 agent loop”的描述已被
  AI SDK 和 Web chat 实现取代，不再按旧方案重复建设 loop。
- [ROADMAP](./ROADMAP.md) v0.8 以前内容是历史快照，不作为当前功能 backlog；v0.9 起才是当前版本计划。
- SignalObservation 是真实事后观察，point-in-time replay 也是历史规则回放；即使已有 PIT universe、
  DailyBar revision 和 benchmark 事实，在费用、滑点、停牌/涨跌停可交易性、公司行动和代码版本
  门禁满足前，仍不展示净值、年化、Sharpe、胜率或严格回测曲线。

### 2.5 未关闭验收项审计（2026-08-14）

以下项目仍保留在计划中，但它们不是可以用临时实现“补绿”的代码缺口：

| 项目 | 当前结论 | 关闭条件 |
|---|---|---|
| S3 生产观测 | 进行中，当前已有 2 个正式真实交易日样本 | 按真实交易日持续形成 schedule/lease/checkpoint/publication/观察/AI 降级审计；不设固定天数门禁 |
| v0.10 更长历史与持续快照 | 基础切片可用，长区间仍受真实 PIT 数据积累限制 | 真实 PIT 日期持续沉淀后完成更长历史任务、断点幂等和快照审计 |
| 连板天梯 → Strategy DSL 字段 | 当前/正式日与 PIT replay 已完成；无对应交易日快照时仍保持 unknown | 持续积累真实交易日快照，并获得可审计炸板/断板历史数据源 |
| 炸板/断板历史语义 | 2026-08-15 已冻结定义、审计信封和数据源门禁；个股历史已收紧为仅读 PIT repository，字段仍未注册 | 用真实凭据完成 Tushare raw daily + daily limit（首选）覆盖/权限/revision smoke 后，再实现专用双 repository；不得用当前情绪接口推断历史天梯字段 |
| Web 账户级鉴权 | 未立项；当前只有 request-scoped 账户选择 | 独立安全/产品决策、认证模型、权限矩阵和端到端验收 |

因此当前开发顺序不扩展横向产品能力：只收口可靠性、安全、测试、观测和文档，并持续积累真实
provider 证据；禁止用 mock、当前快照或推断字段关闭上述门禁。

## 3. 依赖关系

```text
M0～M6 已完成能力基线
  │
  ▼
S0 当前改动收口 ✅ ──► S1 可靠性测试/可观测 🚧 ──► S2 历史评估作业化 ✅
                                                        │
                                                        ▼
                                           S3 持续生产观测（非阻塞）
                                                        │
                                                        ▼
                                    S4 / v0.10 账户绩效与组合归因 🚧

S3 观察期内可以推进 S4 的 PRD/DDD，不提前扩大自动推荐、通知或外部数据源。
```

以下工期按单人或单 Agent 串行开发估算，表示有效开发日，不包含外部数据源审批、产品等待和
真实市场数据等待时间。

### 3.1 当前优先级覆盖（2026-08-14）

M0～M6 已完成，不再重复排期。[Strategy 日运行与评估可靠性开发计划](./strategy-reliability-development-plan.md)
中的 R0～R7 已从“待编码”进入“核心实现已落地、验收和运营证据未完成”的阶段。下一步按以下
顺序推进：

| 顺序 | 里程碑 | 目标 | 预计 |
|---|---|---|---:|
| ✅ | S0 当前改动收口 | 分离安全修复、模板升级与历史评估 UI，消除半完成工作树 | 已完成 |
| P0 | S1 可靠性测试与可观测 | 故障矩阵、阶段审计、lease/checkpoint/provider 观测与汇总 API、5,207 只重复真实运行、审计日志与安全回归已完成；补跨交易日 P95 样本 | 1～2 日 + 真实运行 |
| ✅ | S2 历史评估作业化 | 把同步长请求改为可进度、可续跑、可取消的 evaluation job | 首个切片完成 |
| Observe | S3 生产观测 | 按真实交易日持续收集真实运行、数据覆盖、观察补全和 AI 降级证据；不设固定天数门禁 | 持续进行 |
| P1 | S4 账户绩效与组合归因 | 契约、首个竖向切片、31 交易日真实 SQLite、双账户/拆股、真实缺价 smoke、周报区间指标和收盘分组变化完成；补长区间与后台浏览器验收 | 4～7 日 + 真实运行 |

### 3.2 Strategy 可靠性实现复核

| 原里程碑 | 当前代码状态 | 下一验收动作 |
|---|---|---|
| R0 publication | Summary V4、scope、publication 和 current 查询已落地；手工运行绕过 acceptance 的修正位于当前工作树 | 合入安全修复，验证低覆盖 manual/scheduled 均 withheld，evaluation 永不污染 current |
| R1 fencing lease | run/schedule heartbeat、fencing token 和 fenced commit 已落地；memory/Drizzle contract 已覆盖 fake-clock 三小时续租、接管、旧 fence 拒绝和重复 release | 保持随 S3 真实运行持续观察 leaseRenewals/leaseLost |
| R2 daily cycle | `strategy-daily-cycle` 已成为 Web scheduler 主路径，生产日先通过 `sync_stock_universe` 固化真实 PIT snapshot，显式历史 `asOf` 不触发实时同步；facts-only、阶段耗时、计数和 providerStatuses 已落地；调度层能区分 `partial` 与 `failed`；启动前以 workflow-only tool 收敛超出租约窗口的 stale WorkflowRun；观察补全和推荐均经 `ctx.tools.*` 编排；测试已覆盖目录同步失败不使用旧快照、数据准备失败、AI facts-only、观察阶段失败后保留已发布 run、lease 丢失 | 继续随真实生产周期观察 T+1 补全与 provider 失败分布 |
| R3 规则语义 | crossing、AST 三值短路、实际读取路径和 RuleEvaluation V2 已落地 | 固定 evaluator 兼容测试并核对真实 incomplete 分布 |
| R4 数据准备 | 有界并发、配置化超时/重试、checkpoint、revision、成员 latency P50/P95/max 和真实 5,207 只重复运行已落地；测试已覆盖连接重置的有界重试、超时和并发上限 | 跨交易日阶段 P50/P95/max，并用真实 provider 继续观察限流/回退分布 |
| R5 早期突破 v2 | draft、edge/cooldown、exit/risk signal 能力已落地 | 用户确认后发布试验版本，进入完整 T+20 真实观察期 |
| R6 PIT 历史评估 | universe snapshot、DailyBar revision、evaluation session/day、range replay 与 Web 后台作业已落地 | 真实区间 smoke、断点/取消后的幂等审计和 vintage unavailable 浏览器展示 |
| R7 观察统计 | benchmark/excess return、分位数、MFE/MAE、行业/score/edge/market-state 分组和 `stock-day-horizon` 去重已落地；Tool/Web/AI facts 共用代表性 observation id；生产日与补观察流程显式同步并审计 `000300.SH:qfq:daily:v1` | 继续用真实样本验证 benchmark 完整率、去重分布和跨 Tool/Web/AI 一致性 |

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
2. 证明 lease 丢失后旧 owner 不能提交 run bundle、创建观察、生成 Advice 或发送通知；进程中断后，
   下次 daily cycle 只收敛超过租约窗口的 stale WorkflowRun，近期运行保持 running。
3. 生产日周期先同步当日真实 StockUniverse；同步失败直接结束并释放 schedule lease，不能使用旧
   snapshot 伪装当前目录；显式历史 `asOf` 只读取既有 PIT snapshot。WorkflowRun 保存阶段、耗时、计数、
   publication 原因、checkpoint、lease 续期、观察补全和 providerStatuses；后阶段失败不回滚已发布事实。
4. 将数据准备的并发、单请求超时、有限重试和稳定 error kind 聚合纳入可观测配置；新增
   `get_strategy_reliability_summary` 与 `/api/strategy/reliability-summary` 生成可复核门禁证据，
   检测同一 schedule/交易日重复正式运行；正式周期缺 publication、checkpoint 或观察审计事实时
   直接阻塞 ready，并从真实 `phaseTimings` 输出 P50/P95/max 延迟。
5. ✅ 对 5,207 只真实全市场完成重复数据准备、覆盖率、provider 分布和成员请求 P50/P95/max；
   ✅ 首个显式 schedule 已写入 data-prep/run phase timing，AI 缺失时外层状态为 `partial`；⏳ 继续
   跨交易日记录 WorkflowRun 阶段 P50/P95/max，形成持续运营性能基线。

#### S2：历史评估作业化（首个切片已完成）

1. ✅ Web 创建 evaluation session 后快速返回，由日期级 job 后台推进；页面轮询 session/day 状态。
2. ✅ 支持失败日重试、断点续跑和明确的取消状态；取消不删除已完成日期事实。
3. ✅ 日期级 evaluated/selected/signal/failed 计数已持久化，后台任务异常会收敛为 failed。
4. ✅ 结果固定称为“历史评估/历史回放”，只展示求值、入选、信号、覆盖与观察事实。
5. ✅ 已完成真实 500 只 × 3 个交易日浏览器长任务边界验收：2 日完成、1 日因 PIT universe 缺失
   `not_found`，页面显示部分完成且保留逐日事实；✅ 同一真实 SQLite 已完成 5,207 只全市场两日预算
   验收（2026-08-13～14：累计 evaluated=10,414、selected=10,410、failed=0，vintage 不可用状态按日
   保留）；⏳ 2026-07-01～2026-08-11 真实区间、断点幂等和更长历史验收仍待真实 PIT 数据积累。

#### S3：生产观测（非阻塞）

按真实开市日持续记录：每个 schedule 的正式运行数、lease 续期、checkpoint 覆盖、publication、
到期观察补全、facts-only 降级和通知结果。每周形成可靠性汇总；这些是运营监控与性能基线，
不作为固定交易日数量的完成门禁。观察期间只允许扩大诊断和修复，不扩大自动推荐/通知默认范围。

### 3.4 v0.10：账户绩效与组合归因（首个竖向切片已完成）

实现已按“契约与存储 → Tool → Report/Web/Agent”的竖向顺序完成首片；S3 观察期间只补审计与真实数据验收：

1. ✅ 冻结现金流、分红、拆股、费用、转入转出和公司行动 schema，并完成 Drizzle/memory 合约测试。
2. ✅ 建立按账户隔离的每日估值输出，缺失价格进入 completeness，不填 0。
3. ✅ 实现 TWR、最大回撤、benchmark/超额收益、已实现/未实现 PnL 与持仓贡献归因。
4. ✅ 接入账户复盘页、收盘/开盘账户区块和 Agent 只读白名单；不生成调仓或交易。
5. ✅ 增加输入指纹绩效快照与默认 benchmark 配置；✅ 完成 31 个交易日真实行情 + SQLite + 双账户/拆股/缺价 + 浏览器绩效页基础 smoke；✅ 完成真实 2 日 × 500 只完整及 3 日 × 500 只部分完成后台历史评估浏览器 smoke；✅ 完成周报浏览器回归、周报区间估值/TWR/回撤区块；✅ 收盘复盘通过 `list_watchlists` + `list_watchlist_changes` 生成分组变化汇总；✅ 完成真实 `600984.SH` 缺价验收（缺价不填 0）；⏳ 补更长历史任务与持续快照审计证据。

本轮收口：账户绩效读取发现本地只缓存部分日线时，会向已配置行情 adapter 补齐缺失区间并合并已有事实；provider 失败仍保留已有数据并由计算器返回 `partial/unavailable`，不把部分缓存误报为完整快照。相关工具回归和 typecheck 已通过。

本轮新增快照审计读取闭环：`list_account_performance_snapshots` Tool 与
`GET /api/accounts/:id/performance/snapshots` 只读已持久化摘要，不重新请求行情或重算绩效；返回
区间、输入指纹、`dataAsOf`、完整度、benchmark 状态、估值天数和收益摘要。该能力补齐“可查询审计”
实现；新增 `audit_account_performance_snapshots` Tool 与
`GET /api/accounts/:id/performance/snapshot-audit` 汇总交易日覆盖、缺失日期和 partial 原因，仍只读
持久化事实，并改为按账户+区间重叠查询，避免长区间被最新非重叠快照遮蔽。独立真实 Sina 3 日空库
smoke 已返回 1 条 `complete`/`available` 快照；跨交易日生产证据仍按真实运行持续积累，不以固定天数表述完成度。

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

当前/正式日的 `meta.limitUpLevel` / `meta.limitUpToday` 已通过统一天梯 manager 接入字段 registry，
并由 run provider coverage 记录来源；scan/scheduled 同步写入按交易日、来源幂等的 PIT 快照，历史
replay 只读取该快照，缺失时保持 unknown，不直接把当前快照或临时 mapping 当成历史事实。

本轮实现对应 `market_outlook` 的结构化摘要、行情与研究视图的 `limitUp` facts、涨停 marker
和研究时间线；单日历史拉取失败进入 `status=unavailable/warnings`，不伪造正常空结果。

## 6. 后续产品立项

N1 已排入 v0.10；N2～N4 仍只有 PRD 或方向草案。每项在编码前先产出 PRD 决策补充、DDD、
Tool/API schema、迁移与测试矩阵。

### N1：账户绩效与组合归因

**状态：首个竖向切片已完成；生产验收依赖 Strategy 可靠性门禁。**

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

### N3：Watchlist Strategy source（首个竖向切片已完成）

- 持久化 Strategy → Watchlist 显式订阅、取消和审计历史；
- 只有 published operational run 可以投影，complete sync 才能结束缺失来源；
- partial/failed 只标 stale，不制造全量退出；空 complete 只在完整且可信零命中时结束全部来源；
- manual、AI、Portfolio 和其它 Strategy source 相互隔离；重复 producerRun 幂等；
- Tool、Workflow、SQLite/in-memory repository、Web/API/UI 与测试已接线；不自动生成 Advice、通知、AlertPlan
  或 Trade。

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
- 非只读 Tool 已统一记录 JSONL audit log：CLI/MCP/TUI/Web 生产入口写入各自 `$LUOOME_HOME` 日志，
  文件权限为 `0700/0600`，只记录调用元数据、不记录业务输入输出；Advice 的 LLM reasoning、risks 与 raw reasoning 在落库前
  清理常见 prompt-injection 模式。2026-08-14 release checklist 已通过 MCP smoke、registry/invariant、
  错误脱敏和 Web/TUI 界面回归复核。

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
- 每个到期 schedule 至多一次正式运行，重复 claim 有可审计的 skipped 事实；
- 低覆盖/evaluation 发布污染为 0，长运行不失租或越权提交；
- 到期观察最迟在下一次成功周期补齐，AI 故障仍有 facts-only 输出；
- 全市场数据准备和求值进入设计性能预算，所有阶段都有 WorkflowRun 审计。

账户绩效 DDD、数据完整度规则、端到端场景和测试矩阵的首版已冻结并进入实现；剩余快照审计
扩展需继续遵守同一契约。N2～N4 仍为候选方向，不与 v0.9/v0.10 并行扩张生产能力。
