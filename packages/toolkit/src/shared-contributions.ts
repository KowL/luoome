import type { ToolContributions } from './plugin.js';
import { getAccountFactsTool, reconcileAccountCashTool } from './tools/account-facts.js';
import { addHoldingTool } from './tools/add-holding.js';
import { addTradeTool } from './tools/add-trade.js';
import { listAdviceFeedbackTool, submitAdviceFeedbackTool } from './tools/advice-feedback.js';
import { getAdviceScorecardTool } from './tools/advice-scorecard.js';
import {
  createAlertPlanTool,
  deleteAlertPlanTool,
  listAlertPlansTool,
  updateAlertPlanTool,
} from './tools/alert-plan.js';
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
import { getIntradaySummaryTool } from './tools/get-intraday-summary.js';
import { getMarketDataStatusTool } from './tools/get-market-data-status.js';
import { getPreviousClosesTool } from './tools/get-previous-closes.js';
import { getReportTool } from './tools/get-report.js';
import { getStockBriefTool } from './tools/get-stock-brief.js';
import { getStockFactsTool } from './tools/get-stock-facts.js';
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
import { listStockBriefsTool } from './tools/list-stock-briefs.js';
import { listTradesTool } from './tools/list-trades.js';
import { listWatchPlansTool } from './tools/list-watch-plans.js';
import {
  listWatchTriggersTool,
  resolveWatchNotificationTool,
} from './tools/list-watch-triggers.js';
import { listWorkflowRunsTool } from './tools/list-workflow-runs.js';
import { getMarketRoomAmountDistributionTool } from './tools/market-room-amount-distribution.js';
import { getMarketRoomCoreStocksTool } from './tools/market-room-core-stocks.js';
import { listMarketRoomEventsTool } from './tools/market-room-events.js';
import { getMarketRoomOverviewTool } from './tools/market-room-overview.js';
import { getMarketRoomSectorDetailTool } from './tools/market-room-sector-detail.js';
import { getMarketRoomSectorsTool } from './tools/market-room-sectors.js';
import { getMarketSnapshotBatchTool } from './tools/market-snapshot-batch.js';
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
import { reconcileStaleWorkflowRunsTool } from './tools/reconcile-stale-workflow-runs.js';
import { recordWorkflowRunTool } from './tools/record-workflow-run.js';
import { renderReportTool } from './tools/render-report.js';
import { saveAlertPlanTool } from './tools/save-alert-plan.js';
import { saveStrategyVersionTool } from './tools/save-strategy-version.js';
import { searchStocksTool } from './tools/search-stocks.js';
import { fetchSectorQuotesTool } from './tools/sector-quote.js';
import { setWatchTriggerFeedbackTool } from './tools/set-watch-trigger-feedback.js';
import { getAdviceSettlementsTool, settleAdvicesTool } from './tools/settle-advices.js';
import {
  getSignalObservationStatsTool,
  listPendingStrategyObservationsTool,
} from './tools/signal-observation.js';
import { getStrategyDslCatalogTool } from './tools/strategy-experiment.js';
import { getStrategyInsightFactsTool } from './tools/strategy-insight.js';
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
  validateStrategyDefinitionTool,
  validateStrategyVersionTool,
} from './tools/strategy-lifecycle.js';
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
  getWatchTriggerDeliveryStatsTool,
  listWatchDeliveryRetriesTool,
  listWatchRuleStatesTool,
} from './tools/workflow-operations.js';

