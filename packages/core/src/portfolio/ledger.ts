import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { Account } from '../entity/account.js';
import type { Holding } from '../entity/holding.js';
import type { PortfolioCashFlow, PortfolioCashFlowKind } from '../entity/portfolio-performance.js';
import type { Trade } from '../entity/trade.js';
import { InvariantError } from '../error/index.js';
import { type Money, MoneySchema, money } from '../types/branded.js';

/**
 * 账户现金与账本的关系（单一真源）。
 *
 * 现金是账户上保存的余额字段（Account.cashBalance），不是每次重算出来的投影；
 * 本模块只定义「一笔账本事实对现金的影响」，写路径（add_trade / add_holding /
 * update_holding / close_holding / 资金流水）与对账重算必须共用同一口径，
 * 否则字段与流水会各算各的。
 *
 * 口径（2026-09 产品决定）：
 * - 买卖按「数量 × 成交价」增减现金，**不计手续费**（fee 只作记录）；
 * - 持仓的任何改动都同步现金，按持仓成本差额结算
 *   （登记/加仓扣成本、减仓/平仓回成本）；
 * - 分红、送转等公司行为不自动改现金，由用户通过纠错修正。
 */

/** 交易对现金的影响：买入为负、卖出为正；不计手续费。 */
export const cashImpactOfTrade = (trade: Pick<Trade, 'side' | 'quantity' | 'price'>): Money => {
  const gross = money(trade.quantity * trade.price);
  return money(trade.side === 'buy' ? -gross : gross);
};

/** 资金流水对现金的影响：入金为正、出金为负。 */
export const cashImpactOfCashFlow = (flow: Pick<PortfolioCashFlow, 'kind' | 'amount'>): Money => {
  const signed: Readonly<Record<PortfolioCashFlowKind, number>> = {
    deposit: flow.amount,
    'transfer-in': flow.amount,
    dividend: flow.amount,
    withdrawal: -flow.amount,
    'transfer-out': -flow.amount,
    fee: -flow.amount,
    tax: -flow.amount,
  };
  return money(signed[flow.kind]);
};

/** 持仓成本（数量 × 成本价）；平仓/零数量记为 0。 */
export const holdingCost = (holding: Pick<Holding, 'quantity' | 'avgCost' | 'closedAt'>): Money =>
  holding.closedAt === null ? money(holding.quantity * holding.avgCost) : money(0);

/** 持仓改动对现金的影响：成本增加 → 现金减少（买入/登记/加仓），成本减少 → 现金回补。 */
export const cashImpactOfHoldingChange = (
  before: Pick<Holding, 'quantity' | 'avgCost' | 'closedAt'> | null,
  after: Pick<Holding, 'quantity' | 'avgCost' | 'closedAt'> | null,
): Money =>
  money((before === null ? 0 : holdingCost(before)) - (after === null ? 0 : holdingCost(after)));

/** 现金余额不允许为负：负现金意味着账本与事实已经对不上，先纠错再继续。 */
export const applyCashDelta = (cash: Money, delta: Money): Money => {
  const next = money(cash + delta);
  if (next < 0) {
    throw new InvariantError(
      `现金余额不足：当前 ${cash}，本次变动 ${delta}；请先核对资金流水或用纠错修正账户现金`,
    );
  }
  return next;
};

export const HoldingCashAdjustmentSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  holdingId: z.string().min(1),
  stockId: z.string().min(1),
  amount: MoneySchema,
  quantityDelta: z.number().int(),
  occurredAt: z.coerce.date(),
});
export type HoldingCashAdjustment = z.infer<typeof HoldingCashAdjustmentSchema>;

export const activeHoldingQuantity = (
  holding: Pick<Holding, 'quantity' | 'closedAt'> | null,
): number => (holding === null || holding.closedAt !== null ? 0 : holding.quantity);

/** 持仓在 tool 读取后可能被其它请求修改；拒绝过期计算，避免覆盖数量或重复结算成本。 */
export const assertLedgerHoldingUnchanged = (
  actual: Holding | null,
  expected: Holding | null,
): void => {
  const identity = (holding: Holding | null) =>
    holding === null
      ? null
      : [
          holding.id,
          holding.accountId,
          holding.stockId,
          holding.quantity,
          holding.availableQuantity,
          holding.avgCost,
          holding.openedAt.getTime(),
          holding.closedAt?.getTime() ?? null,
        ];
  if (JSON.stringify(identity(actual)) !== JSON.stringify(identity(expected))) {
    throw new InvariantError('持仓已被其它请求修改，请刷新后重试');
  }
};

export interface LedgerCoverageGap {
  readonly stockId: string;
  readonly holdingQuantity: number;
  /** 交易净额：正数=净买入，负数=净卖出。 */
  readonly tradedQuantity: number;
  /** 持仓多于交易与调整记录：数量缺口，不能猜测现金影响。 */
  readonly uncoveredQuantity: number;
  /** 交易与调整净数量多于持仓：存在未记录的持仓变化。 */
  readonly unmatchedTradeQuantity: number;
  /** 交易与调整合计为净卖出的数量。 */
  readonly oversoldQuantity: number;
}

/**
 * 持仓与交易、持仓调整的数量覆盖关系；缺口只用于解释，不自动改动现金。
 */
