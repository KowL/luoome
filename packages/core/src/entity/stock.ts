import { z } from 'zod';

import { type StockCode, StockCodeSchema } from '../types/branded.js';

/** 交易所（ARCHITECTURE §5.1 标的）。 */
export type Exchange = 'SH' | 'SZ' | 'BJ' | 'HK' | 'US';

export interface Stock {
  readonly id: string;
  readonly code: StockCode;
  readonly exchange: Exchange;
  readonly name: string;
  readonly industry?: string;
}

export const ExchangeSchema = z.enum(['SH', 'SZ', 'BJ', 'HK', 'US']);

export const StockSchema = z.object({
  id: z.string().min(1),
  code: StockCodeSchema,
  exchange: ExchangeSchema,
  name: z.string().min(1),
  industry: z.string().optional(),
});

/** 港股/美股等名称内的空格有意义；只去掉汉字之间的空白（如 "五 粮 液" → "五粮液"）。 */
export const normalizeStockName = (name: string): string =>
  name.replace(/(\p{Script=Han})[\s\u3000]+(?=\p{Script=Han})/gu, '$1');
