import { InvariantError, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from './client.js';
import {
  makeAccount,
  makeAdvice,
  makeHolding,
  makeStock,
  makeTrade,
} from './repository/contract-tests.js';
import { createInMemoryRepos } from './repository/memory/index.js';
import { type SeedData, seedData } from './seed.js';

const fixtures: SeedData = {
  accounts: [makeAccount('acc-1')],
  stocks: [makeStock('stk-1', '002594', { name: '比亚迪' })],
  holdings: [makeHolding('h-1')],
  trades: [makeTrade('t-1')],
  advices: [makeAdvice('adv-1')],
};

describe('seedData', () => {
  it('in-memory repos：全部 fixture 落库可查', async () => {
    const repos = createInMemoryRepos();
    await seedData(repos, fixtures);
    expect(await repos.account.list()).toHaveLength(1);
    expect(await repos.stock.findByCode('002594')).not.toBeNull();
    expect(await repos.holding.listByAccount('acc-1')).toHaveLength(1);
    expect(await repos.trade.listByAccount('acc-1')).toHaveLength(1);
    expect(await repos.advice.findById('adv-1')).not.toBeNull();
  });

  it('drizzle repos：全部 fixture 落库可查', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await seedData(handle.repos, fixtures);
      expect(await handle.repos.account.list()).toHaveLength(1);
      expect(await handle.repos.stock.findByCode('002594')).not.toBeNull();
      expect(await handle.repos.holding.listByAccount('acc-1')).toHaveLength(1);
      expect(await handle.repos.trade.listByAccount('acc-1')).toHaveLength(1);
      expect(await handle.repos.advice.findById('adv-1')).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  it('空 fixtures 不报错；缺省字段跳过', async () => {
    const repos = createInMemoryRepos();
    await seedData(repos, {});
    expect(await repos.account.list()).toHaveLength(0);
  });

  it('fixture 违反不变量时抛出（不静默吞错）', async () => {
    const repos = createInMemoryRepos();
    const bad: SeedData = {
      holdings: [makeHolding('h-bad', { avgCost: money(1), availableQuantity: 10, quantity: 1 })],
    };
    await expect(seedData(repos, bad)).rejects.toThrow(InvariantError);
  });
});
