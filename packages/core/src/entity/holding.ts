import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

/** 持仓（ARCHITECTURE §4.1，字段保持与文档一致）。 */
export interface Holding {
  readonly id: string;
  readonly accountId: string;
  readonly stockId: string;
  readonly quantity: number; // 整数股
  readonly availableQuantity: number; // 可卖数量
  readonly avgCost: Money;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

export const HoldingSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  stockId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  avgCost: MoneySchema,
  openedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
});
