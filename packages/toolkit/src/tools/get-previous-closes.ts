import { MoneySchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const TradingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: 'invalid trading date',
  });

export const GetPreviousClosesInput = z.object({
  stockIds: z.array(z.string().trim().min(1)).min(1).max(1000),
  tradingDate: TradingDateSchema.optional(),
});

const PreviousCloseItemSchema = z.discriminatedUnion('status', [
  z.object({
    stockId: z.string(),
    status: z.literal('ok'),
    close: MoneySchema,
    date: TradingDateSchema,
    source: z.string().min(1),
  }),
  z.object({
    stockId: z.string(),
    status: z.literal('unavailable'),
    reason: z.string().min(1),
  }),
]);

export const GetPreviousClosesOutput = z.object({
  items: z.array(PreviousCloseItemSchema),
});

const shanghaiDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const getPreviousClosesTool = defineTool({
  name: 'get_previous_closes',
  description: '批量读取严格早于目标交易日的最近前复权收盘价',
  sideEffect: 'read',
  input: GetPreviousClosesInput,
  output: GetPreviousClosesOutput,
  handler: async (input, ctx) => {
    const tradingDate = input.tradingDate ?? shanghaiDate(ctx.clock());
    const target = new Date(`${tradingDate}T00:00:00.000Z`);
    const cutoff = new Date(target.getTime() - 1);
    const stockIds = [...new Set(input.stockIds)];
    const items = await Promise.all(
      stockIds.map(async (stockId) => {
        try {
          const bars = await ctx.repos.dailyBar.latestBefore(stockId, cutoff, 1);
          const bar = bars.at(-1);
          if (bar === undefined) {
            return {
              stockId,
              status: 'unavailable' as const,
              reason: `no-qfq-daily-bar-before-${tradingDate}`,
            };
          }
          return {
            stockId,
            status: 'ok' as const,
            close: bar.close,
            date: isoDate(bar.date),
            source: bar.source,
          };
        } catch (error) {
          return {
            stockId,
            status: 'unavailable' as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { items };
  },
});
