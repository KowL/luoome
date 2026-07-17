import { z } from 'zod';

import { type Money, MoneySchema, type Quantity, QuantitySchema } from '../types/branded.js';

/** 交易记录（ARCHITECTURE §5.1：买/卖、数量、价、费、时间、来源）。 */
export type TradeSide = 'buy' | 'sell';
export type TradeSource = 'manual' | 'import' | 'system';

export interface Trade {
  readonly id: string;
  readonly accountId: string;
  readonly stockId: string;
  readonly side: TradeSide;
  readonly quantity: Quantity;
  readonly price: Money;
  readonly fee: Money;
  readonly executedAt: Date;
  readonly source: TradeSource;
  readonly createdAt: Date;
}

export const TradeSideSchema = z.enum(['buy', 'sell']);
export const TradeSourceSchema = z.enum(['manual', 'import', 'system']);

export const TradeSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  stockId: z.string().min(1),
  side: TradeSideSchema,
  quantity: QuantitySchema,
  price: MoneySchema,
  fee: MoneySchema,
  executedAt: z.coerce.date(),
  source: TradeSourceSchema,
  createdAt: z.coerce.date(),
});
