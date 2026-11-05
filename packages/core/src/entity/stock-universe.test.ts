import { describe, expect, it } from 'vitest';

import { stockCode } from '../types/branded.js';
import {
  deriveStStatus,
  StockUniverseSnapshotSchema,
  stockUniverseAttributeCoverage,
  stockUniverseMemberAttributeCoverage,
} from './stock-universe.js';

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

describe('PIT 属性覆盖（显式降级）', () => {
  it('只有名称时只声明 stStatus：缺的属性不会静默算成已提供', () => {
    expect(
      stockUniverseAttributeCoverage([
        {
          stockId: '600519.SH',
          code: stockCode('600519'),
          exchange: 'SH',
          name: '贵州茅台',
          listingStatus: 'unknown',
          stStatus: 'non-st',
        },
      ]),
    ).toEqual(['stStatus']);
  });

  it('完整属性快照覆盖上市状态/行业/上市日期/退市日期', () => {
    expect(
      stockUniverseMemberAttributeCoverage([
        {
          listingStatus: 'listed',
          stStatus: 'unknown',
          industry: '白酒',
          listDate: new Date('2001-08-27T00:00:00.000Z'),
        },
        {
          listingStatus: 'delisted',
          stStatus: 'unknown',
          delistDate: new Date('2020-01-01T00:00:00.000Z'),
        },
      ]),
    ).toEqual(['listingStatus', 'industry', 'listDate', 'delistDate']);
  });

  it('全 unknown/NULL 的快照覆盖为空（来源不提供任何 PIT 属性）', () => {
    expect(
      stockUniverseMemberAttributeCoverage([
        { listingStatus: 'unknown', stStatus: 'unknown' },
        { listingStatus: 'unknown', stStatus: 'unknown' },
      ]),
    ).toEqual([]);
  });

  it('snapshot 声明的 attributeCoverage 必须与实际成员属性一致', () => {
    const entries = [
      {
        stockId: '600519.SH' as const,
        code: '600519',
        exchange: 'SH' as const,
        name: '贵州茅台',
        listingStatus: 'listed' as const,
        stStatus: 'non-st' as const,
      },
    ];
    const base = {
      source: 'eastmoney',
      coverage: 'CN_A_SHARES_SH_SZ' as const,
      observedAt: new Date('2026-07-28T08:20:00.000Z'),
      complete: true as const,
      reportedTotal: 1,
      entries,
    };

    expect(
      StockUniverseSnapshotSchema.parse({
        ...base,
        attributeCoverage: ['listingStatus', 'stStatus'],
      }).attributeCoverage,
    ).toEqual(['listingStatus', 'stStatus']);
    expect(() =>
      StockUniverseSnapshotSchema.parse({ ...base, attributeCoverage: ['industry'] }),
    ).toThrow(/attributeCoverage/);
  });
});
