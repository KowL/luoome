import type { LimitUpLadder, LimitUpLadderDiff, ToolResult } from '@luoome/core';
import { LimitUpLadderSourceSchema } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * daily-review（v0.3，plan-v0.2-v0.3 §3.5）：
 *   get_advice（今日）→ get_advice_stats（7 日准确率）→ limit_up_ladder → limit_up_ladder_compare
 *   → 输出结构化日报（含天梯快照 + vs 昨日 diff）。
 *
 * 步骤间类型被擦除（defineWorkflow 限制），这里用 unknown / 显式 cast 处理；
 * 运行时数据由上下游 zod schema 保证形状正确。
 *
 * Phase 2 改造（docs/ddd/limit-up-ladder-detailed-design.md §10 Phase 2）：
 * - 把"涨停梯队 / 短线龙头"段从手拼字符串切换为 limit_up_ladder_compare 工具输出
 * - 缺失 manager / 工具调用失败 → ladder 字段为 null（不阻断整篇日报）
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

export const DailyReviewLadderSnapshotSchema = z.object({
  date: z.string(),
  total: z.number().int().nonnegative(),
  maxLevel: z.number().int().nonnegative(),
  source: LimitUpLadderSourceSchema,
  warnings: z.array(z.string()),
});

export const DailyReviewLadderSchema = z.object({
  /** 当日（date 输入对应的 Asia/Shanghai 当天） */
  curr: DailyReviewLadderSnapshotSchema,
  /** 前一交易日 */
  prev: DailyReviewLadderSnapshotSchema,
  /** topLevel diff，与 limit_up_ladder_compare 同口径 */
  diff: z.object({
    totalDelta: z.number().int(),
    maxLevelDelta: z.number().int(),
    topLevelAdded: z.array(z.string()),
    topLevelRemoved: z.array(z.string()),
    topLevelRetained: z.array(z.string()),
  }),
});

export const DailyReviewOutput = z.object({
  summary: DailyReviewSummarySchema,
  advices: z.array(z.unknown()),
  stats: z.unknown().nullable(),
  /** Phase 2：null 表示无 manager 注入或上游不可达（不阻断日报） */
  ladder: DailyReviewLadderSchema.nullable(),
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

/** 给定今日，返回前一日 YYYY-MM-DD（简单日历减一天；非交易日由 manager 内部 `non-trading-day` 处理）。 */
const previousDayString = (today: string): string => {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

interface ReviewState {
  advices: readonly unknown[];
  stats: unknown;
  input: DailyReviewInputT;
  /** Phase 2：limit_up_ladder 返回的快照全集（含 warnings + dates），下游只取 summary。 */
  ladder: {
    curr: Pick<LimitUpLadder, 'date' | 'total' | 'maxLevel' | 'source' | 'warnings'>;
    prev: Pick<LimitUpLadder, 'date' | 'total' | 'maxLevel' | 'source' | 'warnings'>;
    diff: LimitUpLadderDiff;
  } | null;
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
    ladder: null,
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

/**
 * Phase 2 新步骤：拉取当日 + 上一日天梯 + diff。
 * 失败（无 manager / 上游不可用）→ 输出 ladder=null，不影响后续 finalize。
 */
const stepLadder: WorkflowStep = async (prev, ctx) => {
  const state = prev as ReviewState;
  const now = ctx.clock();
  const date = computeDateString(now, state.input.timezoneOffsetHours);
  const prevDate = previousDayString(date);

  let ladderData: ReviewState['ladder'] = null;
  try {
    const r = await ctx.tools.limit_up_ladder_compare.execute({
      date,
      prevDate,
    });
    if (r.ok) {
      ladderData = {
        curr: r.data.curr,
        prev: r.data.prev,
        diff: r.data.diff,
      };
    }
  } catch {
    // manager 未注入 / 上游不可达 → ladder=null
    ladderData = null;
  }
  return { ...state, ladder: ladderData } satisfies ReviewState;
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
    ladder: state.ladder,
  });
};

export const dailyReviewWorkflow = defineWorkflow<DailyReviewInputT, DailyReviewOutputT>({
  name: 'daily-review',
  description: '生成当日复盘（今日 advice 汇总 + 7 日准确率 + 涨停梯队快照 + vs 昨日 diff）',
  input: DailyReviewInput,
  steps: [stepAdvices, stepStats, stepLadder, stepFinalize],
});
