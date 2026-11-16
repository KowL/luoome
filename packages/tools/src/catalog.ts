import type { Tool } from './define-tool.js';
import { getAccountFactsTool, reconcileAccountCashTool } from './tools/account-facts.js';
import { addHoldingTool } from './tools/add-holding.js';
import { addTradeTool } from './tools/add-trade.js';
import {
  createAlertPlanTool,
  deleteAlertPlanTool,
  listAlertPlansTool,
  updateAlertPlanTool,
} from './tools/alert-plan.js';
import { analyzePositionTool } from './tools/analyze-position.js';
import { analyzeStockTool } from './tools/analyze-stock.js';
import { analyzeStrategyCandidateTool } from './tools/analyze-strategy-candidate.js';
import { backfillStrategyObservationCandidatesTool } from './tools/backfill-strategy-observation-candidates.js';
import { batchQuoteTool } from './tools/batch-quote.js';
import {
  appendChatMessageTool,
  createChatSessionTool,
  deleteChatSessionTool,
  getChatSessionTool,
  listChatSessionsTool,
  renameChatSessionTool,
} from './tools/chat-session.js';
import { closeHoldingTool } from './tools/close-holding.js';
import { computeIndicatorsTool } from './tools/compute-indicators.js';
import { createAccountTool } from './tools/create-account.js';
import { createStrategyObservationCandidatesTool } from './tools/create-strategy-observation-candidates.js';
import { listDecisionReviewsTool, saveDecisionReviewTool } from './tools/decision-review.js';
import { deleteAdviceTool } from './tools/delete-advice.js';
import { deleteReportTool } from './tools/delete-report.js';
import { dragonTigerListTool } from './tools/dragon-tiger.js';
import { dragonTigerFlowTool } from './tools/dragon-tiger-flow.js';
import { fetchIndexQuotesTool } from './tools/fetch-index-quotes.js';
import { fetchIntradayMinutesTool } from './tools/fetch-intraday-minutes.js';
import { fetchQuoteTool } from './tools/fetch-quote.js';
import { getAccountTool } from './tools/get-account.js';
import { getAccountOverviewTool } from './tools/get-account-overview.js';
import { getAdviceTool } from './tools/get-advice.js';
import { getAdviceStatsTool } from './tools/get-advice-stats.js';
import { getAShareSentimentTool } from './tools/get-ashare-sentiment.js';
import { getConfidenceCalibrationTool } from './tools/get-confidence-calibration.js';
import { getDecisionLoopReviewTool } from './tools/get-decision-loop-review.js';
import { getHoldingTool } from './tools/get-holding.js';
import { getMarketDataStatusTool } from './tools/get-market-data-status.js';
import { getPreviousClosesTool } from './tools/get-previous-closes.js';
import { getReportTool } from './tools/get-report.js';
import { getStockMarketViewTool } from './tools/get-stock-market-view.js';
import { getStockMinuteBarsTool } from './tools/get-stock-minute-bars.js';
import { getStockSectorMembershipsTool } from './tools/get-stock-sector-memberships.js';
import { getStockUniverseStatusTool } from './tools/get-stock-universe-status.js';
import { getStrategyDecisionCyclesTool } from './tools/get-strategy-decision-cycles.js';
import { getStrategyReliabilitySummaryTool } from './tools/get-strategy-reliability-summary.js';
import { getStrategySignalsTool } from './tools/get-strategy-signals.js';
import { getWatchStatusTool } from './tools/get-watch-status.js';
import { limitUpLadderCompareTool, limitUpLadderTool } from './tools/limit-up-ladder.js';
import { limitUpMarketTool } from './tools/limit-up-market.js';
import { listAccountsTool } from './tools/list-accounts.js';
import { listHoldingsTool } from './tools/list-holdings.js';
import { listReportsTool } from './tools/list-reports.js';
import { listTradesTool } from './tools/list-trades.js';
import { listWatchPlansTool } from './tools/list-watch-plans.js';
import {
  listWatchTriggersTool,
  resolveWatchNotificationTool,
} from './tools/list-watch-triggers.js';
import { listWorkflowRunsTool } from './tools/list-workflow-runs.js';
import { marketOutlookTool } from './tools/market-outlook.js';
import { getMarketRoomAmountDistributionTool } from './tools/market-room-amount-distribution.js';
import { getMarketRoomCoreStocksTool } from './tools/market-room-core-stocks.js';
import { listMarketRoomEventsTool } from './tools/market-room-events.js';
import { getMarketRoomOverviewTool } from './tools/market-room-overview.js';
import { getMarketRoomSectorDetailTool } from './tools/market-room-sector-detail.js';
import { getMarketRoomSectorsTool } from './tools/market-room-sectors.js';
import {
  collectMarketSnapshotTool,
  getMarketSnapshotBatchTool,
} from './tools/market-snapshot-batch.js';
import { fetchNewsTool } from './tools/news.js';
import { northboundFlowTool } from './tools/northbound-flow.js';
import {
  auditPortfolioPerformanceSnapshotsTool,
  createPortfolioCashFlowTool,
  createPortfolioCorporateActionTool,
  getAccountPerformanceTool,
  listPortfolioPerformanceSnapshotsTool,
} from './tools/portfolio-performance.js';
import { pruneStrategyHistoryTool } from './tools/prune-strategy-history.js';
import { reconcileStaleStrategyRunsTool } from './tools/reconcile-stale-strategy-runs.js';
import { reconcileStaleWorkflowRunsTool } from './tools/reconcile-stale-workflow-runs.js';
import { recordWorkflowRunTool } from './tools/record-workflow-run.js';
import { renderReportTool } from './tools/render-report.js';
import {
  createResearchDocumentTool,
  getResearchDocumentTool,
  listResearchDocumentsTool,
  searchResearchDocumentsTool,
  syncResearchVaultTool,
} from './tools/research-vault.js';
import { runStrategyTool, trialStrategyTool } from './tools/run-strategy.js';
import { runStrategyBacktestTool } from './tools/run-strategy-backtest.js';
import { saveAlertPlanTool } from './tools/save-alert-plan.js';
import { saveReportTool } from './tools/save-report.js';
import { saveResearchDocumentTool } from './tools/save-research-document.js';
import { saveStrategyVersionTool } from './tools/save-strategy-version.js';
import { saveWatchTriggerTool } from './tools/save-watch-trigger.js';
import { searchStocksTool } from './tools/search-stocks.js';
import { fetchSectorQuotesTool } from './tools/sector-quote.js';
import { sendNotificationTool } from './tools/send-notification.js';
import { setReportDeliveryStatusTool } from './tools/set-report-delivery-status.js';
import { setWatchTriggerFeedbackTool } from './tools/set-watch-trigger-feedback.js';
import { settleChatDraftTool } from './tools/settle-chat-draft.js';
import {
  completeStrategyObservationsTool,
  getSignalObservationStatsTool,
  listPendingStrategyObservationsTool,
} from './tools/signal-observation.js';
import {
  createStrictStrategyBacktestTool,
  executeStrictStrategyBacktestTool,
  getStrictStrategyBacktestTool,
  listStrictStrategyBacktestsTool,
} from './tools/strategy-backtest.js';
import {
  compareStrategyDefinitionsTool,
  proposeStrategyVersionDraftTool,
  trialStrategyVersionTool,
} from './tools/strategy-definition.js';
import { getStrategyDslCatalogTool } from './tools/strategy-experiment.js';
import {
  generateStrategyInsightTool,
  getStrategyInsightFactsTool,
} from './tools/strategy-insight.js';
import {
  archiveStrategyTool,
  createStrategyTool,
  createStrategyVersionTool,
  deleteStrategyTool,
  getStrategyTool,
  listStrategiesTool,
  pauseStrategyTool,
  publishStrategyVersionTool,
  resumeStrategyTool,
  validateStrategyVersionTool,
} from './tools/strategy-lifecycle.js';
import { generateStrategyVersionProposalTool } from './tools/strategy-proposal.js';
import {
  compareStrategyRunsTool,
  getStrategyRunTool,
  getStrategyWorkspaceTool,
  listStrategyResultViewsTool,
  listStrategyRunsTool,
  strategySignalsByStockTool,
} from './tools/strategy-query.js';
import { updateStrategyScheduleTool } from './tools/strategy-schedule.js';
import {
  listStrategyWatchlistSubscriptionsTool,
  subscribeStrategyToWatchlistTool,
  syncStrategyWatchlistSubscriptionsTool,
  unsubscribeStrategyFromWatchlistTool,
} from './tools/strategy-watchlist-subscription.js';
import { syncDailyBarsTool } from './tools/sync-daily-bars.js';
import { syncLimitUpBoardHistoryTool } from './tools/sync-limit-up-board-history.js';
import { syncMarketDumpTool } from './tools/sync-market-dump.js';
import { syncQuotesTool } from './tools/sync-quotes.js';
import { syncSectorCatalogTool } from './tools/sync-sector-catalog.js';
import { syncStockUniverseTool } from './tools/sync-stock-universe.js';
import {
  evaluateTradingPlanBudgetTool,
  getTradingPlanTool,
  listTradingPlansTool,
  saveTradingPlanTool,
} from './tools/trading-plan.js';
import { updateAccountTool } from './tools/update-account.js';
import { updateHoldingTool } from './tools/update-holding.js';
import { updateWatchlistMembersTool } from './tools/update-watchlist-members.js';
import {
  addWatchlistMembersTool,
  addWatchlistMemberTool,
  archiveWatchlistMemberTool,
  archiveWatchlistTool,
  createWatchlistTool,
  getWatchlistTool,
  listWatchlistChangesTool,
  listWatchlistsTool,
  syncWatchlistSourceTool,
  updateWatchlistMemberTool,
  updateWatchlistTool,
} from './tools/watchlist.js';
import {
  beginWatchDeliveryTool,
  commitWatchEvaluationTool,
  getWatchTriggerDeliveryStatsTool,
  listWatchDeliveryRetriesTool,
  listWatchRuleStatesTool,
  saveWatchRuleStatesTool,
  setWatchTriggerDeliveryStatusTool,
} from './tools/workflow-operations.js';

