import { describe, expect, it } from 'vitest';
import { type LimitUpLadder, LimitUpLadderSchema } from './limit-up-ladder.js';
import { buildLimitUpLadderSample } from './limit-up-ladder-sample.js';
import {
  buildMainstreamStockBoard,
  buildStockIntradaySeries,
  isStStockName,
  mainstreamStockRowById,
} from './mainstream-theme-stocks.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry, StockSectorMembership } from './sector-catalog.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const sector = (id: string, vendorCode: string, name: string): SectorCatalogEntry => ({
  id,
  kind: 'concept',
  source: 'fuyao',
  vendorCode,
  name,
  state: 'active',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:30'),
  retiredAt: null,
});

const membership = (
  sectorId: string,
  stockId: string,
  overrides: Partial<StockSectorMembership> = {},
): StockSectorMembership => ({
  sectorId,
  stockId,
  source: 'fuyao',
  state: 'active',
  memberStatus: 'listed',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:30'),
  missingSince: null,
  ...overrides,
});

const AI = sector('concept-ai', '885728.TI', '人工智能');
const AI_APP = sector('concept-ai-app', '886108.TI', 'AI应用');

const A = '000001.SZ';
const B = '000002.SZ';
const C = '000003.SZ';
const D = '000004.SZ';
const E = '000005.SZ';
const F = '000006.SZ';
const G = '000007.SZ';
const H = '000008.SZ';

const item = (
  id: string,
  close: number,
  changePct: number,
  amount: number,
): MarketSnapshotItem => ({
  id,
  code: id.split('.')[0] as string,
  exchange: 'SZ',
  name: id,
  close,
  changePct,
  amount,
});

const batch = (time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: at(time),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'fixture',
      fetchedAt: at(time),
      items: [...items],
      completeness: {
        expectedCount: items.length,
        receivedCount: items.length,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    },
  });

const anchor = batch('10:15', [
  item(A, 10.3, 3, 1100),
  item(B, 9.9, -1, 950),
  item(C, 10.1, 1, 1000),
  item(D, 5.3, 6, 500),
  item(F, 10.2, 2, 700),
  item(G, 7.05, 0.5, 300),
]);
const start15 = batch('10:00', [
  item(A, 10, 0, 1000),
  item(B, 10, 0, 900),
  item(C, 10, 0, 700),
  item(D, 5, 0, 450),
  item(F, 10, 0, 600),
  item(G, 7, 0, 250),
]);
const previous15 = batch('09:45', [
  item(A, 10, 0, 900),
  item(B, 10, 0, 800),
  item(C, 9.5, 0, 500),
  item(D, 5, 0, 420),
  item(F, 9.8, 0, 550),
  item(G, 6.9, 0, 220),
]);
const start5 = batch('10:10', [
  item(A, 10.2, 0, 1050),
  item(B, 10, 0, 930),
  item(C, 10.05, 0, 850),
  item(D, 5.1, 0, 480),
  item(F, 10.1, 0, 650),
  item(G, 7, 0, 270),
]);
const previous5 = batch('10:05', [
  item(A, 10.1, 0, 1030),
  item(B, 10, 0, 920),
  item(C, 10, 0, 800),
  item(D, 5, 0, 470),
  item(F, 10, 0, 620),
  item(G, 6.95, 0, 260),
]);

const universe = [
  { stockId: A, name: '龙头甲', listingStatus: 'listed' as const },
  { stockId: B, name: '稳健乙', listingStatus: 'listed' as const },
  { stockId: C, name: '资金丙', listingStatus: 'listed' as const },
  { stockId: D, name: '*ST风险', listingStatus: 'listed' as const },
  { stockId: E, name: '停牌戊', listingStatus: 'listed' as const },
  { stockId: F, name: '高度丁', listingStatus: 'listed' as const },
  { stockId: G, name: '补位戊', listingStatus: 'listed' as const },
  { stockId: H, name: '缺报价己', listingStatus: 'listed' as const },
];

const entries = (
  rows: ReadonlyArray<{
    code: string;
    level: number;
    firstTime?: string;
    name?: string;
  }>,
) => {
  const byLevel = new Map<number, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    const list = byLevel.get(row.level) ?? [];
    list.push(row);
    byLevel.set(row.level, list);
  }
  return [...byLevel.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([level, stocks]) => ({
      level,
      name: level === 1 ? '首板' : `${level} 连板`,
      count: stocks.length,
      stocks: stocks.map((row) => ({
        code: row.code,
        name: row.name ?? row.code,
        industry: '--',
        ladderLevel: row.level,
        uncategorized: false,
        firstTime: row.firstTime ?? null,
        finalTime: null,
        reason: '--',
        price: 10,
        rawClose: 10,
        corrected: false,
        changePct: 0.1,
        limitUpDate: TRADING_DATE,
        board: 'main_board' as const,
      })),
    }));
};

