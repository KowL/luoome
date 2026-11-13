import { describe, expect, it } from 'vitest';

import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  buildSectorAmountDistribution,
  buildSectorAmountDistributionEmpty,
  SECTOR_AMOUNT_CONCENTRATION_BASIS,
  type SectorAmountDistribution,
  type SectorAmountDistributionInput,
} from './sector-amount-distribution.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';
import type { SectorRankingEmptyReason, SectorWindowKey } from './sector-intraday-ranking.js';

/**
 * 成交分布（ticket #40）：四个批次造出「当前窗口 / 上一窗口」，逐板块核对占比、环比与 CR3。
 *
 * 时点：10:00 → 10:05 → 10:10 → 10:15（5 分钟窗口，anchor 10:15）。
 * 累计成交额按股票给出，两个窗口的增量都在断言里显式写出。
 */

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const STOCK_IDS = [
  '600000.SH',
  '600001.SH',
  '600002.SH',
  '600003.SH',
  '600004.SH',
  '600005.SH',
  '600006.SH',
  '600007.SH',
  '600008.SH',
  '600009.SH',
  '600010.SH',
  '600011.SH',
] as const;

/** 四个批次的累计成交额（元）：A..L 共 12 只，两个窗口的增量各不相同。 */
const AMOUNTS: Readonly<Record<string, readonly number[]>> = {
  '600000.SH': [100, 150, 220, 300], // 当前 80 / 上一 70
  '600001.SH': [200, 260, 300, 340], // 40 / 40
  '600002.SH': [300, 330, 400, 520], // 120 / 70
  '600003.SH': [400, 480, 520, 560], // 40 / 40
  '600004.SH': [500, 560, 640, 780], // 140 / 80
  '600005.SH': [600, 700, 760, 800], // 40 / 60
  '600006.SH': [700, 780, 900, 1000], // 100 / 120
  '600007.SH': [800, 900, 950, 1100], // 150 / 50
  '600008.SH': [900, 950, 1050, 1090], // 40 / 100
  '600009.SH': [1000, 1100, 1200, 1220], // 20 / 100
  '600010.SH': [1100, 1200, 1260, 1400], // 140 / 60
  '600011.SH': [1200, 1300, 1350, 1500], // 150 / 50
};

/** 当前窗口（10:10 → 10:15）全市场增量 1060；上一窗口（10:05 → 10:10）840。 */
const CURRENT_TOTAL = 1060;
const PREVIOUS_TOTAL = 840;

const item = (stockId: string, amount: number): MarketSnapshotItem => ({
  id: stockId,
  code: stockId.split('.')[0] as string,
  exchange: stockId.endsWith('.SH') ? 'SH' : 'SZ',
  name: stockId,
  amount,
  changePct: 1,
});

const batchAt = (
  time: string,
  items: readonly MarketSnapshotItem[],
  options: { readonly expectedCount?: number; readonly complete?: boolean } = {},
) => {
  const expectedCount = options.expectedCount ?? items.length;
  const sampledAt = at(time);
  return buildMarketSnapshotBatch({
    sampledAt,
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'amount-distribution-fixture',
      fetchedAt: sampledAt,
      items: [...items],
      completeness: {
        expectedCount,
        receivedCount: items.length,
        missingCount: expectedCount - items.length,
        duplicateCount: 0,
        complete: options.complete ?? expectedCount === items.length,
      },
    },
  });
};

const itemsAt = (pointIndex: number): readonly MarketSnapshotItem[] =>
  STOCK_IDS.map((stockId) => item(stockId, AMOUNTS[stockId]?.[pointIndex] as number));

/** 10:05 → 10:10 → 10:15：上一窗口 / 当前窗口 / 锚点。 */
const B1 = batchAt('10:05', itemsAt(1));
const B2 = batchAt('10:10', itemsAt(2));
const B3 = batchAt('10:15', itemsAt(3));

