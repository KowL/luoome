import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

export const MinuteBarIntervalSchema = z.enum(['1m', '5m', '15m', '30m', '60m']);
export type MinuteBarInterval = z.infer<typeof MinuteBarIntervalSchema>;

export const MinuteBarCompletenessSchema = z.enum(['closed', 'live']);
export type MinuteBarCompleteness = z.infer<typeof MinuteBarCompletenessSchema>;

/**
 * 单个 provider 原生分钟桶。endedAt 是上游桶结束标签对应的绝对时间；
 * 分钟价格保持 raw 坐标，不能与 qfq DailyBar 混算。
 */
export interface MinuteBar {
  readonly stockId: string;
  readonly interval: MinuteBarInterval;
  readonly endedAt: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly amount?: number | undefined;
  readonly adjustment: 'raw';
  readonly source: string;
  readonly fetchedAt: Date;
  readonly completeness: MinuteBarCompleteness;
}

export const MinuteBarSchema = z
  .object({
    stockId: z.string().trim().min(1),
    interval: MinuteBarIntervalSchema,
    endedAt: z.coerce.date(),
    open: MoneySchema,
    high: MoneySchema,
    low: MoneySchema,
    close: MoneySchema,
    volume: z.number().nonnegative(),
    amount: z.number().nonnegative().optional(),
    adjustment: z.literal('raw'),
    source: z.string().trim().min(1),
    fetchedAt: z.coerce.date(),
    completeness: MinuteBarCompletenessSchema,
  })
  .superRefine((bar, ctx) => {
    if (bar.high < Math.max(bar.open, bar.close)) {
      ctx.addIssue({ code: 'custom', path: ['high'], message: 'high must cover open and close' });
    }
    if (bar.low > Math.min(bar.open, bar.close)) {
      ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must cover open and close' });
    }
    if (bar.low > bar.high) {
      ctx.addIssue({ code: 'custom', path: ['low'], message: 'low must not exceed high' });
    }
    if (bar.endedAt.getTime() > bar.fetchedAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'endedAt must not be after fetchedAt',
      });
    }
  });
