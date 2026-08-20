import { describe, expect, it } from 'vitest';

import { createRegistry, toolRegistry } from './registry.js';

// 工具库存快照：新增 tool 时同步本列表与下方 sideEffect 断言。
const EXPECTED_TOOL_NAMES = [
  // v0.1
  'agent_run',
  'list_accounts',
  'create_account',
  'get_account',
  'list_holdings',
  'get_holding',
  'list_trades',
  'get_advice',
  'get_advice_stats',
  'analyze_stock',
  'analyze_strategy_candidate',
  'analyze_position',
  // v0.2 新增
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'fetch_intraday_minutes',
  'sync_quotes',
  'sync_daily_bars',
  'get_previous_closes',
  'search_stocks',
  'compute_indicators',
  // Strategy + 统一 Watchlist W2
  'list_strategies',
  'get_strategy',
  'create_strategy',
  'delete_strategy',
  'create_strategy_version',
  'compare_strategy_definitions',
  'propose_strategy_version_draft',
  'trial_strategy_version',
  'validate_strategy_version',
  'publish_strategy_version',
  'pause_strategy',
  'resume_strategy',
  'run_strategy',
  'prepare_strategy_data',
  'get_strategy_pit_universe',
  'get_strategy_evaluation_session',
  'list_strategy_evaluation_days',
  'start_strategy_evaluation_session',
  'record_strategy_evaluation_day',
  'finish_strategy_evaluation_session',
  'resume_strategy_evaluation_session',
  'cancel_strategy_evaluation_session',
  'list_strategy_runs',
  'get_strategy_run',
  'get_strategy_workspace',
  'list_strategy_result_views',
  'compare_strategy_runs',
  'run_local_selector_research',
  'assess_adaptive_personality',
  'strategy_signals_by_stock',
  // Strategy Phase B：调度、真实表现补全与事实型 AI 洞察
  'list_pending_strategy_observations',
  'complete_strategy_observations',
  'create_strategy_observation_candidates',
  'get_strategy_insight_facts',
  'generate_strategy_insight',
  'generate_strategy_recommendations',
  'get_strategy_schedule',
  'set_strategy_schedule',
  'renew_strategy_schedule_claim',
  // Strategy + 统一 Watchlist W3
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
  // Strategy + 统一 Watchlist W4
  'list_alert_plans',
  'create_alert_plan',
  'update_alert_plan',
  'delete_alert_plan',
  'record_advice_outcome',
  'send_notification',
  'market_outlook',
  // v0.5 新增
  'add_trade',
  'add_holding',
  'update_holding',
  'close_holding',
  // v0.5 W4：confidence 自校准
  'get_confidence_calibration',
  'list_watch_triggers',
  'get_watch_status',
  // v0.7 策略预警（docs/ddd/strategy-watchlist-unification-detailed-design.md §9.2）新增
  'set_watch_trigger_feedback',
  // ruo 迁移 Phase 1（docs/ddd/ruo-feature-migration-detailed-design.md §7）
  'list_research_topics',
  'get_research_topic',
  'create_research_topic',
  'create_research_document',
  'import_local_research_document',
  'import_remote_research_document',
  'link_research_document',
  'archive_research_topic',
  'list_research_documents',
  'get_research_document',
  'search_research_documents',
  'build_research_brief',
  'get_stock_research_view',
  'sync_research_vault',
  'list_stock_events',
  'add_stock_event',
  'update_stock_event',
  'delete_stock_event',
  'sync_stock_events',
  'sync_stock_universe',
  'get_market_data_status',
  'get_ashare_sentiment',
  'list_workflow_runs',
  'get_strategy_reliability_summary',
  // Vibe A 股报告迁移 Phase 1
  'get_report',
  'list_reports',
  'render_report',
  'delete_report',
  // Phase 1：连板天梯
  'limit_up_ladder',
  'limit_up_ladder_compare',
  // 持久化 AI 对话会话
  'create_chat_session',
  'list_chat_sessions',
  'get_chat_session',
  'rename_chat_session',
  'delete_chat_session',
  'append_chat_message',
  // 个股行情查看 Phase 1（docs/ddd/stock-market-view-detailed-design.md §10）
  'get_stock_market_view',
  'get_stock_universe_status',
  // v0.10 账户绩效与组合归因
  'create_portfolio_cash_flow',
  'create_portfolio_corporate_action',
  'get_account_performance',
  'list_account_performance_snapshots',
  'audit_account_performance_snapshots',
] as const;

