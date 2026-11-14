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
  | 'ashareSentiment';

type CatalogEntry =
  | { readonly tool: Tool; readonly agent: true; readonly dependencies: readonly ToolDependency[] }
  | { readonly tool: Tool; readonly agent: false };

// Catalog membership supplies inventory, never permission to execute a tool.
export const toolCatalog = {
  get_account_overview: { tool: getAccountOverviewTool, agent: true, dependencies: [] },
  list_trades: { tool: listTradesTool, agent: true, dependencies: [] },
  get_advice: { tool: getAdviceTool, agent: true, dependencies: [] },
  save_decision_review: { tool: saveDecisionReviewTool, agent: true, dependencies: [] },
  analyze_stock: {
    tool: analyzeStockTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  analyze_position: {
    tool: analyzePositionTool,
    agent: true,
    dependencies: ['llm', 'market:quote', 'market:daily-bars'],
  },
  save_trading_plan: { tool: saveTradingPlanTool, agent: true, dependencies: [] },
  fetch_quote: { tool: fetchQuoteTool, agent: true, dependencies: ['market:quote'] },
  fetch_index_quotes: {
    tool: fetchIndexQuotesTool,
    agent: true,
    dependencies: ['market:realtime-index'],
  },
  search_stocks: { tool: searchStocksTool, agent: true, dependencies: [] },
  compute_indicators: {
    tool: computeIndicatorsTool,
    agent: true,
    dependencies: ['market:daily-bars'],
  },
  list_strategies: { tool: listStrategiesTool, agent: true, dependencies: [] },
  get_strategy: { tool: getStrategyTool, agent: true, dependencies: [] },
  save_strategy_version: { tool: saveStrategyVersionTool, agent: true, dependencies: [] },
  run_strategy: {
    tool: runStrategyTool,
    agent: true,
    dependencies: ['market:quote', 'market:daily-bars'],
  },
  get_account_performance: { tool: getAccountPerformanceTool, agent: true, dependencies: [] },
  run_strategy_backtest: { tool: runStrategyBacktestTool, agent: true, dependencies: [] },
  get_strategy_signals: { tool: getStrategySignalsTool, agent: true, dependencies: [] },
  list_watchlists: { tool: listWatchlistsTool, agent: true, dependencies: [] },
  get_watchlist: { tool: getWatchlistTool, agent: true, dependencies: [] },
  create_watchlist: { tool: createWatchlistTool, agent: true, dependencies: [] },
  update_watchlist_members: { tool: updateWatchlistMembersTool, agent: true, dependencies: [] },
  list_watch_plans: { tool: listWatchPlansTool, agent: true, dependencies: [] },
  save_alert_plan: { tool: saveAlertPlanTool, agent: true, dependencies: [] },
  limit_up_ladder: { tool: limitUpLadderTool, agent: true, dependencies: ['limitUpLadder'] },
  limit_up_market: { tool: limitUpMarketTool, agent: true, dependencies: ['limitUpMarket'] },
  dragon_tiger_list: { tool: dragonTigerListTool, agent: true, dependencies: ['dragonTiger'] },
  dragon_tiger_flow: { tool: dragonTigerFlowTool, agent: true, dependencies: ['dragonTigerFlow'] },
  northbound_flow: { tool: northboundFlowTool, agent: true, dependencies: ['northboundFlow'] },
  fetch_news: { tool: fetchNewsTool, agent: true, dependencies: ['news'] },
  save_research_document: {
    tool: saveResearchDocumentTool,
    agent: true,
    dependencies: ['researchVault'],
  },
  fetch_sector_quotes: { tool: fetchSectorQuotesTool, agent: true, dependencies: ['sectorQuote'] },
  add_trade: { tool: addTradeTool, agent: true, dependencies: [] },
  update_holding: { tool: updateHoldingTool, agent: true, dependencies: [] },
  search_research_documents: {
    tool: searchResearchDocumentsTool,
    agent: true,
    dependencies: ['researchVault'],
  },
  get_stock_market_view: {
    tool: getStockMarketViewTool,
    agent: true,
    dependencies: ['market:quote', 'market:daily-bars', 'market:intraday-minutes'],
  },
  collect_market_snapshot: {
    tool: collectMarketSnapshotTool,
    agent: true,
    dependencies: ['market:market-snapshot-envelope'],
  },
  get_market_snapshot_batch: { tool: getMarketSnapshotBatchTool, agent: true, dependencies: [] },
  get_market_room_overview: { tool: getMarketRoomOverviewTool, agent: true, dependencies: [] },
  get_market_room_sectors: { tool: getMarketRoomSectorsTool, agent: true, dependencies: [] },
  get_stock_sector_memberships: {
    tool: getStockSectorMembershipsTool,
    agent: true,
    dependencies: [],
  },
  sync_sector_catalog: {
    tool: syncSectorCatalogTool,
    agent: true,
    dependencies: ['sectorCatalog'],
  },
  get_market_room_amount_distribution: {
    tool: getMarketRoomAmountDistributionTool,
    agent: true,
    dependencies: [],
  },
  get_market_room_core_stocks: { tool: getMarketRoomCoreStocksTool, agent: true, dependencies: [] },
  get_market_room_sector_detail: {
    tool: getMarketRoomSectorDetailTool,
    agent: true,
    dependencies: [],
  },
  list_market_room_events: { tool: listMarketRoomEventsTool, agent: true, dependencies: [] },
  prune_strategy_history: { tool: pruneStrategyHistoryTool, agent: true, dependencies: [] },
  add_holding: { tool: addHoldingTool, agent: false },
  add_watchlist_member: { tool: addWatchlistMemberTool, agent: false },
  add_watchlist_members: { tool: addWatchlistMembersTool, agent: false },
  analyze_strategy_candidate: { tool: analyzeStrategyCandidateTool, agent: false },
  append_chat_message: { tool: appendChatMessageTool, agent: false },
  archive_strategy: { tool: archiveStrategyTool, agent: false },
  archive_watchlist_member: { tool: archiveWatchlistMemberTool, agent: false },
  archive_watchlist: { tool: archiveWatchlistTool, agent: false },
  audit_account_performance_snapshots: {
    tool: auditPortfolioPerformanceSnapshotsTool,
    agent: false,
  },
  backfill_strategy_observation_candidates: {
    tool: backfillStrategyObservationCandidatesTool,
    agent: false,
  },
  batch_quote: { tool: batchQuoteTool, agent: false },
  begin_watch_delivery: { tool: beginWatchDeliveryTool, agent: false },
  close_holding: { tool: closeHoldingTool, agent: false },
  commit_watch_evaluation: { tool: commitWatchEvaluationTool, agent: false },
  compare_strategy_definitions: { tool: compareStrategyDefinitionsTool, agent: false },
  compare_strategy_runs: { tool: compareStrategyRunsTool, agent: false },
  complete_strategy_observations: { tool: completeStrategyObservationsTool, agent: false },
  create_account: { tool: createAccountTool, agent: false },
  create_alert_plan: { tool: createAlertPlanTool, agent: false },
  create_chat_session: { tool: createChatSessionTool, agent: false },
  create_portfolio_cash_flow: { tool: createPortfolioCashFlowTool, agent: false },
  create_portfolio_corporate_action: { tool: createPortfolioCorporateActionTool, agent: false },
  create_research_document: { tool: createResearchDocumentTool, agent: false },
  create_strategy: { tool: createStrategyTool, agent: false },
  create_strategy_observation_candidates: {
    tool: createStrategyObservationCandidatesTool,
    agent: false,
  },
  create_strategy_version: { tool: createStrategyVersionTool, agent: false },
  create_strict_strategy_backtest: { tool: createStrictStrategyBacktestTool, agent: false },
  delete_advice: { tool: deleteAdviceTool, agent: false },
  delete_alert_plan: { tool: deleteAlertPlanTool, agent: false },
  delete_chat_session: { tool: deleteChatSessionTool, agent: false },
  delete_report: { tool: deleteReportTool, agent: false },
  delete_strategy: { tool: deleteStrategyTool, agent: false },
  evaluate_trading_plan_budget: { tool: evaluateTradingPlanBudgetTool, agent: false },
  execute_strict_strategy_backtest: { tool: executeStrictStrategyBacktestTool, agent: false },
  fetch_intraday_minutes: { tool: fetchIntradayMinutesTool, agent: false },
  generate_strategy_insight: { tool: generateStrategyInsightTool, agent: false },
  generate_strategy_version_proposal: { tool: generateStrategyVersionProposalTool, agent: false },
  get_ashare_sentiment: { tool: getAShareSentimentTool, agent: false },
  get_account_facts: { tool: getAccountFactsTool, agent: false },
  get_account: { tool: getAccountTool, agent: false },
  get_advice_stats: { tool: getAdviceStatsTool, agent: false },
  get_chat_session: { tool: getChatSessionTool, agent: false },
  get_confidence_calibration: { tool: getConfidenceCalibrationTool, agent: false },
  get_decision_loop_review: { tool: getDecisionLoopReviewTool, agent: false },
  get_holding: { tool: getHoldingTool, agent: false },
  get_market_data_status: { tool: getMarketDataStatusTool, agent: false },
  get_previous_closes: { tool: getPreviousClosesTool, agent: false },
  get_report: { tool: getReportTool, agent: false },
  get_research_document: { tool: getResearchDocumentTool, agent: false },
  get_signal_observation_stats: { tool: getSignalObservationStatsTool, agent: false },
  get_stock_minute_bars: { tool: getStockMinuteBarsTool, agent: false },
  get_stock_universe_status: { tool: getStockUniverseStatusTool, agent: false },
  get_strategy_decision_cycles: { tool: getStrategyDecisionCyclesTool, agent: false },
  get_strategy_dsl_catalog: { tool: getStrategyDslCatalogTool, agent: false },
  get_strategy_insight_facts: { tool: getStrategyInsightFactsTool, agent: false },
  get_strategy_reliability_summary: { tool: getStrategyReliabilitySummaryTool, agent: false },
  get_strategy_run: { tool: getStrategyRunTool, agent: false },
  get_strategy_workspace: { tool: getStrategyWorkspaceTool, agent: false },
  get_strict_strategy_backtest: { tool: getStrictStrategyBacktestTool, agent: false },
  get_trading_plan: { tool: getTradingPlanTool, agent: false },
  get_watch_status: { tool: getWatchStatusTool, agent: false },
  get_watch_trigger_delivery_stats: { tool: getWatchTriggerDeliveryStatsTool, agent: false },
  limit_up_ladder_compare: { tool: limitUpLadderCompareTool, agent: false },
  list_accounts: { tool: listAccountsTool, agent: false },
  list_alert_plans: { tool: listAlertPlansTool, agent: false },
  list_chat_sessions: { tool: listChatSessionsTool, agent: false },
  list_decision_reviews: { tool: listDecisionReviewsTool, agent: false },
  list_holdings: { tool: listHoldingsTool, agent: false },
  list_pending_strategy_observations: { tool: listPendingStrategyObservationsTool, agent: false },
  list_account_performance_snapshots: { tool: listPortfolioPerformanceSnapshotsTool, agent: false },
  list_reports: { tool: listReportsTool, agent: false },
  list_research_documents: { tool: listResearchDocumentsTool, agent: false },
  list_strategy_result_views: { tool: listStrategyResultViewsTool, agent: false },
  list_strategy_runs: { tool: listStrategyRunsTool, agent: false },
  list_strategy_watchlist_subscriptions: {
    tool: listStrategyWatchlistSubscriptionsTool,
    agent: false,
  },
  list_strict_strategy_backtests: { tool: listStrictStrategyBacktestsTool, agent: false },
  list_trading_plans: { tool: listTradingPlansTool, agent: false },
  list_watch_delivery_retries: { tool: listWatchDeliveryRetriesTool, agent: false },
  list_watch_rule_states: { tool: listWatchRuleStatesTool, agent: false },
  list_watch_triggers: { tool: listWatchTriggersTool, agent: false },
  list_watchlist_changes: { tool: listWatchlistChangesTool, agent: false },
  list_workflow_runs: { tool: listWorkflowRunsTool, agent: false },
  market_outlook: { tool: marketOutlookTool, agent: false },
  pause_strategy: { tool: pauseStrategyTool, agent: false },
  propose_strategy_version_draft: { tool: proposeStrategyVersionDraftTool, agent: false },
  publish_strategy_version: { tool: publishStrategyVersionTool, agent: false },
  reconcile_account_cash: { tool: reconcileAccountCashTool, agent: false },
  reconcile_stale_strategy_runs: { tool: reconcileStaleStrategyRunsTool, agent: false },
  reconcile_stale_workflow_runs: { tool: reconcileStaleWorkflowRunsTool, agent: false },
  record_workflow_run: { tool: recordWorkflowRunTool, agent: false },
  rename_chat_session: { tool: renameChatSessionTool, agent: false },
  render_report: { tool: renderReportTool, agent: false },
  resolve_watch_notification: { tool: resolveWatchNotificationTool, agent: false },
  resume_strategy: { tool: resumeStrategyTool, agent: false },
  save_report: { tool: saveReportTool, agent: false },
  save_watch_rule_states: { tool: saveWatchRuleStatesTool, agent: false },
  save_watch_trigger: { tool: saveWatchTriggerTool, agent: false },
  send_notification: { tool: sendNotificationTool, agent: false },
  set_report_delivery_status: { tool: setReportDeliveryStatusTool, agent: false },
  set_watch_trigger_delivery_status: { tool: setWatchTriggerDeliveryStatusTool, agent: false },
  set_watch_trigger_feedback: { tool: setWatchTriggerFeedbackTool, agent: false },
  settle_chat_draft: { tool: settleChatDraftTool, agent: false },
  strategy_signals_by_stock: { tool: strategySignalsByStockTool, agent: false },
  subscribe_strategy_to_watchlist: { tool: subscribeStrategyToWatchlistTool, agent: false },
  sync_daily_bars: { tool: syncDailyBarsTool, agent: false },
  sync_limit_up_board_history: { tool: syncLimitUpBoardHistoryTool, agent: false },
  sync_market_dump: { tool: syncMarketDumpTool, agent: false },
  sync_quotes: { tool: syncQuotesTool, agent: false },
  sync_research_vault: { tool: syncResearchVaultTool, agent: false },
  sync_stock_universe: { tool: syncStockUniverseTool, agent: false },
  sync_strategy_watchlist_subscriptions: {
    tool: syncStrategyWatchlistSubscriptionsTool,
    agent: false,
  },
  sync_watchlist_source: { tool: syncWatchlistSourceTool, agent: false },
  trial_strategy: { tool: trialStrategyTool, agent: false },
  trial_strategy_version: { tool: trialStrategyVersionTool, agent: false },
  unsubscribe_strategy_from_watchlist: { tool: unsubscribeStrategyFromWatchlistTool, agent: false },
  update_account: { tool: updateAccountTool, agent: false },
  update_alert_plan: { tool: updateAlertPlanTool, agent: false },
  update_strategy_schedule: { tool: updateStrategyScheduleTool, agent: false },
  update_watchlist_member: { tool: updateWatchlistMemberTool, agent: false },
  update_watchlist: { tool: updateWatchlistTool, agent: false },
  validate_strategy_version: { tool: validateStrategyVersionTool, agent: false },
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
