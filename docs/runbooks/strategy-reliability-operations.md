# Strategy 生产可靠性运维手册

本手册用于持续复核 Strategy 日运行的 schedule/run fencing、行情 checkpoint、provider fallback、
SignalObservation 基准价与 T+1/T+3/T+5/T+20 补全。它只读取或生成可审计事实，不把历史评估称为
收益回测，也不扩大自动 Advice、通知或交易范围。

## 1. 调度参数

`luoome start` / `luoome web serve` 启动时读取以下环境变量；非法值会直接拒绝启动：

| 变量 | 默认值 | 允许范围 | 含义 |
|---|---:|---:|---|
| `LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES` | 30 | 5～240 | scheduler claim 的租约时长 |
| `LUOOME_STRATEGY_DATA_CONCURRENCY` | 8 | 1～64 | 日线准备 worker 数 |
| `LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS` | 1 | 0～30 | 成员日线允许陈旧的交易日数 |
| `LUOOME_STRATEGY_DATA_MAX_RETRIES` | 2 | 0～5 | 单成员可重试次数 |
| `LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS` | 20000 | 500～120000 | 单成员请求超时，毫秒 |

run lease（15 分钟、5 分钟 heartbeat）是 fenced commit 的安全不变量，不开放环境调节。修改生产参数前
先记录旧值、变更原因和观察窗口；并发或重试上调会直接增加 provider 压力，不能用它掩盖持续限流。

## 2. 每日检查

正常路径由进程内 scheduler 每分钟检查到期配置，无需额外 cron。盘后补偿流程可以重复执行：

```bash
luoome workflow run complete-strategy-observations --input '{"limit":1000}'
```

检查最近一个真实交易日的 WorkflowRun，确认：

1. 同一 `scheduleId + dataAsOf` 只有一个正式周期；重复 claim 只能留下 `skipped` 审计。
2. `leaseLost=0`，长阶段有续租；失租后不得出现新的 observation、Advice 或通知副作用。
3. checkpoint 的 coverage、`fallbackUsed` 和 provider 分布与真实返回来源一致。
4. observation baseline 的 available/unavailable 和 provider 分布可解释；不可用不能填 0 或当前价。
5. `byHorizon.t20` 的 created/completed/pending 随真实交易 session 推进；未到期保持 pending。
6. AI 不可用时周期可为 `partial` + facts-only，但已发布的事实运行不能因此被改写成 failed。

## 3. 周度汇总

用明确的 UTC 区间查询真实审计，`targetTradingDays` 是观察样本目标，不是代码完成门禁：

```bash
luoome tools call get_strategy_reliability_summary --input \
  '{"since":"2026-08-01T00:00:00.000Z","until":"2026-08-31T23:59:59.999Z","targetTradingDays":20,"limit":1000}'
```

如果只复核一个 schedule，追加 `"scheduleId":"..."`，避免把多个 schedule 的交易日拼接成样本。

- `gate.ready`：只检查真实可靠性阻塞，例如无生产周期、周期失败、失租、重复 schedule-day、checkpoint
  低于门槛、baseline 不可用或通知失败。
- `observationTarget.reached`：说明当前是否已经积累目标交易日数；未达到只保留观察状态，不阻塞已完成的
  可靠性代码交付。
- `phaseDurations`：直接从每个正式周期的 phase timing 计算 P50/P95/max；样本数少时只作为事实展示。
- `providerLatencies`：持久化周期摘要只保存成员延迟分位点，因此跨周期结果是等权近似，不应冒充原始请求
  样本的精确全局分位数。
- `checkpoints.fallbackRuns/providers`：审计数据准备的真实来源切换。
- `observations.baselines/byHorizon`：审计信号基准价来源与各观察周期的创建、完成、等待数量。

任何 blocker 都应回查对应 WorkflowRun 和 provider status。不要删除失败审计，也不要通过提高超时、重试或
接受阈值直接“消除”故障。

## 4. 真实 provider 冒烟

使用独立临时数据目录，避免写入个人生产数据库。下面命令只使用真实 Sina 日线，不注入 fixture 或 mock：

```bash
strategy_smoke_home="$(mktemp -d)"
LUOOME_HOME="$strategy_smoke_home" \
LUOOME_MARKET_PROVIDER=real \
LUOOME_MARKET_SOURCES=sina \
  luoome tools call sync_daily_bars --input \
  '{"scope":"explicit","stockIds":["000300.SH"],"correctionWindowDays":60,"concurrency":1,"maxRetries":1,"requestTimeoutMs":30000}'
```

保留命令输出和临时目录路径作为当次证据，至少记录执行时间、真实 provider、bar 数、失败原因与是否 fallback。
公网失败是当次真实观测，不用测试数据替代；确定性 fault-injection 仍由自动测试负责。

## 5. R5 与 T+20 边界

早期突破 v2 继续保持 draft。只有用户显式确认发布后，才从首个 published operational signal 的真实
baseline 开始计算完整 T+20 观察期。历史诊断样本、evaluation run、当前行情快照或推断数据都不能作为
R5 T+20 生产验收证据；观察完成前只报告样本数、缺失率和描述性事实，不生成收益承诺。
