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
  /** 开户时的本金，也是账本推导的起点；不再变化。 */
  readonly initialCapital: Money;
  /**
   * 当前现金余额（元）。账本事实的一部分：
   * 建仓/加仓扣减、减仓/平仓回补、资金流水增减，均由写路径在同一事务内更新，
   * 口径见 `portfolio/ledger.ts`；对账基准由 recomputeCashFromLedger 提供。
   */
  readonly cashBalance: Money;
  readonly createdAt: Date;
}

export const AccountKindSchema = z.literal('real');

export const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AccountKindSchema,
  currency: z.string().length(3),
  initialCapital: MoneySchema,
  cashBalance: MoneySchema,
  createdAt: z.coerce.date(),
});
