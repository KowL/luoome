---
name: luoome-batch
description: luoome 批处理定时任务——五个每日/每周批处理入口的调度表、门槛口径与调用方式。建立、检查或手动补跑 luoome 定时任务时使用。
whenToUse: 用户要求「把 luoome 的定时任务设好」「检查定时任务」「补跑今天的批处理」，或 DSH 定时任务唤起会话要求执行批处理时。
---

# luoome-batch

单机形态没有常驻调度进程：批处理由 **DSH 定时任务**唤起会话，再由 agent 调用
`luoome-batch` 实例上的批处理工具。每个批处理工具内部自带门槛判定，
非交易日、非盘中时段会自动返回 `skipped`，不会写库。

## 调度表

| 批处理 | 工具（`luoome-batch` 实例） | 建议 cron（Asia/Shanghai） | 门槛 |
| --- | --- | --- | --- |
| 策略日循环 | `run_strategy_daily_cycle` | `30 18 * * 1-5` | 交易日，且已过收盘（当日日线已落库） |
| 收盘报告截止 | `run_closing_report_cutoff` | `30 19 * * 1-5` | 交易日，且当日策略日循环已结束 |
| 账户绩效快照 | `run_portfolio_performance_snapshot` | `30 16 * * 1-5` | 交易日且已过 16:00 |
| 盘中计划批处理 | `run_intraday_plan_batch` | `5 9 * * 1-5` | 盘中时段 |
| 策略自治周报 | `run_strategy_autonomy_weekly` | `30 9 * * 0` | 周日 |

cron 用 5 段 Vixie 表达式，时区必须显式给 `Asia/Shanghai`。
策略自治周报用**确定性 run id** 去重（每周一条 `strategy-autonomy-weekly:<日期>` 的 WorkflowRun），
本周已成功/部分成功则跳过，失败可重试。

## 建立定时任务

1. 先 `schedule_list` 查现有提醒，避免重复建立。
2. 缺失的用 `schedule_create` 建，**一次只传一个时间选择器**（`cron` + `time_zone`）。
3. title 用 `luoome 批处理：<批处理名>`。
4. prompt 直接写清调哪个工具、失败怎么汇报，不要写「检查一下」这种模糊指令。

示例（策略日循环）：

- title：`luoome 批处理：策略日循环`
- cron：`30 18 * * 1-5`，time_zone：`Asia/Shanghai`
- prompt：`执行 luoome 策略日循环：调用 luoome-batch 实例的 run_strategy_daily_cycle 工具，
  把 complete/partial/skipped/failed 的计数原样汇报。若返回 outcome=skipped 就说明今天不是交易日，不用重试。`

其余四个批处理按同样方式替换工具名、cron 与 prompt 文案。
`run_intraday_plan_batch` 的 prompt 要补一句「若 outcome=skipped 说明当前不是盘中时段，不要补跑」。
`run_strategy_autonomy_weekly` 的 prompt 要说明「本周已执行会返回 skipped，属正常」。

## 手动补跑

用户要求补跑时，给对应工具传 `force: true` 跳过门槛判定。
补跑前先 `schedule_list` 看当天是否已经跑过，避免重复写事实。

## 边界

- 批处理只写 luoome 的事实库与策略运行记录，不下单、不做投资建议。
- 工具返回 `outcome=failed` 时如实汇报错误，不要重试超过一次；
  连续失败要在汇报里指出需要人工介入。
- 不要用「昨天是交易日吧」这类推断代替工具返回的 `skipped` 判断。
