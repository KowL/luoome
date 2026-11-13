import { describe, expect, it } from 'vitest';

import {
  aggregateDragonTigerFlow,
  assertDragonTigerFlowInvariants,
  conceptNamesOf,
  DRAGON_TIGER_UNCLASSIFIED_CONCEPT,
  type DragonTigerFlowDay,
  DragonTigerFlowQuerySchema,
  DragonTigerFlowSchema,
  type DragonTigerFlowStock,
} from './dragon-tiger-flow.js';

const stock = (overrides: Partial<DragonTigerFlowStock> = {}): DragonTigerFlowStock => ({
  code: '600547',
  name: '山东黄金',
  changePct: 0.05,
  netAmount: 100,
  orgNetAmount: 60,
  hotNetAmount: 10,
  buyAmount: 200,
  sellAmount: 100,
  amount: 1000,
  concepts: ['黄金', '有色'],
  ...overrides,
});

const day = (date: string, stocks: DragonTigerFlowStock[]): DragonTigerFlowDay => ({
  date,
  stocks,
});

const aggregate = (days: DragonTigerFlowDay[], tradingDates = days.map((d) => d.date)) =>
  aggregateDragonTigerFlow(days, {
    tradingDates,
    board: 'all',
    rangeDays: 1,
    source: 'fuyao',
    asOf: new Date('2026-11-12T10:00:00.000Z'),
  });

describe('conceptNamesOf', () => {
  it('去空白 / 去重 / 去空；全空 → 未归类', () => {
    expect(conceptNamesOf([' 黄金 ', '黄金', '', '有色'])).toEqual(['黄金', '有色']);
    expect(conceptNamesOf([])).toEqual([DRAGON_TIGER_UNCLASSIFIED_CONCEPT]);
    expect(conceptNamesOf(['   '])).toEqual([DRAGON_TIGER_UNCLASSIFIED_CONCEPT]);
  });
});

