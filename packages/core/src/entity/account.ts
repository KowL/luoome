import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';

/** 账户类型：仅真实账户。 */
export type AccountKind = 'real';

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  /** ISO 4217 币种代码，如 'CNY' / 'HKD' / 'USD'。 */
  readonly currency: string;
  readonly initialCapital: Money;
  readonly createdAt: Date;
}

export const AccountKindSchema = z.literal('real');

export const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AccountKindSchema,
  currency: z.string().length(3),
  initialCapital: MoneySchema,
  createdAt: z.coerce.date(),
});
