import type { LimitUpLadder, LimitUpLadderDiff, ToolResult } from '@luoome/core';
import { LimitUpLadderSourceSchema } from '@luoome/core';
import { GetAdviceStatsOutput } from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * daily-review（v0.3，plan-v0.2-v0.3 §3.5）：
 *   get_advice（今日）→ get_advice_stats（当日窗口 + 7 日窗口）→ limit_up_ladder
 *   → limit_up_ladder_compare → 输出结构化日报（含天梯快照 + vs 昨日 diff）。
 *
 * 命中率口径（REQ-M3-10 / REQ-M3-18）：当日摘要的命中率直接消费 get_advice_stats
 * 的当日窗口结果，workflow 不再按 outcome 自行重算；口径版本由工具侧维护。
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

/** 当日命中率口径的来源：get_advice_stats 输出（口径版本、分母、排除数都由它定义）。 */
type TodayStats = z.infer<typeof GetAdviceStatsOutput>;

export const DailyReviewSummarySchema = z.object({
  date: z.string(),
  totalAdvices: z.number().int().nonnegative(),
  byDecision: z.record(z.string(), z.number().int().nonnegative()),
  highConfidence: z.number().int().nonnegative(),
  /**
   * 当前口径内的回填条数（= get_advice_stats.feedbackCount）：
   * origin=user 且落在当日窗口的已回填样本，含未了结 / 部分采纳 / 忽略。
   * 这是回填数，不是命中率分母。
   */
  outcomeFilled: z.number().int().nonnegative(),
  /** 分母内盈利的样本数（= get_advice_stats.hits）。 */
  hits: z.number().int().nonnegative(),
  /**
   * 命中率分母（= get_advice_stats.denominator）：origin=user 且明确采纳（followed）
   * 并填写有限盈亏的已了结样本数。分母与 hits 同窗口同来源，hitRate 可由此复算。
   */
  denominator: z.number().int().nonnegative(),
  /**
   * 当日命中率 = hits / denominator。无已了结样本时为 null（未知不写 0）。
   */
  hitRate: z.number().min(0).max(1).nullable(),
  /** 分母是否达到 20 条门槛；不足时命中率只作趋势参考，不给分组结论。 */
  minimumSampleMet: z.boolean(),
  /** 统计口径版本（= get_advice_stats.metricVersion），口径变更即升版。 */
  metricVersion: z.string(),
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
  /** 当日命中率被排除的回填计数（未了结 / 非用户来源 / 部分采纳 / 忽略）。 */
  excluded: GetAdviceStatsOutput.shape.excluded,
  /** 读数口径说明：分母定义与排除规则必须随数字一起给出。 */
  limitations: z.array(z.string()),
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

/** stepAdvices 产出的中间态；stepStats 补齐 todayStats 后才是完整 ReviewState。 */
interface ReviewStateBase {
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

interface ReviewState extends ReviewStateBase {
  /** 当日窗口的 get_advice_stats 结果：命中率口径的唯一来源。 */
  todayStats: TodayStats;
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
  } satisfies ReviewStateBase;
};

const stepStats: WorkflowStep = async (prev, ctx) => {
  const state = prev as ReviewStateBase;
  const now = ctx.clock();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const dateStr = computeDateString(now, state.input.timezoneOffsetHours);
  const todayStart = computeTodayStart(now, state.input.timezoneOffsetHours);
  const todayUntil = new Date(`${dateStr}T23:59:59.999Z`);
  const [week, today] = await Promise.all([
    ctx.tools.get_advice_stats.execute({ since: sevenDaysAgo }),
    ctx.tools.get_advice_stats.execute({ since: todayStart, until: todayUntil }),
  ]);
  if (!week.ok) return week as unknown as ToolResult<ReviewState>;
  if (!today.ok) return today as unknown as ToolResult<ReviewState>;
  return {
    ...state,
    stats: week.data,
    todayStats: today.data,
  } satisfies ReviewState;
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
  for (const a of advices as Array<{
    decision: string;
    confidence: number;
  }>) {
    byDecision[a.decision] = (byDecision[a.decision] ?? 0) + 1;
    if (a.confidence >= HIGH_CONFIDENCE_THRESHOLD) highConfidence++;
  }

  const todayStats = state.todayStats;

  return DailyReviewOutput.parse({
    summary: DailyReviewSummarySchema.parse({
      date: dateStr,
      totalAdvices: advices.length,
      byDecision,
      highConfidence,
      // 命中率相关字段一律取自 get_advice_stats 的当日窗口结果（口径单一来源）。
      outcomeFilled: todayStats.feedbackCount,
      hits: todayStats.hits,
      denominator: todayStats.denominator,
      hitRate: todayStats.hitRate,
      minimumSampleMet: todayStats.minimumSampleMet,
      metricVersion: todayStats.metricVersion,
    }),
    advices: [...advices],
    stats: state.stats,
    ladder: state.ladder,
    excluded: todayStats.excluded,
    limitations: [
      `当日命中率按统一口径计算：分母 = origin=user 且明确采纳并填写有限盈亏的已了结样本；口径版本 ${todayStats.metricVersion}。`,
      '模型/导入来源的回填与无来源戳的历史回填不计入当日分母，排除数见 excluded。',
    ],
  });
};

export const dailyReviewWorkflow = defineWorkflow<DailyReviewInputT, DailyReviewOutputT>({
  name: 'daily-review',
  description:
    '生成当日复盘（今日 advice 汇总 + 当日统一口径命中率 + 7 日准确率 + 涨停梯队快照 + vs 昨日 diff）',
  input: DailyReviewInput,
  steps: [stepAdvices, stepStats, stepLadder, stepFinalize],
});
