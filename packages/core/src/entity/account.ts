import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

/** 账户类型：真实 / 模拟（ARCHITECTURE §5.1）。 */
export type AccountKind = 'real' | 'mock';

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  /** ISO 4217 币种代码，如 'CNY' / 'HKD' / 'USD'。 */
  readonly currency: string;
  readonly initialCapital: Money;
  readonly createdAt: Date;
}

export const AccountKindSchema = z.enum(['real', 'mock']);

export const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AccountKindSchema,
  currency: z.string().length(3),
  initialCapital: MoneySchema,
  createdAt: z.coerce.date(),
});
