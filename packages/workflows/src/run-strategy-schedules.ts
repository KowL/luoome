import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  nextCronOccurrence,
  type Strategy,
} from '@luoome/core';
import { z } from 'zod';

import { closingReportStrategiesReady } from './closing-report.js';
import { closingReportCutoffWorkflow } from './closing-report-cutoff.js';
import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { strategyDailyCycleWorkflow } from './strategy-daily-cycle.js';

export const RunStrategySchedulesInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  concurrency: z.number().int().min(1).max(64).default(8),
  deferReports: z.boolean().default(false),
});
export type RunStrategySchedulesInputT = z.infer<typeof RunStrategySchedulesInput>;

const ItemSchema = z.object({
  strategyId: z.string(),
  /** facts-only 的日循环仍已完成事实发布，不能被调度层误报为失败。 */
  status: z.enum(['ran', 'partial', 'skipped', 'failed']),
  runId: z.string().optional(),
  /** 日循环已发布事实但 insights 降级时，标记为 partial 并保留原因。 */
  reason: z.string().optional(),
});
export const RunStrategySchedulesOutput = z.object({
  items: z.array(ItemSchema),
  ran: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type RunStrategySchedulesOutputT = z.infer<typeof RunStrategySchedulesOutput>;

const STRATEGY_SCHEDULE_TIMEZONE = 'Asia/Shanghai';
/** 单进程调度互斥：跨进程不再依赖数据库租约表。 */
const runningSchedules = new Set<string>();

const errorText = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const details = error as {
      readonly kind?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (typeof details.message === 'string') return details.message;
    if (typeof details.cause === 'string') return details.cause;
    return String(details.kind ?? 'unknown error');
  }
  return String(error);
};

const isDue = (strategy: Strategy, now: Date): boolean => {
  if (strategy.scheduleCron === undefined) return false;
  const anchor = strategy.lastScheduledAt ?? strategy.createdAt;
  return nextCronOccurrence(strategy.scheduleCron, STRATEGY_SCHEDULE_TIMEZONE, anchor) <= now;
};

const runDue: WorkflowStep = async (previous, ctx) => {
  const input = previous as RunStrategySchedulesInputT;
  const now = ctx.clock();
  const listed = await ctx.tools.list_strategies.execute({});
  if (!listed.ok) return listed;
  const items: z.infer<typeof ItemSchema>[] = [];
  let processed = 0;
  for (const strategy of listed.data.strategies) {
    if (processed >= input.limit || ctx.abortSignal?.aborted) break;
    if (runningSchedules.has(strategy.id)) continue;
    try {
      if (!isDue(strategy, now)) continue;
    } catch (error) {
      ctx.logger.warn('run-strategy-schedules: invalid scheduleCron', {
        strategyId: strategy.id,
        error: errorText(error),
      });
      continue;
    }
    processed += 1;
    runningSchedules.add(strategy.id);
    try {
      if (strategy.status !== 'active') {
        items.push({
          strategyId: strategy.id,
          status: 'skipped',
          reason: `Strategy 不是 active: ${strategy.id}`,
        });
      } else {
        const cycle = await strategyDailyCycleWorkflow.run(
          {
            strategyId: strategy.id,
            concurrency: input.concurrency,
            deferReports: input.deferReports,
          },
          ctx,
        );
        if (!cycle.ok) {
          items.push({ strategyId: strategy.id, status: 'failed', reason: errorText(cycle.error) });
        } else {
          const item = cycle.data.items[0];
          if (item === undefined) {
            items.push({
              strategyId: strategy.id,
              status: 'failed',
              reason: 'strategy-daily-cycle 未返回该策略的结果',
            });
          } else {
            items.push({
              strategyId: strategy.id,
              status:
                item.status === 'complete'
                  ? ('ran' as const)
                  : item.status === 'partial'
                    ? ('partial' as const)
                    : item.status === 'skipped'
                      ? ('skipped' as const)
                      : ('failed' as const),
              ...(item.runId === undefined ? {} : { runId: item.runId }),
              ...(item.reason === undefined ? {} : { reason: item.reason }),
            });
          }
        }
      }
      // 无论本次结果如何都推进 lastScheduledAt：调度表已并入 Strategy，
      // 失败或暂停的 tick 不应在下一个 cron 点触发补跑风暴。
      await ctx.tools.update_strategy_schedule.execute({
        strategyId: strategy.id,
        lastScheduledAt: now,
      });
    } finally {
      runningSchedules.delete(strategy.id);
    }
  }
  // 调度 tick 同时负责收盘报告：即使本轮没有到期策略，18:00 之后也必须为每个账户发布一份主报告。
  const reportNow = ctx.clock();
  const reportDate = dateInShanghai(reportNow);
  const planStart = new Date(`${reportDate}T16:30:00+08:00`);
  let cutoff: Awaited<ReturnType<typeof closingReportCutoffWorkflow.run>> | undefined;
  if (
    !ctx.abortSignal?.aborted &&
    reportNow >= planStart &&
    !isWeekend(planStart) &&
    !isHoliday(planStart) &&
    (await closingReportStrategiesReady(reportDate, reportNow, ctx))
  ) {
    const accounts = await ctx.tools.list_accounts.execute({});
    if (!accounts.ok) {
      ctx.logger.warn('run-strategy-schedules: account listing failed', {
        error: accounts.error,
      });
    } else if (!input.deferReports) {
      cutoff = await closingReportCutoffWorkflow.run({ date: reportDate }, ctx);
    }
  }
  if (cutoff !== undefined && (!cutoff.ok || cutoff.data.failed.length > 0)) {
    const reportError = cutoff.ok
      ? `收盘复盘生成失败: ${cutoff.data.failed.join(', ')}`
      : `收盘复盘生成失败: ${errorText(cutoff.error)}`;
    for (const item of items) {
      if (item.status === 'failed' || item.status === 'skipped') continue;
      item.status = 'partial';
      item.reason = item.reason === undefined ? reportError : `${item.reason}；${reportError}`;
    }
  }
  return RunStrategySchedulesOutput.parse({
    items,
    ran: items.filter((item) => item.status === 'ran').length,
    partial: items.filter((item) => item.status === 'partial').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const runStrategySchedulesWorkflow = defineWorkflow<
  RunStrategySchedulesInputT,
  RunStrategySchedulesOutputT
>({
  name: 'run-strategy-schedules',
  description: '按进程内互斥调度到期的 Strategy 并委托 strategy-daily-cycle 完成单周期闭环',
  input: RunStrategySchedulesInput,
  steps: [runDue],
});