const ladderOf = (rows: ReadonlyArray<{ code: string; level: number; firstTime?: string }>) =>
  LimitUpLadderSchema.parse({
    date: TRADING_DATE,
    total: rows.length,
    maxLevel: rows.reduce((max, row) => Math.max(max, row.level), 0),
    source: 'eastmoney',
    levels: entries(rows),
    warnings: [],
    asOf: at('10:15'),
  }) satisfies LimitUpLadder;

const sample = (
  time: string,
  rows: ReadonlyArray<{ code: string; level: number; firstTime?: string }>,
) => buildLimitUpLadderSample({ ladder: ladderOf(rows), sampledAt: at(time) });

const ladderSamples = [
  sample('10:00', [
    { code: '000002', level: 1, firstTime: '09:40:00' },
    { code: '000006', level: 3, firstTime: '09:35:00' },
  ]),
  sample('10:15', [
    { code: '000001', level: 1, firstTime: '10:05:00' },
    { code: '000006', level: 3, firstTime: '09:35:00' },
  ]),
];

const members = [
  membership(AI.id, A),
  membership(AI.id, B),
  membership(AI_APP.id, C),
  membership(AI.id, D),
  membership(AI.id, E, { memberStatus: 'suspended' }),
  membership(AI.id, F),
  membership(AI.id, G),
  membership(AI.id, H),
];

const build = (overrides: Partial<Parameters<typeof buildMainstreamStockBoard>[0]> = {}) =>
  buildMainstreamStockBoard({
    window: 'w15',
    anchor,
    windowStarts: { w5: start5, w15: start15 },
    previousWindowStarts: { w5: previous5, w15: previous15 },
    sectors: [AI, AI_APP],
    members,
    ladderSamples,
    universe,
    ...overrides,
  });

const themeOf = (board: ReturnType<typeof build>) => {
  const found = board.themes.find((theme) => theme.themeId === 'ai-computing');
  if (found === undefined) throw new Error('未找到 AI与算力');
  return found;
};

describe('isStStockName', () => {
  it('识别 *ST / ST / S*ST / SST，普通名称与代码占位不误判', () => {
    for (const name of ['*ST中珠', 'ST中珠', 'S*ST前锋', 'SST华塑', ' st 测试 ']) {
      expect(isStStockName(name), name).toBe(true);
    }
    for (const name of ['贵州茅台', '中ST华', '000001.SZ', null, undefined]) {
      expect(isStStockName(name)).toBe(false);
    }
  });
});

