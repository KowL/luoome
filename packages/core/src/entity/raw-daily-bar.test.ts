import { describe, expect, it } from 'vitest';

import { RawDailyBarRevisionSchema } from './raw-daily-bar.js';

const HASH = 'b'.repeat(64);

const base = {
  stockId: '600519.SH',
  date: '2026-11-03T00:00:00.000Z',
  open: 1450,
  high: 1480,
  low: 1435.1,
  close: 1480,
  volume: 7_412_056,
  turnover: 10_825_780_462.63,
  source: 'fuyao',
  dumpId: 'a_share_daily_k_1d_none_10d',
  artifactSha256: HASH,
  recordedAt: '2026-11-03T16:00:00.000Z',
  contentHash: 'c'.repeat(64),
} as const;

describe('RawDailyBarRevisionSchema', () => {
  it('接受完整 raw revision（含 turnover）', () => {
    const bar = RawDailyBarRevisionSchema.parse(base);
    expect(bar.turnover).toBe(10_825_780_462.63);
  });

  it('turnover 允许 null（上游缺失不补 0）', () => {
    const bar = RawDailyBarRevisionSchema.parse({ ...base, turnover: null });
    expect(bar.turnover).toBeNull();
  });

  it('volume 允许 0（停牌占位行保留）', () => {
    const bar = RawDailyBarRevisionSchema.parse({ ...base, volume: 0 });
    expect(bar.volume).toBe(0);
  });

  it('拒绝非正 OHLC', () => {
    expect(() => RawDailyBarRevisionSchema.parse({ ...base, open: 0 })).toThrow();
    expect(() => RawDailyBarRevisionSchema.parse({ ...base, close: -1 })).toThrow();
  });

  it('拒绝 high 低于 open/close、low 高于 open/close', () => {
    expect(() =>
      RawDailyBarRevisionSchema.parse({ ...base, high: 1440, open: 1450, close: 1460 }),
    ).toThrow(/high/);
    expect(() =>
      RawDailyBarRevisionSchema.parse({ ...base, low: 1455, open: 1450, close: 1452 }),
    ).toThrow(/low/);
  });

  it('source 固定 fuyao，contentHash/artifactSha256 必须 sha256 hex', () => {
    expect(() => RawDailyBarRevisionSchema.parse({ ...base, source: 'tushare' })).toThrow();
    expect(() => RawDailyBarRevisionSchema.parse({ ...base, contentHash: 'zz' })).toThrow();
  });
});