export const sharedToolContributions = {
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
  get_account_performance: {
    owner: 'business.portfolio',
    tool: getAccountPerformanceTool,
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
  get_stock_brief: {
    owner: 'shared-query',
    tool: getStockBriefTool,
    agent: true,
    dependencies: [],
  },
  list_stock_briefs: {
    owner: 'shared-query',
    tool: listStockBriefsTool,
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
  get_stock_market_view: {
    owner: 'business.portfolio',
    tool: getStockMarketViewTool,
    agent: true,
    dependencies: ['market:quote', 'market:daily-bars', 'market:intraday-minutes'],
  },
  get_stock_facts: {
    owner: 'business.market-data',
    tool: getStockFactsTool,
    agent: true,
    dependencies: [
      'market:quote',
      'market:daily-bars',
      'market:intraday-minutes',
      'market:realtime-index',
      'news',
      'sectorQuote',
    ],
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
  batch_quote: { owner: 'business.market-data', tool: batchQuoteTool, agent: false },
  close_holding: { owner: 'business.portfolio', tool: closeHoldingTool, agent: false },
  compare_strategy_runs: { owner: 'shared-query', tool: compareStrategyRunsTool, agent: false },
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
  create_strategy: { owner: 'business.strategy', tool: createStrategyTool, agent: false },
  create_strategy_version: {
    owner: 'business.strategy',
    tool: createStrategyVersionTool,
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
  fetch_intraday_minutes: {
    owner: 'business.market-data',
    tool: fetchIntradayMinutesTool,
    agent: false,
  },
  get_ashare_sentiment: {
    owner: 'business.market-data',
    tool: getAShareSentimentTool,
    agent: false,
  },
  get_account_facts: { owner: 'shared-query', tool: getAccountFactsTool, agent: false },
  submit_advice_feedback: {
    owner: 'shared-query',
    tool: submitAdviceFeedbackTool,
    agent: false,
  },
  list_advice_feedback: {
    owner: 'shared-query',
    tool: listAdviceFeedbackTool,
    agent: false,
  },
  get_advice_scorecard: {
    owner: 'shared-query',
    tool: getAdviceScorecardTool,
    agent: false,
  },
  get_advice_settlements: {
    owner: 'shared-query',
    tool: getAdviceSettlementsTool,
    agent: false,
  },
  settle_advices: { owner: 'shared-query', tool: settleAdvicesTool, agent: false },
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
  get_intraday_summary: {
    owner: 'business.market-data',
    tool: getIntradaySummaryTool,
    agent: true,
    dependencies: ['market:quote', 'market:intraday-minutes'],
  },
  get_market_data_status: { owner: 'shared-query', tool: getMarketDataStatusTool, agent: false },
  get_previous_closes: { owner: 'shared-query', tool: getPreviousClosesTool, agent: false },
  get_report: { owner: 'shared-query', tool: getReportTool, agent: false },
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
    agent: true,
    dependencies: [],
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
  list_trading_plans: { owner: 'shared-query', tool: listTradingPlansTool, agent: false },
  list_watch_rule_states: { owner: 'shared-query', tool: listWatchRuleStatesTool, agent: false },
  list_watch_delivery_retries: {
    owner: 'shared-query',
    tool: listWatchDeliveryRetriesTool,
    agent: false,
  },
  list_watch_triggers: { owner: 'shared-query', tool: listWatchTriggersTool, agent: false },
  list_watchlist_changes: { owner: 'shared-query', tool: listWatchlistChangesTool, agent: false },
  list_workflow_runs: { owner: 'shared-query', tool: listWorkflowRunsTool, agent: false },
  pause_strategy: { owner: 'business.strategy', tool: pauseStrategyTool, agent: false },
  publish_strategy_version: {
    owner: 'business.strategy',
    tool: publishStrategyVersionTool,
    agent: false,
  },
  reconcile_account_cash: { owner: 'shared-query', tool: reconcileAccountCashTool, agent: false },
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
  set_watch_trigger_feedback: {
    owner: 'business.watch',
    tool: setWatchTriggerFeedbackTool,
    agent: false,
  },
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
  validate_strategy_definition: {
    owner: 'shared-query',
    tool: validateStrategyDefinitionTool,
    agent: true,
    dependencies: [],
  },
  validate_strategy_version: {
    owner: 'business.strategy',
    tool: validateStrategyVersionTool,
    agent: false,
  },
} as const satisfies ToolContributions;
