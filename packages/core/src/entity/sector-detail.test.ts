import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import type { LimitUpLadder } from './limit-up-ladder.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';
import {
  buildSectorBreadth,
  buildSectorDetail,
  buildSectorDetailEmpty,
  buildSectorLeaderOrder,
  buildSectorMemberDetails,
  SECTOR_TREND_INDEX_FALLBACK_REASON,
  type SectorDetailInput,
} from './sector-detail.js';
import { buildSectorDayMetric } from './sector-intraday-ranking.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const STOCKS = {
  A1: '600001.SH',
  A2: '600002.SH',
  A3: '600003.SH',
  B1: '000001.SZ',
  B2: '000002.SZ',
  B3: '000003.SZ',
} as const;

/** 六个批次：09:35 / 09:45 / 10:00 / 10:05 / 10:10 / 10:15。 */
const POINTS = ['09:35', '09:45', '10:00', '10:05', '10:10', '10:15'] as const;

const PRICES: Readonly<Record<(typeof POINTS)[number], Readonly<Record<string, number>>>> = {
  '09:35': {
    [STOCKS.A1]: 110,
    [STOCKS.A2]: 110,
    [STOCKS.A3]: 110,
    [STOCKS.B1]: 100,
    [STOCKS.B2]: 100,
    [STOCKS.B3]: 100,
  },
  '09:45': {
    [STOCKS.A1]: 111,
    [STOCKS.A2]: 110.5,
    [STOCKS.A3]: 111,
    [STOCKS.B1]: 100,
    [STOCKS.B2]: 100,
    [STOCKS.B3]: 100,
  },
  '10:00': {
    [STOCKS.A1]: 110.5,
    [STOCKS.A2]: 111,
    [STOCKS.A3]: 110.5,
    [STOCKS.B1]: 100.2,
    [STOCKS.B2]: 100.2,
    [STOCKS.B3]: 100.2,
  },
  '10:05': {
    [STOCKS.A1]: 110,
    [STOCKS.A2]: 111,
    [STOCKS.A3]: 110,
    [STOCKS.B1]: 101.5,
    [STOCKS.B2]: 101.5,
    [STOCKS.B3]: 101.5,
  },
  '10:10': {
    [STOCKS.A1]: 109.5,
    [STOCKS.A2]: 110.5,
    [STOCKS.A3]: 109.5,
    [STOCKS.B1]: 103,
    [STOCKS.B2]: 103,
    [STOCKS.B3]: 103,
  },
  '10:15': {
    [STOCKS.A1]: 109,
    [STOCKS.A2]: 110,
    [STOCKS.A3]: 99,
    [STOCKS.B1]: 104,
    [STOCKS.B2]: 104,
    [STOCKS.B3]: 104,
  },
};

const AMOUNT_PROGRESS: readonly number[] = [0.2, 0.35, 0.5, 0.6, 0.75, 0.9];
const BASE_AMOUNT: Readonly<Record<string, number>> = {
  [STOCKS.A1]: 1_000,
  [STOCKS.A2]: 1_000,
  [STOCKS.A3]: 1_000,
  [STOCKS.B1]: 2_000,
  [STOCKS.B2]: 2_000,
  [STOCKS.B3]: 2_000,
};

const item = (
  stockId: string,
  close: number,
  amount: number,
  changePct: number,
): MarketSnapshotItem => ({
  id: stockId,
  code: stockId.split('.')[0] as string,
  exchange: stockId.endsWith('.SH') ? 'SH' : 'SZ',
  name: `股票${stockId.slice(0, 6)}`,
  close,
  changePct,
  amount,
});

