import { createHash } from 'node:crypto';
import type { Account } from '../entity/account.js';
import type { Holding } from '../entity/holding.js';
import type {
  PortfolioCashFlow,
  PortfolioCorporateAction,
} from '../entity/portfolio-performance.js';
import type { Trade } from '../entity/trade.js';
import { type HoldingCashAdjustment, reconcileCashBalance } from './ledger.js';

export interface DecisionLedgerStateInput {
  readonly account: Account;
  readonly holdings: readonly Holding[];
  readonly trades: readonly Trade[];
  readonly holdingAdjustments: readonly HoldingCashAdjustment[];
  readonly cashFlows: readonly PortfolioCashFlow[];
  readonly corporateActions: readonly PortfolioCorporateAction[];
}

export interface DecisionLedgerState {
  readonly hash: string;
  readonly appendFrom: Date;
  readonly appendEligibility: 'eligible' | 'unavailable';
  readonly reasons: readonly string[];
}

export const decisionLedgerState = (input: DecisionLedgerStateInput): DecisionLedgerState => {
  const sorted = <T extends { readonly id: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== null && item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          account: {
            id: input.account.id,
            initialCapital: input.account.initialCapital,
            cashBalance: input.account.cashBalance,
            currency: input.account.currency,
            createdAt: input.account.createdAt,
          },
          holdings: sorted(input.holdings),
          trades: sorted(input.trades),
          holdingAdjustments: sorted(input.holdingAdjustments),
          cashFlows: sorted(input.cashFlows),
          corporateActions: sorted(input.corporateActions),
        }),
      ),
    )
    .digest('hex');
  const reconciliation = reconcileCashBalance(input.account, input);
  const reasons: string[] = [];
  if (!reconciliation.reconciled) reasons.push('现金余额与历史账本不一致');
  if (reconciliation.gaps.length > 0) reasons.push('持仓数量无法由已登记事实完整解释');
  const appendFrom = new Date(
    Math.max(
      input.account.createdAt.getTime(),
      ...input.trades.map((row) => row.executedAt.getTime()),
      ...input.holdingAdjustments.map((row) => row.occurredAt.getTime()),
      ...input.cashFlows.map((row) => row.occurredAt.getTime()),
      ...input.corporateActions.map((row) => row.occurredAt.getTime()),
    ),
  );
  return {
    hash,
    appendFrom,
    appendEligibility: reasons.length === 0 ? 'eligible' : 'unavailable',
    reasons,
  };
};
