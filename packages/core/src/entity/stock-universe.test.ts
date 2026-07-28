import { describe, expect, it } from 'vitest';

import { StockUniverseSnapshotSchema } from './stock-universe.js';

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
