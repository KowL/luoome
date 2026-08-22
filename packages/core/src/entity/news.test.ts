import { describe, expect, it } from 'vitest';

import {
  assertNewsListInvariants,
  FetchNewsQuerySchema,
  inferNewsCategory,
  type NewsItem,
  NewsItemSchema,
  type NewsList,
  NewsListSchema,
} from './news.js';

const makeItem = (overrides: Partial<NewsItem> = {}): NewsItem => ({
  id: 'n1',
  title: '央行宣布降准释放流动性',
  summary: '中国人民银行宣布……',
  category: '宏观',
  source: '人民日报',
  publishedAt: new Date('2026-08-22T10:12:00+08:00'),
  url: 'https://finance.eastmoney.com/a/n1.html',
  ...overrides,
});

const makeList = (overrides: Partial<NewsList> = {}): NewsList => ({
  total: 1,
  source: 'eastmoney',
  items: [makeItem()],
  warnings: [],
  asOf: new Date('2026-08-22T03:00:00Z'),
  ...overrides,
});

describe('inferNewsCategory', () => {
  it.each([
    ['央行宣布降准', '宏观'],
    ['证监会加强退市监管', '监管'],
    ['北向资金大幅流入', '资金'],
    ['美联储加息预期升温', '海外'],
    ['黄金价格创新高', '商品'],
    ['国务院发布新政策意见', '政策'],
    ['某集团公司发布财报', '公司'],
    ['半导体板块产业链景气', '行业'],
    ['A股三大指数收涨', '市场'],
  ])('inferNewsCategory(%j) === %j', (title, expected) => {
    expect(inferNewsCategory(title)).toBe(expected);
  });
});

describe('NewsItemSchema', () => {
  it('合法输入通过（publishedAt coerce）', () => {
    const r = NewsItemSchema.safeParse({
      ...makeItem(),
      publishedAt: '2026-08-22T10:12:00+08:00',
    });
    expect(r.success).toBe(true);
  });

  it('空 title / 非法 category 拒绝', () => {
    expect(NewsItemSchema.safeParse(makeItem({ title: '' })).success).toBe(false);
    expect(NewsItemSchema.safeParse(makeItem({ category: '娱乐' as never })).success).toBe(false);
  });
});

describe('FetchNewsQuerySchema', () => {
  it('缺省合法；limit 默认 30；source 为可选路由约束（未传 = 按配置顺序）', () => {
    const r = FetchNewsQuerySchema.parse({});
    expect(r.limit).toBe(30);
    expect(r.category).toBeUndefined();
    expect(r.keyword).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  it('limit 越界 / 空 keyword 拒绝', () => {
    expect(FetchNewsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(FetchNewsQuerySchema.safeParse({ keyword: '  ' }).success).toBe(false);
  });
});

describe('NewsListSchema', () => {
  it('合法快照通过', () => {
    expect(NewsListSchema.safeParse(makeList()).success).toBe(true);
  });
});

describe('assertNewsListInvariants', () => {
  it('合法快照不抛错', () => {
    expect(() => assertNewsListInvariants(makeList())).not.toThrow();
  });

  it('total != items.length 抛 InvariantError', () => {
    expect(() => assertNewsListInvariants(makeList({ total: 2 }))).toThrow(/total/);
  });

  it('items 非 publishedAt DESC 抛 InvariantError', () => {
    const asc = makeList({
      total: 2,
      items: [
        makeItem({ id: 'a', publishedAt: new Date('2026-08-22T08:00:00+08:00') }),
        makeItem({ id: 'b', publishedAt: new Date('2026-08-22T10:00:00+08:00') }),
      ],
    });
    expect(() => assertNewsListInvariants(asc)).toThrow(/DESC/);
  });
});
