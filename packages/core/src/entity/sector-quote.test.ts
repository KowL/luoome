import { describe, expect, it } from 'vitest';

import {
  assertSectorQuoteListInvariants,
  FetchSectorQuotesQuerySchema,
  type SectorQuoteItem,
  SectorQuoteItemSchema,
  type SectorQuoteList,
  SectorQuoteListSchema,
} from './sector-quote.js';

const makeItem = (overrides: Partial<SectorQuoteItem> = {}): SectorQuoteItem => ({
  code: 'BK0732',
  name: '贵金属',
  price: 2837.18,
  changePct: 0.0599,
  change: 160.26,
  amount: 38_253_089_126,
  upCount: 12,
  downCount: 0,
  leadingStockName: '湖南白银',
  leadingStockCode: '002716',
  leadingStockChangePct: 0.1003,
  ...overrides,
});

const makeList = (overrides: Partial<SectorQuoteList> = {}): SectorQuoteList => ({
  total: 1,
  source: 'eastmoney',
  items: [makeItem()],
  warnings: [],
  asOf: new Date('2026-08-22T03:00:00Z'),
  ...overrides,
});

describe('SectorQuoteItemSchema', () => {
  it('合法输入通过', () => {
    expect(SectorQuoteItemSchema.safeParse(makeItem()).success).toBe(true);
  });

  it('缺领涨股 / 涨跌家数（可选字段）通过', () => {
    const minimal = {
      code: 'BK0732',
      name: '贵金属',
      price: 2837.18,
      changePct: 0.0599,
      change: 160.26,
      amount: 38_253_089_126,
    };
    expect(SectorQuoteItemSchema.safeParse(minimal).success).toBe(true);
  });

  it('空 code/name、price <= 0、amount 为负拒绝', () => {
    expect(SectorQuoteItemSchema.safeParse(makeItem({ code: '' })).success).toBe(false);
    expect(SectorQuoteItemSchema.safeParse(makeItem({ name: '' })).success).toBe(false);
    expect(SectorQuoteItemSchema.safeParse(makeItem({ price: 0 })).success).toBe(false);
    expect(SectorQuoteItemSchema.safeParse(makeItem({ amount: -1 })).success).toBe(false);
  });
});

describe('FetchSectorQuotesQuerySchema', () => {
  it('缺省合法；sort 默认 changePct；limit 默认 50；source 默认 eastmoney', () => {
    const r = FetchSectorQuotesQuerySchema.parse({});
    expect(r.sort).toBe('changePct');
    expect(r.limit).toBe(50);
    expect(r.source).toBe('eastmoney');
  });

  it('非法 sort / limit 越界拒绝', () => {
    expect(FetchSectorQuotesQuerySchema.safeParse({ sort: 'price' }).success).toBe(false);
    expect(FetchSectorQuotesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(FetchSectorQuotesQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});

describe('SectorQuoteListSchema', () => {
  it('合法快照通过', () => {
    expect(SectorQuoteListSchema.safeParse(makeList()).success).toBe(true);
  });
});

describe('assertSectorQuoteListInvariants', () => {
  it('合法快照不抛错', () => {
    expect(() => assertSectorQuoteListInvariants(makeList())).not.toThrow();
  });

  it('total != items.length 抛 InvariantError', () => {
    expect(() => assertSectorQuoteListInvariants(makeList({ total: 2 }))).toThrow(/total/);
  });

  it('changePct 越界抛 InvariantError', () => {
    expect(() =>
      assertSectorQuoteListInvariants(makeList({ items: [makeItem({ changePct: 11 })] })),
    ).toThrow(/changePct/);
  });

  it('upCount/downCount 只给一半抛 InvariantError', () => {
    expect(() =>
      assertSectorQuoteListInvariants(makeList({ items: [makeItem({ downCount: undefined })] })),
    ).toThrow(/upCount\/downCount/);
  });
});
