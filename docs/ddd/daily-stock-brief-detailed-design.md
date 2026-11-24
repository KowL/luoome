# 每日个股观察（StockBrief）详细设计

> 状态：P0–P3 已实施；盘中 `provisional`（P3-2）不做
> 日期：2026-11-24
> 范围：`stock_briefs`、生成流水线、tool / API / CLI / MCP、调度、降级、结算与成绩单口径
> 关联文档：[产品需求](../prd/daily-stock-brief.md)、[架构说明](../ARCHITECTURE.md)、[领域语言](../../CONTEXT.md)

## 1. 边界与依赖

```text
apps/web ──► packages/tools(catalog) ──► toolkit(tool 查询) ──► db ──► core
    │                                      ▲
    └─ scheduler ──► workflows ──► plugins/analysis(generate_stock_briefs)
                                      │
                                      └─► toolkit internal(事实包/规则预筛/预算) ──► adapters
```

- `packages/core/src/entity/stock-brief.ts`：纯领域 schema、质量 / 阶段 / 来源 / 缺失维度枚举与不变量。
- `packages/db/src/schema/index.ts`：`stock_briefs` 表；`packages/db/src/repository/drizzle/stock-brief.ts`：仓储实现。
- `packages/plugins/analysis/src/tools/generate-stock-briefs.ts`：唯一批量生成工具，owner 为 `business.analysis`。
- `packages/toolkit/src/tools/get-stock-brief.ts` / `list-stock-briefs.ts`：只读查询与展示投影。
- `packages/workflows/src/daily-stock-briefs.ts`：批次编排与 `workflow_runs` 审计。
- Web / CLI / MCP 只消费 tool，不复制领域规则或文案映射。

## 2. `stock_briefs` 表

| 字段 | 含义 |
|---|---|
| `id` | 观察行 id |
| `trading_date` | Asia/Shanghai 交易日（`YYYY-MM-DD`） |
| `phase` | `premarket` / `intraday` / `post-market` |
| `account_id` / `stock_id` | 账户与标的 |
| `source` | `scheduled` / `manual` / `chat` / `cli` / `mcp` |
| `decision` / `confidence` / `horizon` | 从结论复制的板面字段，查询免 join |
| `advice_id` | 仅 AI 结论引用；规则观察为空 |
| `quality` | `ai` / `rule-only` / `partial` / `unavailable` |
| `fact_digest` / `facts_as_of` | 事实包稳定指纹与数据截止时间 |
| `missing` | 降级维度 + 原因 + 可选来源 / 数据时间 |
| `data_sources` | 本次事实包实际使用的来源 |
| `revised_from` | 同日重算时指向被覆盖行或上一轮 advice 链 |
| `llm_http_calls` / `llm_prompt_tokens` / `llm_completion_tokens` / `llm_reasoning_tokens` / `llm_cost_usd` | 当日真实用量，供预算守卫与验收核验 |
| `valid_until` / `created_at` / `updated_at` | 有效期与审计时间 |

唯一键 `(account_id, trading_date, stock_id, phase)` 即幂等键：同日同阶段重跑覆盖该行，
不新增第二行；结论变化用 `revised_from` 保留上一行 id。另有交易日、股票 + 交易日、
账户 + 交易日三个查询索引。

不变量（`assertStockBriefInvariants`）：`quality='ai'` 必须有 `adviceId`；
`rule-only` 只能是 `hold/watch/avoid` 且不得带 `adviceId`；LLM 计量非负；
每条 `missing` 必须同时有维度与非空原因。

## 3. 生成流水线

`generate_stock_briefs`（`sideEffect: 'advice'`，`agent: false`）的执行顺序：

1. **候选集**：持仓 ∪ 关注池（`watching/researching/confirmed`）∪ 当日 `operational` 策略信号
   （高分 bullish 补位，默认 ≤3），去重后按持仓 → 关注 → 信号排序，默认最多 8 票。
