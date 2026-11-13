import { describe, expect, it } from 'vitest';

import { toolRegistry } from './registry.js';

/** S4.1c：公共 Agent Tool 面 = 39 个核心 Agent Tool（设计 §5.2）。 */
const EXPECTED_TOOL_NAMES = [
  // 1. 行情与盘面资讯（15）
  'search_stocks',
  'get_stock_market_view',
  'fetch_quote',
  'fetch_index_quotes',
  'fetch_sector_quotes',
  'compute_indicators',
  'limit_up_ladder',
  'dragon_tiger_list',
  'dragon_tiger_flow',
  'northbound_flow',
  'fetch_news',
  'collect_market_snapshot',
  'get_market_snapshot_batch',
  'get_market_room_overview',
  'get_market_room_sectors',
  // 2. 股票池（4）
  'list_watchlists',
  'get_watchlist',
  'create_watchlist',
  'update_watchlist_members',
  // 3. 策略与回测（6）
  'list_strategies',
  'get_strategy',
  'save_strategy_version',
  'run_strategy',
  'run_strategy_backtest',
  'get_strategy_signals',
  // 4. 账户与持仓组合（5）
  'get_account_overview',
  'get_account_performance',
  'list_trades',
  'add_trade',
  'update_holding',
  // 5. 研究、建议与报告（6）
  'analyze_stock',
  'analyze_position',
  'get_advice',
  'search_research_documents',
  'save_research_document',
  'save_decision_review',
  // 6. 交易计划与盯盘预警（3）
  'list_watch_plans',
  'save_trading_plan',
  'save_alert_plan',
] as const;

/** 已从公共注册表移除、保留为 Application Service / 内部 tool 的旧名。 */
const RETIRED_TOOL_NAMES = [
  'add_holding',
  'add_watchlist_member',
  'add_watchlist_members',
  'analyze_strategy_candidate',
  'append_chat_message',
  'archive_strategy',
  'archive_watchlist',
  'archive_watchlist_member',
  'audit_portfolio_performance_snapshots',
  'batch_quote',
  'close_holding',
  'compare_strategy_definitions',
  'compare_strategy_runs',
  'complete_strategy_observations',
  'create_account',
  'create_alert_plan',
  'create_chat_session',
  'create_portfolio_cash_flow',
  'create_portfolio_corporate_action',
  'create_research_document',
  'create_strategy',
  'create_strategy_version',
  'create_strict_strategy_backtest',
  'delete_advice',
  'delete_alert_plan',
  'delete_chat_session',
  'delete_report',
  'delete_strategy',
  'evaluate_trading_plan_budget',
  'fetch_intraday_minutes',
  'generate_strategy_insight',
  'get_ashare_sentiment',
  'get_account',
  'get_account_facts',
  'get_advice_stats',
  'get_chat_session',
  'get_confidence_calibration',
  'get_decision_loop_review',
  'get_holding',
  'get_market_data_status',
  'get_previous_closes',
  'get_report',
  'get_research_document',
  'get_signal_observation_stats',
  'get_stock_minute_bars',
  'get_stock_universe_status',
  'get_strategy_decision_cycles',
  'get_strategy_dsl_catalog',
  'get_strategy_insight_facts',
  'get_strategy_reliability_summary',
  'get_strategy_run',
  'get_strategy_workspace',
  'get_strict_strategy_backtest',
  'get_trading_plan',
  'get_watch_status',
  'limit_up_ladder_compare',
  'list_accounts',
  'list_alert_plans',
  'list_chat_sessions',
  'list_decision_reviews',
  'list_holdings',
  'list_pending_strategy_observations',
  'list_portfolio_performance_snapshots',
  'list_reports',
  'list_research_documents',
  'list_strategy_result_views',
  'list_strategy_runs',
  'list_strategy_watchlist_subscriptions',
  'list_strict_strategy_backtests',
  'list_trading_plans',
  'list_watch_triggers',
  'list_watchlist_changes',
  'list_workflow_runs',
  'market_outlook',
  'pause_strategy',
  'propose_strategy_version_draft',
  'publish_strategy_version',
  'reconcile_account_cash',
  'rename_chat_session',
  'render_report',
  'resume_strategy',
  'send_notification',
  'set_watch_trigger_feedback',
  'strategy_signals_by_stock',
  'subscribe_strategy_to_watchlist',
  'sync_daily_bars',
  'sync_quotes',
  'sync_stock_universe',
  'trial_strategy',
  'trial_strategy_version',
  'unsubscribe_strategy_from_watchlist',
  'update_account',
  'update_alert_plan',
  'update_watchlist',
  'update_watchlist_member',
  'validate_strategy_version',
] as const;