const itemsAt = (
  pointIndex: number,
  options: { readonly omitA3?: boolean; readonly omitSectorA?: boolean } = {},
): MarketSnapshotItem[] => {
  const point = POINTS[pointIndex] as (typeof POINTS)[number];
  const prices = PRICES[point];
  return Object.entries(prices)
    .filter(([stockId]) => {
      if (options.omitSectorA === true && stockId.startsWith('600')) return false;
      if (options.omitA3 === true && stockId === STOCKS.A3) return false;
      return true;
    })
    .map(([stockId, close]) =>
      item(
        stockId,
        close,
        Math.round((BASE_AMOUNT[stockId] ?? 0) * (AMOUNT_PROGRESS[pointIndex] ?? 0)),
        Math.round((close - 100) * 100) / 100,
      ),
    );
};

const batchAt = (
  pointIndex: number,
  options: { readonly omitA3?: boolean; readonly omitSectorA?: boolean } = {},
) => {
  const point = POINTS[pointIndex] as (typeof POINTS)[number];
  const items = itemsAt(pointIndex, options);
  return buildMarketSnapshotBatch({
    sampledAt: at(point),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'sector-detail-fixture',
      fetchedAt: at(point),
      items,
      completeness: {
        expectedCount:
          options.omitA3 === true || options.omitSectorA === true ? items.length + 1 : items.length,
        receivedCount: items.length,
        missingCount: options.omitA3 === true || options.omitSectorA === true ? 1 : 0,
        duplicateCount: 0,
        complete: options.omitA3 !== true && options.omitSectorA !== true,
      },
    },
  });
};

const sectorOf = (
  id: string,
  vendorCode: string,
  name: string,
  kind: SectorCatalogEntry['kind'] = 'industry',
): SectorCatalogEntry => ({
  id,
  kind,
  source: 'fuyao',
  vendorCode,
  name,
  state: 'active',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:00'),
  retiredAt: null,
});

const SECTOR_A = sectorOf('sector-a', '881001.TI', '领涨行业');
const SECTOR_B = sectorOf('sector-b', '881002.TI', '接力行业');
const CONCEPT_C = sectorOf('sector-c', '886001.TI', '重叠概念', 'concept');

const memberOf = (
  sectorId: string,
  stockId: string,
  memberStatus: StockSectorMembership['memberStatus'] = 'listed',
): StockSectorMembership => ({
  sectorId,
  stockId,
  source: 'fuyao',
  state: 'active',
  memberStatus,
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:00'),
  missingSince: null,
});

const MEMBERS: readonly StockSectorMembership[] = [
  memberOf(SECTOR_A.id, STOCKS.A1),
  memberOf(SECTOR_A.id, STOCKS.A2, 'suspended'),
  memberOf(SECTOR_A.id, STOCKS.A3),
  memberOf(SECTOR_B.id, STOCKS.B1),
  memberOf(SECTOR_B.id, STOCKS.B2),
  memberOf(SECTOR_B.id, STOCKS.B3),
  memberOf(CONCEPT_C.id, STOCKS.A1),
  memberOf(CONCEPT_C.id, STOCKS.B1),
];

const membersBySector = (): Map<string, readonly StockSectorMembership[]> => {
  const map = new Map<string, StockSectorMembership[]>();
  for (const membership of MEMBERS) {
    const list = map.get(membership.sectorId) ?? [];
    list.push(membership);
    map.set(membership.sectorId, list);
  }
  return map;
};

const ladderEntry = (code: string) => ({
  code,
  name: code,
  industry: 'fixture',
  ladderLevel: 2,
  uncategorized: false,
  firstTime: '09:35:00',
  finalTime: '09:35:00',
  reason: 'fixture',
  price: 11,
  rawClose: 11,
  corrected: false,
  changePct: 0.1,
  limitUpDate: TRADING_DATE,
  board: 'main_board' as const,
});

const LADDER: LimitUpLadder = {
  date: TRADING_DATE,
  total: 1,
  maxLevel: 2,
  source: 'eastmoney',
  levels: [{ level: 2, name: '二板', count: 1, stocks: [ladderEntry('600001')] }],
  warnings: [],
  asOf: at('10:15'),
};

