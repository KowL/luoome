import {
  type Advice,
  AdviceSettlementSchema,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  isRuleFallbackAdvice,
  money,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const SETTLEMENT_HORIZONS = [1, 3, 5] as const;

const DAY_MS = 86_400_000;

export const SettleAdvicesInput = z.object({
  /** 结算基准时刻；缺省取 ctx.clock()。 */
  asOf: z.coerce.date().optional(),
  /** 分页大小：每页最多取多少条建议（按创建时间倒序翻页扫完窗口，不丢历史建议）。 */
  limit: z.number().int().min(1).max(200).default(50),
});

const HorizonCoverageSchema = z.object({
  horizonDays: z.number().int().positive(),
  /** 应结算建议中已有该档结算行的条数。 */
  settled: z.number().int().nonnegative(),
  /** 应结算建议中该档仍缺结算的条数。 */
  uncovered: z.number().int().nonnegative(),
});

const DecisionCoverageSchema = z.object({
  decision: z.enum(['buy', 'sell']),
  eligible: z.number().int().nonnegative(),
  settledEligible: z.number().int().nonnegative(),
});

export const SettleAdvicesOutput = z.object({
  /** 本次尝试的建议条数。 */
  scanned: z.number().int().nonnegative(),
  /** 新写入或覆盖的结算条数。 */
  settled: z.number().int().nonnegative(),
  /** 因缺价、缺日线等原因跳过的条数。 */
  skipped: z.number().int().nonnegative(),
  /** 应结算：股票 + buy/sell + 非规则兜底 + 已到 T+1 窗口。 */
  eligible: z.number().int().nonnegative(),
  /** 应结算建议中已有任一分档结算行的条数。 */
  settledEligible: z.number().int().nonnegative(),
  /** settledEligible / eligible；没有应结算建议时为 null，不伪造成 100%。 */
  coverage: z.number().min(0).max(1).nullable(),
  /** 按 T+1/T+3/T+5 分档的覆盖。 */
  horizons: z.array(HorizonCoverageSchema),
  /** buy/sell 对账口径。 */
  byDecision: z.array(DecisionCoverageSchema),
  /** 规则观察（股票、任一 decision，含 watch）：单列，不进覆盖率分子分母。 */
  ruleFallback: z.object({
    total: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
  }),
  /** 应结算但未覆盖的原因计数；missingBars 含日线不足该档的情况。 */
  uncovered: z.object({
    missingEntry: z.number().int().nonnegative(),
    missingBars: z.number().int().nonnegative(),
  }),
});

type SettlementHorizon = (typeof SETTLEMENT_HORIZONS)[number];

/** 应结算口径：股票、buy/sell、非规则兜底。 */
const isEligibleAdvice = (advice: Advice): boolean =>
  advice.subjectKind === 'stock' &&
  (advice.decision === 'buy' || advice.decision === 'sell') &&
  !isRuleFallbackAdvice(advice);

/** 规则观察口径：股票规则兜底，任一 decision（含 watch）。 */
const isRuleFallbackStock = (advice: Advice): boolean =>
  advice.subjectKind === 'stock' && isRuleFallbackAdvice(advice);

/** 假设成交价：用户填的成交价 > 建议入场价 > 入场区间中值 > 建议当日收盘。 */
export const assumedEntryOf = (advice: Advice): number | null => {
  const quoted = advice.basedOn.quotes?.[advice.subjectId]?.close;
  if (advice.entryPrice !== undefined) return advice.entryPrice;
  if (advice.entryPriceLow !== undefined && advice.entryPriceHigh !== undefined) {
    return (advice.entryPriceLow + advice.entryPriceHigh) / 2;
  }
  return quoted ?? null;
};

const hitOf = (decision: Advice['decision'], returnPct: number, excessPct: number): boolean => {
  switch (decision) {
    case 'buy':
    case 'watch':
      return returnPct > 0;
    case 'avoid':
      return returnPct <= 0;
    case 'hold':
    case 'sell':
      return excessPct > 0;
    default:
      return false;
  }
};

/**
 * 按建议假设执行，用日线结算 T+1 / T+3 / T+5。
 *
 * 与用户是否点击反馈无关：结算回答「这条建议本身对不对」。用户填了实际成交价时，
 * 用实际成交价替换假设成交价，但结论仍然只描述建议本身的方向是否正确。
 */
export const settleAdvicesTool = defineTool({
  name: 'settle_advices',
  description:
    '对已过期建议按假设执行结算 T+1/T+3/T+5：收益率、对沪深300 超额、是否命中；已结算的会覆盖',
  sideEffect: 'write',
  input: SettleAdvicesInput,
  output: SettleAdvicesOutput,
  handler: async (input, ctx) => {
    const asOf = input.asOf ?? ctx.clock();
    const advices = await scanDueAdvices(ctx, new Date(asOf.getTime() - DAY_MS), input.limit);
    const existingSettlements = await ctx.repos.adviceTracking.listSettlements({});
    const horizonsByAdvice = new Map<string, Set<number>>();
    for (const settlement of existingSettlements) {
      const horizons = horizonsByAdvice.get(settlement.adviceId) ?? new Set<number>();
      horizons.add(settlement.horizonDays);
      horizonsByAdvice.set(settlement.adviceId, horizons);
    }
    let settled = 0;
    let skipped = 0;
    const missingEntryIds = new Set<string>();
    for (const advice of advices) {
      if (advice.subjectKind !== 'stock') {
        skipped += 1;
        continue;
      }
      const feedback = await ctx.repos.adviceTracking.findFeedback(advice.id);
      const entry = feedback?.fillPrice ?? assumedEntryOf(advice);
      if (entry === null || entry <= 0) {
        missingEntryIds.add(advice.id);
        skipped += 1;
        continue;
      }
      const start = advice.createdAt;
      const [bars, benchmarkBars] = await Promise.all([
        ctx.repos.dailyBar.findInRange(advice.subjectId, start, asOf),
        ctx.repos.dailyBar.findInRange(DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID, start, asOf),
      ]);
      const benchmarkStart = benchmarkBars[0];
      if (bars.length === 0 || benchmarkStart === undefined) {
        skipped += 1;
        continue;
      }
      let wrote = 0;
      for (const horizon of SETTLEMENT_HORIZONS as readonly SettlementHorizon[]) {
        const bar = bars[horizon - 1];
        const benchmarkBar = benchmarkBars[horizon - 1];
        if (bar === undefined || benchmarkBar === undefined) break;
        const returnPct = bar.close / entry - 1;
        const benchmarkReturnPct = benchmarkBar.close / benchmarkStart.close - 1;
        const excessPct = returnPct - benchmarkReturnPct;
        await ctx.repos.adviceTracking.saveSettlement(
          AdviceSettlementSchema.parse({
            adviceId: advice.id,
            horizonDays: horizon,
            assumedEntryPrice: money(entry),
            exitPrice: money(bar.close),
            returnPct,
            benchmarkReturnPct,
            excessPct,
            hit: hitOf(advice.decision, returnPct, excessPct),
            evaluatedAt: asOf,
            ...(feedback?.action === 'done' ? { note: '按用户实际成交价结算' } : {}),
          }),
        );
        wrote += 1;
        const horizons = horizonsByAdvice.get(advice.id) ?? new Set<number>();
        horizons.add(horizon);
        horizonsByAdvice.set(advice.id, horizons);
      }
      if (wrote === 0) skipped += 1;
      else settled += wrote;
    }

    const eligibleAdvices = advices.filter(isEligibleAdvice);
    const settledEligibleAdvices = eligibleAdvices.filter((advice) =>
      horizonsByAdvice.has(advice.id),
    );
    const uncoveredAdvices = eligibleAdvices.filter((advice) => !horizonsByAdvice.has(advice.id));
    const ruleFallbackAdvices = advices.filter(isRuleFallbackStock);
    const settledRuleFallback = ruleFallbackAdvices.filter((advice) =>
      horizonsByAdvice.has(advice.id),
    );
    return {
      scanned: advices.length,
      settled,
      skipped,
      eligible: eligibleAdvices.length,
      settledEligible: settledEligibleAdvices.length,
      coverage:
        eligibleAdvices.length === 0
          ? null
          : settledEligibleAdvices.length / eligibleAdvices.length,
      horizons: SETTLEMENT_HORIZONS.map((horizon) => {
        const horizonSettled = eligibleAdvices.filter((advice) =>
          horizonsByAdvice.get(advice.id)?.has(horizon),
        ).length;
        return {
          horizonDays: horizon,
          settled: horizonSettled,
          uncovered: eligibleAdvices.length - horizonSettled,
        };
      }),
      byDecision: (['buy', 'sell'] as const).map((decision) => ({
        decision,
        eligible: eligibleAdvices.filter((advice) => advice.decision === decision).length,
        settledEligible: settledEligibleAdvices.filter((advice) => advice.decision === decision)
          .length,
      })),
      ruleFallback: {
        total: ruleFallbackAdvices.length,
        settled: settledRuleFallback.length,
      },
      uncovered: {
        missingEntry: uncoveredAdvices.filter((advice) => missingEntryIds.has(advice.id)).length,
        missingBars: uncoveredAdvices.filter((advice) => !missingEntryIds.has(advice.id)).length,
      },
    };
  },
});

/**
 * 按创建时间倒序分页扫完结算窗口。`limit` 只是分页大小：单页上限不应让更早的建议
 * 默默漏结算。同一时间戳跨页时按 id 去重，游标无法再前进才停止。
 */
const scanDueAdvices = async (
  ctx: ToolContext,
  until: Date,
  pageSize: number,
): Promise<Advice[]> => {
  const collected = new Map<string, Advice>();
  let cursor = until;
  for (;;) {
    const page = await ctx.repos.advice.query({
      limit: pageSize,
      includeExpired: true,
      until: cursor,
    });
    let fresh = 0;
    for (const advice of page) {
      if (collected.has(advice.id)) continue;
      collected.set(advice.id, advice);
      fresh += 1;
    }
    const oldest = page[page.length - 1];
    if (page.length < pageSize || fresh === 0 || oldest === undefined) break;
    if (oldest.createdAt.getTime() >= cursor.getTime()) break;
    cursor = oldest.createdAt;
  }
  return [...collected.values()];
};

/** 供测试与页面读取：单条建议的结算结果。 */
export const GetAdviceSettlementsInput = z.object({ adviceId: z.string().min(1) });
export const GetAdviceSettlementsOutput = z.object({
  feedback: z
    .object({
      action: z.enum(['done', 'skipped', 'later']),
      fillPrice: z.number().optional(),
      recordedAt: z.coerce.date(),
    })
    .nullable(),
  settlements: z.array(AdviceSettlementSchema),
});

export const getAdviceSettlementsTool = defineTool({
  name: 'get_advice_settlements',
  description: '读取一条建议的用户反馈与 T+1/T+3/T+5 结算结果',
  sideEffect: 'read',
  input: GetAdviceSettlementsInput,
  output: GetAdviceSettlementsOutput,
  handler: async (input, ctx) => {
    const [feedback, settlements] = await Promise.all([
      ctx.repos.adviceTracking.findFeedback(input.adviceId),
      ctx.repos.adviceTracking.listSettlements({ adviceId: input.adviceId }),
    ]);
    return {
      feedback:
        feedback === null
          ? null
          : {
              action: feedback.action,
              ...(feedback.fillPrice === undefined ? {} : { fillPrice: feedback.fillPrice }),
              recordedAt: feedback.recordedAt,
            },
      settlements: [...settlements],
    };
  },
});

/** ToolContext 参数在校验签名时使用，避免 defineTool 泛型推断丢失。 */
export type SettleAdvicesContext = ToolContext;
