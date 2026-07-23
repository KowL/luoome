import { z } from 'zod';

/**
 * Adshare 股票基本信息。
 * 与 adshare /stock_basic 响应字段对齐，保留 v0.1 最小可用集合。
 */
export const StockBasicSchema = z.object({
  ts_code: z.string().min(1),
  name: z.string().min(1),
  industry: z.string().optional(),
  area: z.string().optional(),
  list_date: z.string().optional(),
  exchange: z.string().optional(),
});
export type StockBasic = z.infer<typeof StockBasicSchema>;

/**
 * Adshare K 线单根 bar。
 * 字段遵循常见 OHLCV + trade_date 约定。
 */
export const KLineBarSchema = z.object({
  ts_code: z.string().min(1),
  trade_date: z.string().min(1),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  vol: z.number().optional(),
  amount: z.number().optional(),
});
export type KLineBar = z.infer<typeof KLineBarSchema>;

/**
 * Adshare 实时行情快照。
 */
export const QuoteSchema = z.object({
  ts_code: z.string().min(1),
  name: z.string().optional(),
  price: z.number(),
  open: z.number().optional(),
  high: z.number().optional(),
  low: z.number().optional(),
  pre_close: z.number().optional(),
  change: z.number().optional(),
  pct_change: z.number().optional(),
  vol: z.number().optional(),
  amount: z.number().optional(),
  trade_date: z.string().optional(),
  trade_time: z.string().optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const AdshareHealthResponse = z.object({
  status: z.string().optional(),
  version: z.string().optional(),
});
