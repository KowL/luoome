import { type Advice, DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

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
  /** 已结算的建议条数（同一条建议只计一次）。 */
  samples: z.number().int().nonnegative(),
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
    const [settlements, advices] = await Promise.all([
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
    ]);
    const confidenceById = new Map<string, number>(
      advices.map((advice: Advice) => [advice.id, advice.confidence]),
    );
    const rows = settlements
      .filter((settlement) => confidenceById.has(settlement.adviceId))
      .map((settlement) => ({
        bucket: bucketOf(confidenceById.get(settlement.adviceId) ?? 0),
        hit: settlement.hit,
        excessPct: settlement.excessPct,
      }));

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