const detailInput = (overrides: Partial<SectorDetailInput> = {}): SectorDetailInput => ({
  sector: SECTOR_A,
  comparisons: [SECTOR_B, CONCEPT_C],
  unresolvedSectorIds: [],
  membersBySector: membersBySector(),
  batches: POINTS.map((_, index) => batchAt(index)),
  window: 'w5',
  windowStarts: { w5: batchAt(4), w15: batchAt(2) },
  limitUp: LADDER,
  limitUpError: null,
  ...overrides,
});

const detailOf = (overrides: Partial<SectorDetailInput> = {}) =>
  buildSectorDetail(detailInput(overrides));

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('expected value');
  return value;
};

describe('板块走势（成分等权合成）', () => {
  it('归一化到首个样本 = 100，逐时点等权合成并保留每个时点的样本口径', () => {
    const detail = detailOf();
    const trend = detail.trend;

    expect(trend?.method).toBe('constituent_equal_weight');
    expect(trend?.methodNote).toContain('成分等权合成');
    expect(trend?.indexFallbackReason).toBe(SECTOR_TREND_INDEX_FALLBACK_REASON);
    expect(trend?.indexFallbackReason).toContain('fetchIndexQuotes');
    expect(trend?.indexFallbackReason).toContain('不用大盘指数冒充');
    expect(trend?.coverage).toMatchObject({
      batchCount: 6,
      pointCount: 6,
      availablePointCount: 6,
      missingPointCount: 0,
      firstSampledAt: at('09:35'),
      baseSampledAt: at('09:35'),
      lastSampledAt: at('10:15'),
    });
    expect(trend?.points[0]?.value).toBe(100);
    expect(trend?.points[5]?.value).toBeCloseTo(((109 / 110 + 99 / 110) / 2) * 100, 4);
    expect(trend?.points.map((point) => point.sampledAt)).toEqual(POINTS.map((point) => at(point)));
    expect(trend?.points.every((point) => point.sampleCount === 2)).toBe(true);
    expect(trend?.points.every((point) => point.nonTradableCount === 1)).toBe(true);
  });

  it('对照概念使用同一批基准时点，各自归一化后并列；口径差异进 notes', () => {
    const detail = detailOf();
    expect(detail.comparisons.map((series) => series.name)).toEqual(['接力行业', '重叠概念']);
    expect(detail.comparisons[0]?.points[0]?.value).toBe(100);
    expect(detail.comparisons[0]?.points[5]?.value).toBe(104);
    expect(detail.comparisons[1]?.points[0]?.value).toBe(100);
    expect(detail.comparisons[1]?.points[5]?.value).toBeCloseTo(
      ((109 / 110 + 104 / 100) / 2) * 100,
      4,
    );
    expect(detail.notes.join(' ')).toContain('成分等权合成');
    expect(detail.notes.join(' ')).toContain('各自归一化');
  });

  it('基准批次缺失时后续批次才成为 100，之前时点写缺失而不是补 100', () => {
    const batches = POINTS.map((_, index) => batchAt(index, { omitSectorA: index === 0 }));
    const detail = detailOf({ batches });
    const trend = detail.trend;
    expect(trend?.points[0]?.value).toBeNull();
    expect(trend?.points[0]?.status).toBe('unavailable');
    expect(trend?.points[0]?.warnings.join(' ')).toContain('missing_trend_base');
    expect(trend?.points[1]?.value).toBe(100);
    expect(trend?.coverage.baseSampledAt).toEqual(at('09:45'));
    expect(trend?.coverage.availablePointCount).toBe(5);
    expect(trend?.coverage.missingPointCount).toBe(1);
  });

  it('某一时点缺成分时仍给出值但标注缺失与样本不足，不把缺失写成 0', () => {
    const batches = POINTS.map((_, index) => batchAt(index, { omitA3: index === 3 }));
    const detail = detailOf({ batches });
    const point = detail.trend?.points[3];
    expect(point?.value).not.toBeNull();
    expect(point?.sampleCount).toBe(1);
    expect(point?.missingCount).toBe(1);
    expect(point?.nonTradableCount).toBe(1);
    expect(point?.status).toBe('partial');
    expect(point?.warnings.join(' ')).toContain('missing_trend_price');
    expect(point?.warnings.join(' ')).toContain('thin_sample');
    expect(point?.warnings.join(' ')).toContain('batch_incomplete');
  });
});

