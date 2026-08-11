# Strategy 日运行与评估可靠性开发计划

> 状态：当前执行计划
> 基线日期：2026-08-11
> 适用范围：Strategy 的定时运行、当前股票池、SignalObservation、AI 洞察与历史评估
> 详细设计：[Strategy 日运行与历史评估可靠性详细设计](./ddd/strategy-daily-cycle-and-replay-detailed-design.md)

## 1. 目标

把 Strategy 从“功能可运行”提升为“每天可持续运行、结果可验收、失败可恢复、历史评估不污染
生产视图”的研究系统。

本计划不新增自动交易，不把 StrategySignal 或 SignalObservation 表述为 Advice、胜率或严格回测。

## 2. 决策基线

2026-08-11 对“早期突破”策略做了两类检查：

1. 以 2026-07-01～2026-08-11 的 30 个交易日做隔离模拟，使用 500 只样本股票；
2. 检查 2026-08-10、2026-08-11 的正式全市场运行、观察补全和 AI 洞察输出。

关键事实如下：

| 事实 | 结果 | 影响 |
|---|---:|---|
| 隔离模拟运行 | 30/30 个交易日完成 | 日级编排路径可用 |
| 模拟命中 | 242 个 signal-day、130 只唯一股票 | 同一股票连续命中会放大样本相关性 |
| T+1 完整样本 | 164；平均收益 -0.37% | 只能作为描述性事实 |
| T+5 完整样本 | 157；平均收益 -1.78% | 需要继续观察并迭代定义 |
| T+20 完整样本 | 58；平均收益 -4.95% | 样本未走完完整周期，不能下收益结论 |
| 2026-08-10 正式运行 | 5,198 只；失败 0；incomplete 485；约 24 分钟 | 数据部分可用，但仍需验收门 |
| 2026-08-11 正式运行 | 5,198 只；evaluated 1,976；failed 3,222；约 143 分钟 | 失败率约 62%，不应替换当前股票池 |
| 正式运行固定租约 | 120 分钟 | 长运行可能在提交前失去互斥保护 |
| 观察补全 | 2026-07-01 后没有成功的正式 workflow 记录；43 条正式观察仍 pending | 18:10 固定外部 cron 与长运行存在竞态 |
| AI 洞察 | 模型输出结构/事实引用无效，被校验器拒绝 | 校验正确，但缺少事实型降级输出 |
| MA60 上穿距今天数 | 足够日线但窗口内未发生上穿时仍记 missing | 产生非真实 incomplete |
| 日线同步 | `Promise.all` 无界并发；首选 provider 大量 socket 失败 | 放大全市场外部依赖波动 |

隔离模拟使用当前股票目录、显式样本和本地 qfq 日线，存在幸存者偏差，且没有费用、滑点、
停牌/涨跌停可交易性、benchmark 与 point-in-time universe。因此以上数字不是严格回测结果，
只用于发现运行和策略定义缺口。

## 3. 优先级总览

| 优先级 | 里程碑 | 目标 | 预计 |
|---|---|---|---:|
| P0 | R0 运行验收与生产/评估隔离 | 不让低覆盖或 replay 结果成为当前事实 | 3～4 日 |
| P0 | R1 租约续期与所有权提交 | 长运行不重复、不越权提交 | 3～5 日 |
| P0 | R2 日运行闭环与 AI 降级 | 调度、观察、洞察形成一次可审计周期 | 4～6 日 |
| P1 | R3 指标与规则语义修正 | 消除伪 incomplete，提高规则解释深度 | 3～5 日 |
| P1 | R4 全市场数据准备稳定化 | 降低 provider 抖动和运行时长 | 5～8 日 |
| P1 | R5 早期突破 v2 试验 | 减少重复信号，增加退出/风险事实 | 4～6 日 + 真实观察期 |
| P2 | R6 point-in-time 历史评估 | 可重放一段日期且不产生幸存者偏差 | 8～12 日 |
| P2 | R7 观察统计增强 | benchmark、分组和样本相关性透明化 | 5～8 日 |

工期按单人或单 Agent 串行开发估算，不包含真实市场等待期。P0 完成前不扩大自动通知或
StrategyRecommendationPolicy 的使用范围。

## 4. P0：先保证每日结果可信

