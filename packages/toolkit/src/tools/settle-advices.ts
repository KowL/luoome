import {
  type Advice,
  AdviceSettlementSchema,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
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
  /** 单次最多结算多少条建议（按创建时间倒序）。 */
  limit: z.number().int().min(1).max(200).default(50),
});
export const SettleAdvicesOutput = z.object({
  /** 本次尝试的建议条数。 */
  scanned: z.number().int().nonnegative(),
  /** 新写入或覆盖的结算条数。 */
  settled: z.number().int().nonnegative(),
  /** 因缺价、缺日线等原因跳过的条数。 */
  skipped: z.number().int().nonnegative(),
});

type SettlementHorizon = (typeof SETTLEMENT_HORIZONS)[number];

/** 假设成交价：用户填的成交价 > 建议入场价 > 入场区间中值 > 建议当日收盘。 */
const assumedEntryOf = (advice: Advice): number | null => {
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
    const advices = await ctx.repos.advice.query({
      limit: input.limit,
      includeExpired: true,
      until: new Date(asOf.getTime() - DAY_MS),
    });
    let settled = 0;
    let skipped = 0;
    for (const advice of advices) {
      if (advice.subjectKind !== 'stock') {
        skipped += 1;
        continue;
      }
      const feedback = await ctx.repos.adviceTracking.findFeedback(advice.id);
      const entry = feedback?.fillPrice ?? assumedEntryOf(advice);
      if (entry === null || entry <= 0) {
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
      }
      if (wrote === 0) skipped += 1;
      else settled += wrote;
    }
    return { scanned: advices.length, settled, skipped };
  },
});

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
