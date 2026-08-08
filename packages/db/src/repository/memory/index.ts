import type {
  Account,
  Advice,
  AlertPlan,
  ChatMessage,
  ChatSession,
  DailyBar,
  Holding,
  Notification,
  Quote,
  Report,
  RepositoryRegistry,
  SignalObservation,
  Stock,
  StockEvent,
  Strategy,
  StrategyRunBundle,
  StrategySchedule,
  StrategyVersion,
  Trade,
  WatchRun,
  WatchTrigger,
  WorkflowRun,
} from '@luoome/core';
import { InMemoryAccountRepository } from './account.js';
import { InMemoryAdviceRepository } from './advice.js';
import { InMemoryAlertPlanRepository } from './alert-plan.js';
import { InMemoryChatRepository } from './chat.js';
import { InMemoryDailyBarRepository } from './daily-bar.js';
import { InMemoryHoldingRepository } from './holding.js';
import { InMemoryNotificationRepository } from './notification.js';
import { InMemoryQuoteRepository } from './quote.js';
import { InMemoryReportRepository } from './report.js';
import { InMemoryResearchIndexRepository } from './research-index.js';
import { InMemoryResearchVaultSyncRunRepository } from './research-vault-run.js';
import { InMemorySignalObservationRepository } from './signal-observation.js';
import { InMemoryStockRepository } from './stock.js';
import { InMemoryStockEventRepository } from './stock-event.js';
import { InMemoryStockUniverseRepository } from './stock-universe.js';
import { InMemoryStrategyRepository, InMemoryStrategyRunRepository } from './strategy.js';
import { InMemoryStrategyScheduleRepository } from './strategy-schedule.js';
import { InMemoryTradeRepository } from './trade.js';
import { InMemoryWatchRuleStateRepository } from './watch-rule-state.js';
import { InMemoryWatchRunRepository } from './watch-run.js';
import { InMemoryWatchTriggerRepository } from './watch-trigger.js';
import { InMemoryWatchlistMemberRepository, InMemoryWatchlistRepository } from './watchlist.js';
import { InMemoryWorkflowRunRepository } from './workflow-run.js';

export { InMemoryAccountRepository } from './account.js';
export { InMemoryAdviceRepository } from './advice.js';
export { InMemoryAlertPlanRepository } from './alert-plan.js';
export { InMemoryChatRepository } from './chat.js';
export { InMemoryDailyBarRepository } from './daily-bar.js';
export { InMemoryHoldingRepository } from './holding.js';
export { InMemoryNotificationRepository } from './notification.js';
export { InMemoryQuoteRepository } from './quote.js';
export { InMemoryReportRepository } from './report.js';
export { InMemoryResearchIndexRepository } from './research-index.js';
export { InMemoryResearchVaultSyncRunRepository } from './research-vault-run.js';
export { InMemorySignalObservationRepository } from './signal-observation.js';
export { InMemoryStockRepository } from './stock.js';
export { InMemoryStockEventRepository } from './stock-event.js';
export { InMemoryStockUniverseRepository } from './stock-universe.js';
export { InMemoryStrategyRepository, InMemoryStrategyRunRepository } from './strategy.js';
export { InMemoryStrategyScheduleRepository } from './strategy-schedule.js';
export { InMemoryTradeRepository } from './trade.js';
export { InMemoryWatchRuleStateRepository } from './watch-rule-state.js';
export { InMemoryWatchRunRepository } from './watch-run.js';
export { InMemoryWatchTriggerRepository } from './watch-trigger.js';
export { InMemoryWatchlistMemberRepository, InMemoryWatchlistRepository } from './watchlist.js';
export { InMemoryWorkflowRunRepository } from './workflow-run.js';

/** createInMemoryRepos 的可选种子数据（同步写入，含不变量断言）。 */
export interface InMemorySeed {
  readonly accounts?: readonly Account[];
  readonly stocks?: readonly Stock[];
  readonly holdings?: readonly Holding[];
  readonly trades?: readonly Trade[];
  readonly advices?: readonly Advice[];
  readonly chatSessions?: readonly ChatSession[];
  readonly chatMessages?: readonly ChatMessage[];
  readonly quotes?: readonly Quote[];
  readonly reports?: readonly Report[];
  readonly signalObservations?: readonly SignalObservation[];
  readonly dailyBars?: readonly DailyBar[];
  readonly strategies?: readonly Strategy[];
  readonly strategySchedules?: readonly StrategySchedule[];
  readonly strategyVersions?: readonly StrategyVersion[];
  readonly strategyRunBundles?: readonly StrategyRunBundle[];
  readonly notifications?: readonly Notification[];
  readonly alertPlans?: readonly AlertPlan[];
  readonly watchTriggers?: readonly WatchTrigger[];
  readonly watchRuns?: readonly WatchRun[];
  /** ruo 迁移起：可选预置公司事件 + workflow 运行。 */
  readonly stockEvents?: readonly StockEvent[];
  readonly workflowRuns?: readonly WorkflowRun[];
}

