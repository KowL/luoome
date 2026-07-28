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
  'analyze_position',
  // v0.2 新增
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'sync_quotes',
  'sync_daily_bars',
  'get_previous_closes',
  'search_stocks',
  'compute_indicators',
  // v0.3 新增
  'list_tactics',
  'get_tactic',
  'run_tactic',
  'score_signals',
  'tactic_signals_by_stock',
  'tactic_signals_by_tactic',
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
  // v0.6 新增：股票池 CRUD + 触发落库
  'list_stock_pools',
  'list_watch_plans',
  'create_stock_pool',
  'update_stock_pool',
  'delete_stock_pool',
  'save_watch_trigger',
  'list_watch_triggers',
  'get_watch_status',
  'record_watch_run',
  // 分组化（阶段 B）新增：分组 CRUD + 刷新 + LLM 解析
  'list_stock_groups',
  'get_stock_group',
  'create_stock_group',
  'update_stock_group',
  'delete_stock_group',
  'add_group_member',
  'refresh_stock_group',
  'resolve_llm_group',
  // v0.7 策略预警（docs/ddd/strategy-alert-detailed-design.md §9.2）新增
  'set_watch_trigger_feedback',
  // ruo 迁移 Phase 1（docs/ddd/ruo-feature-migration-detailed-design.md §7）
  'list_research_notes',
  'add_research_note',
  'update_research_note',
  'delete_research_note',
  'list_stock_events',
  'add_stock_event',
  'update_stock_event',
  'delete_stock_event',
  'sync_stock_events',
  'sync_stock_universe',
  'get_market_data_status',
  'list_workflow_runs',
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
      'market_outlook',
      'resolve_llm_group',
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
      'fetch_quote',
      'get_stock_market_view',
      'refresh_stock_group',
      'send_notification',
      'sync_daily_bars',
      'sync_quotes',
      'sync_stock_events',
      'sync_stock_universe',
    ]);
    const writeTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'write')
      .map((t) => t.name)
      .sort();
    expect(writeTools).toEqual([
      'add_group_member',
      'add_holding',
      'add_research_note',
      'add_stock_event',
      'add_trade',
      'append_chat_message',
      'close_holding',
      'create_account',
      'create_chat_session',
      'create_stock_group',
      'create_stock_pool',
      'delete_chat_session',
      'delete_research_note',
      'delete_stock_event',
      'delete_stock_group',
      'delete_stock_pool',
      'record_advice_outcome',
      'record_watch_run',
      'rename_chat_session',
      'save_watch_trigger',
      'set_watch_trigger_feedback',
      'update_holding',
      'update_research_note',
      'update_stock_event',
      'update_stock_group',
      'update_stock_pool',
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