describe('buildMainstreamStockBoard', () => {
  it('标准题材用全部原始概念 active 成分并集去重，ST / 停牌 / 缺报价分别计数', () => {
    const board = build();
    const theme = themeOf(board);
    expect(theme.coverage).toMatchObject({
      memberCount: 8,
      constituentCount: 6,
      eligibleCount: 5,
      stCount: 1,
      nonTradableCount: 1,
      missingQuoteCount: 1,
    });
    // A 同时属于人工智能与 AI应用：并集只计一次。
    expect(theme.constituents.filter((row) => row.stockId === A)).toHaveLength(1);
    expect(theme.constituents.map((row) => row.stockId)).not.toContain(E);
    expect(theme.constituents.map((row) => row.stockId)).not.toContain(H);
  });

  it('代表股是日涨幅第一的领涨股，中文名只取 stockUniverse，展示全部角色', () => {
    const theme = themeOf(build());
    expect(theme.representative?.stockId).toBe(A);
    expect(theme.representative?.name).toBe('龙头甲');
    expect(theme.representative?.nameSource).toBe('stock_universe');
    expect(theme.representative?.roles).toEqual(['leader']);
    const st = theme.constituents.find((row) => row.stockId === D);
    expect(st?.isSt).toBe(true);
    // ST 日涨幅最高也不能成为领涨代表。
    expect(theme.representative?.stockId).not.toBe(D);
  });

  it('核心股顺序：领涨 → 资金 → 高度 → 增量补足，去重且最多 5 只', () => {
    const theme = themeOf(build());
    expect(theme.coreStocks.map((row) => row.stockId)).toEqual([A, C, F, G, B]);
    expect(theme.coreStocks).toHaveLength(5);
    expect(theme.coreStocks.find((row) => row.stockId === A)?.roles).toEqual(['leader']);
    expect(theme.coreStocks.find((row) => row.stockId === C)?.roles).toEqual(['funds']);
    expect(theme.coreStocks.find((row) => row.stockId === F)?.roles).toEqual(['height']);
    expect(theme.coreStocks.find((row) => row.stockId === G)?.roles).toEqual([]);
  });

  it('角色可合并且不额外占位，不足 5 只不硬凑', () => {
    const onlyLeader = build({
      members: [membership(AI.id, A), membership(AI.id, B), membership(AI.id, C)],
      ladderSamples: [],
      anchor: batch('10:15', [item(A, 10.3, 3, 1100), item(B, 9.9, -1, 950)]),
    });
    const theme = themeOf(onlyLeader);
    expect(theme.coreStocks.length).toBeLessThanOrEqual(5);
    expect(theme.coreStocks.length).toBeLessThanOrEqual(theme.constituents.length);
  });

  it('高度股先比 ladderLevel，再比首次封板时间，再比窗口成交额增量', () => {
    const sameLevel = [
      sample('10:15', [
        { code: '000003', level: 3, firstTime: '09:40:00' },
        { code: '000006', level: 3, firstTime: '09:35:00' },
        { code: '000001', level: 2, firstTime: '09:30:00' },
      ]),
    ];
    const theme = themeOf(build({ ladderSamples: sameLevel }));
    expect(theme.coreStocks.find((row) => row.stockId === F)?.roles).toContain('height');
    expect(theme.coreStocks.find((row) => row.stockId === C)?.roles).not.toContain('height');
  });

  it('没有天梯样本时封板 / 高度 / 炸板全部缺失，不写 false / 0', () => {
    const theme = themeOf(build({ ladderSamples: [] }));
    expect(theme.ladder.status).toBe('unavailable');
    expect(theme.ladder.reason).toContain('limit_up_sample_missing');
    expect(theme.ladder.brokenBoardStatus).toBe('unavailable');
    expect(theme.coreStocks.every((row) => row.sealed === null)).toBe(true);
    expect(theme.coreStocks.every((row) => row.ladderLevel === null)).toBe(true);
    expect(theme.coreStocks.every((row) => row.brokenBoard === null)).toBe(true);
    expect(theme.coreStocks.some((row) => row.roles.includes('height'))).toBe(false);
    // 领涨与资金仍可基于日涨幅与成交额增量成立。
    expect(theme.coreStocks.some((row) => row.roles.includes('leader'))).toBe(true);
    expect(theme.coreStocks.some((row) => row.roles.includes('funds'))).toBe(true);
  });

  it('炸板只在前后对齐样本证明前一样本封板、当前不在时成立', () => {
    const theme = themeOf(build());
    const b = theme.constituents.find((row) => row.stockId === B);
    expect(b?.brokenBoard).toBe(true);
    expect(b?.brokenBoardReason).toBeNull();
    const a = theme.constituents.find((row) => row.stockId === A);
    // 当前封板，前一样本未封板：不是炸板。
    expect(a?.sealed).toBe(true);
    expect(a?.brokenBoard).toBe(false);
    const c = theme.constituents.find((row) => row.stockId === C);
    expect(c?.sealed).toBe(false);
    expect(c?.brokenBoard).toBe(false);
  });

  it('窗口成交占比与上一窗占比使用独立分母，ST 不参与分母', () => {
    const theme = themeOf(build());
    expect(theme.share.denominator).toBe(600);
    expect(theme.share.previousDenominator).toBe(480);
    const a = theme.constituents.find((row) => row.stockId === A);
    expect(a?.sharePct).toBe(16.67);
    expect(a?.previousSharePct).toBe(20.83);
    expect(a?.shareDeltaPp).toBe(-4.16);
    expect(a?.amountDeltaChange).toBe(0);
    const c = theme.constituents.find((row) => row.stockId === C);
    expect(c?.sharePct).toBe(50);
    expect(c?.previousSharePct).toBe(41.67);
    expect(c?.shareDeltaPp).toBe(8.33);
    expect(c?.amountDeltaChange).toBe(100);
    const st = theme.constituents.find((row) => row.stockId === D);
    expect(st?.sharePct).toBeNull();
    expect(st?.shareReason).toContain('ST');
  });

  it('窗口起点缺失时涨幅、成交额增量与占比全部 null + 原因，不补 0', () => {
    const theme = themeOf(
      build({
        windowStarts: { w5: start5, w15: null },
        previousWindowStarts: { w5: previous5, w15: null },
      }),
    );
    expect(theme.share.status).toBe('unavailable');
    expect(theme.share.reason).toContain('window_start_missing');
    expect(theme.share.denominator).toBeNull();
    for (const row of theme.constituents) {
      expect(row.window15ChangePct).toBeNull();
      expect(row.window15AmountDelta).toBeNull();
      expect(row.sharePct).toBeNull();
      expect(row.shareReason).not.toBeNull();
    }
    expect(theme.coreStocks.some((row) => row.roles.includes('funds'))).toBe(false);
  });

  it('上一窗口缺失时当前占比保留、环比为 null + 原因', () => {
    const theme = themeOf(build({ previousWindowStarts: { w5: previous5, w15: null } }));
    expect(theme.share.denominator).toBe(600);
    expect(theme.share.previousDenominator).toBeNull();
    const a = theme.constituents.find((row) => row.stockId === A);
    expect(a?.sharePct).toBe(16.67);
    expect(a?.shareDeltaPp).toBeNull();
    expect(a?.shareReason).toBeNull();
    expect(a?.previousShareReason).toContain('window_start_missing');
  });

  it('默认成分按近 15 分钟成交额增量降序，缺失排最后', () => {
    const theme = themeOf(
      build({
        anchor: batch('10:15', [
          item(A, 10.3, 3, 1100),
          item(B, 9.9, -1, undefined as unknown as number),
          item(C, 10.1, 1, 1000),
          item(D, 5.3, 6, 500),
          item(F, 10.2, 2, 700),
          item(G, 7.05, 0.5, 300),
        ]),
      }),
    );
    const deltas = theme.constituents.map((row) => row.window15AmountDelta);
    expect(deltas[0]).toBe(300);
    expect(deltas).toEqual([300, 100, 100, 50, 50, null]);
    expect(theme.constituents.at(-1)?.stockId).toBe(B);
    expect(theme.share.status).toBe('unavailable');
    expect(theme.share.reason).toContain('denominator_incomplete');
  });

  it('后台汇总 coverage 与按 stockId 反查', () => {
    const board = build();
    expect(board.coverage).toMatchObject({
      themeCount: 44,
      themeWithConstituentsCount: 1,
      constituentCount: 6,
      stCount: 1,
      nonTradableCount: 1,
      missingQuoteCount: 1,
      universeCount: 8,
      hasCurrentLadderSample: true,
      hasPreviousLadderSample: true,
    });
    expect(mainstreamStockRowById(board, A)?.name).toBe('龙头甲');
    expect(mainstreamStockRowById(board, '999999.SZ')).toBeNull();
  });
});