describe('toolRegistry', () => {
  it(`注册全部 ${EXPECTED_TOOL_NAMES.length} 个 tool`, () => {
    const all = toolRegistry.all();
    expect(all).toHaveLength(EXPECTED_TOOL_NAMES.length);
    expect(all.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it('get(name) 命中 / 未命中', () => {
    expect(toolRegistry.get('analyze_stock')?.sideEffect).toBe('advice');
    expect(toolRegistry.get('fetch_quote')?.sideEffect).toBe('external');
    expect(toolRegistry.get('compute_indicators')?.sideEffect).toBe('read');
    expect(toolRegistry.get('not_a_tool')).toBeUndefined();
  });

  it('远程研究导入声明 write + external 组合能力', () => {
    expect(toolRegistry.get('import_remote_research_document')?.requiredCapabilities).toEqual([
      'write',
      'external',
    ]);
  });

  it('W6：legacy、内部 commit/sync/migration 与 trade 不进入公共 registry', () => {
    const names = toolRegistry.all().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('migration_'))).toEqual([]);
    for (const hidden of [
      'sync_watchlist_source',
      'sync_strategy_watchlist_subscriptions',
      'record_watch_run',
      'record_workflow_run',
      'save_report',
      'save_watch_trigger',
      'set_report_delivery_status',
      'list_tactics',
      'get_tactic',
      'run_tactic',
      'list_stock_groups',
      'get_stock_group',
      'list_stock_pools',
      'list_watch_plans',
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(toolRegistry.all().filter((tool) => tool.sideEffect === 'trade')).toEqual([]);
  });

  it('AUDIT：工具表不含 trade 副作用（advice × trade 隔离硬约束）', () => {
    for (const tool of toolRegistry.all()) {
      expect(tool.sideEffect).not.toBe('trade');
    }
    const sideEffects = new Set(toolRegistry.all().map((t) => t.sideEffect));
    // v0.2 末态：read / write / external / advice / trade
    // 当前注册表：read / advice / external
    expect([...sideEffects].sort()).toEqual(['advice', 'external', 'read', 'write']);
    const adviceTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'advice')
      .map((t) => t.name)
      .sort();
    expect(adviceTools).toEqual([
      'analyze_position',
      'analyze_stock',
      'analyze_strategy_candidate',
      'generate_strategy_recommendations',
      'market_outlook',
    ]);
    const externalTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'external')
      .map((t) => t.name)
      .sort();
    expect(externalTools).toEqual([
      'agent_run',
      'batch_quote',
      'fetch_index_quotes',
      'fetch_intraday_minutes',
      'fetch_quote',
      'generate_strategy_insight',
      'get_account_performance',
      'get_ashare_sentiment',
      'get_stock_market_view',
      'import_remote_research_document',
      'prepare_strategy_data',
      'propose_strategy_version_draft',
      'run_strategy',
      'send_notification',
      'sync_daily_bars',
      'sync_quotes',
      'sync_stock_events',
      'sync_stock_universe',
      'trial_strategy_version',
    ]);
    const writeTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'write')
      .map((t) => t.name)
      .sort();
    expect(writeTools).toEqual([
      'add_holding',
      'add_stock_event',
      'add_trade',
      'add_watchlist_member',
      'add_watchlist_members',
      'append_chat_message',
      'archive_research_topic',
      'archive_watchlist',
      'archive_watchlist_member',
      'cancel_strategy_evaluation_session',
      'close_holding',
      'complete_strategy_observations',
      'create_account',
      'create_alert_plan',
      'create_chat_session',
      'create_portfolio_cash_flow',
      'create_portfolio_corporate_action',
      'create_research_document',
      'create_research_topic',
      'create_strategy',
      'create_strategy_observation_candidates',
      'create_strategy_version',
      'create_watchlist',
      'delete_alert_plan',
      'delete_chat_session',
      'delete_report',
      'delete_stock_event',
      'delete_strategy',
      'finish_strategy_evaluation_session',
      'import_local_research_document',
      'link_research_document',
      'pause_strategy',
      'publish_strategy_version',
      'record_advice_outcome',
      'record_strategy_evaluation_day',
      'rename_chat_session',
      'renew_strategy_schedule_claim',
      'resume_strategy',
      'resume_strategy_evaluation_session',
      'set_strategy_schedule',
      'set_watch_trigger_feedback',
      'start_strategy_evaluation_session',
      'subscribe_strategy_to_watchlist',
      'sync_research_vault',
      'unsubscribe_strategy_from_watchlist',
      'update_alert_plan',
      'update_holding',
      'update_stock_event',
      'update_watchlist',
      'update_watchlist_member',
      'validate_strategy_version',
    ]);
  });

  it('toMCP()：[{ name, description, inputSchema(JSON Schema) }]', () => {
    const mcp = toolRegistry.toMCP();
    expect(mcp).toHaveLength(EXPECTED_TOOL_NAMES.length);
    for (const descriptor of mcp) {
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.inputSchema.type).toBe('object');
    }
    const getAccount = mcp.find((d) => d.name === 'get_account');
    expect(getAccount).toBeDefined();
    const properties = getAccount?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('accountId');
  });

  it('toOpenAI()：function calling 格式', () => {
    const openai = toolRegistry.toOpenAI();
    expect(openai).toHaveLength(EXPECTED_TOOL_NAMES.length);
    for (const descriptor of openai) {
      expect(descriptor.type).toBe('function');
      expect(descriptor.function.name.length).toBeGreaterThan(0);
      expect(descriptor.function.description.length).toBeGreaterThan(0);
      expect(descriptor.function.parameters.type).toBe('object');
    }
  });

  it('toTypeScript()：包含全部 tool 名与声明骨架', () => {
    const dts = toolRegistry.toTypeScript();
    expect(dts).toContain('export type LuoomeToolName');
    expect(dts).toContain('export declare const luoomeToolMeta');
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(dts).toContain(`'${name}'`);
    }
  });

  it('createRegistry 重名 → 抛错（装配期防御）', () => {
    const [first] = toolRegistry.all();
    if (first === undefined) throw new Error('registry is empty');
    expect(() => createRegistry([first, first])).toThrow(/duplicate tool name/);
  });
});
