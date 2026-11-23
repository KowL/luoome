import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { deriveOpeningFact, OPEN_FLAT_TOLERANCE_PCT } from './stock-facts.js';

describe('stock-facts/deriveOpeningFact', () => {
  it('开盘 1475.35 / 昨收 1485.75 判为低开', () => {
    const fact = deriveOpeningFact({ open: money(1475.35), prevClose: money(1485.75) });
    expect(fact.status).toBe('ok');
    if (fact.status !== 'ok') return;
    expect(fact.data.label).toBe('低开');
    expect(fact.data.direction).toBe('low');
    expect(fact.data.openChangePct).toBeCloseTo(-0.7, 3);
  });

  it('平开容差边界只吸收 0.1% 以内噪声', () => {
    const flat = deriveOpeningFact({ open: money(100.1), prevClose: money(100) });
    const high = deriveOpeningFact({ open: money(100.11), prevClose: money(100) });
    expect(flat.status === 'ok' && flat.data.label).toBe('平开');
    expect(high.status === 'ok' && high.data.label).toBe('高开');
    expect(OPEN_FLAT_TOLERANCE_PCT).toBe(0.1);
  });

  it('缺昨收时不可用，不用开盘价顶替', () => {
    const fact = deriveOpeningFact({ open: money(10) });
    expect(fact).toEqual({
      status: 'unavailable',
      reason: '缺少上一交易日收盘价，无法判断开盘方向',
    });
  });
});