export type ToolDependency =
  | `market:${string}`
  | 'llm'
  | 'researchVault'
  | 'sectorCatalog'
  | 'limitUpLadder'
  | 'limitUpMarket'
  | 'dragonTiger'
  | 'dragonTigerFlow'
  | 'northboundFlow'
  | 'news'
  | 'sectorQuote'
  | 'ashareSentiment'
  | 'stockUniverse'
  | 'marketDump'
  | 'limitUp';

export type ToolOwner =
  | 'shared-query'
  | `platform.${'chat' | 'audit'}`
  | `business.${string}`
  | `task.${string}`;

type CatalogEntry = {
  readonly owner: ToolOwner;
  readonly execution?: 'p1' | 'p2' | 'p3';
  readonly optionalPlugins?: readonly import('@luoome/core').ManagedPluginId[];
  readonly modes?: Readonly<
    Record<string, { readonly data: readonly string[]; readonly conditional?: readonly string[] }>
  >;
} & (
  | { readonly tool: Tool; readonly agent: true; readonly dependencies: readonly ToolDependency[] }
  | {
      readonly tool: Tool;
      readonly agent: false;
      readonly dependencies?: readonly ToolDependency[];
    }
);

// Catalog membership supplies inventory, never permission to execute a tool.
export const toolCatalog = {
  get_account_overview: {
    owner: 'shared-query',
    tool: getAccountOverviewTool,
    agent: true,
    dependencies: [],
  },
  list_trades: { owner: 'shared-query', tool: listTradesTool, agent: true, dependencies: [] },
  get_advice: { owner: 'shared-query', tool: getAdviceTool, agent: true, dependencies: [] },
  save_decision_review: {
    owner: 'business.review',
    tool: saveDecisionReviewTool,
    agent: true,
    dependencies: [],
  },
  analyze_stock: {
    execution: 'p3',
    modes: {
      stock: { data: ['llm', 'market:quote', 'market:daily-bars'] },
      market: { data: ['market-outlook:inputs'] },
      'strategy-candidate': { data: ['strategy-candidate:inputs'] },
    },
    owner: 'business.analysis',
    tool: analyzeStockTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  analyze_position: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: analyzePositionTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  save_trading_plan: {
    owner: 'business.portfolio',
    tool: saveTradingPlanTool,
    agent: true,
    dependencies: [],
  },
  fetch_quote: {
    owner: 'business.market-data',
    tool: fetchQuoteTool,
    agent: true,
    dependencies: ['market:quote'],
  },
  fetch_index_quotes: {
    owner: 'business.market-data',
    tool: fetchIndexQuotesTool,
    agent: true,
    dependencies: ['market:realtime-index'],
  },
  search_stocks: {
    owner: 'business.market-data',
    tool: searchStocksTool,
    agent: true,
    dependencies: [],
  },
  compute_indicators: {
    owner: 'business.market-data',
    tool: computeIndicatorsTool,
    agent: true,
    dependencies: [],
  },
  list_strategies: {
    owner: 'shared-query',
    tool: listStrategiesTool,
    agent: true,
    dependencies: [],
  },
  get_strategy: { owner: 'shared-query', tool: getStrategyTool, agent: true, dependencies: [] },
  save_strategy_version: {
    owner: 'business.strategy',
    tool: saveStrategyVersionTool,
    agent: true,
    dependencies: [],
  },
  run_strategy: {
    modes: {
      scan: { data: ['live:strategy-rule-inputs'], conditional: ['live:limit-up-ladder'] },
      scheduled: {
        data: ['local:daily-bars', 'local:stock-universe'],
        conditional: ['live:limit-up-ladder'],
      },
      replay: {
        data: ['local:daily-bars', 'local:stock-universe'],
        conditional: ['archive:limit-up-ladder', 'archive:limit-up-board'],
      },
    },
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: runStrategyTool,
    agent: true,
    dependencies: [],
  },
  get_account_performance: {
    owner: 'business.portfolio',
    tool: getAccountPerformanceTool,
    agent: true,
    dependencies: [],
  },
  run_strategy_backtest: {
    owner: 'business.strategy',
    tool: runStrategyBacktestTool,
    agent: true,
    dependencies: [],
  },
  get_strategy_signals: {
    owner: 'shared-query',
    tool: getStrategySignalsTool,
    agent: true,
    dependencies: [],
  },
  list_watchlists: {
    owner: 'shared-query',
    tool: listWatchlistsTool,
    agent: true,
    dependencies: [],
  },
  get_watchlist: { owner: 'shared-query', tool: getWatchlistTool, agent: true, dependencies: [] },
  create_watchlist: {
    owner: 'business.watch',
    tool: createWatchlistTool,
    agent: true,
    dependencies: [],
  },
  update_watchlist_members: {
    owner: 'business.watch',
    tool: updateWatchlistMembersTool,
    agent: true,
    dependencies: [],
  },
  list_watch_plans: {
    owner: 'shared-query',
    tool: listWatchPlansTool,
    agent: true,
    dependencies: [],
  },
  save_alert_plan: {
    owner: 'business.watch',
    tool: saveAlertPlanTool,
    agent: true,
    dependencies: [],
  },
  limit_up_ladder: {
    owner: 'shared-query',
    tool: limitUpLadderTool,
    agent: true,
    dependencies: ['limitUpLadder'],
  },
  limit_up_market: {
    owner: 'shared-query',
    tool: limitUpMarketTool,
    agent: true,
    dependencies: ['limitUpMarket'],
  },
  dragon_tiger_list: {
    owner: 'shared-query',
    tool: dragonTigerListTool,
    agent: true,
    dependencies: ['dragonTiger'],
  },
  dragon_tiger_flow: {
    owner: 'shared-query',
    tool: dragonTigerFlowTool,
    agent: true,
    dependencies: ['dragonTigerFlow'],
  },
  northbound_flow: {
    owner: 'shared-query',
    tool: northboundFlowTool,
    agent: true,
    dependencies: ['northboundFlow'],
  },
  fetch_news: {
    owner: 'business.market-data',
    tool: fetchNewsTool,
    agent: true,
    dependencies: ['news'],
  },
  save_research_document: {
    owner: 'business.research',
    tool: saveResearchDocumentTool,
    agent: true,
    dependencies: ['researchVault'],
  },
  fetch_sector_quotes: {
    owner: 'business.market-data',
    tool: fetchSectorQuotesTool,
    agent: true,
    dependencies: ['sectorQuote'],
  },
  add_trade: { owner: 'business.portfolio', tool: addTradeTool, agent: true, dependencies: [] },
  update_holding: {
    owner: 'business.portfolio',
    tool: updateHoldingTool,
    agent: true,
    dependencies: [],
  },
  search_research_documents: {
    owner: 'shared-query',
    tool: searchResearchDocumentsTool,
    agent: true,
    dependencies: ['researchVault'],
  },
  get_stock_market_view: {
    owner: 'business.portfolio',
    tool: getStockMarketViewTool,
    agent: true,
    dependencies: ['market:quote', 'market:daily-bars', 'market:intraday-minutes'],
  },
  collect_market_snapshot: {
    execution: 'p2',
    owner: 'task.collect-market-snapshot',
    tool: collectMarketSnapshotTool,
    agent: true,
    dependencies: ['market:market-snapshot-envelope'],
  },
  get_market_snapshot_batch: {
    owner: 'shared-query',
    tool: getMarketSnapshotBatchTool,
    agent: true,
    dependencies: [],
  },
  get_market_room_overview: {
    owner: 'business.portfolio',
    tool: getMarketRoomOverviewTool,
    agent: true,
    dependencies: [],
  },
  get_market_room_sectors: {
    owner: 'shared-query',
    tool: getMarketRoomSectorsTool,
    agent: true,
    dependencies: [],
  },
  get_stock_sector_memberships: {
    owner: 'shared-query',
    tool: getStockSectorMembershipsTool,
    agent: true,
    dependencies: [],
  },
  sync_sector_catalog: {
    execution: 'p2',
    owner: 'task.sync-sector-catalog',
    tool: syncSectorCatalogTool,
    agent: true,
    dependencies: ['sectorCatalog'],
  },
  get_market_room_amount_distribution: {
    owner: 'shared-query',
    tool: getMarketRoomAmountDistributionTool,
    agent: true,
    dependencies: [],
  },
  get_market_room_core_stocks: {
    owner: 'shared-query',
    tool: getMarketRoomCoreStocksTool,
    agent: true,
    dependencies: [],
  },
  get_market_room_sector_detail: {
    owner: 'shared-query',
    tool: getMarketRoomSectorDetailTool,
    agent: true,
    dependencies: [],
  },
  list_market_room_events: {
    owner: 'shared-query',
    tool: listMarketRoomEventsTool,
    agent: true,
    dependencies: [],
  },
  prune_strategy_history: {
    owner: 'business.strategy',
    tool: pruneStrategyHistoryTool,
    agent: true,
    dependencies: [],
  },
  add_holding: { owner: 'business.portfolio', tool: addHoldingTool, agent: false },
  add_watchlist_member: { owner: 'business.watch', tool: addWatchlistMemberTool, agent: false },
  add_watchlist_members: { owner: 'business.watch', tool: addWatchlistMembersTool, agent: false },
  analyze_strategy_candidate: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: analyzeStrategyCandidateTool,
    agent: false,
    dependencies: ['llm'],
  },
  append_chat_message: { owner: 'platform.chat', tool: appendChatMessageTool, agent: false },
  archive_strategy: { owner: 'business.strategy', tool: archiveStrategyTool, agent: false },
  archive_watchlist_member: {
    owner: 'business.watch',
    tool: archiveWatchlistMemberTool,
    agent: false,
  },
  archive_watchlist: { owner: 'business.watch', tool: archiveWatchlistTool, agent: false },
  audit_account_performance_snapshots: {
    owner: 'shared-query',
    tool: auditPortfolioPerformanceSnapshotsTool,
    agent: false,
  },
  backfill_strategy_observation_candidates: {
    owner: 'business.strategy',
    tool: backfillStrategyObservationCandidatesTool,
    agent: false,
  },
  batch_quote: { owner: 'business.market-data', tool: batchQuoteTool, agent: false },
  begin_watch_delivery: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: beginWatchDeliveryTool,
    agent: false,
  },
  close_holding: { owner: 'business.portfolio', tool: closeHoldingTool, agent: false },
  commit_watch_evaluation: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: commitWatchEvaluationTool,
    agent: false,
  },
  compare_strategy_definitions: {
    owner: 'shared-query',
    tool: compareStrategyDefinitionsTool,
    agent: false,
  },
  compare_strategy_runs: { owner: 'shared-query', tool: compareStrategyRunsTool, agent: false },
  complete_strategy_observations: {
    owner: 'business.strategy',
    tool: completeStrategyObservationsTool,
    agent: false,
  },
  create_account: { owner: 'business.portfolio', tool: createAccountTool, agent: false },
  create_alert_plan: { owner: 'business.watch', tool: createAlertPlanTool, agent: false },
  create_chat_session: { owner: 'platform.chat', tool: createChatSessionTool, agent: false },
  create_portfolio_cash_flow: {
    owner: 'business.portfolio',
    tool: createPortfolioCashFlowTool,
    agent: false,
  },
  create_portfolio_corporate_action: {
    owner: 'business.portfolio',
    tool: createPortfolioCorporateActionTool,
    agent: false,
  },
  create_research_document: {
    owner: 'business.research',
    tool: createResearchDocumentTool,
    agent: false,
  },
  create_strategy: { owner: 'business.strategy', tool: createStrategyTool, agent: false },
  create_strategy_observation_candidates: {
    owner: 'business.strategy',
    tool: createStrategyObservationCandidatesTool,
    agent: false,
  },
  create_strategy_version: {
    owner: 'business.strategy',
    tool: createStrategyVersionTool,
    agent: false,
  },
  create_strict_strategy_backtest: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: createStrictStrategyBacktestTool,
    agent: false,
  },
  delete_advice: { owner: 'business.portfolio', tool: deleteAdviceTool, agent: false },
  delete_alert_plan: { owner: 'business.watch', tool: deleteAlertPlanTool, agent: false },
  delete_chat_session: { owner: 'platform.chat', tool: deleteChatSessionTool, agent: false },
  delete_report: { owner: 'business.report', tool: deleteReportTool, agent: false },
  delete_strategy: { owner: 'business.strategy', tool: deleteStrategyTool, agent: false },
  evaluate_trading_plan_budget: {
    owner: 'shared-query',
    tool: evaluateTradingPlanBudgetTool,
    agent: false,
  },
  execute_strict_strategy_backtest: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: executeStrictStrategyBacktestTool,
    agent: false,
  },
  fetch_intraday_minutes: {
    owner: 'business.market-data',
    tool: fetchIntradayMinutesTool,
    agent: false,
  },
  generate_strategy_insight: {
    execution: 'p1',
    optionalPlugins: ['strategy.ai-insight'],
    owner: 'business.strategy-insight',
    tool: generateStrategyInsightTool,
    agent: false,
  },
  generate_strategy_version_proposal: {
    owner: 'business.strategy',
    tool: generateStrategyVersionProposalTool,
    agent: false,
  },
  get_ashare_sentiment: {
    owner: 'business.market-data',
    tool: getAShareSentimentTool,
    agent: false,
  },
  get_account_facts: { owner: 'shared-query', tool: getAccountFactsTool, agent: false },
  get_account: { owner: 'shared-query', tool: getAccountTool, agent: false },
  get_advice_stats: { owner: 'shared-query', tool: getAdviceStatsTool, agent: false },
  get_chat_session: { owner: 'shared-query', tool: getChatSessionTool, agent: false },
  get_confidence_calibration: {
    owner: 'shared-query',
    tool: getConfidenceCalibrationTool,
    agent: false,
  },
  get_decision_loop_review: {
    owner: 'shared-query',
    tool: getDecisionLoopReviewTool,
    agent: false,
  },
  get_holding: { owner: 'shared-query', tool: getHoldingTool, agent: false },
  get_market_data_status: { owner: 'shared-query', tool: getMarketDataStatusTool, agent: false },
  get_previous_closes: { owner: 'shared-query', tool: getPreviousClosesTool, agent: false },
  get_report: { owner: 'shared-query', tool: getReportTool, agent: false },
  get_research_document: { owner: 'shared-query', tool: getResearchDocumentTool, agent: false },
  get_signal_observation_stats: {
    owner: 'shared-query',
    tool: getSignalObservationStatsTool,
    agent: false,
  },
  get_stock_minute_bars: {
    owner: 'business.portfolio',
    tool: getStockMinuteBarsTool,
    agent: false,
  },
  get_stock_universe_status: {
    owner: 'shared-query',
    tool: getStockUniverseStatusTool,
    agent: false,
  },
  get_strategy_decision_cycles: {
    owner: 'shared-query',
    tool: getStrategyDecisionCyclesTool,
    agent: false,
  },
  get_strategy_dsl_catalog: {
    owner: 'shared-query',
    tool: getStrategyDslCatalogTool,
    agent: false,
  },
  get_strategy_insight_facts: {
    execution: 'p1',
    owner: 'shared-query',
    tool: getStrategyInsightFactsTool,
    agent: false,
  },
  get_strategy_reliability_summary: {
    owner: 'shared-query',
    tool: getStrategyReliabilitySummaryTool,
    agent: false,
  },
  get_strategy_run: { owner: 'shared-query', tool: getStrategyRunTool, agent: false },
  get_strategy_workspace: { owner: 'shared-query', tool: getStrategyWorkspaceTool, agent: false },
  get_strict_strategy_backtest: {
    owner: 'shared-query',
    tool: getStrictStrategyBacktestTool,
    agent: false,
  },
  get_trading_plan: { owner: 'shared-query', tool: getTradingPlanTool, agent: false },
  get_watch_status: { owner: 'shared-query', tool: getWatchStatusTool, agent: false },
  get_watch_trigger_delivery_stats: {
    owner: 'shared-query',
    tool: getWatchTriggerDeliveryStatsTool,
    agent: false,
  },
  limit_up_ladder_compare: { owner: 'shared-query', tool: limitUpLadderCompareTool, agent: false },
  list_accounts: { owner: 'shared-query', tool: listAccountsTool, agent: false },
  list_alert_plans: { owner: 'shared-query', tool: listAlertPlansTool, agent: false },
  list_chat_sessions: { owner: 'shared-query', tool: listChatSessionsTool, agent: false },
  list_decision_reviews: { owner: 'shared-query', tool: listDecisionReviewsTool, agent: false },
  list_holdings: { owner: 'shared-query', tool: listHoldingsTool, agent: false },
  list_pending_strategy_observations: {
    owner: 'shared-query',
    tool: listPendingStrategyObservationsTool,
    agent: false,
  },
  list_account_performance_snapshots: {
    owner: 'shared-query',
    tool: listPortfolioPerformanceSnapshotsTool,
    agent: false,
  },
  list_reports: { owner: 'shared-query', tool: listReportsTool, agent: false },
  list_research_documents: { owner: 'shared-query', tool: listResearchDocumentsTool, agent: false },
  list_strategy_result_views: {
    owner: 'business.strategy',
    tool: listStrategyResultViewsTool,
    agent: false,
  },
  list_strategy_runs: { owner: 'shared-query', tool: listStrategyRunsTool, agent: false },
  list_strategy_watchlist_subscriptions: {
    owner: 'shared-query',
    tool: listStrategyWatchlistSubscriptionsTool,
    agent: false,
  },
  list_strict_strategy_backtests: {
    owner: 'shared-query',
    tool: listStrictStrategyBacktestsTool,
    agent: false,
  },
  list_trading_plans: { owner: 'shared-query', tool: listTradingPlansTool, agent: false },
  list_watch_delivery_retries: {
    owner: 'shared-query',
    tool: listWatchDeliveryRetriesTool,
    agent: false,
  },
  list_watch_rule_states: { owner: 'shared-query', tool: listWatchRuleStatesTool, agent: false },
  list_watch_triggers: { owner: 'shared-query', tool: listWatchTriggersTool, agent: false },
  list_watchlist_changes: { owner: 'shared-query', tool: listWatchlistChangesTool, agent: false },
  list_workflow_runs: { owner: 'shared-query', tool: listWorkflowRunsTool, agent: false },
  market_outlook: {
    execution: 'p3',
    owner: 'business.analysis',
    tool: marketOutlookTool,
    agent: false,
    dependencies: ['llm', 'market:quote'],
  },
  pause_strategy: { owner: 'business.strategy', tool: pauseStrategyTool, agent: false },
  propose_strategy_version_draft: {
    owner: 'business.strategy',
    tool: proposeStrategyVersionDraftTool,
    agent: false,
  },
  publish_strategy_version: {
    owner: 'business.strategy',
    tool: publishStrategyVersionTool,
    agent: false,
  },
  reconcile_account_cash: { owner: 'shared-query', tool: reconcileAccountCashTool, agent: false },
  reconcile_stale_strategy_runs: {
    owner: 'business.strategy',
    tool: reconcileStaleStrategyRunsTool,
    agent: false,
  },
  reconcile_stale_workflow_runs: {
    owner: 'platform.audit',
    tool: reconcileStaleWorkflowRunsTool,
    agent: false,
  },
  record_workflow_run: { owner: 'platform.audit', tool: recordWorkflowRunTool, agent: false },
  rename_chat_session: { owner: 'platform.chat', tool: renameChatSessionTool, agent: false },
  render_report: { owner: 'shared-query', tool: renderReportTool, agent: false },
  resolve_watch_notification: {
    owner: 'shared-query',
    tool: resolveWatchNotificationTool,
    agent: false,
  },
  resume_strategy: { owner: 'business.strategy', tool: resumeStrategyTool, agent: false },
  save_report: { execution: 'p3', owner: 'business.report', tool: saveReportTool, agent: false },
  save_watch_rule_states: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: saveWatchRuleStatesTool,
    agent: false,
  },
  save_watch_trigger: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: saveWatchTriggerTool,
    agent: false,
  },
  send_notification: { owner: 'business.notification', tool: sendNotificationTool, agent: false },
  set_report_delivery_status: {
    execution: 'p3',
    owner: 'business.report',
    tool: setReportDeliveryStatusTool,
    agent: false,
  },
  set_watch_trigger_delivery_status: {
    execution: 'p3',
    owner: 'business.watch-monitoring',
    tool: setWatchTriggerDeliveryStatusTool,
    agent: false,
  },
  set_watch_trigger_feedback: {
    owner: 'business.watch',
    tool: setWatchTriggerFeedbackTool,
    agent: false,
  },
  settle_chat_draft: { owner: 'platform.chat', tool: settleChatDraftTool, agent: false },
  strategy_signals_by_stock: {
    owner: 'shared-query',
    tool: strategySignalsByStockTool,
    agent: false,
  },
  subscribe_strategy_to_watchlist: {
    owner: 'business.strategy',
    tool: subscribeStrategyToWatchlistTool,
    agent: false,
  },
  sync_daily_bars: {
    execution: 'p2',
    owner: 'task.daily-bars-sync',
    tool: syncDailyBarsTool,
    agent: false,
    dependencies: ['market:daily-bars'],
  },
  sync_limit_up_board_history: {
    execution: 'p2',
    owner: 'task.sync-limit-up-board-history',
    tool: syncLimitUpBoardHistoryTool,
    agent: false,
    dependencies: ['limitUp'],
  },
  sync_market_dump: {
    execution: 'p2',
    owner: 'task.sync-market-dump',
    tool: syncMarketDumpTool,
    agent: false,
    dependencies: ['marketDump'],
  },
  sync_quotes: {
    execution: 'p2',
    owner: 'task.sync-quotes',
    tool: syncQuotesTool,
    agent: false,
    dependencies: ['market:quote'],
  },
  sync_research_vault: {
    owner: 'task.sync-research-vault',
    tool: syncResearchVaultTool,
    agent: false,
  },
  sync_stock_universe: {
    execution: 'p2',
    owner: 'task.sync-stock-universe',
    tool: syncStockUniverseTool,
    agent: false,
    dependencies: ['stockUniverse'],
  },
  sync_strategy_watchlist_subscriptions: {
    owner: 'task.sync-strategy-watchlist-subscriptions',
    tool: syncStrategyWatchlistSubscriptionsTool,
    agent: false,
  },
  sync_watchlist_source: {
    owner: 'task.sync-watchlist-source',
    tool: syncWatchlistSourceTool,
    agent: false,
  },
  trial_strategy: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: trialStrategyTool,
    agent: false,
  },
  trial_strategy_version: {
    execution: 'p3',
    owner: 'business.strategy-execution',
    tool: trialStrategyVersionTool,
    agent: false,
  },
  unsubscribe_strategy_from_watchlist: {
    owner: 'business.strategy',
    tool: unsubscribeStrategyFromWatchlistTool,
    agent: false,
  },
  update_account: { owner: 'business.portfolio', tool: updateAccountTool, agent: false },
  update_alert_plan: { owner: 'business.watch', tool: updateAlertPlanTool, agent: false },
  update_strategy_schedule: {
    owner: 'business.strategy',
    tool: updateStrategyScheduleTool,
    agent: false,
  },
  update_watchlist_member: {
    owner: 'business.watch',
    tool: updateWatchlistMemberTool,
    agent: false,
  },
  update_watchlist: { owner: 'business.watch', tool: updateWatchlistTool, agent: false },
  validate_strategy_version: {
    owner: 'business.strategy',
    tool: validateStrategyVersionTool,
    agent: false,
  },
} as const satisfies Record<string, CatalogEntry>;

export type CatalogToolName = keyof typeof toolCatalog;
export type AgentToolName = {
  [K in CatalogToolName]: (typeof toolCatalog)[K]['agent'] extends true ? K : never;
}[CatalogToolName];

export type CatalogToolMap = {
  readonly [K in CatalogToolName]: (typeof toolCatalog)[K]['tool'];
};

export const catalogTools: CatalogToolMap = Object.fromEntries(
  Object.entries(toolCatalog).map(([name, entry]) => [name, entry.tool]),
) as CatalogToolMap;

export const agentTools: readonly Tool[] = Object.values(toolCatalog)
  .filter((entry) => entry.agent)
  .map((entry) => entry.tool);

export const agentToolDependencies: Readonly<Record<AgentToolName, readonly ToolDependency[]>> =
  Object.fromEntries(
    Object.entries(toolCatalog).flatMap(([name, entry]): [string, readonly ToolDependency[]][] =>
      entry.agent ? [[name, entry.dependencies]] : [],
    ),
  ) as Record<AgentToolName, readonly ToolDependency[]>;
