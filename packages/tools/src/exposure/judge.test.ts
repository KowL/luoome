import type { SideEffect } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import {
  assertSurfaceSelection,
  assertTradeNeverExposed,
  capabilitiesOf,
  capabilitiesSatisfied,
  declaresTrade,
  type ExposureCriteriaSpec,
  exposureCriteria,
  isNameAllowed,
  isNameDenied,
  isPrivateResearchTool,
  type JudgedTool,
  judgeTool,
  judgeTools,
  privateResearchTools,
  selectExposedTools,
  TRADE_EXPOSURE_MESSAGE,
  tradeExposureRequested,
} from './judge.js';

const tool = (
  name: string,
  sideEffect: SideEffect,
  requiredCapabilities?: readonly SideEffect[],
): JudgedTool => ({
  name,
  sideEffect,
  ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
});

/** 只读面 criteria 的便捷构造：默认 allowedSideEffects=['read']，其余按需覆盖。 */
const readCriteria = (
  patch: Omit<ExposureCriteriaSpec, 'allowedSideEffects'> = {},
): ReturnType<typeof exposureCriteria> =>
  exposureCriteria({ allowedSideEffects: ['read'], ...patch });

describe('exposure/judge · 纯数据谓词', () => {
  it('私人研究按精确名字判定，不做子串归类', () => {
    for (const name of privateResearchTools) expect(isPrivateResearchTool(name)).toBe(true);
    expect(isPrivateResearchTool('research_health_check')).toBe(false);
    expect(isPrivateResearchTool('get_stock_research_view_v2')).toBe(false);
  });

  it('trade 声明：sideEffect 是 trade 或任一 required capability 是 trade', () => {
    expect(declaresTrade(tool('a', 'trade'))).toBe(true);
    expect(declaresTrade(tool('b', 'write', ['write', 'trade']))).toBe(true);
    expect(declaresTrade(tool('c', 'read'))).toBe(false);
    expect(capabilitiesOf(tool('c', 'read'))).toEqual(['read']);
    expect(capabilitiesOf(tool('d', 'external', ['external', 'write']))).toEqual([
      'external',
      'write',
    ]);
  });

  it('名字闸门：allowlist 缺省是全收，空集合是一个不收', () => {
    expect(isNameAllowed('x', undefined)).toBe(true);
    expect(isNameAllowed('x', new Set())).toBe(false);
    expect(isNameAllowed('x', new Set(['x']))).toBe(true);
    expect(isNameDenied('x', undefined)).toBe(false);
    expect(isNameDenied('x', new Set(['x']))).toBe(true);
  });

  it('能力闸门是「每个都满足」，不做降级', () => {
    expect(capabilitiesSatisfied(['read'], new Set<SideEffect>(['read']))).toBe(true);
    expect(capabilitiesSatisfied(['external', 'write'], new Set<SideEffect>(['external']))).toBe(
      false,
    );
  });

  it('trade 开关只认严格字符串 true', () => {
    expect(tradeExposureRequested('true')).toBe(true);
    expect(tradeExposureRequested(undefined, 'TRUE')).toBe(false);
    expect(tradeExposureRequested('1')).toBe(false);
    expect(() => assertTradeNeverExposed('true')).toThrow(TRADE_EXPOSURE_MESSAGE);
    expect(() => assertTradeNeverExposed(undefined, 'false')).not.toThrow();
  });
});