### R0：运行验收与生产/评估隔离

#### 任务

1. 在 core 增加纯函数模块 `StrategyRunPublication`，以运行 intent、scope、summary 和版本化
   policy 计算 `published/withheld/non-publishing`，不把决策塞进 `status` 或 `dataHealth`。
2. 新增 Summary V4，保存实际比率、阈值快照和稳定 reason code。初始默认阈值：
   - `evaluatedRatio >= 0.98`；
   - `failedRatio <= 0.02`；
   - `incompleteRatio <= 0.10`。
3. 为 StrategyRun 增加 `scope='operational' | 'evaluation'` 和持久化 publication：
   - 全市场 scan/scheduled 为 operational；
   - 显式子集 scan、replay/backtest 为 evaluation；
   - `persist=false` 仍不落库。
4. 当前股票池、默认 Diff、AlertPlan、推荐和生产洞察只消费 `publication=published` 的终态运行；
   repository 直接查询 latest/previous published run，不扫描固定 10 条猜测当前池。
5. legacy run 没有 publication/acceptance 时按兼容规则迁移，但页面增加 `legacy-publication`
   warning；不能让兼容规则应用到新的 Summary V4。
6. Web 工作台同时展示 latest attempt 与 current published run，并显示 withheld 原因。
7. `dataAsOf` 使用实际所需数据中最保守的观测时间；provider 信封保存成功、失败、缺失、fallback、
   stale 和各自数据时间，不能用 run.startedAt 代替。

#### 验收

- 2026-08-10 对应计数在默认 policy 下 acceptance=accepted、publication=published；
- 2026-08-11 对应计数必须 withheld，不能覆盖之前 current run；
- evaluation run 永不改变当前池、预警、推荐和生产洞察；
- persist=true 的显式子集 scan 也必须 non-publishing；
- published 且零入选仍是合法当前空结果；
- 连续超过 10 次 running/failed/withheld 后仍能找到更早的 published current run；
- memory/drizzle 对 scope、publication 过滤的 contract tests 一致。

### R1：租约续期与所有权提交

#### 任务

1. `StrategyRunRepository` 增加 fencing lease 原子接口：
   - `acquireRunLease(...) -> LeaseToken | null`；
   - `renewRunLease(token, ...) -> boolean`；
   - `commitRunWithFence(token, ...) -> 'committed' | 'lease-lost'`。
2. 正式运行使用短租约和周期 heartbeat；heartbeat 间隔必须显著小于租约长度。
3. schedule claim 同样支持续期，整个日运行周期结束后才推进 `nextRunAt`。
4. lease 已丢失时禁止提交 run bundle、SignalObservation、Advice 或通知；正在运行的记录收敛为
   `failed` 并保存稳定 `lease_lost_before_commit` error code，不新增 abandoned 状态。
5. 进程崩溃后允许新 owner 在租约到期后以更大 fence 接管；旧 owner 恢复后不能提交。
6. scheduler 不再一次 claim 20 个 schedule 后串行等待；逐个 claim 或有限并行，每个 claim 独立
   heartbeat，避免尚未开始的任务先过期。

#### 验收

- fake clock 下 3 小时运行持续续租且只能提交一次；
- owner A 失租、owner B 以新 fence 接管后，A 的提交原子失败；
- heartbeat 或 release 重复调用保持幂等；
- SQLite DDL、Drizzle schema、memory 实现和 contract tests 同步。

### R2：日运行闭环与 AI 降级

#### 任务

1. 新增深的 workflow 模块 `strategy-daily-cycle`，通过 `ctx.tools.*` 依次编排：
   schedule claim → 数据检查/准备 → run → publication → 到期观察补全 → insight → 可选推荐/通知。
2. 观察补全不再依赖“运行开始后固定 10 分钟”的外部 cron；日周期在 run 终态后执行一次，
   独立 cron 只保留为幂等补偿任务。
3. pending observation 改为最早到期/最老优先；同步失败记录 attempt/nextAttemptAt，防止新样本
   长期挤压旧样本或每天无界重试。
4. 每个阶段写 WorkflowRun 摘要和 providerStatuses；后阶段失败不回滚已提交的 published run。
5. `generate_strategy_insight` 保持严格 Zod 和 factRef 校验，增加一次有界修复重试。
6. LLM 仍失败时输出 facts-only 洞察，WorkflowRun 标记 partial，并明确“AI 叙述不可用”；不得
   伪造 narrative 或 Advice。
