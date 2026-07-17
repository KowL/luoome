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
