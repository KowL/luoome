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
  readonly volume: number; // 股（各源统一换算：Eastmoney/Tencent 的手 ×100）
  /** 昨收（可选）：数据源给得出才填（eastmoney f60 / tushare pre_close；tencent 分钟端点无此字段）。 */
  readonly prevClose?: Money | undefined;
  readonly source: string;
}

/** 日线（标的、日期、OHLC、量、复权因子、数据源）。 */
export interface DailyBar {
  readonly stockId: string;
  readonly date: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number; // 股（与 Quote.volume 同量纲）
  readonly adjFactor: number;
  /** 实际产出该 bar 的数据源（如 eastmoney / tencent）；daily_bars.source 已有该列。 */
  readonly source: string;
}

/** 日期区间，供 fetchDailyBars 等接口使用。 */
export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

/** 大盘指数实时行情（代码、名称、最新点位、涨跌、时间、源；点位复用 Money 精度不变量）。 */
export interface IndexQuote {
  readonly code: string;
  readonly name: string;
  readonly close: Money; // 指数最新点位
  readonly change: number; // 涨跌额（点）
  readonly changePct: number; // 涨跌幅（%）
  readonly ts: Date;
  readonly source: string;
}

export const QuoteSchema = z.object({
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  prevClose: MoneySchema.optional(),
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
  source: z.string().min(1),
});

export const DateRangeSchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});

export const IndexQuoteSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  close: MoneySchema,
  change: z.number(),
  changePct: z.number(),
  ts: z.coerce.date(),
  source: z.string().min(1),
});
