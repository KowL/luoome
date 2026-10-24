/**
 * DSH 交互面的「设置面」工具白名单。
 *
 * 读面实例（luoome）保持严格只读；设置面实例（luoome-settings）只暴露配置类写工具，
 * 让用户在 DSH 会话里直接维护账户、持仓、自选、告警计划、策略配置与研究结构，
 * 不再依赖网页端表单。
 *
 * 边界（与消费者实例的队列白名单同构的白名单机制，缺一即不放）：
 * - 不含 analysis 队列写回（record_advice_outcome / complete_analysis_job 等）：
 *   结论只由消费者实例产出，交互面写结论会破坏「事实→消费端推理→校验写回」链路。
 * - 不含 delete_* 破坏性工具（advice / report / strategy / stock_event / chat_session）：
 *   一次误判就会丢历史记录，这类操作留给 CLI。
 * - 不含 chat_* 会话内部工具，不含 external 能力。
 * - trade（下单）永不暴露，与 MCP 层的硬卡一致。
 */
export const SETTINGS_TOOL_NAMES = [
  // 账户与持仓
  'create_account',
  'update_account',
  'add_holding',
  'update_holding',
  'close_holding',
  'add_trade',
  'create_portfolio_cash_flow',
  'create_portfolio_corporate_action',
  // 自选与盯盘告警
  'create_watchlist',
  'update_watchlist',
  'archive_watchlist',
  'add_watchlist_member',
  'add_watchlist_members',
  'update_watchlist_member',
  'archive_watchlist_member',
  'create_alert_plan',
  'update_alert_plan',
  'delete_alert_plan',
  'set_watch_trigger_feedback',
  // 策略配置（不含运行与评估）
  'create_strategy',
  'create_strategy_version',
  'validate_strategy_version',
  'publish_strategy_version',
  'archive_strategy',
  'pause_strategy',
  'resume_strategy',
  'set_strategy_schedule',
  'renew_strategy_schedule_claim',
  'subscribe_strategy_to_watchlist',
  'unsubscribe_strategy_from_watchlist',
  // 研究结构（正文与索引同步）
  'create_research_topic',
  'archive_research_topic',
  'create_research_document',
  'create_research_hypothesis_version',
  'link_research_document',
  'import_local_research_document',
  'sync_research_vault',
  // 决策与跟踪
  'save_decision_review',
  'save_investment_consensus',
  'set_investment_tracking',
  'save_trading_plan',
  // 手工公司事件
  'add_stock_event',
  'update_stock_event',
] as const;
