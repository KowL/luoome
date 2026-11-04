import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertSectorMembershipSnapshotInvariants,
  GetStockSectorMembershipsQuerySchema,
  SectorMembershipSnapshotSchema,
} from './sector-membership.js';

const mkSnapshot = () =>
  SectorMembershipSnapshotSchema.parse({
    total: 2,
    source: 'fuyao',
    items: [
      {
        stockId: '600519.SH',
        memberships: [
          { sectorCode: '881273.TI', sectorName: '白酒', type: 'industry' },
          { sectorCode: '885338.TI', type: 'cn_concept' },
        ],
      },
      { stockId: '830799.BJ', memberships: [] },
    ],
    warnings: [],
    fetchedAt: '2026-11-04T01:00:00.000Z',
    contentHash: '0123456789abcdef',
  });

describe('SectorMembershipSnapshotSchema', () => {
  it('接受 .TI 身份、缺名归属与空关系组；fetchedAt 强制转 Date', () => {
    const snapshot = mkSnapshot();
    expect(snapshot.items[0]?.memberships[0]?.sectorCode).toBe('881273.TI');
    expect(snapshot.items[0]?.memberships[1]?.sectorName).toBeUndefined();
    expect(snapshot.items[1]?.memberships).toEqual([]);
    expect(snapshot.fetchedAt).toBeInstanceOf(Date);
  });

  it('拒绝非法 type / 空 sectorCode / 空 sectorName / 空 contentHash', () => {
    const base = mkSnapshot();
    expect(() =>
      SectorMembershipSnapshotSchema.parse({
        ...base,
        items: [
          {
            stockId: '600519.SH',
            memberships: [{ sectorCode: '881273.TI', type: 'unknown' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      SectorMembershipSnapshotSchema.parse({
        ...base,
        items: [{ stockId: '600519.SH', memberships: [{ sectorCode: '', type: 'industry' }] }],
      }),
    ).toThrow();
    expect(() =>
      SectorMembershipSnapshotSchema.parse({
        ...base,
        items: [
          {
            stockId: '600519.SH',
            memberships: [{ sectorCode: '881273.TI', sectorName: '', type: 'industry' }],
          },
        ],
      }),
    ).toThrow();
    expect(() => SectorMembershipSnapshotSchema.parse({ ...base, contentHash: '' })).toThrow();
  });
});

describe('GetStockSectorMembershipsQuerySchema', () => {
  it('stockIds 1–100 只；代码必须带交易所后缀；type/source 可选', () => {
    const parsed = GetStockSectorMembershipsQuerySchema.parse({ stockIds: ['600519.SH'] });
    expect(parsed.type).toBeUndefined();
    expect(parsed.source).toBeUndefined();

    expect(() => GetStockSectorMembershipsQuerySchema.parse({ stockIds: [] })).toThrow();
    expect(() =>
      GetStockSectorMembershipsQuerySchema.parse({
        stockIds: Array.from({ length: 101 }, (_, i) => `6005${String(i).padStart(2, '0')}.SH`),
      }),
    ).toThrow();
    expect(() => GetStockSectorMembershipsQuerySchema.parse({ stockIds: ['600519'] })).toThrow();
    expect(() =>
      GetStockSectorMembershipsQuerySchema.parse({ stockIds: ['600519.SH'], type: 'concept' }),
    ).toThrow();
  });
});

describe('assertSectorMembershipSnapshotInvariants', () => {
  it('items 必须与请求一一对应（同长度、同顺序、同代码）', () => {
    const snapshot = mkSnapshot();
    expect(() =>
      assertSectorMembershipSnapshotInvariants(snapshot, ['600519.SH', '830799.BJ']),
    ).not.toThrow();

    expect(() => assertSectorMembershipSnapshotInvariants(snapshot, ['600519.SH'])).toThrow(
      InvariantError,
    );
    expect(() =>
      assertSectorMembershipSnapshotInvariants(snapshot, ['830799.BJ', '600519.SH']),
    ).toThrow(InvariantError);
  });

  it('total 必须等于 items.length；entry 代码非空', () => {
    const snapshot = mkSnapshot();
    expect(() =>
      assertSectorMembershipSnapshotInvariants({ ...snapshot, total: 3 }, [
        '600519.SH',
        '830799.BJ',
      ]),
    ).toThrow(InvariantError);
  });
});
