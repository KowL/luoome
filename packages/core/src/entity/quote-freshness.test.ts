import { describe, expect, it } from 'vitest';

import { classifyQuoteFreshness, isQuoteFreshnessDegraded } from './quote-freshness.js';

describe('task-30 持仓报价时效分档', () => {
  const now = new Date('2026-11-02T02:00:00.000Z'); // 周一 10:00 Asia/Shanghai（盘中）
  const today = new Date('2026-11-02T01:30:00.000Z'); // 今日 09:30
  const yesterdayClose = new Date('2026-10-30T07:00:00.000Z'); // 上一交易日 15:00
  const threeDaysAgo = new Date('2026-10-28T07:00:00.000Z');

  // ② 验收核心：**同一份昨日数据**，盘前 factual / 盘中 warning。
  it('同一份上一交易日数据：盘前 factual，盘中 warning', () => {
    const preOpen = classifyQuoteFreshness(yesterdayClose, now, 'pre-open');
    expect(preOpen.tier).toBe('prior-session');
    expect(preOpen.tone).toBe('factual');
    expect(preOpen.label).toContain('上一交易日');

    const trading = classifyQuoteFreshness(yesterdayClose, now, 'trading');
    expect(trading.tier).toBe('stale');
    expect(trading.tone).toBe('warning');
  });

  it('当日数据在任何时段都是 live（盘后看到今天的收盘价仍是当日数据）', () => {
    for (const session of ['pre-open', 'trading', 'midday-break', 'closed'] as const) {
      const result = classifyQuoteFreshness(today, now, session);
      expect(result.tier, session).toBe('live');
      expect(result.tone, session).toBe('factual');
    }
  });

  it('更早的日期在任何时段都是 stale', () => {
    for (const session of ['pre-open', 'non-trading-day', 'trading'] as const) {
      const result = classifyQuoteFreshness(threeDaysAgo, now, session);
      expect(result.tier, session).toBe('stale');
      expect(result.tone, session).toBe('warning');
    }
  });

  it('非交易日用上一交易日数据算正常（无需在交易日之外告警）', () => {
    const weekend = new Date('2026-11-01T02:00:00.000Z'); // 周日 10:00
    const fridayClose = new Date('2026-10-30T07:00:00.000Z');
    const result = classifyQuoteFreshness(fridayClose, weekend, 'non-trading-day');
    expect(result.tier).toBe('prior-session');
    expect(result.tone).toBe('factual');
  });

  // ① 时间缺失 ≠ 价格缺失：有价但不知多旧 → unknown + warning。
  it('没有观测时间时是 unknown + warning（不是 live、不是缺席）', () => {
    const result = classifyQuoteFreshness(undefined, now, 'trading');
    expect(result.tier).toBe('unknown');
    expect(result.tone).toBe('warning');
    expect(isQuoteFreshnessDegraded(result)).toBe(true);
  });

  it('只有 stale / unknown 算降级', () => {
    expect(isQuoteFreshnessDegraded(classifyQuoteFreshness(today, now, 'trading'))).toBe(false);
    expect(isQuoteFreshnessDegraded(classifyQuoteFreshness(yesterdayClose, now, 'pre-open'))).toBe(
      false,
    );
    expect(isQuoteFreshnessDegraded(classifyQuoteFreshness(yesterdayClose, now, 'trading'))).toBe(
      true,
    );
  });
});