describe('aggregateDragonTigerFlow', () => {
  it('一股多概念按概念数等分，概念总额守恒', () => {
    const flow = aggregate([day('2026-11-11', [stock({ netAmount: 100, orgNetAmount: 60 })])]);
    expect(flow.concepts.map((c) => c.name).sort()).toEqual(['有色', '黄金']);
    expect(flow.concepts[0]?.netAmount).toBe(50);
    expect(flow.concepts[1]?.netAmount).toBe(50);
    const sum = flow.concepts.reduce((acc, c) => acc + c.netAmount, 0);
    expect(sum).toBeCloseTo(flow.stats.netAmount, 8);
  });

  it('无概念 -> 未归类桶，仍计入总额', () => {
    const flow = aggregate([day('2026-11-11', [stock({ concepts: [], netAmount: 30 })])]);
    expect(flow.concepts).toHaveLength(1);
    expect(flow.concepts[0]?.name).toBe(DRAGON_TIGER_UNCLASSIFIED_CONCEPT);
    expect(flow.concepts[0]?.netAmount).toBe(30);
  });

  it('区间累计轨迹：逐日累加，缺数据日按 0 计入', () => {
    const flow = aggregate(
      [
        day('2026-11-10', [stock({ netAmount: 100, concepts: ['黄金'] })]),
        day('2026-11-12', [stock({ netAmount: -40, concepts: ['黄金'] })]),
      ],
      ['2026-11-10', '2026-11-11', '2026-11-12'],
    );
    expect(flow.days).toBe(3);
    expect(flow.concepts[0]?.series).toEqual([100, 100, 60]);
    expect(flow.concepts[0]?.netAmount).toBe(60);
    expect(flow.stats.detailCount).toBe(2);
  });

  it('机构 / 游资 / 其他拆解守恒（其他可为负）', () => {
    const flow = aggregate([
      day('2026-11-11', [stock({ netAmount: 100, orgNetAmount: 150, hotNetAmount: -20 })]),
    ]);
    const concept = flow.concepts[0];
    expect(concept?.orgNetAmount).toBe(75);
    expect(concept?.hotNetAmount).toBe(-10);
    expect(concept?.otherNetAmount).toBeCloseTo(50 - 75 + 10, 8);
  });

  it('board=org 只保留机构有净额的股票，拆解在机构榜内部闭合', () => {
    const flow = aggregateDragonTigerFlow(
      [
        day('2026-11-11', [
          stock({ code: '600001', netAmount: 100, orgNetAmount: 40, concepts: ['黄金'] }),
          stock({ code: '600002', netAmount: 200, orgNetAmount: 0, concepts: ['黄金'] }),
        ]),
      ],
      {
        tradingDates: ['2026-11-11'],
        board: 'org',
        rangeDays: 1,
        source: 'fuyao',
        asOf: new Date(),
      },
    );
    expect(flow.stats.stockCount).toBe(1);
    expect(flow.stats.netAmount).toBe(40);
    expect(flow.concepts[0]?.netAmount).toBe(40);
    // 拆解在所选榜单内部闭合：机构榜 = 机构净额，游资 / 其他为 0
    expect(flow.concepts[0]?.orgNetAmount).toBe(40);
    expect(flow.concepts[0]?.hotNetAmount).toBe(0);
    expect(flow.concepts[0]?.otherNetAmount).toBe(0);
  });

  it('同一交易日内重复代码只计一次', () => {
    const flow = aggregate([
      day('2026-11-11', [
        stock({ netAmount: 100, concepts: ['黄金'] }),
        stock({ netAmount: 100, concepts: ['黄金'] }),
      ]),
    ]);
    expect(flow.stats.detailCount).toBe(1);
    expect(flow.concepts[0]?.netAmount).toBe(100);
  });

  it('Top5 集中度 = 绝对净额前五 / 全部绝对净额', () => {
    const flow = aggregate([
      day('2026-11-11', [
        stock({ code: '600001', netAmount: 100, concepts: ['A'] }),
        stock({ code: '600002', netAmount: -30, concepts: ['B'] }),
        stock({ code: '600003', netAmount: 10, concepts: ['C'] }),
      ]),
    ]);
    expect(flow.stats.top5Concentration).toBeCloseTo(140 / 140, 8);
  });

  it('概念按绝对值截断，conceptCount 保留截断前总数', () => {
    const stocks = ['A', 'B', 'C', 'D'].map((name, index) =>
      stock({ code: `60000${index}`, netAmount: 100 - index * 10, concepts: [name] }),
    );
    const flow = aggregateDragonTigerFlow([day('2026-11-11', stocks)], {
      tradingDates: ['2026-11-11'],
      board: 'all',
      rangeDays: 1,
      source: 'fuyao',
      asOf: new Date(),
      maxConcepts: 2,
    });
    expect(flow.concepts.map((c) => c.name)).toEqual(['A', 'B']);
    expect(flow.stats.conceptCount).toBe(4);
  });

  it('概念内个股正负贡献各取 Top N', () => {
    const stocks = [
      stock({ code: '600001', name: '甲', netAmount: 50, concepts: ['黄金'] }),
      stock({ code: '600002', name: '乙', netAmount: -30, concepts: ['黄金'] }),
      stock({ code: '600003', name: '丙', netAmount: 20, concepts: ['黄金'] }),
      stock({ code: '600004', name: '丁', netAmount: -10, concepts: ['黄金'] }),
    ];
    const flow = aggregateDragonTigerFlow([day('2026-11-11', stocks)], {
      tradingDates: ['2026-11-11'],
      board: 'all',
      rangeDays: 1,
      source: 'fuyao',
      asOf: new Date(),
      stocksPerSide: 1,
    });
    expect(flow.concepts[0]?.stocks.map((s) => s.code)).toEqual(['600001', '600002']);
    expect(flow.concepts[0]?.stockCount).toBe(4);
  });

  it('空交易日区间 → 抛 InvariantError（manager 保证至少一个交易日）', () => {
    expect(() => aggregate([], [])).toThrow(/至少需要一个交易日/);
  });

  it('输出通过 schema 与不变量校验', () => {
    const flow = aggregate([
      day('2026-11-10', [stock({ netAmount: 100 })]),
      day('2026-11-11', [stock({ code: '000001', netAmount: -20, concepts: [] })]),
    ]);
    expect(() => DragonTigerFlowSchema.parse(flow)).not.toThrow();
    expect(() => assertDragonTigerFlowInvariants(flow)).not.toThrow();
  });

  it('不变量：series 末项与 netAmount 不一致时抛错', () => {
    const flow = aggregate([day('2026-11-11', [stock()])]);
    const broken = {
      ...flow,
      concepts: flow.concepts.map((c) => ({ ...c, netAmount: (c.netAmount ?? 0) + 1 })),
    };
    expect(() => assertDragonTigerFlowInvariants(broken)).toThrow();
  });
});

describe('DragonTigerFlowQuerySchema', () => {
  it('缺省值：10 日 / 全部榜 / 仅 1 日榜', () => {
    const q = DragonTigerFlowQuerySchema.parse({});
    expect(q).toEqual({ days: 10, board: 'all', rangeDays: 1 });
  });

  it('days 只接受 5 / 10 / 20', () => {
    expect(DragonTigerFlowQuerySchema.parse({ days: 20 }).days).toBe(20);
    expect(() => DragonTigerFlowQuerySchema.parse({ days: 7 })).toThrow();
  });
});