/** 构造全部 in-memory repository，可选灌入种子。 */
export const createInMemoryRepos = (seed?: InMemorySeed): RepositoryRegistry => {
  const account = new InMemoryAccountRepository();
  const stock = new InMemoryStockRepository();
  const stockUniverse = new InMemoryStockUniverseRepository(stock);
  const holding = new InMemoryHoldingRepository();
  const trade = new InMemoryTradeRepository();
  const advice = new InMemoryAdviceRepository();
  const report = new InMemoryReportRepository();
  const chat = new InMemoryChatRepository();
  const quote = new InMemoryQuoteRepository();
  const dailyBar = new InMemoryDailyBarRepository();
  const signalObservation = new InMemorySignalObservationRepository();
  const strategy = new InMemoryStrategyRepository();
  const strategySchedule = new InMemoryStrategyScheduleRepository();
  const strategyRun = new InMemoryStrategyRunRepository(strategy);
  const watchlist = new InMemoryWatchlistRepository();
  const watchlistMember = new InMemoryWatchlistMemberRepository(watchlist);
  const notification = new InMemoryNotificationRepository();
  // v0.6 起
  const alertPlan = new InMemoryAlertPlanRepository();
  const watchTrigger = new InMemoryWatchTriggerRepository();
  const watchRuleState = new InMemoryWatchRuleStateRepository();
  const watchRun = new InMemoryWatchRunRepository();
  // ruo 迁移起
  const researchIndex = new InMemoryResearchIndexRepository();
  const researchVaultSyncRun = new InMemoryResearchVaultSyncRunRepository();
  const stockEvent = new InMemoryStockEventRepository();
  const workflowRun = new InMemoryWorkflowRunRepository();
  if (seed !== undefined) {
    for (const a of seed.accounts ?? []) account.put(a);
    for (const s of seed.stocks ?? []) stock.put(s);
    for (const h of seed.holdings ?? []) holding.put(h);
    for (const t of seed.trades ?? []) trade.put(t);
    for (const adv of seed.advices ?? []) advice.put(adv);
    for (const r of seed.reports ?? []) report.put(r);
    for (const session of seed.chatSessions ?? []) chat.putSession(session);
    for (const message of seed.chatMessages ?? []) chat.putMessage(message);
    for (const q of seed.quotes ?? []) quote.put(q);
    for (const b of seed.dailyBars ?? []) dailyBar.put(b);
    for (const observation of seed.signalObservations ?? []) signalObservation.put(observation);
    for (const item of seed.strategies ?? []) void strategy.create(item);
    for (const item of seed.strategySchedules ?? []) strategySchedule.put(item);
    for (const item of seed.strategyVersions ?? []) void strategy.createVersion(item);
    for (const bundle of seed.strategyRunBundles ?? []) void strategyRun.commitRun(bundle);
    for (const n of seed.notifications ?? []) notification.put(n);
    for (const p of seed.alertPlans ?? []) void alertPlan.save(p);
    for (const t of seed.watchTriggers ?? []) watchTrigger.put(t);
    for (const r of seed.watchRuns ?? []) watchRun.put(r);
    for (const e of seed.stockEvents ?? []) stockEvent.put(e);
    for (const r of seed.workflowRuns ?? []) workflowRun.put(r);
  }
  return {
    account,
    stock,
    stockUniverse,
    holding,
    trade,
    advice,
    report,
    quote,
    dailyBar,
    signalObservation,
    strategy,
    strategySchedule,
    strategyRun,
    watchlist,
    watchlistMember,
    notification,
    alertPlan,
    watchTrigger,
    watchRuleState,
    watchRun,
    researchIndex,
    researchVaultSyncRun,
    stockEvent,
    workflowRun,
    chat,
  };
};