const sector = (
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

const member = (
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

const INDUSTRY_SECTORS: readonly SectorCatalogEntry[] = [
  sector('sec-x', '881001.TI', '甲行业'),
  sector('sec-y', '881002.TI', '乙行业'),
  sector('sec-z', '881003.TI', '丙行业'),
  sector('sec-w', '881004.TI', '丁行业'),
];
const INDUSTRY_MEMBERS: readonly StockSectorMembership[] = [
  member('sec-x', '600000.SH'),
  member('sec-x', '600001.SH'),
  member('sec-x', '600002.SH'),
  member('sec-y', '600003.SH'),
  member('sec-y', '600004.SH'),
  member('sec-y', '600005.SH'),
  member('sec-z', '600006.SH'),
  member('sec-z', '600007.SH'),
  member('sec-z', '600008.SH'),
  member('sec-w', '600009.SH'),
  member('sec-w', '600010.SH'),
  member('sec-w', '600011.SH'),
];

/** 概念与行业共用成分：A 与 E 同时属于行业与概念，占比不可相加。 */
const CONCEPT_SECTORS: readonly SectorCatalogEntry[] = [
  sector('sec-cc', '886001.TI', '重叠概念', 'concept'),
];
const CONCEPT_MEMBERS: readonly StockSectorMembership[] = [
  member('sec-cc', '600004.SH'),
  member('sec-cc', '600000.SH'),
];

const distribution = (
  input: Partial<SectorAmountDistributionInput> & { readonly window?: SectorWindowKey } = {},
): SectorAmountDistribution =>
  buildSectorAmountDistribution({
    kind: input.kind ?? 'industry',
    window: input.window ?? 'w5',
    anchor: input.anchor ?? B3,
    currentStart: input.currentStart === undefined ? B2 : input.currentStart,
    previousStart: input.previousStart === undefined ? B1 : input.previousStart,
    sectors: input.sectors ?? INDUSTRY_SECTORS,
    members: input.members ?? INDUSTRY_MEMBERS,
  });

const rowOf = (result: SectorAmountDistribution, name: string) => {
  const row = result.rows.find((entry) => entry.name === name);
  if (row === undefined) throw new Error(`缺少板块行: ${name}`);
  return row;
};

describe('窗口成交占比与环比', () => {
  it('占比 = 成分成交额增量 ÷ 同期全市场去重增量，环比以百分点表示', () => {
    const result = distribution();

    expect(result.state).toBe('ready');
    expect(result.kind).toBe('industry');
    expect(result.window).toBe('w5');
    expect(result.tradingDate).toBe(TRADING_DATE);
    expect(result.anchor).toMatchObject({
      sampledAt: at('10:15'),
      complete: true,
      receivedCount: STOCK_IDS.length,
    });
    expect(result.windows.current).toMatchObject({
      status: 'complete',
      startSampledAt: at('10:10'),
      spanMs: 5 * 60_000,
      reason: null,
    });
    expect(result.windows.previous).toMatchObject({
      status: 'complete',
      startSampledAt: at('10:05'),
      spanMs: 5 * 60_000,
      reason: null,
    });

    expect(result.turnover.current).toMatchObject({
      window: 'w5',
      status: 'complete',
      marketAmountDelta: CURRENT_TOTAL,
      marketSampleCount: STOCK_IDS.length,
      marketTotalCount: STOCK_IDS.length,
      reason: null,
    });
    expect(result.turnover.previous).toMatchObject({
      window: 'w5',
      status: 'complete',
      marketAmountDelta: PREVIOUS_TOTAL,
      marketSampleCount: STOCK_IDS.length,
      marketTotalCount: STOCK_IDS.length,
      reason: null,
    });

    // 丁行业 = J 20 + K 140 + L 150 = 310 / 1060 = 29.25%；上一窗口 210 / 840 = 25.00%。
    const w = rowOf(result, '丁行业');
    expect(w.rank).toBe(1);
    expect(w.share.value).toBeCloseTo(29.25, 2);
    expect(w.share.numeratorAmount).toBe(310);
    expect(w.share.sampleCount).toBe(3);
    expect(w.share.memberCount).toBe(3);
    expect(w.share.status).toBe('complete');
    expect(w.previousShare.value).toBeCloseTo(25, 2);
    expect(w.previousShare.numeratorAmount).toBe(210);
    expect(w.deltaPp.value).toBeCloseTo(4.25, 2);
    expect(w.deltaPp.status).toBe('complete');

    // 丙行业 = G 100 + H 150 + I 40 = 290 / 1060 = 27.36%；上一窗口 270 / 840 = 32.14%。
    const z = rowOf(result, '丙行业');
    expect(z.share.value).toBeCloseTo(27.36, 2);
    expect(z.deltaPp.value).toBeCloseTo(-4.78, 2);

    // 乙行业 = D 40 + E 140 + F 40 = 220 / 1060 = 20.75%；上一窗口 180 / 840 = 21.43%。
    const y = rowOf(result, '乙行业');
    expect(y.share.value).toBeCloseTo(20.75, 2);
    expect(y.deltaPp.value).toBeCloseTo(-0.68, 2);

    // 名次按当前窗口占比降序，缺失占比没有名次。
    expect(result.rows.map((row) => row.name)).toEqual(['丁行业', '丙行业', '甲行业', '乙行业']);
    expect(result.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
    expect(result.coverage).toMatchObject({ sectorCount: 4, rowCount: 4, omittedSectorCount: 0 });
  });

  it('CR3 集中度带定义字段，取当前窗口占比前三名之和，并说明概念重叠不可加总', () => {
    const result = distribution();

    expect(result.concentration.basis).toBe(SECTOR_AMOUNT_CONCENTRATION_BASIS);
    expect(result.concentration.definition).toContain('前 3');
    expect(result.concentration.definition).toContain('不可加总');
    expect(result.concentration.status).toBe('complete');
    // 29.25 + 27.36 + 22.64 = 79.25。
    expect(result.concentration.value).toBeCloseTo(79.25, 2);
    expect(result.concentration.sectorCount).toBe(4);
    expect(result.concentration.top.map((entry) => entry.name)).toEqual([
      '丁行业',
      '丙行业',
      '甲行业',
    ]);
    expect(result.concentration.reason).toBeNull();

    expect(result.notes.join(' ')).toContain('不可加总');
    expect(result.notes.join(' ')).toContain('停牌');
    expect(result.notes.join(' ')).toContain('漏采');
    expect(result.notes.join(' ')).toContain('百分点');
  });

  it('概念按自身成分独立计算，占比不可加总；不足 3 个板块时 CR3 缺失而不补零', () => {
    const result = distribution({
      kind: 'concept',
      sectors: CONCEPT_SECTORS,
      members: CONCEPT_MEMBERS,
    });

    const concept = rowOf(result, '重叠概念');
    // (80 + 140) / 1060 = 20.75%；上一窗口 (70 + 80) / 840 = 17.86%。
    expect(concept.share.value).toBeCloseTo(20.75, 2);
    expect(concept.previousShare.value).toBeCloseTo(17.86, 2);
    expect(concept.deltaPp.value).toBeCloseTo(2.89, 2);

    expect(result.concentration.status).toBe('unavailable');
    expect(result.concentration.value).toBeNull();
    expect(result.concentration.reason).toContain('concentration_insufficient_sectors');
    expect(result.concentration.top).toEqual([]);
  });

  it('前 3 名概念共享成分时 CR3 缺失并写出重叠明细，不把同一批股票重复计入', () => {
    const result = distribution({
      kind: 'concept',
      sectors: [
        sector('sec-ca', '886101.TI', '概念甲', 'concept'),
        sector('sec-cb', '886102.TI', '概念乙', 'concept'),
        sector('sec-cc', '886103.TI', '概念丙', 'concept'),
      ],
      members: [
        member('sec-ca', '600000.SH'),
        member('sec-ca', '600001.SH'),
        member('sec-cb', '600001.SH'),
        member('sec-cb', '600002.SH'),
        member('sec-cc', '600003.SH'),
        member('sec-cc', '600004.SH'),
      ],
    });

    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.share.value !== null)).toBe(true);
    expect(result.concentration.status).toBe('unavailable');
    expect(result.concentration.value).toBeNull();
    expect(result.concentration.top).toEqual([]);
    expect(result.concentration.reason).toContain('concentration_overlapping_constituents');
    expect(result.concentration.reason).toContain('概念乙 ↔ 概念甲');
    expect(result.concentration.reason).toContain('600001.SH');
    expect(result.concentration.sectorCount).toBe(3);
  });

  it('前 3 名概念成分完全不相交时仍能算出 CR3', () => {
    const result = distribution({
      kind: 'concept',
      sectors: [
        sector('sec-da', '886201.TI', '概念丁', 'concept'),
        sector('sec-db', '886202.TI', '概念戊', 'concept'),
        sector('sec-dc', '886203.TI', '概念己', 'concept'),
      ],
      members: [
        member('sec-da', '600000.SH'),
        member('sec-da', '600001.SH'),
        member('sec-da', '600002.SH'),
        member('sec-db', '600003.SH'),
        member('sec-db', '600004.SH'),
        member('sec-db', '600005.SH'),
        member('sec-dc', '600006.SH'),
        member('sec-dc', '600007.SH'),
        member('sec-dc', '600008.SH'),
      ],
    });

    expect(result.concentration.status).toBe('complete');
    expect(result.concentration.value).toBeCloseTo(70.75, 2);
    expect(result.concentration.top.map((entry) => entry.name)).toEqual([
      '概念己',
      '概念丁',
      '概念戊',
    ]);
    expect(result.concentration.reason).toBeNull();
    expect(result.concentration.warnings).toEqual([]);
  });
});

describe('缺失与不可比：一律 null + 原因，不补零', () => {
  it('窗口起点批次缺失时不计算占比与环比', () => {
    const result = distribution({ currentStart: null, previousStart: null });

    expect(result.windows.current.status).toBe('unavailable');
    expect(result.windows.current.reason).toContain('window_start_missing');
    expect(result.turnover.current.status).toBe('unavailable');
    expect(result.turnover.current.reason).toContain('window_start_missing');
    expect(result.turnover.current.marketAmountDelta).toBeNull();
    expect(result.rows.every((row) => row.share.value === null)).toBe(true);
    expect(result.rows.every((row) => row.previousShare.value === null)).toBe(true);
    expect(result.rows.every((row) => row.deltaPp.value === null)).toBe(true);
    expect(result.rows.every((row) => row.deltaPp.reason !== null)).toBe(true);
    expect(result.rows.every((row) => row.rank === null)).toBe(true);
    expect(result.concentration.status).toBe('unavailable');
    expect(result.concentration.reason).not.toBeNull();
  });

  it('跨午休的窗口不可比：占比与环比缺失，原因写明跨午休', () => {
    const start = batchAt('11:00', itemsAt(1));
    const anchor = batchAt('13:15', itemsAt(3));
    const result = distribution({ anchor, currentStart: start, previousStart: null });

    expect(result.windows.current.status).toBe('unavailable');
    expect(result.windows.current.reason).toContain('window_crosses_lunch_break');
    expect(result.turnover.current.reason).toContain('window_crosses_lunch_break');
    expect(result.rows.every((row) => row.share.value === null)).toBe(true);
    expect(result.rows.every((row) => row.deltaPp.value === null)).toBe(true);
  });

  it('全市场增量不为正时分母无效，占比缺失而不是 0', () => {
    const start = batchAt(
      '10:10',
      STOCK_IDS.map((stockId) => item(stockId, 900)),
    );
    const anchor = batchAt(
      '10:15',
      STOCK_IDS.map((stockId) => item(stockId, 100)),
    );
    const result = distribution({ anchor, currentStart: start, previousStart: null });

    expect(result.turnover.current.status).toBe('unavailable');
    expect(result.turnover.current.reason).toContain('denominator_invalid');
    expect(result.rows.every((row) => row.share.value === null)).toBe(true);
    expect(result.rows.some((row) => row.share.value === 0)).toBe(false);
  });

  it('锚点批次不完整时分母不可用，原因写明缺条目', () => {
    const incomplete = batchAt('10:15', itemsAt(3).slice(0, 11), {
      expectedCount: STOCK_IDS.length,
      complete: false,
    });
    const result = distribution({ anchor: incomplete });

    expect(result.turnover.current.status).toBe('unavailable');
    expect(result.turnover.current.reason).toContain('batch_incomplete');
    expect(result.rows.every((row) => row.share.value === null)).toBe(true);
  });

  it('分母覆盖不全（有股票不在窗口起点批次）时不拿部分覆盖当全市场', () => {
    const partialStart = batchAt('10:10', itemsAt(2).slice(0, 11));
    const anchor = batchAt('10:15', itemsAt(3));
    const result = distribution({ anchor, currentStart: partialStart, previousStart: null });

    expect(result.turnover.current.status).toBe('unavailable');
    expect(result.turnover.current.reason).toContain('denominator_incomplete');
    expect(result.turnover.current.marketSampleCount).toBe(11);
    expect(result.turnover.current.marketTotalCount).toBe(12);
    expect(result.rows.every((row) => row.share.value === null)).toBe(true);
  });

  it('上一窗口起点缺失时只缺环比，当前窗口占比照常给出', () => {
    const result = distribution({ previousStart: null });

    expect(result.windows.current.status).toBe('complete');
    expect(result.turnover.current.status).toBe('complete');
    expect(result.windows.previous.status).toBe('unavailable');
    expect(result.windows.previous.reason).toContain('window_start_missing');

    const w = rowOf(result, '丁行业');
    expect(w.share.value).toBeCloseTo(29.25, 2);
    expect(w.previousShare.value).toBeNull();
    expect(w.deltaPp.value).toBeNull();
    expect(w.deltaPp.status).toBe('unavailable');
    expect(w.deltaPp.reason).toContain('previous_window_missing');
    expect(w.deltaPp.warnings.join(' ')).toContain('window_start_missing');
  });

  it('板块成分缺样本时不补零：缺失样本计数进入行内说明', () => {
    const sectors = [...INDUSTRY_SECTORS, sector('sec-q', '881005.TI', '缺样本行业')];
    const members = [...INDUSTRY_MEMBERS, member('sec-q', '600099.SH')];
    const result = distribution({ sectors, members });

    const q = rowOf(result, '缺样本行业');
    expect(q.share.value).toBeNull();
    expect(q.share.status).toBe('unavailable');
    expect(q.share.memberCount).toBe(1);
    expect(q.share.sampleCount).toBe(0);
    expect(q.share.missingCount).toBe(1);
    expect(q.share.warnings.join(' ')).toContain('missing_window_amount');
    expect(q.rank).toBeNull();
    // 4 / 5 个板块有可用占比：CR3 仍可用，但标注部分板块不参与。
    expect(result.concentration.status).toBe('partial');
    expect(result.concentration.warnings.join(' ')).toContain('concentration_partial_sectors');
    expect(result.concentration.top.map((entry) => entry.name)).not.toContain('缺样本行业');
  });

  it('停牌成分排除但不算缺失、也不计作零成交', () => {
    const members = [
      member('sec-x', '600000.SH'),
      member('sec-x', '600001.SH', 'suspended'),
      member('sec-x', '600002.SH'),
    ];
    const result = distribution({
      sectors: [INDUSTRY_SECTORS[0] as SectorCatalogEntry],
      members,
    });

    const x = rowOf(result, '甲行业');
    expect(x.share.memberCount).toBe(3);
    expect(x.share.sampleCount).toBe(2);
    expect(x.share.missingCount).toBe(0);
    expect(x.share.nonTradableCount).toBe(1);
    expect(x.share.status).toBe('partial');
    expect(x.share.warnings.join(' ')).toContain('non_tradable');
    // 只用 A + C 的增量：200 / 1060，而不是把停牌股当 0 后除以 3 只成分。
    expect(x.share.numeratorAmount).toBe(200);
    expect(x.share.value).toBeCloseTo(18.87, 2);
  });
});

describe('不变量与空态', () => {
  it('环比只在本窗口与上一窗口都有值时才给出，且等于两者之差', () => {
    const result = distribution();
    for (const row of result.rows) {
      if (row.share.value === null || row.previousShare.value === null) {
        expect(row.deltaPp.value).toBeNull();
        continue;
      }
      expect(row.deltaPp.value).toBeCloseTo(row.share.value - row.previousShare.value, 2);
    }
  });

  it('空态保留最近批次时点，窗口、分母、集中度全部不可用', () => {
    const reason: SectorRankingEmptyReason = 'no_sector_catalog';
    const result = buildSectorAmountDistributionEmpty({
      kind: 'industry',
      window: 'w15',
      reason,
      latest: B3,
    });

    expect(result).toMatchObject({
      state: 'empty',
      emptyReason: reason,
      kind: 'industry',
      window: 'w15',
      tradingDate: TRADING_DATE,
      rows: [],
    });
    expect(result.anchor?.sampledAt).toEqual(at('10:15'));
    expect(result.windows.current.reason).toContain(reason);
    expect(result.turnover.current.status).toBe('unavailable');
    expect(result.concentration.value).toBeNull();
    expect(result.concentration.top).toEqual([]);
  });

  it('无批次空态不带交易日期与批次摘要', () => {
    const result = buildSectorAmountDistributionEmpty({
      kind: 'concept',
      window: 'w5',
      reason: 'no_batch',
      latest: null,
    });

    expect(result.tradingDate).toBeNull();
    expect(result.anchor).toBeNull();
    expect(result.coverage).toEqual({ sectorCount: 0, rowCount: 0, omittedSectorCount: 0 });
  });
});