7. 默认 notification 仅发送 published run 的事实摘要；Advice 仍由显式启用的
   recommendation policy 产生。

#### 验收

- 一个日周期的阶段、耗时、计数、接受/拒绝原因可追踪；
- T+1 到期观察最迟在下一次成功日周期中补齐；
- insight 结构无效时仍返回确定性 facts，且记录 provider 和失败原因；
- withheld/non-publishing run 不生成推荐、预警或生产通知；
- workflow 源码不直接访问 repository 或 adapter。

## 5. P1：提高数据和策略事实质量

### R3：指标与规则语义修正

#### 任务

1. 修正 `daysSinceMa20CrossUp/daysSinceMa60CrossUp`：
   - 样本不足才是 missing；
   - 样本足够但回看窗口内没有上穿，返回“未观察到”的可比较数值和 provenance，而不是 missing。
2. requiredLookback 与真实算法一致；为 20/60 日均线边界和无上穿场景增加性质测试。
3. 将“早期突破”单条大 selection rule 拆成趋势、动量、量能、RSI、乖离、突破新鲜度等规则，
   利用现有 `all/any` 汇总语义，让已知 false 能阻断无关 missing。
4. 将表达式编译为 AST，selection/scoring/signal 复用真正的三值短路求值，并只记录实际读取路径；
   不改变表达式安全白名单。
5. RuleEvaluation 增加稳定的缺失/未观察解释和 evaluatorVersion 变化提示。
6. 展示 incomplete 的字段分布和规则分布，区分数据缺失与规则未命中。

#### 验收

- 足够日线但没有 MA60 上穿不再计为 incomplete；
- 任一明确不匹配的 `all` 规则可使 selection 明确失败，不受其它规则 missing 影响；
- 老 StrategyVersion 不原地修改，新语义通过 evaluator 版本和测试固定；
- 当前结果与 evidence 可确定性重算。

### R4：全市场数据准备稳定化

#### 任务

1. 把 `sync_daily_bars` 的无界 `Promise.all` 改为有界 worker pool，配置并发、每请求超时、有限重试
   和 provider 错误聚合。
2. 扩展 sync scope 支持 Strategy universe，由 tool 内部分页，不向 workflow 暴露逐股细节。
3. 每日盘后先形成 immutable daily-bar checkpoint；scheduled run 优先读取 checkpoint，避免运行中
   对 5,000+ 股票逐股实时抓取。
4. checkpoint 保存 asOf、coverage、成功率、provider 分布、数据 checksum 和 evaluator identity。
5. 未达到数据准备门槛时提前拒绝运行，不制造 2 小时后才发现覆盖失败的结果。
6. 为 provider 连接重置、限流、部分回退和进程重启增加 fault-injection 测试。
7. P1 checkpoint 只能证明本次输入一致性；P2 增加 append-only DailyBar revision 后才承诺跨时间
   重放同一数据 vintage。

#### 验收

- 并发请求数不超过配置上限；
- 单 provider 大面积 socket 失败时 fallback 不形成请求风暴；
- checkpoint bar checksum 仍匹配时，相同 checkpoint + definitionHash + evaluatorVersion 的
  evaluation 结果可重复；
- 5,198 股票运行耗时和失败率进入可观测预算，超限产生明确告警。

### R5：早期突破 v2 试验

#### 任务

1. 创建新的 draft version，不修改已发布版本；先应用 R3 的规则拆分。
2. 为 signal emission 增加 `level/edge` 与交易日 cooldown 语义；v1 默认 level，早期突破 v2 使用
   edge，避免连续命中每天重复创建同类观察。
3. 增加退出和风险信号事实，例如趋势失效、过热/放量失败；这些仍不是自动交易指令。
4. 使用同一 point-in-time 样本做 `persist=false` 对比试算，检查入选、阻断、数据完整度和
   signal 去重差异。
5. 用户确认后才发布；发布后至少观察一个完整 T+20 周期再决定是否继续迭代。

#### 验收

