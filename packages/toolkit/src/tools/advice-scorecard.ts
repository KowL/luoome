import {
  type Advice,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  isRuleFallbackAdvice,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { assumedEntryOf } from './settle-advices.js';

/** 成绩单门禁：样本量与命中率下限（docs 与用户确认的唯一验收口径）。 */
export const SCORECARD_MIN_SAMPLES = 50;
export const SCORECARD_MIN_HIT_RATE = 0.6;

const DAY_MS = 86_400_000;

const BucketSchema = z.enum(['<50', '50-69', '>=70']);

const bucketOf = (confidence: number): z.infer<typeof BucketSchema> => {
  if (confidence >= 70) return '>=70';
  if (confidence >= 50) return '50-69';
  return '<50';
};

export const GetAdviceScorecardInput = z.object({
  /** 回溯天数（按建议创建时间）。 */
  days: z.number().int().min(7).max(365).default(30),
  /** 以哪个持有期作为主口径；T+5 是默认验收口径。 */
  horizonDays: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(5),
});
export type GetAdviceScorecardInput = z.infer<typeof GetAdviceScorecardInput>;

const GroupSchema = z.object({
  bucket: BucketSchema,
  samples: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
  avgExcessPct: z.number().nullable(),
});

export const GetAdviceScorecardOutput = z.object({
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  horizonDays: z.number().int(),
  benchmark: z.string().min(1),
  /** 已结算的建议条数（同一条建议只计一次；排除规则观察）。 */
  samples: z.number().int().nonnegative(),
  /** 窗口内已结算的规则观察条数（股票、任一 decision，含 watch；只单列，不进命中率分母）。 */
  ruleFallbackSamples: z.number().int().nonnegative(),
  /** 窗口内规则观察总条数（股票、任一 decision，含 watch；与已结算数一起单列）。 */
  ruleFallbackTotal: z.number().int().nonnegative(),
  /** 应结算：股票 + buy/sell + 非规则兜底 + 已到 T+horizon 窗口。 */
  eligible: z.number().int().nonnegative(),
  /** 应结算中已有该档结算行的条数。 */
  settledEligible: z.number().int().nonnegative(),
  /** settledEligible / eligible；没有应结算样本时为 null。 */
  coverage: z.number().min(0).max(1).nullable(),
  /** 应结算但未覆盖的原因计数；missingBars 含日线不足该档。 */
  uncovered: z.object({
    missingEntry: z.number().int().nonnegative(),
    missingBars: z.number().int().nonnegative(),
  }),
  /** 与同一窗口 repos.advice.query 重算对账用的分类计数。 */
  reconciliation: z.object({
    /** 窗口内建议总数（含全部 decision 与 subjectKind）。 */
    windowAdvices: z.number().int().nonnegative(),
    /** 股票且 buy/sell（含规则观察）。 */
    buySellStock: z.number().int().nonnegative(),
    /** 窗口内股票规则观察条数（任一 decision，含 watch）。 */
    ruleFallback: z.number().int().nonnegative(),
    /** 同条件但尚未到结算窗口。 */
    notDue: z.number().int().nonnegative(),
    /** 股票 hold/watch/avoid。 */
    otherDecisions: z.number().int().nonnegative(),
    /** 非股票主体。 */
    nonStock: z.number().int().nonnegative(),
  }),
  hitRate: z.number().min(0).max(1).nullable(),
  avgExcessPct: z.number().nullable(),
  groups: z.array(GroupSchema),
  gate: z.object({
    minSamples: z.number().int(),
    minHitRate: z.number(),
    passed: z.boolean(),
    reasons: z.array(z.string()),
  }),
});
export type GetAdviceScorecardOutput = z.infer<typeof GetAdviceScorecardOutput>;

const stats = (rows: readonly { hit: boolean; excessPct: number }[]) => ({
  samples: rows.length,
  hitRate: rows.length === 0 ? null : rows.filter((row) => row.hit).length / rows.length,
  avgExcessPct:
    rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.excessPct, 0) / rows.length,
});

/**
 * 每周一的建议成绩单：命中率、对基准的平均超额、按 confidence 分组的表现，
 * 并给出 ≥50 条样本 / ≥60% 命中率的门禁结论。只读聚合，不写任何状态。
 */