2. **事实包**：行情、日线、分时、新闻、板块、策略信号、账户事实汇总为 `stock-facts`，
   带 `factsAsOf` 与 `missing`；同时计算稳定 `factDigest`。
3. **规则预筛**：同日同 digest 跳过；连续 3 个交易日无新事实跳过；缺关键行情直接
   `unavailable`；只触发规则观察的票写 `rule-only` 行。
4. **盘前分支**：`phase='premarket'` 只写事实包 + 规则预筛的研究名单，0 次 LLM，不写 `advices`。
5. **AI 分支**：预算守卫（8 票 / 16 次 HTTP / 90k token，按「将触达」预留）通过后调用
   `analyze_stock` brief 路径；并发 2，单票最多 2 次尝试。数值、方向、指标可用性、DSL、
   禁用词与 factRef 校验都在 `analyze_stock` 内完成，通过后才写 Advice。
6. **落库与降级**：AI 结论写 `stock_briefs` 并引用 `adviceId`；模型两次失败、预算触达、
   插件缺失或数据不足写 `rule-only` / `unavailable`，并附 `missing.dimension` 与原因；
   LLM 计量累加到当日行。
7. **审计**：`daily-stock-briefs` workflow 先写 `running`，结束写 `succeeded` / `partial` /
   `failed`，`output_summary` 含 coverage、budget、HTTP 次数、token、LLM / 规则 / 不可用 /
   digest 跳过计数与降级原因。

候选集、预筛、预算与事实包逻辑位于 `packages/toolkit/src/internal/brief-rules.ts`、
`llm-budget.ts`、`stock-facts.ts`，生成工具只做编排。

## 4. Tool / API / CLI / MCP

| 入口 | 契约 | 副作用 | 暴露 |
|---|---|---|---|
| `generate_stock_briefs` | `scope`（all/holdings/watchlist/signals/stock）、`stockIds`、`phase`、`tradingDate`、`source`、`force`、预筛与预算覆盖项；输出 items + summary + coverage + budget + degradation | `advice` | 仅应用 registry；不进 Agent registry / MCP / OpenAI schema |
| `get_stock_brief` | `stockId` + 可选 `date` / `phase` / `accountId`；返回 brief、关联 advice、展示词与 warnings | `read` | `shared-query`，进 MCP 只读基线 |
| `list_stock_briefs` | 交易日 / 账户 / 关注列表 / 股票集合 / phase / limit；返回列表、当日预算、覆盖率与降级 | `read` | 同上 |

Web API（`apps/web/src/routes/stock-brief.ts`）：

- `GET /api/stock-briefs`：列表或单票详情，只读；
- `GET /api/stock-briefs/today`：首页 Top 与覆盖计数，只读；
- `POST /api/stock-briefs/generate`：唯一写入口，`write + external` 双闸 + 同源 Origin，
  受预算与 plugin 启用位约束。

CLI（`packages/cli/src/index.ts`）：`luoome brief list/show` 只读本地；
`luoome brief run` 调生成工具，需 `LUOOME_EXPOSE_EXTERNAL=true`；
`luoome workflow run daily-stock-briefs` 走批次审计。Web 与 CLI 共用
`stockBriefViewOf*` 投影，不在 surface 重写 decision 文案。

MCP：`get_stock_brief` / `list_stock_briefs` 随 read 基线自动发现；
`generate_stock_briefs` 不在 registry 中，直接调用也会被拒绝（Q3 既定结论）。

## 5. 调度

- **交易日 17:30（默认路径）**：`daily-stock-briefs(phase='post-market')` →
  `daily-advice(briefsOnly=true)`。前者是唯一 LLM 入口；后者只读当日 brief 与其中
  `adviceId` 指向的已有 advice，派生「今日无新信号 / 今日有 N 个信号」。
- **回退开关**：`LUOOME_DAILY_JUDGMENT_LEGACY=true` 时 17:30 只跑旧的
  `daily-advice` 生成路径；该兼容分支计划在一个版本周期后删除。
- **交易日 08:45**：`daily-stock-briefs(phase='premarket')`，只出研究名单与隔夜新闻，
  0 次 LLM、不写 advices。
