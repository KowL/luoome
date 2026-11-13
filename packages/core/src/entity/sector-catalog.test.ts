import { describe, expect, it } from 'vitest';

import {
  type SectorCatalogEntry,
  SectorCatalogEntrySchema,
  type StockSectorMembership,
  StockSectorMembershipSchema,
} from './sector-catalog.js';

const T1 = new Date('2026-11-02T00:20:00.000Z');
const T2 = new Date('2026-11-03T00:20:00.000Z');

const makeSector = (overrides: Partial<SectorCatalogEntry> = {}): SectorCatalogEntry => ({
  id: '5b0a6e0e-6f43-4e4a-9d1e-3f3f4f5a6b7c',
  kind: 'industry',
  source: 'fuyao',
  vendorCode: '881273.TI',
  name: '白酒',
  state: 'active',
  firstSeenAt: T1,
  lastSeenAt: T2,
  retiredAt: null,
  ...overrides,
});

const makeMembership = (overrides: Partial<StockSectorMembership> = {}): StockSectorMembership => ({
  sectorId: '5b0a6e0e-6f43-4e4a-9d1e-3f3f4f5a6b7c',
  stockId: '600519.SH',
  source: 'fuyao',
  state: 'active',
  memberStatus: 'listed',
  firstSeenAt: T1,
  lastSeenAt: T2,
  missingSince: null,
  ...overrides,
});

describe('SectorCatalogEntrySchema', () => {
  it('内部标识、分类与供应商编码各自独立', () => {
    const parsed = SectorCatalogEntrySchema.parse(makeSector());
    expect(parsed.id).not.toBe(parsed.vendorCode);
    expect(parsed.kind).toBe('industry');
    expect(parsed.vendorCode).toBe('881273.TI');
  });

  it('内部标识不得直接复用供应商编码', () => {
    expect(SectorCatalogEntrySchema.safeParse(makeSector({ id: '881273.TI' })).success).toBe(false);
  });

  it('分类只接受 industry / concept', () => {
    expect(
      SectorCatalogEntrySchema.safeParse({ ...makeSector(), kind: 'region' as never }).success,
    ).toBe(false);
  });

  it('下线条目必须带 retiredAt，active 条目不得携带', () => {
    expect(
      SectorCatalogEntrySchema.safeParse(makeSector({ state: 'retired', retiredAt: T2 })).success,
    ).toBe(true);
    expect(SectorCatalogEntrySchema.safeParse(makeSector({ retiredAt: T2 })).success).toBe(false);
  });

  it('观测时间倒序拒绝', () => {
    expect(
      SectorCatalogEntrySchema.safeParse(makeSector({ firstSeenAt: T2, lastSeenAt: T1 })).success,
    ).toBe(false);
  });
});

describe('StockSectorMembershipSchema', () => {
  it('active 成分不携带 missingSince', () => {
    expect(StockSectorMembershipSchema.safeParse(makeMembership()).success).toBe(true);
    expect(
      StockSectorMembershipSchema.safeParse(makeMembership({ missingSince: T2 })).success,
    ).toBe(false);
  });

  it('missing 成分保留首次观测时间与来源', () => {
    const missing = StockSectorMembershipSchema.parse(
      makeMembership({ state: 'missing', missingSince: T2, memberStatus: 'suspended' }),
    );
    expect(missing.firstSeenAt).toEqual(T1);
    expect(missing.source).toBe('fuyao');
    expect(missing.memberStatus).toBe('suspended');
  });
});
