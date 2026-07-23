import { describe, expect, it } from 'vitest';

import { createRegistry, toolRegistry } from './registry.js';

// 分组化（阶段 B）末态：32 (v0.6) + 7 (stockGroup CRUD / refresh / resolve_llm_group) = 39 tool
const EXPECTED_TOOL_NAMES = [
  // v0.1
  'list_accounts',
  'get_account',
  'list_holdings',
  'get_holding',
  'get_advice',
  'get_advice_stats',
  'analyze_stock',
  'analyze_position',
  // v0.2 新增
  'fetch_quote',
  'batch_quote',
  'sync_quotes',
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
  'create_stock_pool',
  'update_stock_pool',
  'delete_stock_pool',
  'save_watch_trigger',
  // 分组化（阶段 B）新增：分组 CRUD + 刷新 + LLM 解析
  'list_stock_groups',
  'get_stock_group',
  'create_stock_group',
  'update_stock_group',
  'delete_stock_group',
  'refresh_stock_group',
  'resolve_llm_group',
] as const;

describe('toolRegistry', () => {
  it(`注册全部 ${EXPECTED_TOOL_NAMES.length} 个 tool（v0.1 8 + v0.2 新增 5）`, () => {
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
      'batch_quote',
      'fetch_quote',
      'refresh_stock_group',
      'send_notification',
      'sync_quotes',
    ]);
    const writeTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'write')
      .map((t) => t.name)
      .sort();
    expect(writeTools).toEqual([
      'add_holding',
      'add_trade',
      'close_holding',
      'create_stock_group',
      'create_stock_pool',
      'delete_stock_group',
      'delete_stock_pool',
      'record_advice_outcome',
      'save_watch_trigger',
      'update_holding',
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
