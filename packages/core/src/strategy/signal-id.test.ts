import { describe, expect, it } from 'vitest';

import { nextStrategySignalId, strategySignalIdAt } from './signal-id.js';

describe('strategy signal id', () => {
  it('是 18–19 位十进制字符串，且严格递增', () => {
    const ids = Array.from({ length: 50 }, () => nextStrategySignalId(1_780_000_000_000));
    for (const id of ids) expect(id).toMatch(/^\d{18,19}$/);
    const sorted = [...ids].sort((left, right) => Number(left) - Number(right));
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('同一毫秒内序列用尽时借用下一毫秒，不产生重复', () => {
    const first = strategySignalIdAt(1_780_000_000_000, 0);
    const second = strategySignalIdAt(1_780_000_000_000, 1);
    expect(second).not.toBe(first);
    expect(BigInt(second) > BigInt(first)).toBe(true);
    // 时间戳左移 22 位：同毫秒的序号只影响低位
    expect(BigInt(second) - BigInt(first)).toBe(1n);
  });

  it('时钟回拨时沿用上一毫秒，id 不倒退', () => {
    const later = nextStrategySignalId(1_780_000_000_100);
    const earlier = nextStrategySignalId(1_780_000_000_000);
    expect(BigInt(earlier) >= BigInt(later)).toBe(true);
  });
});
