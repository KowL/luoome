import { describe, expect, it } from 'vitest';

import {
  assertNorthboundFlowInvariants,
  type NorthboundFlowEntry,
  NorthboundFlowEntrySchema,
  NorthboundFlowQuerySchema,
  type NorthboundFlowSeries,
  NorthboundFlowSeriesSchema,
} from './northbound-flow.js';

const makeEntry = (overrides: Partial<NorthboundFlowEntry> = {}): NorthboundFlowEntry => ({
  date: '2026-08-21',
  netAmount: null,
  buyAmount: null,
  sellAmount: null,
  dealAmount: 268_087_540_000,
  ...overrides,
});

const makeSeries = (overrides: Partial<NorthboundFlowSeries> = {}): NorthboundFlowSeries => ({
  endDate: '2026-08-21',
  days: 1,
  source: 'eastmoney',
  series: [makeEntry()],
  warnings: [],
  asOf: new Date('2026-08-21T10:00:00Z'),
  ...overrides,
});

describe('NorthboundFlowEntrySchema', () => {
  it('净买入 null（未披露）合法；披露口径下数值合法', () => {
    expect(NorthboundFlowEntrySchema.safeParse(makeEntry()).success).toBe(true);
    expect(
      NorthboundFlowEntrySchema.safeParse(
        makeEntry({ netAmount: 12_753_330_000, buyAmount: 53e9, sellAmount: 40e9 }),
      ).success,
    ).toBe(true);
  });

  it('负成交额拒绝；非法 date 拒绝', () => {
    expect(NorthboundFlowEntrySchema.safeParse(makeEntry({ dealAmount: -1 })).success).toBe(false);
    expect(NorthboundFlowEntrySchema.safeParse(makeEntry({ date: '2026/08/21' })).success).toBe(
      false,
    );
  });
});

describe('NorthboundFlowQuerySchema', () => {
  it('days 默认 30；endDate 缺省合法；source 为可选路由约束（未传 = 按配置顺序）', () => {
    const r = NorthboundFlowQuerySchema.parse({});
    expect(r.days).toBe(30);
    expect(r.endDate).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  it('days 越界 / 非法 endDate 拒绝', () => {
    expect(NorthboundFlowQuerySchema.safeParse({ days: 0 }).success).toBe(false);
    expect(NorthboundFlowQuerySchema.safeParse({ days: 251 }).success).toBe(false);
    expect(NorthboundFlowQuerySchema.safeParse({ endDate: '08-21' }).success).toBe(false);
  });
});

describe('NorthboundFlowSeriesSchema', () => {
  it('合法快照通过', () => {
    expect(NorthboundFlowSeriesSchema.safeParse(makeSeries()).success).toBe(true);
  });
});

describe('assertNorthboundFlowInvariants', () => {
  it('合法快照不抛错', () => {
    expect(() => assertNorthboundFlowInvariants(makeSeries())).not.toThrow();
  });

  it('days != series.length 抛 InvariantError', () => {
    expect(() => assertNorthboundFlowInvariants(makeSeries({ days: 2 }))).toThrow(/days/);
  });

  it('series 非 ASC / 重复日期抛 InvariantError', () => {
    const dup = makeSeries({
      days: 2,
      series: [makeEntry(), makeEntry()],
    });
    expect(() => assertNorthboundFlowInvariants(dup)).toThrow(/ASC/);
  });

  it('披露口径下 net != buy - sell 抛 InvariantError', () => {
    const bad = makeSeries({
      series: [makeEntry({ netAmount: 100, buyAmount: 300, sellAmount: 100 })],
    });
    expect(() => assertNorthboundFlowInvariants(bad)).toThrow(/netAmount/);
  });
});
