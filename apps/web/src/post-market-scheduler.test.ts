import { describe, expect, it } from 'vitest';

import { duePostMarketTradingDay } from './post-market-scheduler.js';

describe('duePostMarketTradingDay', () => {
  it('盘后窗口内的交易日返回交易日 key', () => {
    // 2026-11-12 16:05 北京 = 08:05 UTC，周四
    expect(duePostMarketTradingDay(new Date('2026-11-12T08:05:00.000Z'))).toBe('2026-11-12');
  });

  it('未到收盘后小时不触发', () => {
    expect(duePostMarketTradingDay(new Date('2026-11-12T07:00:00.000Z'))).toBeNull();
  });

  it('周末与节假日不触发', () => {
    expect(duePostMarketTradingDay(new Date('2026-11-14T08:05:00.000Z'))).toBeNull();
    expect(duePostMarketTradingDay(new Date('2026-10-01T08:05:00.000Z'))).toBeNull();
  });
});
