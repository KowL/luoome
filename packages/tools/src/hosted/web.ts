import type { SideEffect, ToolContext, ToolResult } from '@luoome/core';
import { errNotFound, type Tool } from '../define-tool.js';
import { toolRegistry } from '../registry.js';
import {
  beginAccountPlanBatchTool,
  finishAccountPlanBatchTool,
  getAccountPlanBatchTool,
} from '../tools/account-plan-batch-state.js';
import { reconcileStaleStrategyRunsTool } from '../tools/reconcile-stale-strategy-runs.js';
import { reconcileStaleWorkflowRunsTool } from '../tools/reconcile-stale-workflow-runs.js';
import { recordWatchRunTool } from '../tools/record-watch-run.js';
import { recordWorkflowRunTool } from '../tools/record-workflow-run.js';
import { saveReportTool } from '../tools/save-report.js';
import { saveWatchTriggerTool } from '../tools/save-watch-trigger.js';
import { setReportDeliveryStatusTool } from '../tools/set-report-delivery-status.js';
import { settleChatDraftTool } from '../tools/settle-chat-draft.js';
import {
  createStrategyAutonomyActionTool,
  transitionStrategyAutonomyActionTool,
} from '../tools/strategy-autonomy-action.js';
import { executeStrictStrategyBacktestTool } from '../tools/strategy-backtest.js';
import {
  claimDueStrategySchedulesTool,
  finishStrategyScheduleClaimTool,
} from '../tools/strategy-schedule.js';
import { syncStrategyWatchlistSubscriptionsTool } from '../tools/strategy-watchlist-subscription.js';
import { syncWatchlistSourceTool } from '../tools/watchlist.js';
import {
  beginWatchDeliveryTool,
  commitWatchEvaluationTool,
  getWatchTriggerDeliveryStatsTool,
  listWatchDeliveryRetriesTool,
  listWatchRuleStatesTool,
  saveWatchRuleStatesTool,
  setWatchTriggerDeliveryStatusTool,
  watchExecutionTool,
} from '../tools/workflow-operations.js';
import type { HostedInvocation } from './invoke.js';
import { deliverHostedReportTool, hostedReportExecutionTool } from './report.js';
import { hostedStrategyExecutionTool } from './strategy.js';
import {
  claimHostedWatchTickTool,
  createHostedWatchNotificationManager,
  finishHostedWatchTickTool,
  getHostedWatchSettingsTool,
  listHostedWatchDeliveriesTool,
  resolveHostedWatchNotificationTool,
  saveHostedWatchSettingsTool,
  testHostedWatchSettingsTool,
} from './watch.js';

export const HOSTED_WEB_POLICY_VERSION = 'hosted-web-v2' as const;