export const getAdviceScorecardTool = defineTool({
  name: 'get_advice_scorecard',
  description:
    '汇总最近 N 天已结算建议的命中率、平均超额与按 confidence 分组表现，并按 ≥50 条/≥60% 给出门禁结论',
  sideEffect: 'read',
  input: GetAdviceScorecardInput,
  output: GetAdviceScorecardOutput,
  handler: async (input, ctx) => {
    const windowEnd = ctx.clock();
    const windowStart = new Date(windowEnd.getTime() - input.days * DAY_MS);
    const [settlements, advices, feedbacks] = await Promise.all([
      ctx.repos.adviceTracking.listSettlements({
        horizonDays: input.horizonDays,
        since: windowStart,
        until: windowEnd,
        limit: 5000,
      }),
      ctx.repos.advice.query({
        includeExpired: true,
        since: windowStart,
        until: windowEnd,
        limit: 5000,
      }),
      ctx.repos.adviceTracking.listFeedbacks({ limit: 5000 }),
    ]);
    const fallbackIds = new Set(
      advices
        .filter((advice: Advice) => advice.subjectKind === 'stock' && isRuleFallbackAdvice(advice))
        .map((advice) => advice.id),
    );
    const confidenceById = new Map<string, number>(
      advices
        .filter((advice: Advice) => !isRuleFallbackAdvice(advice))
        .map((advice: Advice) => [advice.id, advice.confidence]),
    );
    const ruleFallbackSamples = settlements.filter((settlement) =>
      fallbackIds.has(settlement.adviceId),
    ).length;
    const rows = settlements
      .filter((settlement) => confidenceById.has(settlement.adviceId))
      .map((settlement) => ({
        bucket: bucketOf(confidenceById.get(settlement.adviceId) ?? 0),
        hit: settlement.hit,
        excessPct: settlement.excessPct,
      }));

    const settledIds = new Set(settlements.map((settlement) => settlement.adviceId));
    const fillPriceById = new Map(
      feedbacks.flatMap((feedback) =>
        feedback.fillPrice === undefined ? [] : [[feedback.adviceId, feedback.fillPrice] as const],
      ),
    );
    const buySellStock = advices.filter(
      (advice) =>
        advice.subjectKind === 'stock' && (advice.decision === 'buy' || advice.decision === 'sell'),
    );
    const ruleFallbackAdvices = advices.filter(
      (advice) => advice.subjectKind === 'stock' && isRuleFallbackAdvice(advice),
    );
    const aiBuySell = buySellStock.filter((advice) => !isRuleFallbackAdvice(advice));
    // 已到结算窗口：按自然日近似，与 scorecard 的 days 窗口一致；
    // 已有结算行的（例如补算历史）直接视为到期，不让日历口径吞掉真实结算。
    const dueCutoff = new Date(windowEnd.getTime() - input.horizonDays * DAY_MS);
    const isDue = (advice: Advice): boolean =>
      advice.createdAt.getTime() <= dueCutoff.getTime() || settledIds.has(advice.id);
    const eligibleAdvices = aiBuySell.filter(isDue);
    const uncoveredAdvices = eligibleAdvices.filter((advice) => !settledIds.has(advice.id));
    const missingEntryAdvices = uncoveredAdvices.filter((advice) => {
      const entry = fillPriceById.get(advice.id) ?? assumedEntryOf(advice);
      return entry === null || entry <= 0;
    });
    const settledEligible = eligibleAdvices.length - uncoveredAdvices.length;
    const otherDecisions = advices.filter(
      (advice) =>
        advice.subjectKind === 'stock' && advice.decision !== 'buy' && advice.decision !== 'sell',
    ).length;
    const nonStock = advices.filter((advice) => advice.subjectKind !== 'stock').length;

    const overall = stats(rows);
    const groups = (['<50', '50-69', '>=70'] as const).map((bucket) => ({
      bucket,
      ...stats(rows.filter((row) => row.bucket === bucket)),
    }));
    const reasons: string[] = [];
    if (overall.samples < SCORECARD_MIN_SAMPLES) {
      reasons.push(`已结算样本 ${overall.samples} 条，不足 ${SCORECARD_MIN_SAMPLES} 条`);
    }
    if (overall.hitRate !== null && overall.hitRate < SCORECARD_MIN_HIT_RATE) {
      reasons.push(
        `命中率 ${(overall.hitRate * 100).toFixed(1)}%，低于 ${(SCORECARD_MIN_HIT_RATE * 100).toFixed(0)}%`,
      );
    }
    return {
      windowStart,
      windowEnd,
      horizonDays: input.horizonDays,
      benchmark: DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      samples: overall.samples,
      ruleFallbackSamples,
      ruleFallbackTotal: ruleFallbackAdvices.length,
      eligible: eligibleAdvices.length,
      settledEligible,
      coverage: eligibleAdvices.length === 0 ? null : settledEligible / eligibleAdvices.length,
      uncovered: {
        missingEntry: missingEntryAdvices.length,
        missingBars: uncoveredAdvices.length - missingEntryAdvices.length,
      },
      reconciliation: {
        windowAdvices: advices.length,
        buySellStock: buySellStock.length,
        ruleFallback: ruleFallbackAdvices.length,
        notDue: aiBuySell.length - eligibleAdvices.length,
        otherDecisions,
        nonStock,
      },
      hitRate: overall.hitRate,
      avgExcessPct: overall.avgExcessPct,
      groups,
      gate: {
        minSamples: SCORECARD_MIN_SAMPLES,
        minHitRate: SCORECARD_MIN_HIT_RATE,
        passed: reasons.length === 0,
        reasons,
      },
    };
  },
});
