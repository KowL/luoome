import type { ToolResult } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * daily-review（v0.3，plan-v0.2-v0.3 §3.5）：
 * get_advice（今日）→ get_advice_stats（7 日准确率）→ 输出结构化日报。
 *
 * 注：步骤间类型被擦除，这里用 unknown / 显式 cast 处理；运行时数据由
 * 上下游 zod schema 保证形状正确。
 */

export const DailyReviewInput = z.object({
  timezoneOffsetHours: z.number().int().min(-12).max(14).default(8),
});

export type DailyReviewInputT = z.infer<typeof DailyReviewInput>;

export const DailyReviewSummarySchema = z.object({
  date: z.string(),
  totalAdvices: z.number().int().nonnegative(),
  byDecision: z.record(z.string(), z.number().int().nonnegative()),
  highConfidence: z.number().int().nonnegative(),
  outcomeFilled: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
});

export const DailyReviewOutput = z.object({
  summary: DailyReviewSummarySchema,
  advices: z.array(z.unknown()),
  stats: z.unknown().nullable(),
});

export type DailyReviewOutputT = z.infer<typeof DailyReviewOutput>;

const HIGH_CONFIDENCE_THRESHOLD = 70;

const computeDateString = (now: Date, tzOffsetHours: number): string => {
  const shifted = new Date(now.getTime() + tzOffsetHours * 3_600_000);
  return shifted.toISOString().slice(0, 10);
};

const computeTodayStart = (now: Date, tzOffsetHours: number): Date => {
  const dateStr = computeDateString(now, tzOffsetHours);
  return new Date(`${dateStr}T00:00:00.000Z`);
};

interface ReviewState {
  advices: readonly unknown[];
  stats: unknown;
  input: DailyReviewInputT;
}

const stepAdvices: WorkflowStep = async (prev, ctx) => {
  const input = prev as DailyReviewInputT;
  const now = ctx.clock();
  const todayStart = computeTodayStart(now, input.timezoneOffsetHours);
  const res = await ctx.tools.get_advice.execute({
    since: todayStart,
    includeExpired: true,
    limit: 500,
  });
  if (!res.ok) return res as unknown as ToolResult<ReviewState>;
  return {
    advices: res.data.advices,
    stats: null,
    input,
  } satisfies ReviewState;
};

const stepStats: WorkflowStep = async (prev, ctx) => {
  const state = prev as ReviewState;
  const now = ctx.clock();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const r = await ctx.tools.get_advice_stats.execute({ since: sevenDaysAgo });
  if (!r.ok) return r as unknown as ToolResult<ReviewState>;
  return { ...state, stats: r.data } satisfies ReviewState;
};

const stepFinalize: WorkflowStep = async (prev, ctx) => {
  const state = prev as ReviewState;
  const now = ctx.clock();
  const dateStr = computeDateString(now, state.input.timezoneOffsetHours);
  const advices = state.advices;

  const byDecision: Record<string, number> = {};
  let highConfidence = 0;
  let outcomeFilled = 0;
  let hits = 0;
  for (const a of advices as Array<{
    decision: string;
    confidence: number;
    outcome?: { outcome: string; pnl?: { readonly __brand: 'Money' } & number };
  }>) {
    byDecision[a.decision] = (byDecision[a.decision] ?? 0) + 1;
    if (a.confidence >= HIGH_CONFIDENCE_THRESHOLD) highConfidence++;
    if (a.outcome !== undefined) {
      outcomeFilled++;
      if (
        a.outcome.outcome === 'followed' &&
        a.outcome.pnl !== undefined &&
        Number(a.outcome.pnl) > 0
      ) {
        hits++;
      }
    }
  }
  const hitRate = outcomeFilled === 0 ? 0 : hits / outcomeFilled;

  return DailyReviewOutput.parse({
    summary: DailyReviewSummarySchema.parse({
      date: dateStr,
      totalAdvices: advices.length,
      byDecision,
      highConfidence,
      outcomeFilled,
      hits,
      hitRate,
    }),
    advices: [...advices],
    stats: state.stats,
  });
};

export const dailyReviewWorkflow = defineWorkflow<DailyReviewInputT, DailyReviewOutputT>({
  name: 'daily-review',
  description: '生成当日复盘（今日 advice 汇总 + 7 日准确率）',
  input: DailyReviewInput,
  steps: [stepAdvices, stepStats, stepFinalize],
});
