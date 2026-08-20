import {
  DataFreshnessSchema,
  dateInShanghai,
  MinuteBarIntervalSchema,
  MinuteBarSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { normalizeMinuteBars, shanghaiDayRange } from '../internal/minute-bar.js';

const RETENTION_DAYS = 30;

const MinuteBarWarningSchema = z.enum([
  'unsupported-capability',
  'provider-error',
  'no-data',
  'local-fallback',
  'historical-provider-unavailable',
  'session-in-progress',
  'gaps-detected',
  'outside-trading-session',
  'mixed-provider-date',
  'source-date-mismatch',
]);

export const GetStockMinuteBarsInput = z.object({
  stockId: z.string().trim().min(1),
  interval: MinuteBarIntervalSchema.default('1m'),
  /** 历史日期只读取本地按需采集事实；当前 provider 不提供 HTTP 历史分页。 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const GetStockMinuteBarsOutput = z.object({
  stockId: z.string().min(1),
  interval: MinuteBarIntervalSchema,
  date: z.string().nullable(),
  status: z.enum(['complete', 'partial', 'unavailable']),
  retrieval: z.enum(['live', 'local-fallback', 'none']),
  freshness: DataFreshnessSchema,
  bars: z.array(MinuteBarSchema),
  gaps: z.array(
    z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      missingBars: z.number().int().positive(),
    }),
  ),
  asOf: z.coerce.date().nullable(),
  sources: z.array(z.string().min(1)),
  warnings: z.array(MinuteBarWarningSchema),
  providerScope: z.literal('current-session-only'),
  retentionDays: z.literal(RETENTION_DAYS),
});

export const getStockMinuteBarsTool = defineTool({
  name: 'get_stock_minute_bars',
  description: '获取独立分钟 OHLCV；支持当前真实源与本地按需历史，缺口和不可用状态显式返回',
  sideEffect: 'external',
  input: GetStockMinuteBarsInput,
  output: GetStockMinuteBarsOutput,
  handler: async (input, ctx) => {
    const today = dateInShanghai(ctx.clock());
    const canFetchCurrent = input.date === undefined || input.date === today;
    const warnings = new Set<z.infer<typeof MinuteBarWarningSchema>>();
    let remoteBars: Awaited<ReturnType<typeof ctx.adapters.market.fetchMinuteBars>> | null = null;

    if (canFetchCurrent) {
      try {
        remoteBars = await ctx.adapters.market.fetchMinuteBars(input.stockId, input.interval);
        if (remoteBars.length === 0) warnings.add('no-data');
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        warnings.add(
          cause.includes('unsupported_capability') ? 'unsupported-capability' : 'provider-error',
        );
        ctx.logger.warn('get_stock_minute_bars provider failed', {
          stockId: input.stockId,
          interval: input.interval,
          error: cause,
        });
      }
    } else {
      warnings.add('historical-provider-unavailable');
    }

    if (remoteBars !== null && remoteBars.length > 0) {
      const normalized = normalizeMinuteBars(remoteBars, input.interval);
      if (input.date !== undefined && normalized.date !== input.date) {
        warnings.add('source-date-mismatch');
      } else if (normalized.bars.length > 0) {
        await ctx.repos.minuteBar.saveMany(normalized.bars);
        await ctx.repos.minuteBar.removeBefore(
          new Date(ctx.clock().getTime() - RETENTION_DAYS * 86_400_000),
        );
        return buildOutput({
          stockId: input.stockId,
          interval: input.interval,
          normalized,
          retrieval: 'live',
          today,
          warnings,
        });
      }
    }

    const localBars =
      input.date === undefined
        ? await ctx.repos.minuteBar.latestSession(input.stockId, input.interval)
        : await ctx.repos.minuteBar.findInRange(
            input.stockId,
            input.interval,
            shanghaiDayRange(input.date).from,
            shanghaiDayRange(input.date).to,
          );
    if (localBars.length === 0) {
      if (warnings.size === 0) warnings.add('no-data');
      return {
        stockId: input.stockId,
        interval: input.interval,
        date: null,
        status: 'unavailable' as const,
        retrieval: 'none' as const,
        freshness: 'unavailable' as const,
        bars: [],
        gaps: [],
        asOf: null,
        sources: [],
        warnings: [...warnings],
        providerScope: 'current-session-only' as const,
        retentionDays: RETENTION_DAYS,
      };
    }
    warnings.add('local-fallback');
    return buildOutput({
      stockId: input.stockId,
      interval: input.interval,
      normalized: normalizeMinuteBars(localBars, input.interval),
      retrieval: 'local-fallback',
      today,
      warnings,
    });
  },
});

const buildOutput = (input: {
  readonly stockId: string;
  readonly interval: z.infer<typeof MinuteBarIntervalSchema>;
  readonly normalized: ReturnType<typeof normalizeMinuteBars>;
  readonly retrieval: 'live' | 'local-fallback';
  readonly today: string;
  readonly warnings: Set<z.infer<typeof MinuteBarWarningSchema>>;
}): z.input<typeof GetStockMinuteBarsOutput> => {
  const { normalized, warnings } = input;
  if (normalized.gaps.length > 0) warnings.add('gaps-detected');
  if (normalized.outsideSessionCount > 0) warnings.add('outside-trading-session');
  if (normalized.mixedDateCount > 0) warnings.add('mixed-provider-date');
  const isCurrentSession = normalized.date === input.today;
  if (isCurrentSession && !normalized.completeSession) warnings.add('session-in-progress');
  const status = normalized.completeSession ? 'complete' : 'partial';
  const freshness =
    input.retrieval === 'local-fallback' || normalized.date !== input.today ? 'stale' : 'fresh';
  return {
    stockId: input.stockId,
    interval: input.interval,
    date: normalized.date,
    status,
    retrieval: input.retrieval,
    freshness,
    bars: [...normalized.bars],
    gaps: [...normalized.gaps],
    asOf: normalized.bars.at(-1)?.endedAt ?? null,
    sources: [...new Set(normalized.bars.map((bar) => bar.source))],
    warnings: [...warnings],
    providerScope: 'current-session-only',
    retentionDays: RETENTION_DAYS,
  };
};