describe('多板块领先顺序', () => {
  it('逐时点按走势值排名，标记顺序变化时点并保留上一顺序', () => {
    const detail = detailOf();
    const at1000 = detail.leaderOrder.find(
      (point) => point.sampledAt.getTime() === at('10:00').getTime(),
    );
    const at1005 = detail.leaderOrder.find(
      (point) => point.sampledAt.getTime() === at('10:05').getTime(),
    );
    expect(at1000?.entries.map((entry) => entry.name)).toEqual([
      '领涨行业',
      '重叠概念',
      '接力行业',
    ]);
    expect(at1005?.reordered).toBe(true);
    expect(at1005?.entries.map((entry) => [entry.name, entry.rank])).toEqual([
      ['接力行业', 1],
      ['重叠概念', 2],
      ['领涨行业', 3],
    ]);
    expect(at1005?.previousOrder).toEqual([SECTOR_A.id, CONCEPT_C.id, SECTOR_B.id]);
    expect(detail.notes.join(' ')).toContain('不产出事件');
  });

  it('某时点没有样本的板块只出现在 missingSectorIds，不参与排名', () => {
    const batches = POINTS.map((_, index) => batchAt(index, { omitSectorA: index === 2 }));
    const detail = detailOf({ batches });
    const point = detail.leaderOrder[2];
    expect(point?.missingSectorIds).toContain(SECTOR_A.id);
    expect(point?.entries.some((entry) => entry.sectorId === SECTOR_A.id)).toBe(false);
    expect(buildSectorLeaderOrder([])).toEqual([]);
  });
});