describe('buildStockIntradaySeries', () => {
  const seriesBatch = (time: string, items: readonly MarketSnapshotItem[]) => batch(time, items);

  const batches = [
    seriesBatch('10:12', [item(A, 10.1, 0, 1000)]),
    seriesBatch('10:13', [item(A, 10.2, 0, 1200)]),
    // 10:14 缺批次：下一分钟断线，不插值
    seriesBatch('10:15', [item(A, 10.4, 0, 1500)]),
    // 10:16 在 anchor 之后：回放不得使用
    seriesBatch('10:16', [item(A, 10.5, 0, 1600)]),
  ];

  it('只取 anchor 及之前批次，缺口断线且不插值', () => {
    const series = buildStockIntradaySeries({
      stockId: A,
      anchor,
      batches,
      name: '龙头甲',
    });
    expect(series.state).toBe('ready');
    expect(series.points.map((point) => point.close)).toEqual([10.1, 10.2, 10.4]);
    expect(series.points[0]?.amountDelta).toBeNull();
    expect(series.points[0]?.amountReason).toContain('first_point');
    expect(series.points[1]?.amountDelta).toBe(200);
    expect(series.points[2]?.gapBefore).toBe(true);
    expect(series.points[2]?.amountDelta).toBeNull();
    expect(series.points[2]?.amountReason).toContain('gap_before');
    expect(series.coverage).toMatchObject({
      batchCount: 3,
      pointCount: 3,
      gapCount: 1,
      amountMissingCount: 1,
      negativeCorrectionCount: 0,
    });
  });

  it('负修正按缺失说明，不补 0', () => {
    const series = buildStockIntradaySeries({
      stockId: A,
      anchor: seriesBatch('10:13', [item(A, 10.2, 0, 900)]),
      batches: [
        seriesBatch('10:12', [item(A, 10.1, 0, 1000)]),
        seriesBatch('10:13', [item(A, 10.2, 0, 900)]),
      ],
      name: '龙头甲',
    });
    expect(series.points[1]?.amountDelta).toBeNull();
    expect(series.points[1]?.amountDelta).not.toBe(0);
    expect(series.points[1]?.amountReason).toContain('negative_correction');
    expect(series.coverage.negativeCorrectionCount).toBe(1);
  });

  it('无名称时 name 为 null，不用代码占位冒充', () => {
    const series = buildStockIntradaySeries({
      stockId: A,
      anchor,
      batches,
      name: null,
    });
    expect(series.name).toBeNull();
    expect(series.nameSource).toBeNull();
  });
});
