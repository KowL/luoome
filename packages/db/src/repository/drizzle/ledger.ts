import {
  type Account,
  activeHoldingQuantity,
  applyCashDelta,
  assertAccountInvariants,
  assertHoldingInvariants,
  assertLedgerHoldingUnchanged,
  assertTradeInvariants,
  cashImpactOfCashFlow,
  cashImpactOfHoldingChange,
  cashImpactOfTrade,
  type Holding,
  type HoldingCashAdjustment,
  InvariantError,
  type LedgerRepository,
  type Money,
  PortfolioCashFlowSchema,
} from '@luoome/core';
import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
  accounts,
  holdingCashAdjustments,
  holdings,
  portfolioCashFlows,
  type Schema,
  trades,
} from '../../schema/index.js';

type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

export class DrizzleLedgerRepository implements LedgerRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async applyTrade(input: Parameters<LedgerRepository['applyTrade']>[0]): Promise<void> {
    assertTradeInvariants(input.trade);
    assertHoldingInvariants(input.holding);
    this.db.transaction(
      (tx) => {
        this.checkHolding(tx, input.holding, input.previousHolding);
        if (
          input.trade.accountId !== input.holding.accountId ||
          input.trade.stockId !== input.holding.stockId
        ) {
          throw new InvariantError('交易与持仓归属不一致');
        }
        if (tx.select().from(trades).where(eq(trades.id, input.trade.id)).get()) {
          throw new InvariantError('交易已记录，不能重复结算现金');
        }
        this.updateCash(tx, input.trade.accountId, cashImpactOfTrade(input.trade));
        this.saveHolding(tx, input.holding);
        this.saveTrade(tx, input.trade);
      },
      { behavior: 'immediate' },
    );
  }

  async applyHolding(input: Parameters<LedgerRepository['applyHolding']>[0]): Promise<void> {
    assertHoldingInvariants(input.holding);
    this.db.transaction(
      (tx) => {
        this.checkHolding(tx, input.holding, input.previousHolding);
        const amount = cashImpactOfHoldingChange(input.previousHolding, input.holding);
        this.updateCash(tx, input.holding.accountId, amount);
        this.saveHolding(tx, input.holding);
        tx.insert(holdingCashAdjustments)
          .values({
            id: crypto.randomUUID(),
            accountId: input.holding.accountId,
            holdingId: input.holding.id,
            stockId: input.holding.stockId,
            amount,
            quantityDelta:
              activeHoldingQuantity(input.holding) - activeHoldingQuantity(input.previousHolding),
            occurredAt: input.occurredAt,
          })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  async applyCashFlow(input: Parameters<LedgerRepository['applyCashFlow']>[0]): Promise<void> {
    const flow = PortfolioCashFlowSchema.parse(input.flow);
    this.db.transaction(
      (tx) => {
        if (tx.select().from(portfolioCashFlows).where(eq(portfolioCashFlows.id, flow.id)).get()) {
          throw new InvariantError('资金流水已记录，不能重复结算现金');
        }
        const account = this.account(tx, flow.accountId);
        if (account.currency !== flow.currency)
          throw new InvariantError('资金流水币种与账户不一致');
        this.updateCash(tx, flow.accountId, cashImpactOfCashFlow(flow));
        tx.insert(portfolioCashFlows)
          .values({ ...flow, stockId: flow.stockId ?? null, note: flow.note ?? null })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  async listHoldingAdjustments(accountId: string): Promise<readonly HoldingCashAdjustment[]> {
    return this.db
      .select()
      .from(holdingCashAdjustments)
      .where(eq(holdingCashAdjustments.accountId, accountId))
      .all();
  }

  private account(tx: DrizzleTransaction, accountId: string): Account {
    const account = tx.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (account === undefined) throw new InvariantError('账户已不存在，请刷新后重试');
    return account;
  }

  private updateCash(tx: DrizzleTransaction, accountId: string, delta: Money): void {
    const account = this.account(tx, accountId);
    const cashBalance = applyCashDelta(account.cashBalance, delta);
    assertAccountInvariants({ ...account, cashBalance });
    tx.update(accounts).set({ cashBalance }).where(eq(accounts.id, accountId)).run();
  }

  private checkHolding(tx: DrizzleTransaction, holding: Holding, previous: Holding | null): void {
    const actual =
      tx
        .select()
        .from(holdings)
        .where(
          and(eq(holdings.accountId, holding.accountId), eq(holdings.stockId, holding.stockId)),
        )
        .get() ?? null;
    assertLedgerHoldingUnchanged(actual, previous);
    if (
      previous !== null &&
      (previous.id !== holding.id ||
        previous.accountId !== holding.accountId ||
        previous.stockId !== holding.stockId)
    ) {
      throw new InvariantError('持仓身份不能修改');
    }
  }

  private saveHolding(tx: DrizzleTransaction, holding: import('@luoome/core').Holding): void {
    const row = {
      id: holding.id,
      accountId: holding.accountId,
      stockId: holding.stockId,
      quantity: holding.quantity,
      availableQuantity: holding.availableQuantity,
      avgCost: holding.avgCost,
      openedAt: holding.openedAt,
      closedAt: holding.closedAt,
    };
    tx.insert(holdings).values(row).onConflictDoUpdate({ target: holdings.id, set: row }).run();
  }

  private saveTrade(tx: DrizzleTransaction, trade: import('@luoome/core').Trade): void {
    const row = {
      id: trade.id,
      accountId: trade.accountId,
      stockId: trade.stockId,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      fee: trade.fee,
      executedAt: trade.executedAt,
      source: trade.source,
      adviceId: trade.adviceId ?? null,
      researchHypothesisVersionId: trade.researchHypothesisVersionId ?? null,
      strategyVersionId: trade.strategyVersionId ?? null,
      createdAt: trade.createdAt,
    };
    tx.insert(trades).values(row).onConflictDoUpdate({ target: trades.id, set: row }).run();
  }
}