describe('成分上涨比例与成分明细', () => {
  it('上涨比例独立于板块日涨幅：50% 与板块等权涨幅并存', () => {
    const day = buildSectorDayMetric({
      members: MEMBERS.filter((membership) => membership.sectorId === SECTOR_A.id),
      items: new Map(itemsAt(5).map((entry) => [entry.id, entry])),
    });
    const breadth = buildSectorBreadth(day);
    expect(breadth.advanceRatio).toBe(50);
    expect(breadth.advancing).toBe(1);
    expect(breadth.declining).toBe(1);
    expect(breadth.sampleCount).toBe(2);
    expect(breadth.memberCount).toBe(3);
    expect(breadth.nonTradableCount).toBe(1);
    expect(breadth.method).toContain('与板块指数无关');
    expect(day.value).toBeCloseTo(4, 4);
  });

  it('成分明细给日涨幅、窗口涨幅、成交额增量与占比、封板与停牌状态', () => {
    const detail = detailOf();
    const byStock = new Map(detail.members.map((member) => [member.stockId, member]));
    const a1 = byStock.get(STOCKS.A1);
    const a2 = byStock.get(STOCKS.A2);
    expect(a1).toMatchObject({
      code: '600001',
      memberStatus: 'listed',
      inBatch: true,
      dayChangePct: 9,
      sealed: true,
      ladderLevel: 2,
    });
    expect(a1?.name).toContain('股票');
    expect(a1?.windowChangePct).toBeCloseTo((109 / 109.5 - 1) * 100, 4);
    expect(a1?.windowAmountDelta).toBe(150);
    expect(a1?.windowAmountSharePct).toBe(50);
    expect(a2).toMatchObject({
      memberStatus: 'suspended',
      dayChangePct: null,
      windowChangePct: null,
      windowAmountDelta: null,
      windowAmountSharePct: null,
      sealed: false,
    });
    expect(a2?.warnings.join(' ')).toContain('non_tradable');
    expect(detail.members.every((member) => member.sealed !== null)).toBe(true);
  });

  it('无天梯快照时封板状态为 null；窗口不可比时窗口口径全部缺失', () => {
    const noLadder = detailOf({ limitUp: null, limitUpError: 'eastmoney down' });
    expect(requireValue(noLadder.limitUpBlock).status).toBe('unavailable');
    expect(noLadder.members.every((member) => member.sealed === null)).toBe(true);
    expect(requireValue(noLadder.limitUp).value).toBeNull();

    const noWindow = detailOf({ windowStarts: { w5: null, w15: null } });
    expect(noWindow.windows.w5.status).toBe('unavailable');
    expect(requireValue(noWindow.windowMetric).value).toBeNull();
    expect(noWindow.members.every((member) => member.windowChangePct === null)).toBe(true);
    expect(requireValue(noWindow.turnover).value).toBeNull();
    expect(noWindow.members.every((member) => member.windowAmountSharePct === null)).toBe(true);
  });

  it('成分成交额占比的分母是板块增量合计，板块增量为非正时明确缺失', () => {
    const detail = detailOf();
    expect(requireValue(detail.turnover).numeratorAmount).toBe(300);
    expect(requireValue(detail.turnover).value).not.toBeNull();
    const member = detail.members.find((entry) => entry.stockId === STOCKS.A1);
    expect(member?.windowAmountSharePct).toBe(50);

    const flatMembers = buildSectorMemberDetails({
      members: MEMBERS.filter((membership) => membership.sectorId === SECTOR_A.id),
      anchor: batchAt(5),
      windowRef: detail.windows.w5,
      windowStart: batchAt(4),
      sectorAmountDelta: 0,
      limitUp: LADDER,
    });
    // 板块增量为 0：成分增量仍可见，但占比缺失而不是 0%。
    expect(
      flatMembers
        .filter((entry) => entry.memberStatus === 'listed')
        .every((entry) => entry.dayChangePct !== null),
    ).toBe(true);
    expect(flatMembers.every((entry) => entry.windowAmountSharePct === null)).toBe(true);
    expect(
      flatMembers.some((entry) =>
        entry.warnings.some((warning) => warning.includes('amount_share')),
      ),
    ).toBe(true);
  });
});

describe('板块详情空态与不变量', () => {
  it('无批次空态保留最近批次与板块身份，全部数据维度缺失', () => {
    const empty = buildSectorDetailEmpty({
      reason: 'no_batch',
      sector: SECTOR_A,
      latest: null,
      window: 'w15',
    });
    expect(empty).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      sector: { sectorId: SECTOR_A.id, name: SECTOR_A.name },
      tradingDate: null,
      anchor: null,
      trend: null,
      breadth: null,
      window: 'w15',
      members: [],
      leaderOrder: [],
    });
    expect(empty.windows.w15.reason).toContain('no_batch');
  });

  it('sector_not_found 空态不携带板块身份', () => {
    const empty = buildSectorDetailEmpty({
      reason: 'sector_not_found',
      sector: null,
      latest: batchAt(5),
      window: 'w5',
    });
    expect(empty.sector).toBeNull();
    expect(empty.anchor?.sampledAt).toEqual(at('10:15'));
    expect(empty.emptyReason).toBe('sector_not_found');
    expect(() =>
      buildSectorDetailEmpty({
        reason: 'sector_not_found',
        sector: SECTOR_A,
        latest: null,
        window: 'w5',
      }),
    ).toThrow(InvariantError);
  });

  it('无批次却构造 ready 详情时拒绝，不产生假数据', () => {
    expect(() => detailOf({ batches: [] })).toThrow(InvariantError);
  });
});
