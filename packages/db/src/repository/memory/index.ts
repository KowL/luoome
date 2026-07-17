import type { Account, Advice, Holding, RepositoryRegistry, Stock, Trade } from '@luoome/core';

import { InMemoryAccountRepository } from './account.js';
import { InMemoryAdviceRepository } from './advice.js';
import { InMemoryHoldingRepository } from './holding.js';
import { InMemoryStockRepository } from './stock.js';
import { InMemoryTradeRepository } from './trade.js';

export { InMemoryAccountRepository } from './account.js';
export { InMemoryAdviceRepository } from './advice.js';
export { InMemoryHoldingRepository } from './holding.js';
export { InMemoryStockRepository } from './stock.js';
export { InMemoryTradeRepository } from './trade.js';

/** createInMemoryRepos 的可选种子数据（同步写入，含不变量断言）。 */
export interface InMemorySeed {
  readonly accounts?: readonly Account[];
  readonly stocks?: readonly Stock[];
  readonly holdings?: readonly Holding[];
  readonly trades?: readonly Trade[];
  readonly advices?: readonly Advice[];
}

/** 构造 5 个 in-memory repository，可选灌入种子数据（供测试与 tools 单测）。 */
export const createInMemoryRepos = (seed?: InMemorySeed): RepositoryRegistry => {
  const account = new InMemoryAccountRepository();
  const stock = new InMemoryStockRepository();
  const holding = new InMemoryHoldingRepository();
  const trade = new InMemoryTradeRepository();
  const advice = new InMemoryAdviceRepository();
  if (seed !== undefined) {
    for (const a of seed.accounts ?? []) account.put(a);
    for (const s of seed.stocks ?? []) stock.put(s);
    for (const h of seed.holdings ?? []) holding.put(h);
    for (const t of seed.trades ?? []) trade.put(t);
    for (const adv of seed.advices ?? []) advice.put(adv);
  }
  return { account, stock, holding, trade, advice };
};
