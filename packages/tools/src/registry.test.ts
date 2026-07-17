import { describe, expect, it } from 'vitest';

import { createRegistry, toolRegistry } from './registry.js';

const EXPECTED_TOOL_NAMES = [
  'list_accounts',
  'get_account',
  'list_holdings',
  'get_holding',
  'get_advice',
  'get_advice_stats',
  'analyze_stock',
  'analyze_position',
] as const;

describe('toolRegistry', () => {
  it('注册全部 8 个 v0.1 tool（6 read + 2 advice）', () => {
    const all = toolRegistry.all();
    expect(all).toHaveLength(8);
    expect(all.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it('get(name) 命中 / 未命中', () => {
    expect(toolRegistry.get('analyze_stock')?.sideEffect).toBe('advice');
    expect(toolRegistry.get('get_advice_stats')?.sideEffect).toBe('read');
    expect(toolRegistry.get('not_a_tool')).toBeUndefined();
  });

  it('AUDIT：工具表不含 trade 副作用（advice × trade 隔离硬约束）', () => {
    for (const tool of toolRegistry.all()) {
      expect(tool.sideEffect).not.toBe('trade');
    }
    const sideEffects = new Set(toolRegistry.all().map((t) => t.sideEffect));
    expect([...sideEffects].sort()).toEqual(['advice', 'read']);
    const adviceTools = toolRegistry
      .all()
      .filter((t) => t.sideEffect === 'advice')
      .map((t) => t.name)
      .sort();
    expect(adviceTools).toEqual(['analyze_position', 'analyze_stock']);
  });

  it('toMCP()：[{ name, description, inputSchema(JSON Schema) }]', () => {
    const mcp = toolRegistry.toMCP();
    expect(mcp).toHaveLength(8);
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
    expect(openai).toHaveLength(8);
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
