import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { numericAuditViolations } from './numeric-audit.js';
import { deriveOpeningFact } from './stock-facts.js';

const factPack = (overrides: Record<string, unknown> = {}) => ({
  quote: { open: money(104), close: money(105.8), prevClose: money(105.8) },
  indicators: { ma20: 100, high20: 108, low20: 96 },
  opening: deriveOpeningFact({ open: money(104), prevClose: money(105.8) }),
  ...overrides,
});

const audit = (premise: string, facts: unknown = factPack(), availableFields: string[] = []) =>
  numericAuditViolations({
    output: {
      decision: 'hold',
      confidence: 55,
      horizon: 'short',
      reasoning: { premise, evidence: [], counterEvidence: [] },
      risks: [],
    },
    facts,
    availableFields,
  });

describe('numeric-audit', () => {
  it('开盘 1475.35 / 昨收 1485.75 判低开，输出「高开」被拦截', () => {
    const facts = {
      quote: { open: money(1475.35), close: money(1480), prevClose: money(1485.75) },
      indicators: { ma20: 1470 },
      opening: deriveOpeningFact({ open: money(1475.35), prevClose: money(1485.75) }),
    };
    const violations = audit('今日高开，随后回落到 1475.35 附近。', facts);
    expect(violations.join('\n')).toContain('开盘方向与事实不符');
    expect(violations.join('\n')).toContain('低开');
  });

  it('编造数字被判违规，事实数字与其派生值通过', () => {
    expect(audit('收盘 105.8，较昨收变动 0%。')).toEqual([]);
    expect(audit('目标看到 1234.56。').join('\n')).toContain('未在事实包或可派生范围内出现');
  });

  it('0.5% 容差边界：100.5 通过，100.51 违规', () => {
    expect(audit('参考价 100.5。').some((item) => item.includes('未在事实包'))).toBe(false);
    expect(audit('参考价 100.51。').join('\n')).toContain('未在事实包或可派生范围内出现');
  });

  it.each(['建仓', '加仓', '减仓', '清仓', '买入', '卖出'])('操作动词「%s」判违规', (verb) => {
    expect(audit(`当前条件支持${verb}。`).join('\n')).toContain('操作动词');
  });

  it('引用不可用指标被拦截，可用指标不误杀', () => {
    expect(audit('MACD 金叉，MA60 走平。').join('\n')).toContain('不可用的指标 MACD');
    expect(audit('MACD 金叉，MA60 走平。', factPack(), ['macdHist', 'ma60'])).toEqual([]);
  });

  it('涨跌方向必须与当日事实一致', () => {
    const facts = factPack({
      quote: { open: money(100), close: money(102), prevClose: money(100) },
    });
    expect(audit('今日上涨 2%。', facts)).toEqual([]);
    expect(audit('今日下跌 2%。', facts).join('\n')).toContain('涨跌方向与事实不符');
  });

  it('指标周期等结构性数字由字段名提供，不当成编造', () => {
    expect(audit('近 20 日均量为 100。')).toEqual([]);
  });
});
