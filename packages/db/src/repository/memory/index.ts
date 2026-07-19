import type {
  Account,
  Advice,
  DailyBar,
  Holding,
  Quote,
  RepositoryRegistry,
  Stock,
  Trade,
} from '@luoome/core';

import { InMemoryAccountRepository } from './account.js';
import { InMemoryAdviceRepository } from './advice.js';
import { InMemoryDailyBarRepository } from './daily-bar.js';
import { InMemoryHoldingRepository } from './holding.js';
import { InMemoryQuoteRepository } from './quote.js';
import { InMemoryStockRepository } from './stock.js';
import { InMemoryTradeRepository } from './trade.js';

export { InMemoryAccountRepository } from './account.js';
export { InMemoryAdviceRepository } from './advice.js';
export { InMemoryDailyBarRepository } from './daily-bar.js';
export { InMemoryHoldingRepository } from './holding.js';
export { InMemoryQuoteRepository } from './quote.js';
export { InMemoryStockRepository } from './stock.js';
export { InMemoryTradeRepository } from './trade.js';

/** createInMemoryRepos 的可选种子数据（同步写入，含不变量断言）。 */
export interface InMemorySeed {
  readonly accounts?: readonly Account[];
  readonly stocks?: readonly Stock[];
  readonly holdings?: readonly Holding[];
  readonly trades?: readonly Trade[];
  readonly advices?: readonly Advice[];
  /** v0.2 起：可选预置行情快照 / 日线缓存。 */
  readonly quotes?: readonly Quote[];
  readonly dailyBars?: readonly DailyBar[];
}

/** 构造 7 个 in-memory repository（v0.2 起含 quote + dailyBar），可选灌入种子数据。 */
export const createInMemoryRepos = (seed?: InMemorySeed): RepositoryRegistry => {
  const account = new InMemoryAccountRepository();
  const stock = new InMemoryStockRepository();
  const holding = new InMemoryHoldingRepository();
  const trade = new InMemoryTradeRepository();
  const advice = new InMemoryAdviceRepository();
  const quote = new InMemoryQuoteRepository();
  const dailyBar = new InMemoryDailyBarRepository();
  if (seed !== undefined) {
    for (const a of seed.accounts ?? []) account.put(a);
    for (const s of seed.stocks ?? []) stock.put(s);
    for (const h of seed.holdings ?? []) holding.put(h);
    for (const t of seed.trades ?? []) trade.put(t);
    for (const adv of seed.advices ?? []) advice.put(adv);
    for (const q of seed.quotes ?? []) quote.put(q);
    for (const b of seed.dailyBars ?? []) dailyBar.put(b);
  }
  return { account, stock, holding, trade, advice, quote, dailyBar };
};
