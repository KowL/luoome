import { describe, expect, it } from 'vitest';

import { computeMarketSession, nextTradingSessionStart } from './trading-calendar.js';

const shanghai = (yyyyMmDd: string, hour: number, minute = 0): Date =>
  new Date(
    `${yyyyMmDd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );

describe('computeMarketSession', () => {
  it('交易日按上海时间划分时段', () => {
    expect(computeMarketSession(shanghai('2026-07-17', 9, 29))).toBe('pre-open');
    expect(computeMarketSession(shanghai('2026-07-17', 10))).toBe('trading');
    expect(computeMarketSession(shanghai('2026-07-17', 11, 30))).toBe('midday-break');
    expect(computeMarketSession(shanghai('2026-07-17', 13))).toBe('trading');
    expect(computeMarketSession(shanghai('2026-07-17', 15))).toBe('closed');
  });

  it('周末与节假日休市', () => {
    expect(computeMarketSession(shanghai('2026-07-18', 10))).toBe('non-trading-day');
    expect(computeMarketSession(shanghai('2026-10-01', 10))).toBe('non-trading-day');
  });
});

describe('nextTradingSessionStart', () => {
  it('盘前 → 当日 09:30', () => {
    expect(nextTradingSessionStart(shanghai('2026-07-17', 8)).toISOString()).toBe(
      new Date('2026-07-17T09:30:00+08:00').toISOString(),
    );
  });

  it('午休 → 当日 13:00', () => {
    expect(nextTradingSessionStart(shanghai('2026-07-17', 12)).toISOString()).toBe(
      new Date('2026-07-17T13:00:00+08:00').toISOString(),
    );
  });

  it('上午盘中 → 当日 13:00；收盘后 → 下一个交易日 09:30', () => {
    expect(nextTradingSessionStart(shanghai('2026-07-17', 10)).toISOString()).toBe(
      new Date('2026-07-17T13:00:00+08:00').toISOString(),
    );
    expect(nextTradingSessionStart(shanghai('2026-07-17', 16)).toISOString()).toBe(
      new Date('2026-07-20T09:30:00+08:00').toISOString(),
    );
  });

  it('周末 → 周一 09:30', () => {
    expect(nextTradingSessionStart(shanghai('2026-07-18', 10)).toISOString()).toBe(
      new Date('2026-07-20T09:30:00+08:00').toISOString(),
    );
  });

  it('节假日 → 节后首个交易日 09:30', () => {
    expect(nextTradingSessionStart(shanghai('2026-10-01', 10)).toISOString()).toBe(
      new Date('2026-10-08T09:30:00+08:00').toISOString(),
    );
  });
});
