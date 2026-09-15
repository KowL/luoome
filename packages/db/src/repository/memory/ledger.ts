import {
  type Account,
  assertAccountInvariants,
  assertHoldingInvariants,
  assertTradeInvariants,
  type LedgerRepository,
  PortfolioCashFlowSchema,
} from '@luoome/core';

import type { InMemoryAccountRepository } from './account.js';
import type { InMemoryHoldingRepository } from './holding.js';
import type { InMemoryPortfolioCashFlowRepository } from './portfolio-performance.js';
import type { InMemoryTradeRepository } from './trade.js';

/**
 * 内存实现的账户事实原子写入：先校验全部不变量，再落库，
 * 避免半写状态（单线程同步写，校验通过后不会再失败）。
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  constructor(
    private readonly account: InMemoryAccountRepository,
    private readonly trade: InMemoryTradeRepository,
    private readonly holding: InMemoryHoldingRepository,
    private readonly cashFlow: InMemoryPortfolioCashFlowRepository,
  ) {}

  async applyTrade(input: {
    readonly account: Account;
    readonly trade: import('@luoome/core').Trade;
    readonly holding: import('@luoome/core').Holding;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    assertTradeInvariants(input.trade);
    assertHoldingInvariants(input.holding);
    this.trade.put(input.trade);
    this.holding.put(input.holding);
    this.account.put(input.account);
  }

  async applyHolding(input: {
    readonly account: Account;
    readonly holding: import('@luoome/core').Holding;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    assertHoldingInvariants(input.holding);
    this.holding.put(input.holding);
    this.account.put(input.account);
  }

  async applyCashFlow(input: {
    readonly account: Account;
    readonly flow: import('@luoome/core').PortfolioCashFlow;
  }): Promise<void> {
    assertAccountInvariants(input.account);
    const flow = PortfolioCashFlowSchema.parse(input.flow);
    await this.cashFlow.save(flow);
    this.account.put(input.account);
  }
}
