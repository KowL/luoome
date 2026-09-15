import {
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
import type { InMemoryAccountRepository } from './account.js';
import type { InMemoryHoldingRepository } from './holding.js';
import type { InMemoryPortfolioCashFlowRepository } from './portfolio-performance.js';
import type { InMemoryTradeRepository } from './trade.js';

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly adjustments = new Map<string, HoldingCashAdjustment>();
  private lock: Promise<void> = Promise.resolve();
  constructor(
    private readonly account: InMemoryAccountRepository,
    private readonly trade: InMemoryTradeRepository,
    private readonly holding: InMemoryHoldingRepository,
    private readonly cashFlow: InMemoryPortfolioCashFlowRepository,
  ) {}

  async applyTrade(input: Parameters<LedgerRepository['applyTrade']>[0]): Promise<void> {
    await this.write(async () => {
      assertTradeInvariants(input.trade);
      assertHoldingInvariants(input.holding);
      await this.checkHolding(input.holding, input.previousHolding);
      if (
        input.trade.accountId !== input.holding.accountId ||
        input.trade.stockId !== input.holding.stockId
      ) {
        throw new InvariantError('交易与持仓归属不一致');
      }
      if (await this.trade.findById(input.trade.id))
        throw new InvariantError('交易已记录，不能重复结算现金');
      const account = await this.afterCash(input.trade.accountId, cashImpactOfTrade(input.trade));
      this.holding.put(input.holding);
      this.trade.put(input.trade);
      this.account.put(account);
    });
  }

  async applyHolding(input: Parameters<LedgerRepository['applyHolding']>[0]): Promise<void> {
    await this.write(async () => {
      assertHoldingInvariants(input.holding);
      await this.checkHolding(input.holding, input.previousHolding);
      const amount = cashImpactOfHoldingChange(input.previousHolding, input.holding);
      const account = await this.afterCash(input.holding.accountId, amount);
      const adjustment: HoldingCashAdjustment = {
        id: crypto.randomUUID(),
        accountId: input.holding.accountId,
        holdingId: input.holding.id,
        stockId: input.holding.stockId,
        amount,
        occurredAt: input.occurredAt,
        quantityDelta:
          activeHoldingQuantity(input.holding) - activeHoldingQuantity(input.previousHolding),
      };
      this.holding.put(input.holding);
      this.adjustments.set(adjustment.id, adjustment);
      this.account.put(account);
    });
  }

  async applyCashFlow(input: Parameters<LedgerRepository['applyCashFlow']>[0]): Promise<void> {
    await this.write(async () => {
      const flow = PortfolioCashFlowSchema.parse(input.flow);
      if (await this.cashFlow.findById(flow.id))
        throw new InvariantError('资金流水已记录，不能重复结算现金');
      const account = await this.afterCash(flow.accountId, cashImpactOfCashFlow(flow));
      if (account.currency !== flow.currency) throw new InvariantError('资金流水币种与账户不一致');
      this.cashFlow.put(flow);
      this.account.put(account);
    });
  }

  async listHoldingAdjustments(accountId: string): Promise<readonly HoldingCashAdjustment[]> {
    return [...this.adjustments.values()].filter((row) => row.accountId === accountId);
  }

  private async afterCash(accountId: string, delta: Money) {
    const account = await this.account.findById(accountId);
    if (account === null) throw new InvariantError('账户已不存在，请刷新后重试');
    const after = { ...account, cashBalance: applyCashDelta(account.cashBalance, delta) };
    assertAccountInvariants(after);
    return after;
  }

  private async checkHolding(holding: Holding, previous: Holding | null): Promise<void> {
    assertLedgerHoldingUnchanged(
      await this.holding.findByAccountAndStock(holding.accountId, holding.stockId),
      previous,
    );
    if (
      previous !== null &&
      (previous.id !== holding.id ||
        previous.accountId !== holding.accountId ||
        previous.stockId !== holding.stockId)
    ) {
      throw new InvariantError('持仓身份不能修改');
    }
  }

  private async write(action: () => Promise<void>): Promise<void> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await action();
    } finally {
      release();
    }
  }
}
