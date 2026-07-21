import type {
  Account,
  Advice,
  DailyBar,
  Holding,
  Notification,
  Quote,
  RepositoryRegistry,
  Stock,
  StockPool,
  Tactic,
  TacticSignal,
  Trade,
  WatchTrigger,
} from '@luoome/core';
import { BUILTIN_TACTICS } from '@luoome/core';
import { InMemoryAccountRepository } from './account.js';
import { InMemoryAdviceRepository } from './advice.js';
import { InMemoryDailyBarRepository } from './daily-bar.js';
import { InMemoryHoldingRepository } from './holding.js';
import { InMemoryNotificationRepository } from './notification.js';
import { InMemoryQuoteRepository } from './quote.js';
import { InMemoryStockRepository } from './stock.js';
import { InMemoryStockPoolRepository } from './stock-pool.js';
import { InMemoryTacticRepository } from './tactic.js';
import { InMemoryTradeRepository } from './trade.js';
import { InMemoryWatchTriggerRepository } from './watch-trigger.js';

export { InMemoryAccountRepository } from './account.js';
export { InMemoryAdviceRepository } from './advice.js';
export { InMemoryDailyBarRepository } from './daily-bar.js';
export { InMemoryHoldingRepository } from './holding.js';
export { InMemoryNotificationRepository } from './notification.js';
export { InMemoryQuoteRepository } from './quote.js';
export { InMemoryStockRepository } from './stock.js';
export { InMemoryStockPoolRepository } from './stock-pool.js';
export { InMemoryTacticRepository } from './tactic.js';
export { InMemoryTradeRepository } from './trade.js';
export { InMemoryWatchTriggerRepository } from './watch-trigger.js';

/** createInMemoryRepos 的可选种子数据（同步写入，含不变量断言）。 */
export interface InMemorySeed {
  readonly accounts?: readonly Account[];
  readonly stocks?: readonly Stock[];
  readonly holdings?: readonly Holding[];
  readonly trades?: readonly Trade[];
  readonly advices?: readonly Advice[];
  readonly quotes?: readonly Quote[];
  readonly dailyBars?: readonly DailyBar[];
  /** v0.3 起：可选预置战法定义 + 信号。 */
  readonly tactics?: readonly Tactic[];
  readonly tacticSignals?: readonly TacticSignal[];
  readonly notifications?: readonly Notification[];
  /** v0.6 起：可选预置股票池 + 触发。 */
  readonly stockPools?: readonly StockPool[];
  readonly watchTriggers?: readonly WatchTrigger[];
}

/** 构造 11 个 in-memory repository（v0.3 + v0.6 stockPool/watchTrigger），可选灌入种子。 */
export const createInMemoryRepos = (seed?: InMemorySeed): RepositoryRegistry => {
  const account = new InMemoryAccountRepository();
  const stock = new InMemoryStockRepository();
  const holding = new InMemoryHoldingRepository();
  const trade = new InMemoryTradeRepository();
  const advice = new InMemoryAdviceRepository();
  const quote = new InMemoryQuoteRepository();
  const dailyBar = new InMemoryDailyBarRepository();
  const tactic = new InMemoryTacticRepository();
  const notification = new InMemoryNotificationRepository();
  // v0.6 起
  const stockPool = new InMemoryStockPoolRepository();
  const watchTrigger = new InMemoryWatchTriggerRepository();
  if (seed !== undefined) {
    for (const a of seed.accounts ?? []) account.put(a);
    for (const s of seed.stocks ?? []) stock.put(s);
    for (const h of seed.holdings ?? []) holding.put(h);
    for (const t of seed.trades ?? []) trade.put(t);
    for (const adv of seed.advices ?? []) advice.put(adv);
    for (const q of seed.quotes ?? []) quote.put(q);
    for (const b of seed.dailyBars ?? []) dailyBar.put(b);
    for (const tc of seed.tactics ?? []) tactic.put(tc);
    for (const s of seed.tacticSignals ?? []) {
      void tactic.saveSignal(s);
    }
    for (const n of seed.notifications ?? []) notification.put(n);
    for (const p of seed.stockPools ?? []) stockPool.put(p);
    for (const t of seed.watchTriggers ?? []) watchTrigger.put(t);
  }
  // v0.3 起：默认灌入 5 个内置战法（即使 seed 没指定 tactics），让 list_tactics / run_tactic 默认可用
  for (const tc of BUILTIN_TACTICS) {
    if (tactic.findByIdSync(tc.id) === null) tactic.put(tc);
  }
  return {
    account,
    stock,
    holding,
    trade,
    advice,
    quote,
    dailyBar,
    tactic,
    notification,
    stockPool,
    watchTrigger,
  };
};
