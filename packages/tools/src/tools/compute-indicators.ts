import { TechnicalIndicatorsSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';

/**
 * compute_indicators（v0.2 起，read）。
 * 给定 stockId + dateRange 拉日线 → 算指标快照，不落库（与 analyze_stock 不同；
 * analyze 会落库到 advice.basedOn.indicators）。
 * range.lookbackDays 给默认值 120（与 v0.1 analyze-stock 一致）。
 */
const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 120;

export const ComputeIndicatorsInput = z.object({
  stockId: z.string().min(1),
  /** 缺省回看 120 天（端点 = now）。 */
  lookbackDays: z.number().int().positive().max(365).default(DEFAULT_LOOKBACK_DAYS),
});

export const ComputeIndicatorsOutput = z.object({
  stockId: z.string(),
  indicators: TechnicalIndicatorsSchema,
  /** 实际用的日线条数；不足 60 时部分指标返回 undefined。 */
  barsCount: z.number().int().nonnegative(),
  dataAsOf: z.coerce.date(),
});

export const computeIndicatorsTool = defineTool({
  name: 'compute_indicators',
  description: '拉日线算技术指标快照（不落库）；stockId 支持纯代码',
  sideEffect: 'read',
  input: ComputeIndicatorsInput,
  output: ComputeIndicatorsOutput,
  handler: async (input, ctx) => {
    const stock =
      (await ctx.repos.stock.findById(input.stockId)) ??
      (await ctx.repos.stock.findByCode(input.stockId.trim().toUpperCase()));
    if (stock === null) return errNotFound('Stock', input.stockId);
    const now = ctx.clock();
    const bars = await ctx.adapters.market.fetchDailyBars(stock.id, {
      start: new Date(now.getTime() - input.lookbackDays * DAY_MS),
      end: now,
    });
    const indicators = computeSimpleIndicators(bars);
    return {
      stockId: stock.id,
      indicators,
      barsCount: bars.length,
      dataAsOf: now,
    };
  },
});
