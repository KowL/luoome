import { describe, expect, it } from 'vitest';

import type { LimitUpLadder } from './limit-up-ladder.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';
import {
  buildSectorIntradayEmptyRanking,
  buildSectorIntradayRanking,
  resolveSectorWindow,
  SECTOR_INTRADAY_WINDOWS,
  type SectorIntradayRanking,
  type SectorIntradaySort,
  type SectorWindowKey,
  sectorWindowTarget,
} from './sector-intraday-ranking.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const item = (
  stockId: string,
  fields: { readonly changePct?: number; readonly close?: number; readonly amount?: number },
): MarketSnapshotItem => ({
  id: stockId,
  code: stockId.split('.')[0] as string,
  exchange: stockId.endsWith('.SH') ? 'SH' : 'SZ',
  name: stockId,
  ...(fields.close === undefined ? {} : { close: fields.close }),
  ...(fields.changePct === undefined ? {} : { changePct: fields.changePct }),
  ...(fields.amount === undefined ? {} : { amount: fields.amount }),
});

const batchOf = (
  time: string,
  items: readonly MarketSnapshotItem[],
  options: {
    readonly complete?: boolean;
    readonly expectedCount?: number;
    readonly date?: string;
  } = {},
) => {
  const expectedCount = options.expectedCount ?? items.length;
  const sampledAt = new Date(`${options.date ?? TRADING_DATE}T${time}+08:00`);
  return buildMarketSnapshotBatch({
    sampledAt,
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'sector-ranking-fixture',
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

const ladderEntry = (code: string, name = code) => ({
  code,
  name,
  industry: 'fixture',
  ladderLevel: 1,
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

const ladderOf = (codes: readonly string[], warnings: readonly string[] = []): LimitUpLadder => ({
  date: TRADING_DATE,
  total: codes.length,
  maxLevel: codes.length === 0 ? 0 : 1,
  source: 'eastmoney',
  levels:
    codes.length === 0
      ? []
      : [{ level: 1, name: '首板', count: codes.length, stocks: codes.map((c) => ladderEntry(c)) }],
  warnings: [...warnings],
  asOf: at('10:16'),
});

/** 白酒 3 只（第 3 只故意不在批次里）；银行 3 只（1 只停牌、1 只不在批次里）。 */
const SECTORS = [
  sector('sec-liquor', '881273.TI', '白酒'),
  sector('sec-bank', '881155.TI', '银行'),
];
const MEMBERS = [
  member('sec-liquor', '600519.SH'),
  member('sec-liquor', '000858.SZ'),
  member('sec-liquor', '600036.SH'),
  member('sec-bank', '601318.SH'),
  member('sec-bank', '000063.SZ', 'suspended'),
  member('sec-bank', '600036.SH'),
];

const ranking = (input: {
  readonly anchor: ReturnType<typeof batchOf>;
  readonly w5?: ReturnType<typeof batchOf> | null;
  readonly w15?: ReturnType<typeof batchOf> | null;
  readonly sort?: SectorIntradaySort;
  readonly window?: SectorWindowKey;
  readonly kind?: SectorCatalogEntry['kind'];
  readonly sectors?: readonly SectorCatalogEntry[];
  readonly members?: readonly StockSectorMembership[];
  readonly limitUp?: LimitUpLadder | null;
  readonly limitUpError?: string | null;
}): SectorIntradayRanking =>
  buildSectorIntradayRanking({
    kind: input.kind ?? 'industry',
    sort: input.sort ?? 'day',
    window: input.window ?? 'w15',
    anchor: input.anchor,
    windowStarts: { w5: input.w5 ?? null, w15: input.w15 ?? null },
    sectors: input.sectors ?? SECTORS,
    members: input.members ?? MEMBERS,
    limitUp: input.limitUp ?? null,
    limitUpError: input.limitUpError ?? null,
  });

const rowOf = (result: SectorIntradayRanking, sectorId: string) => {
  const row = result.rows.find((entry) => entry.sectorId === sectorId);
  if (row === undefined) throw new Error(`榜单缺少板块 ${sectorId}`);
  return row;
};

describe('板块日涨幅（等权均值 + 涨跌分类）', () => {
  it('按成分 changePct 等权平均，同时给出上涨家数与有效成分分母', () => {
    const result = ranking({
      anchor: batchOf('10:15', [
        item('600519.SH', { changePct: 2, close: 102, amount: 1300 }),
        item('000858.SZ', { changePct: -1, close: 99, amount: 600 }),
        item('601318.SH', { changePct: 0, close: 50, amount: 400 }),
        item('000063.SZ', { changePct: 0, close: 42, amount: 300 }),
      ]),
    });

    const liquor = rowOf(result, 'sec-liquor').day;
    expect(liquor).toMatchObject({
      value: 0.5,
      status: 'partial',
      memberCount: 3,
      sampleCount: 2,
      missingCount: 1,
      nonTradableCount: 0,
      advancing: 1,
      declining: 1,
      unchanged: 0,
      thinSample: true,
    });
    expect(liquor.warnings.join(' ')).toContain('missing_change_pct');
    expect(result.rows[0]?.sectorId).toBe('sec-liquor');
    expect(result.rows[0]?.rank).toBe(1);

    // 停牌成分从样本里排除并单独计数，不算缺失、也不计作 0。
    const bank = rowOf(result, 'sec-bank').day;
    expect(bank).toMatchObject({
      value: 0,
      memberCount: 3,
      sampleCount: 1,
      missingCount: 1,
      nonTradableCount: 1,
      advancing: 0,
      declining: 0,
      unchanged: 1,
    });
    expect(bank.warnings.join(' ')).toContain('non_tradable');
  });

  it('没有任何可用样本时日涨幅为 null，不写 0', () => {
    const result = ranking({
      anchor: batchOf('10:15', [item('601318.SH', { changePct: 1, close: 50, amount: 10 })]),
      sectors: [sector('sec-liquor', '881273.TI', '白酒')],
      members: [member('sec-liquor', '600519.SH'), member('sec-liquor', '000858.SZ')],
    });

    expect(rowOf(result, 'sec-liquor').day).toMatchObject({
      value: null,
      status: 'unavailable',
      sampleCount: 0,
      missingCount: 2,
    });
    expect(rowOf(result, 'sec-liquor').day.value).not.toBe(0);
  });
});

describe('板块窗口涨幅（比较窗口两端价格）', () => {
  const w5Start = batchOf('10:10', [
    item('600519.SH', { changePct: 1.5, close: 100, amount: 1000 }),
    item('000858.SZ', { changePct: 0.5, close: 100, amount: 500 }),
    item('601318.SH', { changePct: 0.1, close: 50, amount: 300 }),
    item('000063.SZ', { changePct: 0.1, close: 42, amount: 200 }),
  ]);
  const w15Start = batchOf('10:00', [
    item('600519.SH', { changePct: 0.9, close: 96, amount: 800 }),
    item('000858.SZ', { changePct: 0.2, close: 100, amount: 400 }),
  ]);
  const anchor = batchOf('10:15', [
    item('600519.SH', { changePct: 2, close: 102, amount: 1300 }),
    item('000858.SZ', { changePct: -1, close: 99, amount: 600 }),
    item('601318.SH', { changePct: 0.5, close: 50, amount: 400 }),
    item('000063.SZ', { changePct: 0.2, close: 42, amount: 300 }),
  ]);

  it('逐成分用两端价格算涨幅再等权，与日涨幅不同源', () => {
    const result = ranking({ anchor, w5: w5Start, w15: w15Start });

    const liquor = rowOf(result, 'sec-liquor');
    expect(liquor.day.value).toBe(0.5);
    expect(liquor.window5.value).toBe(0.5);
    expect(liquor.window5.status).toBe('partial');
    expect(liquor.window5.sampleCount).toBe(2);
    expect(liquor.window5.missingCount).toBe(1);
    // (102 / 96 - 1) = 6.25%，(99 / 100 - 1) = -1%，等权 = 2.625%（第三只缺窗口起点价格）
    expect(liquor.window15.value).toBe(2.625);
    expect(liquor.window5.method).toContain('5 分钟窗口');
    expect(liquor.window15.method).toContain('15 分钟窗口');
    expect(result.windows.w5).toMatchObject({
      status: 'complete',
      startSampledAt: w5Start.sampledAt,
      spanMs: 5 * 60_000,
      reason: null,
    });
  });

  it('窗口起点批次缺失时窗口涨幅为 null + 原因，日涨幅照常', () => {
    const result = ranking({ anchor, w5: w5Start, w15: null });

    const liquor = rowOf(result, 'sec-liquor');
    expect(liquor.day.value).toBe(0.5);
    expect(liquor.window15).toMatchObject({ value: null, status: 'unavailable' });
    expect(liquor.window15.warnings.join(' ')).toContain('window_start_missing');
    expect(result.windows.w15).toMatchObject({
      status: 'unavailable',
      startSampledAt: null,
      spanMs: null,
    });
    expect(result.windows.w15.reason).toContain('window_start_missing');
  });

  it('起点批次不是目标时点（间隔不匹配）时不可比', () => {
    const stale = batchOf('09:45', [item('600519.SH', { close: 98, amount: 100 })]);
    const result = ranking({ anchor, w5: stale });

    expect(result.windows.w5.status).toBe('unavailable');
    expect(result.windows.w5.reason).toContain('window_start_missing');
    expect(result.windows.w5.reason).toContain('10:10');
    expect(rowOf(result, 'sec-liquor').window5.value).toBeNull();
  });

  it('跨午休时不比较窗口两端价格，给出跨午休原因', () => {
    const morning = batchOf('11:00', [
      item('600519.SH', { changePct: 3, close: 103, amount: 1000 }),
      item('000858.SZ', { changePct: 1, close: 101, amount: 500 }),
      item('601318.SH', { changePct: 1, close: 50, amount: 300 }),
      item('000063.SZ', { changePct: 1, close: 42, amount: 200 }),
    ]);
    const afternoon = batchOf('13:15', [
      item('600519.SH', { changePct: 4, close: 104, amount: 1600 }),
      item('000858.SZ', { changePct: 2, close: 102, amount: 800 }),
      item('601318.SH', { changePct: 2, close: 51, amount: 500 }),
      item('000063.SZ', { changePct: 2, close: 43, amount: 300 }),
    ]);
    const result = ranking({ anchor: afternoon, w5: morning, w15: morning });

    expect(result.windows.w5.reason).toContain('window_crosses_lunch_break');
    expect(result.windows.w15.reason).toContain('window_crosses_lunch_break');
    expect(rowOf(result, 'sec-liquor').window5.value).toBeNull();
    expect(rowOf(result, 'sec-liquor').window15.value).toBeNull();
    expect(rowOf(result, 'sec-liquor').day.value).toBe(3);
  });

  it('sectorWindowTarget 按窗口分钟回退锚点时点', () => {
    expect(sectorWindowTarget(at('10:15'), 'w5').toISOString()).toBe(at('10:10').toISOString());
    expect(sectorWindowTarget(at('10:15'), 'w15').toISOString()).toBe(at('10:00').toISOString());
    expect(SECTOR_INTRADAY_WINDOWS).toEqual({ w5: 5, w15: 15 });
  });
});

describe('窗口成交占比（成分增量 / 全市场去重增量）', () => {
  const w10Start = batchOf('10:10', [
    item('600519.SH', { changePct: 1, close: 100, amount: 1000 }),
    item('000858.SZ', { changePct: 1, close: 100, amount: 500 }),
    item('601318.SH', { changePct: 0.5, close: 50, amount: 300 }),
    item('000063.SZ', { changePct: 0.2, close: 42, amount: 200 }),
  ]);
  const anchor = batchOf('10:15', [
    item('600519.SH', { changePct: 2, close: 102, amount: 1300 }),
    item('000858.SZ', { changePct: -1, close: 99, amount: 600 }),
    item('601318.SH', { changePct: 0, close: 50, amount: 400 }),
    item('000063.SZ', { changePct: 0.2, close: 42, amount: 300 }),
  ]);

  it('分母为全市场去重增量，分子为成分增量之和；概念重叠不加总', () => {
    const result = ranking({ anchor, w5: w10Start, window: 'w5' });

    // 全市场增量 = 300 + 100 + 100 + 100 = 600
    expect(result.turnover).toMatchObject({
      window: 'w5',
      status: 'complete',
      marketAmountDelta: 600,
      marketSampleCount: 4,
      marketTotalCount: 4,
      reason: null,
    });
    // 白酒 = (1300-1000) + (600-500) = 400 → 400 / 600 = 66.67%
    const liquor = rowOf(result, 'sec-liquor').turnover;
    expect(liquor.value).toBe(66.67);
    expect(liquor.numeratorAmount).toBe(400);
    expect(liquor.sampleCount).toBe(2);
    expect(liquor.missingCount).toBe(1);
    expect(liquor.warnings.join(' ')).toContain('missing_window_amount');
    // 银行只有 601318 可算（000063 停牌、600036 不在批次）→ 100 / 600 = 16.67%
    const bank = rowOf(result, 'sec-bank').turnover;
    expect(bank.value).toBe(16.67);
    expect(bank.numeratorAmount).toBe(100);
    expect(bank.nonTradableCount).toBe(1);
    expect(result.notes.join(' ')).toContain('不可加总');
  });

  it('分母无效（批次不完整 / 增量为负）时占比为 null + 原因', () => {
    const incomplete = ranking({
      anchor: batchOf(
        '10:15',
        [
          item('600519.SH', { changePct: 2, close: 102, amount: 1300 }),
          item('000858.SZ', { changePct: -1, close: 99, amount: 600 }),
        ],
        { expectedCount: 4, complete: false },
      ),
      w5: w10Start,
      sort: 'window5',
      window: 'w5',
    });
    expect(incomplete.turnover.status).toBe('unavailable');
    expect(incomplete.turnover.reason).toContain('batch_incomplete');
    expect(incomplete.turnover.marketAmountDelta).toBeNull();
    expect(rowOf(incomplete, 'sec-liquor').turnover.value).toBeNull();
    expect(rowOf(incomplete, 'sec-liquor').turnover.warnings.join(' ')).toContain(
      'batch_incomplete',
    );
    expect(rowOf(incomplete, 'sec-liquor').turnover.value).not.toBe(0);

    const shrinking = batchOf('10:15', [
      item('600519.SH', { changePct: 2, close: 102, amount: 900 }),
      item('000858.SZ', { changePct: -1, close: 99, amount: 400 }),
      item('601318.SH', { changePct: 0, close: 50, amount: 200 }),
      item('000063.SZ', { changePct: 0.2, close: 42, amount: 100 }),
    ]);
    const negative = ranking({ anchor: shrinking, w5: w10Start, window: 'w5' });
    expect(negative.turnover.status).toBe('unavailable');
    expect(negative.turnover.reason).toContain('denominator_invalid');
    expect(negative.turnover.marketAmountDelta).toBe(-400);
    expect(rowOf(negative, 'sec-liquor').turnover.value).toBeNull();
  });

  it('窗口不可比时占比同样缺失（不拿错窗口凑数）', () => {
    const result = ranking({ anchor, w5: null, window: 'w5' });

    expect(result.turnover.status).toBe('unavailable');
    expect(result.turnover.reason).toContain('window_start_missing');
    expect(rowOf(result, 'sec-liquor').turnover.value).toBeNull();
  });
});

describe('封板数', () => {
  const anchor = batchOf('10:15', [
    item('600519.SH', { changePct: 2, close: 102, amount: 1300 }),
    item('000858.SZ', { changePct: 10, close: 110, amount: 600 }),
    item('601318.SH', { changePct: 0, close: 50, amount: 400 }),
    item('000063.SZ', { changePct: 0.2, close: 42, amount: 300 }),
  ]);

  it('统计天梯里出现的成分，无快照时为 null 并给原因', () => {
    const withLadder = ranking({
      anchor,
      limitUp: ladderOf(['000858', '601318']),
    });
    expect(withLadder.limitUp).toMatchObject({
      status: 'complete',
      tradingDate: TRADING_DATE,
      total: 2,
      maxLevel: 1,
      reason: null,
    });
    expect(rowOf(withLadder, 'sec-liquor').limitUp.value).toBe(1);
    expect(rowOf(withLadder, 'sec-bank').limitUp.value).toBe(1);

    const withoutLadder = ranking({ anchor, limitUp: null, limitUpError: 'manager 未注入' });
    expect(withoutLadder.limitUp.status).toBe('unavailable');
    expect(withoutLadder.limitUp.reason).toContain('manager 未注入');
    expect(rowOf(withoutLadder, 'sec-liquor').limitUp.value).toBeNull();
    expect(rowOf(withoutLadder, 'sec-liquor').limitUp.value).not.toBe(0);

    const notTrading = ranking({ anchor, limitUp: ladderOf([], ['non-trading-day']) });
    expect(notTrading.limitUp.status).toBe('unavailable');
    expect(notTrading.limitUp.reason).toContain('non-trading-day');
    expect(rowOf(notTrading, 'sec-bank').limitUp.value).toBeNull();

    // 空天梯且没有缺口说明：当日确实没有封板股，真 0 照常展示。
    const emptyButReal = ranking({ anchor, limitUp: ladderOf([]) });
    expect(emptyButReal.limitUp.status).toBe('complete');
    expect(rowOf(emptyButReal, 'sec-bank').limitUp.value).toBe(0);
  });
});

describe('排序与名次', () => {
  const w5Start = batchOf('10:10', [
    item('600519.SH', { changePct: 0.5, close: 110, amount: 1000 }),
    item('000858.SZ', { changePct: 0.5, close: 110, amount: 500 }),
    item('601318.SH', { changePct: 0.1, close: 50, amount: 300 }),
    item('000063.SZ', { changePct: 0.1, close: 42, amount: 200 }),
  ]);
  const anchor = batchOf('10:15', [
    // 白酒日涨幅低但 5 分钟窗口冲高；银行日涨幅高但 5 分钟窗口回落。
    item('600519.SH', { changePct: 1, close: 121, amount: 1300 }),
    item('000858.SZ', { changePct: 1, close: 121, amount: 600 }),
    item('601318.SH', { changePct: 2, close: 49, amount: 400 }),
    item('000063.SZ', { changePct: 2, close: 41, amount: 300 }),
  ]);

  it('同一张榜可按日涨幅与 5 / 15 分钟窗口分别排序', () => {
    const day = ranking({ anchor, w5: w5Start, sort: 'day' });
    expect(day.rows.map((row) => [row.sectorId, row.rank])).toEqual([
      ['sec-bank', 1],
      ['sec-liquor', 2],
    ]);
    expect(day.sort).toBe('day');

    const window5 = ranking({ anchor, w5: w5Start, sort: 'window5' });
    expect(window5.rows.map((row) => [row.sectorId, row.rank])).toEqual([
      ['sec-liquor', 1],
      ['sec-bank', 2],
    ]);
    expect(rowOf(window5, 'sec-liquor').window5.value).toBeCloseTo(10, 6);
    expect(rowOf(window5, 'sec-bank').window5.value).toBeLessThan(0);
  });

  it('排序口径缺失的板块排在末尾且没有名次；15 分钟窗口缺失时整列 null', () => {
    const onlyLiquor = ranking({
      anchor,
      w5: w5Start,
      sectors: [...SECTORS, sector('sec-empty-members', '881999.TI', '空板块')],
      members: [
        ...MEMBERS.filter((entry) => entry.sectorId !== 'sec-bank'),
        member('sec-empty-members', '600900.SH'),
      ] as readonly StockSectorMembership[],
      sort: 'window5',
    });

    expect(onlyLiquor.coverage).toMatchObject({
      sectorCount: 3,
      rowCount: 2,
      omittedSectorCount: 1,
    });
    const last = onlyLiquor.rows.at(-1);
    expect(last?.sectorId).toBe('sec-empty-members');
    expect(last?.rank).toBeNull();
    expect(last?.window5.value).toBeNull();
    expect(last?.window5.status).toBe('unavailable');

    const noWindow15 = ranking({ anchor, w5: w5Start, sort: 'window15' });
    expect(noWindow15.rows.every((row) => row.rank === null)).toBe(true);
    expect(noWindow15.rows.every((row) => row.window15.value === null)).toBe(true);
  });
});

describe('空态', () => {
  it('无批次时给出 no_batch 空态并保留最近批次为 null', () => {
    const result = buildSectorIntradayEmptyRanking({
      kind: 'concept',
      sort: 'day',
      window: 'w15',
      reason: 'no_batch',
      latest: null,
    });
    expect(result).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      kind: 'concept',
      tradingDate: null,
      anchor: null,
      rows: [],
    });
    expect(result.windows.w5.status).toBe('unavailable');
    expect(result.turnover.status).toBe('unavailable');
    expect(result.limitUp.status).toBe('unavailable');
  });

  it('目录未同步与批次状态不一致时拒绝构造', () => {
    const batch = batchOf('10:15', [item('600519.SH', { changePct: 1, amount: 10 })]);
    expect(() =>
      buildSectorIntradayEmptyRanking({
        kind: 'industry',
        sort: 'day',
        window: 'w15',
        reason: 'no_sector_catalog',
        latest: batch,
      }),
    ).not.toThrow();
    expect(() =>
      buildSectorIntradayEmptyRanking({
        kind: 'industry',
        sort: 'day',
        window: 'w15',
        reason: 'no_batch',
        latest: batch,
      }),
    ).toThrow(/不一致/);
  });
});

describe('窗口可比性判定', () => {
  const anchor = batchOf('10:15', [item('600519.SH', { changePct: 1, amount: 10 })]);

  it('同一时段的窗口起点可比，跨日 / 盘前不可比', () => {
    const start = batchOf('10:10', [item('600519.SH', { changePct: 0.5, amount: 5 })]);
    expect(resolveSectorWindow({ key: 'w5', anchor, start }).status).toBe('complete');

    const previousDay = batchOf('10:10', [item('600519.SH', { changePct: 0.5, amount: 5 })], {
      date: '2026-09-25',
    });
    const crossDay = resolveSectorWindow({ key: 'w5', anchor, start: previousDay });
    expect(crossDay.status).toBe('unavailable');
    expect(crossDay.reason).toContain('window_cross_day');

    const preOpen = resolveSectorWindow({
      key: 'w15',
      anchor: batchOf('09:40', [item('600519.SH', { changePct: 1, amount: 10 })]),
      start: batchOf('09:25', [item('600519.SH', { changePct: 0.5, amount: 5 })]),
    });
    expect(preOpen.status).toBe('unavailable');
    expect(preOpen.reason).toContain('window_outside_session');
  });
});