// 新 registry 项必须逐项审核；新增工具不会自动获得托管权限。
export const hostedWebPublicToolNames: readonly string[] = Object.freeze([
  'get_investment_workspace',
  'save_investment_consensus',
  'set_investment_tracking',
  'get_investment_candidates',
  'list_chat_sessions',
  'get_chat_session',
  'create_chat_session',
  'rename_chat_session',
  'delete_chat_session',
  'append_chat_message',
  'list_accounts',
  'update_account',
  'get_account',
  'get_account_facts',
  'reconcile_account_cash',
  'list_holdings',
  'list_trades',
  'get_holding',
  'get_advice',
  'get_advice_stats',
  'get_confidence_calibration',
  'get_decision_loop_review',
  'get_decision_review_snapshot',
  'refresh_decision_review_report',
  'get_decision_review_context',
  'list_decision_reviews',
  'get_decision_write_receipt',
  'save_decision_review',
  'record_decision_trade',
  'get_strategy_decision_cycles',
  'get_strategy_recommendation_preflight_history',
  'get_financial_facts',
  'get_fundamental_score',
  'get_watch_status',
  'save_trading_plan',
  'get_trading_plan',
  'list_trading_plans',
  'evaluate_trading_plan_budget',
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'fetch_intraday_minutes',
  'get_stock_minute_bars',
  'sync_quotes',
  'sync_daily_bars',
  'sync_financial_facts',
  'run_fundamental_score',
  'get_previous_closes',
  'search_stocks',
  'compute_indicators',
  'list_strategies',
  'get_strategy',
  'create_strategy',
  'delete_strategy',
  'create_strategy_version',
  'compare_strategy_definitions',
  'get_strategy_dsl_catalog',
  'get_strategy_experiment_context',
  'propose_strategy_version_draft',
  'trial_strategy_version',
  'validate_strategy_version',
  'export_strategy_manifest',
  'validate_strategy_manifest',
  'import_strategy_manifest',
  'publish_strategy_version',
  'pause_strategy',
  'resume_strategy',
  'archive_strategy',
  'run_strategy',
  'trial_strategy',
  'prepare_strategy_data',
  'create_portfolio_cash_flow',
  'create_portfolio_corporate_action',
  'get_account_performance',
  'list_account_performance_snapshots',
  'audit_account_performance_snapshots',
  'get_strategy_pit_universe',
  'get_strategy_evaluation_session',
  'list_strategy_evaluation_days',
  'start_strategy_evaluation_session',
  'record_strategy_evaluation_day',
  'finish_strategy_evaluation_session',
  'resume_strategy_evaluation_session',
  'cancel_strategy_evaluation_session',
  'create_strict_strategy_backtest',
  'get_strict_strategy_backtest',
  'list_strict_strategy_backtests',
  'list_strategy_runs',
  'get_strategy_run',
  'list_strategy_result_views',
  'get_strategy_workspace',
  'compare_strategy_runs',
  'run_local_selector_research',
  'assess_adaptive_personality',
  'strategy_signals_by_stock',
  'list_pending_strategy_observations',
  'complete_strategy_observations',
  'get_signal_observation_stats',
  'create_strategy_observation_candidates',
  'get_strategy_insight_facts',
  'list_strategy_autonomy_actions',
  'confirm_strategy_autonomy_action',
  'reject_strategy_autonomy_action',
  'get_strategy_schedule',
  'set_strategy_schedule',
  'renew_strategy_schedule_claim',
  'list_watchlists',
  'get_watchlist',
  'create_watchlist',
  'update_watchlist',
  'archive_watchlist',
  'add_watchlist_member',
  'add_watchlist_members',
  'update_watchlist_member',
  'archive_watchlist_member',
  'list_watchlist_changes',
  'list_strategy_watchlist_subscriptions',
  'subscribe_strategy_to_watchlist',
  'unsubscribe_strategy_from_watchlist',
  'list_alert_plans',
  'create_alert_plan',
  'update_alert_plan',
  'delete_alert_plan',
  'record_advice_outcome',
  'send_notification',
  'limit_up_ladder',
  'limit_up_ladder_compare',
  'dragon_tiger_list',
  'northbound_flow',
  'fetch_news',
  'fetch_sector_quotes',
  'add_trade',
  'add_holding',
  'update_holding',
  'close_holding',
  'list_watch_triggers',
  'get_intraday_delivery_audit',
  'get_closing_batch_audit',
  'set_watch_trigger_feedback',
  'list_stock_events',
  'add_stock_event',
  'update_stock_event',
  'list_research_topics',
  'create_research_hypothesis_version',
  'list_research_hypothesis_versions',
  'get_research_topic',
  'create_research_topic',
  'create_research_document',
  'import_local_research_document',
  'import_remote_research_document',
  'link_research_document',
  'archive_research_topic',
  'build_research_brief',
  'list_research_documents',
  'get_research_document',
  'search_research_documents',
  'get_research_embedding_status',
  'search_research_documents_hybrid',
  'rebuild_research_embeddings',
  'evaluate_research_embeddings',
  'get_stock_research_view',
  'sync_research_vault',
  'delete_stock_event',
  'sync_stock_events',
  'sync_stock_universe',
  'get_market_data_status',
  'get_ashare_sentiment',
  'list_workflow_runs',
  'get_strategy_reliability_summary',
  'get_report',
  'list_reports',
  'render_report',
  'delete_report',
  'delete_advice',
  'get_stock_market_view',
  'get_stock_universe_status',
]);

const internalTools: readonly Tool[] = [
  hostedReportExecutionTool,
  hostedStrategyExecutionTool,
  deliverHostedReportTool,
  getHostedWatchSettingsTool,
  saveHostedWatchSettingsTool,
  testHostedWatchSettingsTool,
  listHostedWatchDeliveriesTool,
  resolveHostedWatchNotificationTool,
  claimHostedWatchTickTool,
  finishHostedWatchTickTool,
  beginAccountPlanBatchTool,
  finishAccountPlanBatchTool,
  getAccountPlanBatchTool,
  reconcileStaleStrategyRunsTool,
  reconcileStaleWorkflowRunsTool,
  recordWatchRunTool,
  recordWorkflowRunTool,
  saveReportTool,
  saveWatchTriggerTool,
  setReportDeliveryStatusTool,
  settleChatDraftTool,
  createStrategyAutonomyActionTool,
  transitionStrategyAutonomyActionTool,
  executeStrictStrategyBacktestTool,
  claimDueStrategySchedulesTool,
  finishStrategyScheduleClaimTool,
  syncStrategyWatchlistSubscriptionsTool,
  syncWatchlistSourceTool,
  beginWatchDeliveryTool,
  commitWatchEvaluationTool,
  getWatchTriggerDeliveryStatsTool,
  listWatchDeliveryRetriesTool,
  listWatchRuleStatesTool,
  saveWatchRuleStatesTool,
  setWatchTriggerDeliveryStatusTool,
  watchExecutionTool,
];
export const hostedWebInternalToolNames: readonly string[] = Object.freeze(
  internalTools.map((tool) => tool.name),
);
const approved = new Map<string, Tool>(internalTools.map((tool) => [tool.name, tool]));
for (const name of hostedWebPublicToolNames) {
  const tool = toolRegistry.get(name);
  if (tool === undefined) throw new Error(`hosted Web policy references missing tool: ${name}`);
  approved.set(name, tool);
}