describe('toolRegistry（39 核心 Agent Tool）', () => {
  it(`恰好注册 ${EXPECTED_TOOL_NAMES.length} 个 tool，名字与设计 §5.2 一致`, () => {
    const all = toolRegistry.all();
    expect(all).toHaveLength(39);
    expect(all).toHaveLength(EXPECTED_TOOL_NAMES.length);
    expect(all.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(new Set(all.map((tool) => tool.name)).size).toBe(39);
  });

  it('get(name) 命中 / 未命中', () => {
    expect(toolRegistry.get('analyze_stock')?.sideEffect).toBe('advice');
    expect(toolRegistry.get('fetch_quote')?.sideEffect).toBe('external');
    expect(toolRegistry.get('compute_indicators')?.sideEffect).toBe('read');
    expect(toolRegistry.get('add_trade')?.sideEffect).toBe('write');
    expect(toolRegistry.get('not_a_tool')).toBeUndefined();
  });

  it('已移出公共注册表的 96 个旧 tool 不再注册（保留为 Application Service）', () => {
    for (const name of RETIRED_TOOL_NAMES) {
      expect(toolRegistry.get(name), name).toBeUndefined();
    }
    expect(RETIRED_TOOL_NAMES.length).toBe(96);
    expect(EXPECTED_TOOL_NAMES.length + RETIRED_TOOL_NAMES.length).toBe(135);
  });

  it('legacy、内部 commit/sync/migration tool 不进入公共 registry', () => {
    for (const name of [
      'agent_run',
      'list_tactics',
      'get_tactic',
      'run_tactic',
      'list_stock_groups',
      'get_stock_group',
      'list_stock_pools',
      'sync_watchlist_source',
      'sync_strategy_watchlist_subscriptions',
      'record_workflow_run',
      'save_watch_trigger',
      'generate_strategy_version_proposal',
      'prepare_strategy_data',
      'run_local_selector_research',
      'assess_adaptive_personality',
    ]) {
      expect(toolRegistry.get(name), name).toBeUndefined();
    }
  });

  it('sideEffect 分组与最终分类一致：read / external / advice / write', () => {
    const sideEffects = new Set(toolRegistry.all().map((tool) => tool.sideEffect));
    expect([...sideEffects].sort()).toEqual(['advice', 'external', 'read', 'write']);

    const namesOf = (sideEffect: string): string[] =>
      toolRegistry
        .all()
        .filter((tool) => tool.sideEffect === sideEffect)
        .map((tool) => tool.name)
        .sort();

    expect(namesOf('read')).toEqual([
      'compute_indicators',
      'dragon_tiger_flow',
      'dragon_tiger_list',
      'get_account_overview',
      'get_advice',
      'get_market_room_sectors',
      'get_market_snapshot_batch',
      'get_strategy',
      'get_strategy_signals',
      'get_watchlist',
      'limit_up_ladder',
      'list_strategies',
      'list_trades',
      'list_watch_plans',
      'list_watchlists',
      'northbound_flow',
      'search_research_documents',
      'search_stocks',
    ]);
    expect(namesOf('external')).toEqual([
      'collect_market_snapshot',
      'fetch_index_quotes',
      'fetch_news',
      'fetch_quote',
      'fetch_sector_quotes',
      'get_account_performance',
      'get_market_room_overview',
      'get_stock_market_view',
      'run_strategy',
    ]);
    expect(namesOf('advice')).toEqual(['analyze_position', 'analyze_stock']);
    expect(namesOf('write')).toEqual([
      'add_trade',
      'create_watchlist',
      'run_strategy_backtest',
      'save_alert_plan',
      'save_decision_review',
      'save_research_document',
      'save_strategy_version',
      'save_trading_plan',
      'update_holding',
      'update_watchlist_members',
    ]);
  });

  it('add_trade 以 write 声明并由 MCP name denylist 拦截（trade 副作用永不暴露）', () => {
    // §5.2 把 add_trade 标为 trade；Web 统一写入门只放行 read/advice/write，
    // 因此以 write 声明并由 MCP 层 denylist + LUOOME_EXPOSE_TRADE 硬卡保证永不通过 MCP 暴露。
    expect(toolRegistry.get('add_trade')?.sideEffect).toBe('write');
    expect(
      toolRegistry
        .all()
        .filter((tool) => tool.sideEffect === 'trade')
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(toolRegistry.get('list_trades')?.sideEffect).toBe('read');
  });

  it('关键 Tool 的 requiredCapabilities 与真实副作用一致', () => {
    expect(toolRegistry.get('analyze_stock')?.requiredCapabilities).toEqual(['advice']);
    expect(toolRegistry.get('analyze_position')?.requiredCapabilities).toEqual(['advice']);
    expect(toolRegistry.get('run_strategy')?.requiredCapabilities).toEqual(['external', 'write']);
    expect(toolRegistry.get('fetch_news')?.requiredCapabilities).toEqual(['external']);
    expect(toolRegistry.get('fetch_sector_quotes')?.requiredCapabilities).toEqual(['external']);
    expect(toolRegistry.get('collect_market_snapshot')?.requiredCapabilities).toEqual([
      'external',
      'write',
    ]);
    expect(toolRegistry.get('get_market_room_overview')?.requiredCapabilities).toEqual([
      'external',
    ]);
    expect(toolRegistry.get('get_stock_market_view')?.requiredCapabilities).toEqual(['external']);
    expect(toolRegistry.get('add_trade')?.requiredCapabilities).toEqual(['write']);
    expect(toolRegistry.get('save_research_document')?.requiredCapabilities).toEqual(['write']);
    expect(toolRegistry.get('run_strategy_backtest')?.requiredCapabilities).toEqual(['write']);
  });

  it('toMCP()：[{ name, description, inputSchema(JSON Schema) }]', () => {
    const mcp = toolRegistry.toMCP();
    expect(mcp).toHaveLength(39);
    for (const descriptor of mcp) {
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.inputSchema.type).toBe('object');
    }
    const account = mcp.find((descriptor) => descriptor.name === 'get_account_overview');
    expect(account).toBeDefined();
    const properties = account?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('accountId');
    const strategy = mcp.find((descriptor) => descriptor.name === 'save_strategy_version');
    expect(strategy).toBeDefined();
    const strategyProps = strategy?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(strategyProps)).toContain('action');
  });

  it('toOpenAI()：function calling 格式', () => {
    const openai = toolRegistry.toOpenAI();
    expect(openai).toHaveLength(39);
    for (const descriptor of openai) {
      expect(descriptor.type).toBe('function');
      expect(descriptor.function.name.length).toBeGreaterThan(0);
      expect(descriptor.function.description.length).toBeGreaterThan(0);
      expect(descriptor.function.parameters.type).toBe('object');
    }
  });

  it('toTypeScript()：包含全部 39 个 tool 名与声明骨架', () => {
    const text = toolRegistry.toTypeScript();
    expect(text).toContain('共 39 个 tool');
    expect(text).toContain('export type LuoomeToolName =');
    expect(text).toContain('export declare const luoomeToolMeta:');
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(text, name).toContain(`'${name}'`);
    }
  });

  it('createRegistry 重名 → 抛错（装配期防御）', async () => {
    const { createRegistry } = await import('./registry.js');
    const tool = toolRegistry.get('get_advice');
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    expect(() => createRegistry([tool, tool])).toThrow(/重复|duplicate/i);
  });
});