describe('exposure/judge · 判定与拒绝原因', () => {
  it('五条规则按固定顺序给出原因', () => {
    const criteria = readCriteria({
      allowlist: ['denylisted_name', privateResearchTools[0], 'plain_read'],
      denylist: ['denylisted_name'],
    });
    expect(judgeTool(tool('trade_tool', 'trade'), criteria)).toEqual({
      exposed: false,
      reason: 'trade',
    });
    expect(judgeTool(tool('write_tool', 'write'), criteria)).toEqual({
      exposed: false,
      reason: 'not-in-allowlist',
    });
    expect(judgeTool(tool('denylisted_name', 'read'), criteria)).toEqual({
      exposed: false,
      reason: 'denylisted',
    });
    expect(judgeTool(tool(privateResearchTools[0], 'read'), criteria)).toEqual({
      exposed: false,
      reason: 'private-research',
    });
    expect(
      judgeTool(tool('multi_capability', 'external', ['external', 'write']), readCriteria()),
    ).toEqual({ exposed: false, reason: 'capability-not-allowed' });
    expect(judgeTool(tool('plain_read', 'read'), criteria)).toEqual({ exposed: true });
  });

  it('trade 不可被任何放行集合解释成其他原因', () => {
    expect(judgeTool(tool('t', 'trade'), readCriteria({ allowlist: ['t'] }))).toEqual({
      exposed: false,
      reason: 'trade',
    });
  });

  it('私人研究只有显式 opt-in 才暴露（fail-closed）', () => {
    const name = privateResearchTools[0];
    expect(judgeTool(tool(name, 'read'), readCriteria()).exposed).toBe(false);
    expect(judgeTool(tool(name, 'read'), readCriteria({ exposeResearch: true })).exposed).toBe(
      true,
    );
  });

  it('judgeTools 与 selectExposedTools 同源：拒绝集合一致、顺序保持入参顺序', () => {
    const tools = [
      tool('b_read', 'read'),
      tool('a_write', 'write'),
      tool('c_read', 'read'),
    ] as const;
    const criteria = exposureCriteria({ allowedSideEffects: ['read'] });
    expect(judgeTools(tools, criteria).map((item) => [item.name, item.verdict.exposed])).toEqual([
      ['b_read', true],
      ['a_write', false],
      ['c_read', true],
    ]);
    expect(selectExposedTools(tools, criteria).map((item) => item.name)).toEqual([
      'b_read',
      'c_read',
    ]);
  });

  it('criteria 复制调用方的集合，装配后不受外部改动影响', () => {
    const allowlist = ['a'];
    const allowed = new Set<SideEffect>(['read']);
    const criteria = exposureCriteria({ allowedSideEffects: allowed, allowlist });
    allowlist.push('b');
    allowed.add('write');
    expect(criteria.allowlist?.has('b')).toBe(false);
    expect(criteria.allowedSideEffects.has('write')).toBe(false);
    expect(judgeTool(tool('b', 'read'), criteria)).toEqual({
      exposed: false,
      reason: 'not-in-allowlist',
    });
  });
});

describe('exposure/judge · 装配期 fail-closed 断言', () => {
  const tools = [
    tool('read_tool', 'read'),
    tool('market_tool', 'external'),
    tool('mixed_tool', 'external', ['external', 'write']),
    tool('trade_tool', 'trade'),
  ] as const;

  it('read 面：未知名字 / 非只读 / 组合能力都拒绝装备', () => {
    expect(() =>
      assertSurfaceSelection(['read_tool'], tools, 'read', { label: 'read tool' }),
    ).not.toThrow();
    expect(() =>
      assertSurfaceSelection(['missing'], tools, 'read', { label: 'read tool' }),
    ).toThrow('Unknown configured read tool: missing');
    expect(() =>
      assertSurfaceSelection(['market_tool'], tools, 'read', { label: 'read tool' }),
    ).toThrow('Configured read tool is not read-only: market_tool');
    expect(() =>
      assertSurfaceSelection(['trade_tool'], tools, 'read', { label: 'read tool' }),
    ).toThrow('not read-only');
  });

  it('external 面：只有 external 且能力仅 external 的名字能通过', () => {
    expect(() =>
      assertSurfaceSelection(['market_tool'], tools, 'external', { label: 'market tool' }),
    ).not.toThrow();
    expect(() =>
      assertSurfaceSelection(['read_tool'], tools, 'external', { label: 'market tool' }),
    ).toThrow('Configured market tool is not external: read_tool');
    expect(() =>
      assertSurfaceSelection(['mixed_tool'], tools, 'external', { label: 'market tool' }),
    ).toThrow('Configured market tool requires unsupported capabilities: mixed_tool');
  });
});