// 这些旧 read 入口会访问上游或刷新缓存，不能用历史读取权益执行。
const refreshingReads = new Set([
  'compute_indicators',
  'search_stocks',
  'limit_up_ladder',
  'limit_up_ladder_compare',
  'dragon_tiger_list',
  'northbound_flow',
  'fetch_news',
  'fetch_sector_quotes',
  'get_stock_research_view',
]);

const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export interface HostedWebToolOptions {
  /** 仅绑定人工确认的专用成交记账路由；通用工具路由不得开启。 */
  readonly allowDecisionTrade?: boolean;
  readonly notificationPublicOrigin?: string;
}

export const authorizeHostedWebRequest = async (
  invocation: HostedInvocation,
  paid: boolean,
): Promise<ToolResult<never> | null> => {
  const { context, identity } = invocation;
  const trusted = context.identity;
  if (
    trusted?.mode !== 'hosted' ||
    trusted.userId !== identity.userId ||
    trusted.tenantId !== identity.tenantId ||
    trusted.tenantGeneration !== identity.tenantGeneration ||
    trusted.actor !== identity.actor ||
    trusted.requestId !== identity.requestId ||
    trusted.operationId !== identity.operationId ||
    context.user.id !== identity.userId
  )
    return denied('hosted:trusted-identity');
  if (context.user.defaultAccountId.length === 0) return denied('hosted:default-account');
  const tenant = await invocation.currentTenant();
  if (tenant === null || tenant.id !== identity.tenantId || tenant.ownerUserId !== identity.userId)
    return errNotFound('Tenant', identity.tenantId);
  if (
    tenant.generation !== identity.tenantGeneration ||
    (tenant.status !== 'active' && !(tenant.status === 'suspended' && !paid))
  )
    return denied('hosted:tenant-active');
  if (!paid) return null;
  if (!invocation.capabilities.write) return denied('capability:write');
  if ((invocation.entitlementRequired ?? true) === false) return null;
  const entitlement =
    invocation.currentEntitlement === undefined
      ? invocation.entitlement
      : await invocation.currentEntitlement();
  const now = context.clock();
  if (
    entitlement === null ||
    entitlement.period.tenantId !== tenant.id ||
    entitlement.period.planVersionId !== entitlement.plan.id ||
    entitlement.plan.productPolicyVersion !== HOSTED_WEB_POLICY_VERSION ||
    entitlement.period.startsAt > now ||
    entitlement.period.endsAt <= now ||
    !['trial', 'paid'].includes(entitlement.period.status)
  )
    return denied(`entitlement:${HOSTED_WEB_POLICY_VERSION}`);
  return null;
};

const hasForeignAccount = (value: unknown, accountId: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasForeignAccount(item, accountId));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (key === 'accountId' && item !== undefined && item !== accountId) ||
      hasForeignAccount(item, accountId),
  );
};

export const contextForHostedWebTools = (
  invocation: HostedInvocation,
  options: HostedWebToolOptions = {},
): ToolContext => ({
  ...invocation.context,
  notification: {
    send: async (input) => {
      if (input.watchDelivery !== undefined)
        return createHostedWatchNotificationManager(
          invocation.context,
          () => authorizeHostedWebRequest(invocation, true),
          options.notificationPublicOrigin === undefined
            ? {}
            : { publicOrigin: options.notificationPublicOrigin },
        ).send(input);
      const original = invocation.context.notification;
      if (original === undefined) throw new Error('notification manager unavailable');
      return original.send(input);
    },
  },
  hostedAuthorization: async (name, input, declaredCapabilities) => {
    const tool = approved.get(name);
    if (tool === undefined) return denied('hosted:web-tool');
    if (hasForeignAccount(input, invocation.context.user.defaultAccountId))
      return denied('hosted:default-account');
    const capabilities = new Set<SideEffect>([
      tool.sideEffect,
      ...tool.requiredCapabilities,
      ...declaredCapabilities,
    ]);
    if (capabilities.has('trade')) {
      if (
        name !== 'record_decision_trade' ||
        options.allowDecisionTrade !== true ||
        invocation.identity.actor !== 'user'
      )
        return denied('capability:trade');
      capabilities.delete('trade');
      capabilities.add('write');
    }
    if (refreshingReads.has(name)) capabilities.add('external');
    // 外部查询可能持久化行情/派生缓存；统一保留完整写入授权。
    if (capabilities.has('external')) capabilities.add('write');
    const paid = capabilities.has('write') || capabilities.has('external');
    const authorization = await authorizeHostedWebRequest(invocation, paid);
    if (authorization !== null) return authorization;
    if (capabilities.has('external') && !invocation.capabilities.external)
      return denied('capability:external');
    return null;
  },
});
