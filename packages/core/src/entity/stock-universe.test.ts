import { describe, expect, it } from 'vitest';

import { deriveStStatus, StockUniverseSnapshotSchema } from './stock-universe.js';

describe('StockUniverseSnapshotSchema', () => {
  it('accepts a complete non-empty Shanghai/Shenzhen A-share snapshot', () => {
    const snapshot = StockUniverseSnapshotSchema.parse({
      source: 'eastmoney',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: '2026-07-28T08:20:00.000Z',
      complete: true,
      reportedTotal: 2,
      entries: [
        {
          stockId: '600519.SH',
          code: '600519',
          exchange: 'SH',
          name: '贵州茅台',
          listingStatus: 'listed',
        },
        {
          stockId: '002594.SZ',
          code: '002594',
          exchange: 'SZ',
          name: '比亚迪',
          listingStatus: 'listed',
        },
      ],
    });

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.observedAt).toEqual(new Date('2026-07-28T08:20:00.000Z'));
  });

  it('rejects an empty or incomplete snapshot', () => {
    const base = {
      source: 'eastmoney',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: new Date('2026-07-28T08:20:00.000Z'),
      reportedTotal: 0,
      entries: [],
    };

    expect(() => StockUniverseSnapshotSchema.parse({ ...base, complete: true })).toThrow();
    expect(() =>
      StockUniverseSnapshotSchema.parse({
        ...base,
        complete: false,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519',
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects duplicate identities and stockId/exchange mismatches', () => {
    const base = {
      source: 'eastmoney',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt: new Date('2026-07-28T08:20:00.000Z'),
      complete: true,
      reportedTotal: 2,
    };

    expect(() =>
      StockUniverseSnapshotSchema.parse({
        ...base,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519',
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
          {
            stockId: '600519.SH',
            code: '600519',
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      StockUniverseSnapshotSchema.parse({
        ...base,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SZ',
            code: '600519',
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('T22 deriveStStatus', () => {
  it('按同步时点名称派生 ST；股改旧前缀不猜', () => {
    expect(deriveStStatus('ST康美')).toBe('st');
    expect(deriveStStatus('*ST海航')).toBe('st');
    expect(deriveStStatus('贵州茅台')).toBe('non-st');
    expect(deriveStStatus('S*ST长油')).toBe('unknown');
    expect(deriveStStatus('SST天海')).toBe('unknown');
  });
});
