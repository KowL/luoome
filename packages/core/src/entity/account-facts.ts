import { z } from 'zod';
import { accountFactsDigest } from '../portfolio/ledger.js';
import { type Money, MoneySchema } from '../types/branded.js';
import type { Account } from './account.js';
import type { Holding } from './holding.js';
import type { Stock } from './stock.js';

/**
 * 账户事实：现金余额（账户字段）+ 当前持仓按合格行情估值的市值。
 *
 * 这是「不要快照，只拿当前持仓」之后仓位计算与计划生成的唯一账户输入：
 * - 现金来自 Account.cashBalance（由交易/持仓/流水同步维护）；
 * - 市值必须来自行情，不能由用户手填的历史数字代替；
 * - 任何一个有数量的持仓缺少可用行情 → status='unavailable'，不给精确仓位；
 * - digest 是持仓 + 现金 + 本金的指纹，计划据此判定「账户事实是否已变化」。
 */

export const AccountFactsPositionSchema = z.object({
  stockId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  marketValue: MoneySchema,
  industry: z.string().trim().min(1).optional(),
  price: MoneySchema.optional(),
  observedAt: z.coerce.date().optional(),
});
export type AccountFactsPosition = z.infer<typeof AccountFactsPositionSchema>;

export const AccountFactsSchema = z.object({
  accountId: z.string().min(1),
  /** 账户事实时间：现金与持仓口径的形成时间。 */
  asOf: z.coerce.date(),
  /** 持仓 + 现金 + 本金指纹（portfolio/ledger.accountFactsDigest）。 */
  digest: z.string().min(8),
  cashBalance: MoneySchema,
  /** 持仓 × 行情；有数量但缺合格行情时为 null。 */
  stockMarketValue: MoneySchema.nullable(),
  totalAssets: MoneySchema.nullable(),
  positions: z.array(AccountFactsPositionSchema),
  status: z.enum(['complete', 'unavailable']),
  /** status=unavailable 的原因（逐条可读），便于 UI 与报告解释。 */
  reasons: z.array(z.string().min(1)),
});
export type AccountFacts = z.infer<typeof AccountFactsSchema>;

export interface AccountPriceFact {
  readonly close: Money;
  readonly observedAt: Date;
}

/**
 * 由账户 + 当前持仓 + 行情构造账户事实。
 * 持仓缺行情（或行情不可用）时整体标 unavailable 并给出原因，而不是用旧数字凑数。
 */
export const buildAccountFacts = (input: {
  readonly account: Pick<Account, 'id' | 'initialCapital' | 'cashBalance'>;
  readonly holdings: readonly Holding[];
  readonly stocks?: ReadonlyMap<string, Pick<Stock, 'industry'>>;
  readonly prices?: ReadonlyMap<string, AccountPriceFact>;
  readonly asOf: Date;
  readonly extraReasons?: readonly string[];
}): AccountFacts => {
  const reasons = [...(input.extraReasons ?? [])];
  if (input.account.cashBalance < 0) reasons.push('历史账本重算现金为负，请核对资金和持仓记录');
  const active = input.holdings.filter(
    (holding) => holding.closedAt === null && holding.quantity > 0,
  );
  const positions: AccountFactsPosition[] = [];
  for (const holding of active) {
    const price = input.prices?.get(holding.stockId);
    const industry =
      input.stocks?.get(holding.stockId)?.industry ?? (holding as { industry?: string }).industry;
    if (price === undefined) {
      reasons.push(`持仓 ${holding.stockId} 缺少合格行情，无法计算市值`);
      continue;
    }
    positions.push({
      stockId: holding.stockId,
      quantity: holding.quantity,
      availableQuantity: holding.availableQuantity,
      marketValue: round4(holding.quantity * price.close),
      ...(industry === undefined ? {} : { industry }),
      price: price.close,
      observedAt: price.observedAt,
    });
  }
  const stockMarketValue =
    reasons.length === 0
      ? round4(positions.reduce((sum, item) => sum + item.marketValue, 0))
      : null;
  const totalAssets =
    stockMarketValue === null ? null : round4(input.account.cashBalance + stockMarketValue);
  return {
    accountId: input.account.id,
    asOf: input.asOf,
    digest: accountFactsDigest({ account: input.account, holdings: input.holdings }),
    cashBalance: input.account.cashBalance,
    stockMarketValue,
    totalAssets,
    positions,
    status: reasons.length === 0 ? 'complete' : 'unavailable',
    reasons,
  };
};

const round4 = (value: number): Money => (Math.round(value * 10000) / 10000) as Money;
