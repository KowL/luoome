import {
  type Account,
  assertAccountInvariants,
  assertHoldingInvariants,
  assertTradeInvariants,
  type LedgerRepository,
  PortfolioCashFlowSchema,
} from '@luoome/core';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { accounts, holdings, portfolioCashFlows, type Schema, trades } from '../../schema/index.js';

type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

/**
 * 账户事实的 Drizzle 实现：账户余额 + 交易/持仓/资金流水在**同一个 IMMEDIATE 事务**内提交。
 * 行结构与实体一致（可空 provenance 转 null），与各自的单表 repo 保持同一映射。
 */
export class DrizzleLedgerRepository implements LedgerRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async applyTrade(input: {
    readonly account: Account;
    readonly trade: import('@luoome/core').Trade;
    readonly holding: import('@luoome/core').Holding;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    assertTradeInvariants(input.trade);
    assertHoldingInvariants(input.holding);
    this.db.transaction(
      (tx: DrizzleTransaction) => {
        this.saveAccount(tx, input.account);
        this.saveHolding(tx, input.holding);
        this.saveTrade(tx, input.trade);
      },
      { behavior: 'immediate' },
    );
  }

  async applyHolding(input: {
    readonly account: Account;
    readonly holding: import('@luoome/core').Holding;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    assertHoldingInvariants(input.holding);
    this.db.transaction(
      (tx: DrizzleTransaction) => {
        this.saveAccount(tx, input.account);
        this.saveHolding(tx, input.holding);
      },
      { behavior: 'immediate' },
    );
  }

  async applyCashFlow(input: {
    readonly account: Account;
    readonly flow: import('@luoome/core').PortfolioCashFlow;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    const flow = PortfolioCashFlowSchema.parse(input.flow);
    this.db.transaction(
      (tx: DrizzleTransaction) => {
        this.saveAccount(tx, input.account);
        const row = { ...flow, stockId: flow.stockId ?? null, note: flow.note ?? null };
        tx.insert(portfolioCashFlows)
          .values(row)
          .onConflictDoUpdate({ target: portfolioCashFlows.id, set: row })
          .run();
      },
      { behavior: 'immediate' },
    );
  }

  private saveAccount(tx: DrizzleTransaction, account: Account): void {
    const row = {
      id: account.id,
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      initialCapital: account.initialCapital,
      cashBalance: account.cashBalance,
      createdAt: account.createdAt,
    };
    tx.insert(accounts).values(row).onConflictDoUpdate({ target: accounts.id, set: row }).run();
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