- 调度只在上海交易日触发，进程内按交易日去重；重启后重跑一次，靠唯一键与 digest 幂等。
  brief 批次失败时回退到「消费当日已有 brief」，不自动改用逐只 `analyze_stock` 烧预算。

## 6. 降级矩阵

| 触发 | 观察结果 | 可见性 |
|---|---|---|
| 模型两次失败 | 规则兜底 advice（`isRuleFallbackAdvice`）/ 规则观察 | `quality='rule-only'` + `missing.dimension='llm'` |
| 预算触达 | 本票及后续票规则观察 | `missing.dimension='budget'`，批次 `partial` |
| 行情 / 日线 / 分时 / 新闻 / 板块 / 信号 / 账户缺失 | 按可算部分出结论或 `unavailable` | `missing` 逐维度记录，UI 必显 |
| 插件未启用 | `PluginExecutionDenied`，不静默跳过 | 结果与页面显示 plugin 缺失 |
| 无新事实 | 跳过 LLM，保留原观察 | `skippedByDigest` 计数与原因 |

降级不允许伪造「看起来正常」的完整结论；没有数据时不编造收益或方向。

## 7. 结算与成绩单

`packages/toolkit/src/tools/settle-advices.ts` 对到期 advice 按假设执行结算 T+1/T+3/T+5，
使用本地日线与基准 `000300.SH`；缺日线、缺入场价时跳过，不写假结算。输出新增：

- `eligible` / `settledEligible` / `coverage`：仅统计股票、`buy/sell`、非规则兜底且已到
  结算窗口的 advice；没有应结算样本时 `coverage=null`；
- `horizons`：T+1/T+3/T+5 各档已结算与未覆盖条数；
- `byDecision`：buy / sell 对账；
- `ruleFallback`：规则兜底 buy/sell 总数与已结算数，单列且不进覆盖率分母；
- `uncovered`：`missingEntry` / `missingBars` 原因计数。

`limit` 是分页大小而非总量上限：工具按创建时间倒序翻页扫完窗口，避免历史建议被单页上限
静默漏结算。

`packages/toolkit/src/tools/advice-scorecard.ts` 用同一口径输出 `eligible`、
`settledEligible`、`coverage`、`uncovered`、`ruleFallbackTotal` 与 `reconciliation`
（窗口 advice 数、buy/sell 股票数、规则观察、未到期、其它 decision、非股票），
使成绩单能与同窗口 `repos.advice.query` 重算对账。命中率分母仍只含非规则兜底已结算建议；
Q6 结论：规则观察不计入成绩单分母。

周报「个股观察成绩」（`packages/workflows/src/weekly-report.ts`）展示应结算、已结算、
覆盖率、规则观察单列与未覆盖原因；样本不足或结算失败时维持 `unavailable` + 原因，
不伪造 0 值。

## 8. 测试与验收

相关测试：`packages/core/src/entity/stock-brief.test.ts`、
`packages/db/src/repository/drizzle/stock-brief.contract.test.ts`、
`packages/tools/src/tools/generate-stock-briefs.test.ts`、
`stock-brief-query.test.ts`、`brief-regression.fixtures.test.ts`、
`packages/workflows/src/daily-stock-briefs.test.ts`、`weekly-report.test.ts`、
`packages/tools/src/tools/advice-tracking.test.ts`、`advice-scorecard.test.ts`、
`apps/web/src/routes/stock-brief.test.ts`、`apps/web/src/premarket-scheduler.test.ts`、
`apps/web/src/daily-judgment-scheduler.test.ts`。

验收指标（单票 P95、批次 P95、每日 HTTP / token / 金额、覆盖率、调用放大、digest 去重、
数值可追溯、幻觉回归、文案合规、降级可见、结算联通）逐项状态见
[验收记录](../archive/daily-stock-brief-acceptance-20261124.md)；自动化证据以本节所列测试与
全仓 typecheck/lint/test 命令为准。
