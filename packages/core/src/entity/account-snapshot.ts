import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { MoneySchema } from '../types/branded.js';

/**
 * 用户手动维护的账户事实快照。
 *
 * 现金和持仓估值必须来自同一份版本；无法证明二者同步时保留快照，但禁止
 * 下游把它当作精确仓位预算。它不是成交记录，也不会因为 Advice/信号而变化。
 */
export const AccountSnapshotStatusSchema = z.enum([
  'complete',
  'needs-reconciliation',
  'unavailable',
]);
export type AccountSnapshotStatus = z.infer<typeof AccountSnapshotStatusSchema>;

export const AccountSnapshotSourceSchema = z.enum(['manual', 'import']);
export type AccountSnapshotSource = z.infer<typeof AccountSnapshotSourceSchema>;

export const AccountPositionSnapshotSchema = z.object({
  stockId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  marketValue: MoneySchema,
  industry: z.string().trim().min(1).optional(),
  price: MoneySchema.optional(),
  observedAt: z.coerce.date().optional(),
});
export type AccountPositionSnapshot = z.infer<typeof AccountPositionSnapshotSchema>;

export const AccountSnapshotSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  version: z.number().int().positive(),
  asOf: z.coerce.date(),
  cashBalance: MoneySchema.nullable(),
  stockMarketValue: MoneySchema.nullable(),
  totalAssets: MoneySchema.nullable(),
  status: AccountSnapshotStatusSchema,
  positions: z.array(AccountPositionSnapshotSchema),
  source: AccountSnapshotSourceSchema,
  note: z.string().max(500).optional(),
  createdAt: z.coerce.date(),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;

export const assertAccountSnapshotInvariants = (snapshot: AccountSnapshot): void => {
  for (const position of snapshot.positions) {
    if (position.availableQuantity > position.quantity) {
      throw new InvariantError(
        `account snapshot available quantity exceeds quantity for ${position.stockId}`,
      );
    }
  }
  if (snapshot.status === 'complete') {
    if (
      snapshot.cashBalance === null ||
      snapshot.stockMarketValue === null ||
      snapshot.totalAssets === null
    ) {
      throw new InvariantError(
        'complete account snapshot requires cash, stock value and total assets',
      );
    }
    const expected = Math.round((snapshot.cashBalance + snapshot.stockMarketValue) * 10000) / 10000;
    const actual = Math.round(snapshot.totalAssets * 10000) / 10000;
    if (expected !== actual) {
      throw new InvariantError(
        'account snapshot totalAssets must equal cashBalance + stockMarketValue',
      );
    }
    const positionTotal = snapshot.positions.reduce(
      (sum, position) => sum + position.marketValue,
      0,
    );
    if (
      Math.round(positionTotal * 10000) / 10000 !==
      Math.round(snapshot.stockMarketValue * 10000) / 10000
    ) {
      throw new InvariantError(
        'account snapshot stockMarketValue must equal position market values',
      );
    }
  }
  if (snapshot.status !== 'complete' && snapshot.totalAssets !== null) {
    throw new InvariantError('incomplete account snapshot cannot expose precise totalAssets');
  }
};
