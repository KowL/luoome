import type { SideEffect } from '@luoome/core';

/**
 * Web 端暴露面（对齐 ARCHITECTURE §7.1）：默认只放行 read + advice。
 * write 需 LUOOME_EXPOSE_WRITE=true、external 需 LUOOME_EXPOSE_EXTERNAL=true 且命中
 * WEB_ALLOWED_EXTERNAL 白名单才放行（见 /api/tools/:name/call 的门控）；
 * MCP 暴露面同样默认只读（write 需 LUOOME_EXPOSE_WRITE）。
 */
export const EXPOSED_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(['read', 'advice', 'write']);

/**
 * external 白名单仅包含目标模型运行、行情读取与显式同步；
 * sync_quotes / send_notification 等仍不对通用 Web tool call 开放。
 */
export const WEB_ALLOWED_EXTERNAL: ReadonlySet<string> = new Set([
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'fetch_intraday_minutes',
  'get_stock_minute_bars',
  'get_ashare_sentiment',
  'get_stock_market_view',
  'get_account_performance',
  'sync_stock_universe',
  'sync_daily_bars',
  'run_strategy',
  'trial_strategy',
  'generate_strategy_insight',
  'propose_strategy_version_draft',
  'trial_strategy_version',
]);

/**
 * external（白名单外）/trade tool 不通过 web 暴露：已在 registry 实现的被
 * sideEffect 门拦截（403 文案准确）；本表覆盖「契约里有名字但尚未实现」的
 * tool——同样按契约返回 403 permission_denied，而不是 404 not_found。
 * （write 默认不放行；未实现的 write 类契约 tool 走 not_found。）
 */
export const KNOWN_UNEXPOSED_TOOLS: Readonly<Record<string, SideEffect>> = {
  generate_report: 'external',
  place_order: 'trade',
  cancel_order: 'trade',
};

/**
 * Web 通用 tool 路由的 Agent Tool 名单：与 `toolRegistry`（ARCHITECTURE §7.1，45 个）逐项一致；
 * 名单只决定「这个 tool 是否走通用路由」，副作用仍由 EXPOSED_SIDE_EFFECTS、
 * WEB_ALLOWED_EXTERNAL 与 tool.requiredCapabilities 逐项门控。
 */
export const WEB_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // 行情与盘面资讯（21）
  'search_stocks',
  'get_stock_market_view',
  'fetch_quote',
  'fetch_index_quotes',
  'fetch_sector_quotes',
  'compute_indicators',
  'limit_up_ladder',
  'limit_up_market',
  'dragon_tiger_list',
  'dragon_tiger_flow',
  'northbound_flow',
  'fetch_news',
  'collect_market_snapshot',
  'get_market_snapshot_batch',
  'get_market_room_overview',
  'get_market_room_sectors',
  'get_market_room_amount_distribution',
  'get_market_room_sector_detail',
  'get_market_room_core_stocks',
  'list_market_room_events',
  'get_stock_sector_memberships',
  'sync_sector_catalog',
  // 股票池（4）
  'list_watchlists',
  'get_watchlist',
  'create_watchlist',
  'update_watchlist_members',
  'prune_strategy_history',
  // 策略与回测（6）
  'list_strategies',
  'get_strategy',
  'save_strategy_version',
  'run_strategy',
  'run_strategy_backtest',
  'get_strategy_signals',
  // 账户与持仓（5）
  'get_account_overview',
  'get_account_performance',
  'list_trades',
  'add_trade',
  'update_holding',
  // 研究、建议与报告（6）
  'analyze_stock',
  'analyze_position',
  'get_advice',
  'search_research_documents',
  'save_research_document',
  'save_decision_review',
  // 交易计划与盯盘预警（3）
  'list_watch_plans',
  'save_trading_plan',
  'save_alert_plan',
]);