export const ledgerCoverage = (input: {
  readonly holdings: readonly Pick<Holding, 'stockId' | 'quantity' | 'closedAt'>[];
  readonly trades: readonly Pick<Trade, 'stockId' | 'side' | 'quantity'>[];
  readonly holdingAdjustments?: readonly Pick<HoldingCashAdjustment, 'stockId' | 'quantityDelta'>[];
}): readonly LedgerCoverageGap[] => {
  const heldByStock = new Map<string, number>();
  for (const holding of input.holdings) {
    if (holding.closedAt !== null) continue;
    heldByStock.set(holding.stockId, (heldByStock.get(holding.stockId) ?? 0) + holding.quantity);
  }
  const tradedByStock = new Map<string, number>();
  for (const trade of input.trades) {
    const signed = trade.side === 'buy' ? trade.quantity : -trade.quantity;
    tradedByStock.set(trade.stockId, (tradedByStock.get(trade.stockId) ?? 0) + signed);
  }
  const adjustedByStock = new Map<string, number>();
  for (const adjustment of input.holdingAdjustments ?? []) {
    adjustedByStock.set(
      adjustment.stockId,
      (adjustedByStock.get(adjustment.stockId) ?? 0) + adjustment.quantityDelta,
    );
  }
  const stockIds = [
    ...new Set([...heldByStock.keys(), ...tradedByStock.keys(), ...adjustedByStock.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  return stockIds.map((stockId) => {
    const holdingQuantity = heldByStock.get(stockId) ?? 0;
    const tradedQuantity = tradedByStock.get(stockId) ?? 0;
    const recordedQuantity = tradedQuantity + (adjustedByStock.get(stockId) ?? 0);
    return {
      stockId,
      holdingQuantity,
      tradedQuantity,
      uncoveredQuantity: Math.max(0, holdingQuantity - Math.max(0, recordedQuantity)),
      unmatchedTradeQuantity: Math.max(0, recordedQuantity - holdingQuantity),
      oversoldQuantity: Math.max(0, -recordedQuantity),
    };
  });
};

export interface LedgerReplayInput {
  readonly account: Pick<Account, 'id' | 'initialCapital'>;
  readonly trades: readonly Pick<Trade, 'stockId' | 'side' | 'quantity' | 'price'>[];
  readonly cashFlows: readonly Pick<PortfolioCashFlow, 'kind' | 'amount'>[];
  readonly holdingAdjustments: readonly HoldingCashAdjustment[];
  readonly holdings: readonly Pick<Holding, 'stockId' | 'quantity' | 'avgCost' | 'closedAt'>[];
}

/**
 * 按账本重算现金（对账基准，不是日常读写路径）。
 * 口径与写路径一致，不计手续费：
 *   初始资金 + 所有交易现金影响 + 所有资金流水 + 持久化的持仓现金调整。
 * 已卖出或关闭的持仓也能通过调整记录重放原始成本，不依赖剩余持仓反推。
 */
export const recomputeCashFromLedger = (input: LedgerReplayInput): Money => {
  let cash = money(input.account.initialCapital);
  for (const trade of input.trades) {
    cash = money(cash + cashImpactOfTrade(trade));
  }
  for (const flow of input.cashFlows) {
    cash = money(cash + cashImpactOfCashFlow(flow));
  }
  for (const adjustment of input.holdingAdjustments) {
    cash = money(cash + adjustment.amount);
  }
  return cash;
};

/** 对账结果：字段与账本是否一致，差额是多少。 */
export interface CashReconciliation {
  readonly accountId: string;
  readonly stored: Money;
  readonly recomputed: Money;
  readonly difference: Money;
  readonly reconciled: boolean;
  /** 交易与持仓调整仍未覆盖的数量缺口，用于解释差额来源。 */
  readonly gaps: readonly LedgerCoverageGap[];
}

export const reconcileCashBalance = (
  account: Pick<Account, 'id' | 'cashBalance'>,
  ledger: LedgerReplayInput,
): CashReconciliation => {
  const recomputed = recomputeCashFromLedger(ledger);
  const difference = money(account.cashBalance - recomputed);
  return {
    accountId: account.id,
    stored: account.cashBalance,
    recomputed,
    difference,
    reconciled: difference === 0,
    gaps: ledgerCoverage(ledger).filter(
      (gap) =>
        gap.uncoveredQuantity > 0 || gap.unmatchedTradeQuantity > 0 || gap.oversoldQuantity > 0,
    ),
  };
};

/**
 * 账户事实指纹：持仓集合 + 现金 + 初始资金。用于替代快照版本号，
 * 让「基于哪一版账户事实生成的计划」可判定失效（账本一变，指纹就变）。
 */
export const accountFactsDigest = (input: {
  readonly account: Pick<Account, 'id' | 'initialCapital' | 'cashBalance'>;
  readonly holdings: readonly Pick<
    Holding,
    'stockId' | 'quantity' | 'availableQuantity' | 'avgCost' | 'closedAt'
  >[];
}): string => {
  const payload = {
    accountId: input.account.id,
    initialCapital: input.account.initialCapital,
    cashBalance: input.account.cashBalance,
    holdings: [...input.holdings]
      .map((holding) => ({
        stockId: holding.stockId,
        quantity: holding.quantity,
        availableQuantity: holding.availableQuantity,
        avgCost: holding.avgCost,
        closed: holding.closedAt !== null,
      }))
      .sort((left, right) => left.stockId.localeCompare(right.stockId)),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};
