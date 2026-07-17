import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

/** 实时行情快照（ARCHITECTURE §5.1 PriceSnapshot：标的、ts、OHLC、量、源）。 */
export interface Quote {
  readonly stockId: string;
  readonly ts: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money; // 实时价取最近成交价，放入 close
  readonly volume: number;
  readonly source: string;
}

/** 日线（标的、日期、OHLC、量、复权因子）。 */
export interface DailyBar {
  readonly stockId: string;
  readonly date: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly adjFactor: number;
}

/** 日期区间，供 fetchDailyBars 等接口使用。 */
export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

export const QuoteSchema = z.object({
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  source: z.string().min(1),
});

export const DailyBarSchema = z.object({
  stockId: z.string().min(1),
  date: z.coerce.date(),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  adjFactor: z.number().positive(),
});

export const DateRangeSchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});