- 连续 5 日保持条件为真时，edge signal 只在首次跃迁产生；
- 退出/风险 signal 有独立 ruleId、evidence 和 observation；
- v1 历史事实保持可读；
- 评审页同时显示 definition diff、试算差异、样本数、缺失率和免责声明。

## 6. P2：建设历史评估能力

### R6：point-in-time 历史评估

#### 任务

1. 持久化 StockUniverse 成功同步的成员快照，按 `asOf` 选择不晚于目标日期的 snapshot。
2. 为历史 qfq 日线建立 data pack/checkpoint，保存 coverage、日期范围、provider 和 checksum。
3. 新增 `strategy-replay-range` workflow；逐交易日调用原子 `run_strategy`，所有持久化运行写入
   `scope=evaluation`。
4. 支持断点续跑、幂等 run identity、日期级失败重试和显式样本模式。
5. 输出逐日池变化、SignalObservation 与覆盖质量；费用、滑点、成交和 benchmark 未完成前，
   不输出净值、年化、Sharpe 或“回测胜率”。

#### 验收

- 2026-07-01～2026-08-11 范围可一键重放并在中断后续跑；
- 每日 universe 来自当日可见 snapshot，而不是当前目录；
- 重复运行相同 data pack 和 definition 不生成重复事实；
- evaluation 结果只能在显式评估视图查询。

### R7：观察统计增强

#### 任务

1. 同步明确版本的 benchmark 日线，完成 excess return 的事实计算；benchmark 缺失仍保持
   unavailable。
2. 按首次 edge signal、行业、市场状态、score bucket 分组，避免把重复 signal-day 当独立样本。
3. 同时展示样本数、唯一股票数、完整率、均值、中位数、分位数、MFE、MAE 和观察截止日。
4. 最小样本不足时只展示描述性事实，不生成概率或收益承诺。

#### 验收

- 所有聚合都可回溯到 SignalObservation id；
- benchmark 数据缺失不会回填 0；
- 统计窗口、去重口径和缺失率在 Tool/Web/AI facts 中一致。

## 7. 实施切片

按以下顺序形成小而完整的 PR；未经用户要求不自动 commit 或 push：

1. **PR-1：运行发布契约** — Summary V4、scope、publication、repository 查询、当前池读取；
2. **PR-2：租约所有权** — renew、fencing token、fenced commit、schedule heartbeat、故障测试；
3. **PR-3：日运行闭环** — daily-cycle、WorkflowRun、观察补全、facts-only insight；
4. **PR-4：规则事实质量** — crossing 语义、规则拆分能力、incomplete 诊断；
5. **PR-5：数据 checkpoint** — 有界同步、Strategy universe、盘后数据准备；
6. **PR-6：早期突破 v2** — draft、edge signal、退出/风险事实、试算；
7. **PR-7：历史评估** — universe snapshot、data pack、range replay；
8. **PR-8：统计增强** — benchmark 和去相关聚合。

每个 PR 都按 core → repository 双实现 → tool → workflow → surface → 测试/文档的竖向顺序
完成，合入后不得留下长期半迁移状态。

## 8. 统一交付门槛

- `core` 保持零 IO；workflow 只通过 `ctx.tools.*`；
- Tool 继续返回 `ToolResult`，write/external sideEffect 明确；
- Drizzle schema、SQLite `ensureSchema`、memory repository 和 contract tests 同步；
- Advice 不等于 trade，任何 Strategy 路径都不能自动下单；
- 新策略发布、正式运行和 recommendation policy 保持现有确认边界；
- 最小相关测试先通过，交付前运行 `bun run test:all`、`bun run typecheck`、`bun run lint`、
  `bun run build`；
- Web 改动必须真实启动并用浏览器验证；
- 外部 provider smoke 单独记录，不用公网波动替代确定性测试。

## 9. 完成判定

P0 完成的判定不是“定时任务被触发”，而是连续 30 个交易日满足：每个到期 schedule 至多一个
正式运行；长运行不失去租约；低覆盖运行不发布；到期观察能补齐；AI 故障仍有事实输出；每个阶段
都有 WorkflowRun 审计。

P1 完成后，早期突破 v2 才进入至少一个完整 T+20 真实观察周期。P2 完成前，任何历史区间结果
都继续标记为“历史评估/描述性观察”，不得称为严格回测。
