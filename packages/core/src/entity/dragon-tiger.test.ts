import { describe, expect, it } from 'vitest';

import {
  assertDragonTigerListInvariants,
  type DragonTigerEntry,
  DragonTigerEntrySchema,
  type DragonTigerList,
  DragonTigerListQuerySchema,
  DragonTigerListSchema,
} from './dragon-tiger.js';

const makeEntry = (overrides: Partial<DragonTigerEntry> = {}): DragonTigerEntry => ({
  code: '600547',
  name: '山东黄金',
  close: 37.05,
  changePct: 0.049575,
  turnoverRate: 0.041323,
  reason: '日涨幅偏离值达7%的证券',
  netAmount: 855648751.87,
  buyAmount: 3371674861.76,
  sellAmount: 2516026109.89,
  amount: 17302349779,
  tradeDate: '2026-08-21',
  ...overrides,
});

const makeList = (overrides: Partial<DragonTigerList> = {}): DragonTigerList => ({
  date: '2026-08-21',
  total: 1,
  source: 'eastmoney',
  entries: [makeEntry()],
  warnings: [],
  asOf: new Date('2026-08-21T10:00:00Z'),
  ...overrides,
});

describe('DragonTigerEntrySchema', () => {
  it('合法输入通过（netAmount 可为负）', () => {
    expect(DragonTigerEntrySchema.safeParse(makeEntry()).success).toBe(true);
    expect(DragonTigerEntrySchema.safeParse(makeEntry({ netAmount: -100 })).success).toBe(true);
    expect(
      DragonTigerEntrySchema.safeParse(
        makeEntry({
          buySeats: [{ name: '沪股通专用', amount: 1000 }],
          sellSeats: [{ name: '机构专用', amount: 800 }],
        }),
      ).success,
    ).toBe(true);
  });

  it('非法 code / close / changePct 拒绝', () => {
    expect(DragonTigerEntrySchema.safeParse(makeEntry({ code: 'abc' })).success).toBe(false);
    expect(DragonTigerEntrySchema.safeParse(makeEntry({ close: 0 })).success).toBe(false);
    expect(DragonTigerEntrySchema.safeParse(makeEntry({ changePct: 11 })).success).toBe(false);
  });
});

describe('DragonTigerListQuerySchema', () => {
  it('date 缺省合法；source 为可选路由约束（未传 = 按配置顺序）', () => {
    const r = DragonTigerListQuerySchema.parse({});
    expect(r.date).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  it('非法 date 拒绝', () => {
    expect(DragonTigerListQuerySchema.safeParse({ date: '2026/08/21' }).success).toBe(false);
  });
});

describe('DragonTigerListSchema', () => {
  it('合法快照通过', () => {
    expect(DragonTigerListSchema.safeParse(makeList()).success).toBe(true);
  });
});

describe('assertDragonTigerListInvariants', () => {
  it('合法快照不抛错', () => {
    expect(() => assertDragonTigerListInvariants(makeList(), '2026-08-21')).not.toThrow();
  });

  it('total != entries.length 抛 InvariantError', () => {
    expect(() => assertDragonTigerListInvariants(makeList({ total: 2 }))).toThrow(/total/);
  });

  it('entry.tradeDate 与基准日不一致抛 InvariantError', () => {
    const list = makeList({ entries: [makeEntry({ tradeDate: '2026-08-20' })] });
    expect(() => assertDragonTigerListInvariants(list, '2026-08-21')).toThrow(/tradeDate/);
  });
});
