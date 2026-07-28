import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

/** 单股票稀疏市场观测；ts 是 observedAt 的兼容投影。 */
export interface Quote {
  readonly stockId: string;
  readonly observedAt: Date;
  readonly fetchedAt: Date;
  readonly timestampSource: 'upstream' | 'retrieval';
  /** @deprecated 使用 observedAt；迁移期保留给现有 caller。 */
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

/** 调用方可消费的规范日线；所有价格都位于前复权（qfq）坐标系。 */
export interface DailyBar {
  readonly stockId: string;
  readonly date: Date;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number; // 股（与 Quote.volume 同量纲）
  readonly adjustment: 'qfq';
  /** 数据源原始复权因子；源未提供时省略，不能用 1 伪装。 */
  readonly sourceAdjFactor?: number | undefined;
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

export const QuoteSchema = z
  .object({
    stockId: z.string().min(1),
    observedAt: z.coerce.date().optional(),
    fetchedAt: z.coerce.date().optional(),
    timestampSource: z.enum(['upstream', 'retrieval']).optional(),
    ts: z.coerce.date().optional(),
    open: MoneySchema,
    high: MoneySchema,
    low: MoneySchema,
    close: MoneySchema,
    volume: z.number().nonnegative(),
    prevClose: MoneySchema.optional(),
    source: z.string().min(1),
  })
  .superRefine((quote, ctx) => {
    const observedAt = quote.observedAt ?? quote.ts;
    if (observedAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['observedAt'], message: 'observedAt is required' });
      return;
    }
    const fetchedAt = quote.fetchedAt ?? observedAt;
    const timestampSource = quote.timestampSource ?? 'retrieval';
    if (observedAt.getTime() > fetchedAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'observedAt must not be after fetchedAt',
      });
    }
    if (timestampSource === 'retrieval' && observedAt.getTime() !== fetchedAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['timestampSource'],
        message: 'retrieval timestamp requires observedAt === fetchedAt',
      });
    }
  })
  .transform((quote): Quote => {
    const observedAt = quote.observedAt ?? (quote.ts as Date);
    const fetchedAt = quote.fetchedAt ?? observedAt;
    return {
      stockId: quote.stockId,
      observedAt,
      fetchedAt,
      timestampSource: quote.timestampSource ?? 'retrieval',
      ts: observedAt,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume,
      ...(quote.prevClose === undefined ? {} : { prevClose: quote.prevClose }),
      source: quote.source,
    };
  });

export const DailyBarSchema = z.object({
  stockId: z.string().min(1),
  date: z.coerce.date(),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  adjustment: z.literal('qfq'),
  sourceAdjFactor: z.number().positive().optional(),
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
