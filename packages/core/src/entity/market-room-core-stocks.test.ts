import { describe, expect, it } from 'vitest';
import type { LimitUpLadder, LimitUpLadderEntry } from './limit-up-ladder.js';
import { buildLimitUpLadderSample } from './limit-up-ladder-sample.js';
import {
  buildMarketRoomCoreStocks,
  buildMarketRoomCoreStocksEmpty,
  type MarketRoomCoreStocks,
} from './market-room-core-stocks.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';
import type {
  SectorCatalogEntry,
  StockSectorMembership,
  StockSectorMembershipView,
} from './sector-catalog.js';

/** 六时点夹具：09:35 / 10:15 / 11:00 / 13:15 / 14:15 / 14:50（Asia/Shanghai）。 */
const POINTS = ['09:35', '10:15', '11:00', '13:15', '14:15', '14:50'] as const;
const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const STOCKS = [
  { stockId: '600519.SH', code: '600519', name: '贵州茅台' },
  { stockId: '300750.SZ', code: '300750', name: '宁德时代' },
  { stockId: '600036.SH', code: '600036', name: '招商银行' },
] as const;

/** 领涨组前段强、后段回落；接力组成分后段走强。 */
const CHANGE_PCT: Readonly<Record<string, readonly number[]>> = {
  '600519.SH': [3.4, 2.92, 2.44, 1.96, 1.48, 1.0],
  '300750.SZ': [3.5, 3.02, 2.54, 2.06, 1.68, 1.2],
  '600036.SH': [-0.2, 0.2608, 0.7216, 2.2, 1.75, 2.104],
};

/** 接力组累计成交额最高，因此“成交额最高 + 持续相对强度”只在后段同时成立。 */
const AMOUNT_BASE: Readonly<Record<string, number>> = {
  '600519.SH': 2e8,
  '300750.SZ': 4.4e8,
  '600036.SH': 9.2e8,
};
const AMOUNT_PROGRESS = [0.14, 0.31, 0.48, 0.63, 0.84, 0.97];

const itemsAt = (index: number): MarketSnapshotItem[] =>
  STOCKS.map((stock) => ({
    id: stock.stockId,
    code: stock.code,
    exchange: stock.stockId.endsWith('.SH') ? 'SH' : 'SZ',
    name: stock.name,
    close: 100 * (1 + (CHANGE_PCT[stock.stockId]?.[index] ?? 0) / 100),
    changePct: CHANGE_PCT[stock.stockId]?.[index] ?? 0,
    amount: Math.round((AMOUNT_BASE[stock.stockId] ?? 0) * (AMOUNT_PROGRESS[index] ?? 0)),
  }));

const batchAt = (index: number) =>
  buildMarketSnapshotBatch({
    sampledAt: at(POINTS[index] ?? '09:35'),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'six-point-fixture',
      fetchedAt: at(POINTS[index] ?? '09:35'),
      items: itemsAt(index),
      completeness: {
        expectedCount: STOCKS.length,
        receivedCount: STOCKS.length,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    },
  });

const batchAtTime = (time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: at(time),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'six-point-fixture',
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

const batches = POINTS.map((_point, index) => batchAt(index));

interface LadderSeed {
  readonly code: string;
  readonly name: string;
  readonly level: number;
  readonly firstTime: string | null;
}

const ladderSampleAt = (time: string, seed: readonly LadderSeed[]) => {
  const entries: LimitUpLadderEntry[] = seed.map((entry) => ({
    code: entry.code,
    name: entry.name,
    industry: '测试行业',
    ladderLevel: entry.level,
    uncategorized: false,
    firstTime: entry.firstTime,
    finalTime: entry.firstTime,
    reason: '测试事实',
    price: 110,
    rawClose: 110,
    corrected: false,
    changePct: 0.1,
    limitUpDate: TRADING_DATE,
    board: 'main_board',
  }));
  const levels = [...new Set(entries.map((entry) => entry.ladderLevel))]
    .sort((left, right) => right - left)
    .map((level) => {
      const stocks = entries.filter((entry) => entry.ladderLevel === level);
      return {
        level,
        name: level === 1 ? '首板' : `${level} 连板`,
        count: stocks.length,
        stocks,
      };
    });
  const ladder: LimitUpLadder = {
    date: TRADING_DATE,
    total: entries.length,
    maxLevel: levels[0]?.level ?? 0,
    source: 'eastmoney',
    levels,
    warnings: [],
    asOf: at(time),
  };
  return buildLimitUpLadderSample({ ladder, sampledAt: at(time) });
};

const baseLadderSeeds: Readonly<Record<string, readonly LadderSeed[]>> = {
  '09:35': [
    { code: '600519', name: '贵州茅台', level: 2, firstTime: '09:31:00' },
    { code: '300750', name: '宁德时代', level: 1, firstTime: '09:45:00' },
  ],
  '10:15': [
    { code: '600519', name: '贵州茅台', level: 2, firstTime: '09:31:00' },
    { code: '300750', name: '宁德时代', level: 1, firstTime: '09:45:00' },
  ],
  '11:00': [{ code: '600519', name: '贵州茅台', level: 2, firstTime: '09:31:00' }],
  '13:15': [{ code: '600036', name: '招商银行', level: 1, firstTime: '13:05:00' }],
  '14:15': [{ code: '600036', name: '招商银行', level: 1, firstTime: '13:05:00' }],
  '14:50': [{ code: '600036', name: '招商银行', level: 1, firstTime: '13:05:00' }],
};

const ladderSamples = (skip: readonly string[] = []) =>
  POINTS.filter((point) => !skip.includes(point)).map((point) =>
    ladderSampleAt(point, baseLadderSeeds[point] ?? []),
  );

const sector: SectorCatalogEntry = {
  id: 'sector-test-industry',
  kind: 'industry',
  source: 'fuyao',
  vendorCode: '881001.TI',
  name: '测试题材',
  state: 'active',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:00'),
  retiredAt: null,
};

const concept: SectorCatalogEntry = {
  id: 'sector-test-concept',
  kind: 'concept',
  source: 'fuyao',
  vendorCode: '886001.TI',
  name: '科技概念',
  state: 'active',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:00'),
  retiredAt: null,
};

const membership = (stockId: string): StockSectorMembership => ({
  sectorId: sector.id,
  stockId,
  source: 'fuyao',
  state: 'active',
  memberStatus: 'listed',
  firstSeenAt: at('09:00'),
  lastSeenAt: at('09:00'),
  missingSince: null,
});

const members = STOCKS.map((stock) => membership(stock.stockId));

const view = (input: {
  sectorId: string;
  kind: 'industry' | 'concept';
  vendorCode: string;
  name: string;
  stockId: string;
}): StockSectorMembershipView => ({
  ...membership(input.stockId),
  sectorId: input.sectorId,
  kind: input.kind,
  vendorCode: input.vendorCode,
  name: input.name,
  sectorState: 'active',
});

const build = (overrides: Partial<Parameters<typeof buildMarketRoomCoreStocks>[0]> = {}) =>
  buildMarketRoomCoreStocks({
    sector,
    members,
    batches,
    ladderSamples: ladderSamples(),
    window: 'w15',
    windowStart: batches[3] ?? null,
    ...overrides,
  });

const holderCodes = (core: MarketRoomCoreStocks, kind: 'ignition' | 'turnover' | 'height') =>
  core.roles[kind].holders.map((holder) => holder.code);

describe('角色入选依据', () => {
  it('锚点 14:50：启动先锋按首次封板 + 上涨面扩散，成交核心按成交额最高 + 连续跑赢中位数，高度标按连板层级', () => {
    const core = build();

    expect(core.state).toBe('ready');
    expect(core.sector?.name).toBe('测试题材');
    expect(core.anchor?.sampledAt).toEqual(at('14:50'));
    expect(core.window).toBe('w15');

    expect(core.roles.ignition.status).toBe('assigned');
    expect(holderCodes(core, 'ignition')).toEqual(['600519']);
    expect(core.roles.turnover.status).toBe('assigned');
    expect(holderCodes(core, 'turnover')).toEqual(['600036']);
    expect(core.roles.height.status).toBe('assigned');
    expect(holderCodes(core, 'height')).toEqual(['600036']);
  });

  it('每个角色都带时点 / 字段 / 数值 / 来源证据', () => {
    const core = build();
    for (const kind of ['ignition', 'turnover', 'height'] as const) {
      const role = core.roles[kind];
      expect(role.holders.length).toBeGreaterThan(0);
      for (const holder of role.holders) {
        expect(holder.evidence.length).toBeGreaterThan(0);
        for (const evidence of holder.evidence) {
          expect(evidence.sampledAt).toBeInstanceOf(Date);
          expect(evidence.field.length).toBeGreaterThan(0);
          expect(evidence.value).not.toBeUndefined();
          expect(evidence.source.length).toBeGreaterThan(0);
        }
      }
    }
    const ignitionEvidence = core.roles.ignition.holders[0]?.evidence ?? [];
    expect(ignitionEvidence.some((evidence) => evidence.field === 'firstTime')).toBe(true);
    expect(ignitionEvidence.find((evidence) => evidence.field === 'firstTime')?.value).toBe(
      '09:31:00',
    );
    expect(ignitionEvidence.some((evidence) => evidence.field === 'sectorAdvanceRatio')).toBe(true);
    const turnoverEvidence = core.roles.turnover.holders[0]?.evidence ?? [];
    expect(turnoverEvidence.some((evidence) => evidence.field === 'amount')).toBe(true);
    expect(
      turnoverEvidence.filter((evidence) => evidence.field === 'dayChangePct').length,
    ).toBeGreaterThanOrEqual(2);
    const heightEvidence = core.roles.height.holders[0]?.evidence ?? [];
    expect(heightEvidence.some((evidence) => evidence.field === 'ladderLevel')).toBe(true);
  });

  it('成交核心在最高成交额成分尚未连续跑赢中位数前为空，不降级选第二名', () => {
    const early = build({ batches: batches.slice(0, 4), ladderSamples: ladderSamples() });

    expect(early.anchor?.sampledAt).toEqual(at('13:15'));
    expect(early.roles.turnover.status).toBe('unavailable');
    expect(early.roles.turnover.reason).toContain('top_contributor_without_sustained_strength');
    expect(early.roles.turnover.reason).toContain('600036');
    expect(early.roles.turnover.holders).toEqual([]);
  });

  it('所选时点之前没有后续样本时，启动先锋空态并说明扩散未能核实', () => {
    const firstPoint = build({ batches: batches.slice(0, 1) });

    expect(firstPoint.roles.ignition.status).toBe('unavailable');
    expect(firstPoint.roles.ignition.reason).toContain('expansion_unverified');
    expect(firstPoint.roles.height.status).toBe('assigned');
    expect(holderCodes(firstPoint, 'height')).toEqual(['600519']);
  });

  it('没有按采样时点保存的天梯事实时，高度标为空并标注缺失原因', () => {
    const core = build({ ladderSamples: [] });

    expect(core.roles.height.status).toBe('unavailable');
    expect(core.roles.height.reason).toContain('missing_limit_up_sample');
    expect(core.roles.ignition.status).toBe('unavailable');
    expect(core.roles.ignition.reason).toContain('ignition_evidence_missing');
    expect(core.coverage.ladderSampleCount).toBe(0);
    expect(core.coverage.ladderMissingCount).toBe(batches.length);
  });

  it('供应商封板时间相同时并列，不硬凑单一赢家', () => {
    const tiedLadder = POINTS.map((point) =>
      ladderSampleAt(
        point,
        ['600519', '300750'].map((code) => ({
          code,
          name: code,
          level: 1,
          firstTime: '09:31:00',
        })),
      ),
    );
    const core = build({ ladderSamples: tiedLadder });

    expect(core.roles.ignition.status).toBe('tied');
    expect(holderCodes(core, 'ignition').sort()).toEqual(['300750', '600519']);
    expect(core.roles.ignition.warnings[0]).toContain('ignition_tied');
  });
});

describe('时间线', () => {
  it('记录出现、开板、换位与退出，全部带时点与依据', () => {
    const core = build();
    const kinds = core.timeline.map((event) => `${event.kind}:${event.roleKind ?? '-'}`);

    expect(kinds).toContain('appear:height');
    expect(kinds).toContain('appear:ignition');
    expect(kinds).toContain('rotate:height');
    expect(kinds).toContain('open_board:-');
    expect(kinds).toContain('appear:turnover');

    const rotate = core.timeline.find(
      (event) => event.kind === 'rotate' && event.roleKind === 'height',
    );
    expect(rotate?.sampledAt).toEqual(at('13:15'));
    expect(rotate?.from.map((entry) => entry.code)).toEqual(['600519']);
    expect(rotate?.to.map((entry) => entry.code)).toEqual(['600036']);
    expect(rotate?.basis).toContain('高度标换位');

    const openBoard = core.timeline.find((event) => event.kind === 'open_board');
    expect(openBoard?.sampledAt).toEqual(at('13:15'));
    expect(openBoard?.from.map((entry) => entry.code)).toEqual(['600519']);
    expect(openBoard?.evidence[0]?.field).toBe('sealed');
    expect(openBoard?.previousSampledAt).toEqual(at('11:00'));

    for (const event of core.timeline) {
      expect(event.basis.length).toBeGreaterThan(0);
      expect(event.sampledAt).toBeInstanceOf(Date);
    }
    // 时间线不落事件存储：这里只返回事实。
    expect(core.coverage.timelineEventCount).toBe(core.timeline.length);
  });

  it('角色先出现后退出：成交核心在最高成交额成分失去持续强度后为空', () => {
    // 手工构造：600036 在 14:15 之后涨幅掉到板块中位数以下，但成交额仍最高。
    const falling: readonly number[] = [-0.2, 0.2608, 0.7216, 2.2, 1.75, -3];
    const fallingBatches = POINTS.map((point, index) =>
      buildMarketSnapshotBatch({
        sampledAt: at(point),
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'six-point-fixture',
          fetchedAt: at(point),
          items: itemsAt(index).map((item) =>
            item.id === '600036.SH' ? { ...item, changePct: falling[index] } : item,
          ),
          completeness: {
            expectedCount: STOCKS.length,
            receivedCount: STOCKS.length,
            missingCount: 0,
            duplicateCount: 0,
            complete: true,
          },
        },
      }),
    );
    const core = build({ batches: fallingBatches, windowStart: fallingBatches[3] ?? null });

    expect(core.roles.turnover.status).toBe('unavailable');
    const exit = core.timeline.find(
      (event) => event.kind === 'exit' && event.roleKind === 'turnover',
    );
    expect(exit?.sampledAt).toEqual(at('14:50'));
    expect(exit?.from.map((entry) => entry.code)).toEqual(['600036']);
    expect(exit?.basis).toContain('成交核心退出');
  });

  it('相邻样本缺天梯事实时标注缺失，不推断开板', () => {
    const core = build({ batches: batches.slice(0, 5), ladderSamples: ladderSamples(['14:15']) });
    const missing = core.timeline.filter((event) => event.kind === 'sample_missing');

    expect(missing).toHaveLength(1);
    expect(missing[0]?.sampledAt).toEqual(at('14:15'));
    expect(missing[0]?.roleKind).toBeNull();
    expect(missing[0]?.basis).toContain('无法判断核心股开板或高度标换位');
    expect(core.coverage.ladderMissingCount).toBe(1);
    // 锚点 14:15 的高度标沿用 13:15 的样本，但显式标注 stale。
    expect(core.roles.height.warnings.some((warning) => warning.includes('stale'))).toBe(true);
  });

  it('锚点时点截断时间线，不提前出现之后才发生的事实', () => {
    const early = build({ batches: batches.slice(0, 3) });

    expect(early.timeline.every((event) => event.sampledAt <= at('11:00'))).toBe(true);
    expect(early.timeline.some((event) => event.kind === 'rotate')).toBe(false);
    expect(early.timeline.some((event) => event.kind === 'open_board')).toBe(false);
  });
});

const stockMemberships = new Map<string, readonly StockSectorMembershipView[]>([
  [
    '600519.SH',
    [
      view({
        sectorId: sector.id,
        kind: 'industry',
        vendorCode: '881001.TI',
        name: '测试题材',
        stockId: '600519.SH',
      }),
      view({
        sectorId: concept.id,
        kind: 'concept',
        vendorCode: '886001.TI',
        name: '科技概念',
        stockId: '600519.SH',
      }),
    ],
  ],
  [
    '600036.SH',
    [
      view({
        sectorId: sector.id,
        kind: 'industry',
        vendorCode: '881001.TI',
        name: '测试题材',
        stockId: '600036.SH',
      }),
      view({
        sectorId: concept.id,
        kind: 'concept',
        vendorCode: '886001.TI',
        name: '科技概念',
        stockId: '600036.SH',
      }),
    ],
  ],
]);
const conceptMembers = [membership('600519.SH'), membership('600036.SH')].map(
  (entry): StockSectorMembership => ({ ...entry, sectorId: concept.id }),
);
const membersBySector = new Map<string, readonly StockSectorMembership[]>([
  [sector.id, members],
  [concept.id, conceptMembers],
]);

const buildWithLookups = (lookupKinds?: readonly ('ignition' | 'turnover' | 'height')[]) =>
  build({
    membershipsByStock: stockMemberships,
    membersBySector,
    ...(lookupKinds === undefined ? {} : { lookupKinds }),
  });

describe('从核心股反查题材', () => {
  it('核心股可以看到所属题材、其他成员同期表现，并核对是否拉动多个题材', () => {
    const core = buildWithLookups();
    const lookup = core.lookups.find((entry) => entry.stockId === '600519.SH');

    expect(core.lookups).toHaveLength(2);
    expect(lookup?.themeCount).toBe(2);
    expect(lookup?.roleThemeCount).toBeGreaterThanOrEqual(1);
    expect(lookup?.pullsMultipleThemes).toBe(true);
    const industry = lookup?.themes.find((theme) => theme.sectorId === sector.id);
    const conceptTheme = lookup?.themes.find((theme) => theme.sectorId === concept.id);
    expect(industry?.roleKinds).toContain('ignition');
    // 14:50 高度标已换位到 600036，600519 在该题材只保留启动先锋角色。
    expect(industry?.roleKinds).not.toContain('height');
    expect(conceptTheme?.roleKinds).toContain('ignition');
    expect(conceptTheme?.peerCount).toBe(1);
    expect(conceptTheme?.peers[0]?.code).toBe('600036');
    expect(conceptTheme?.peers[0]?.dayChangePct).toBe(2.104);
    // 六个演示时点间隔不是 15 分钟，窗口不可比时同期表现只保留日涨幅。
    expect(conceptTheme?.peers[0]?.windowChangePct).toBeNull();
    expect(conceptTheme?.thisStock.dayRank).toBe(2);
    expect(conceptTheme?.breadth.advanceRatio).toBe(100);
  });

  it('可以只反查指定角色，未入选的角色不产生反查记录', () => {
    const core = buildWithLookups(['height']);
    expect(core.lookups.map((entry) => entry.stockId)).toEqual(['600036.SH']);
  });

  it('窗口可比时其他成员带 15 分钟同期涨幅', () => {
    const windowBatches = [batchAtTime('14:35', itemsAt(4)), batchAtTime('14:50', itemsAt(5))];
    const core = build({
      batches: windowBatches,
      windowStart: windowBatches[0] ?? null,
      membershipsByStock: stockMemberships,
      membersBySector,
    });
    const lookup = core.lookups.find((entry) => entry.stockId === '600036.SH');
    const industry = lookup?.themes.find((theme) => theme.sectorId === sector.id);
    const peer = industry?.peers.find((entry) => entry.code === '600519');
    expect(peer?.windowChangePct).toBeCloseTo((101 / 101.48 - 1) * 100, 2);
    expect(industry?.thisStock.windowChangePct).toBeCloseTo((102.104 / 101.75 - 1) * 100, 2);
  });

  it('题材没有 active 成分时不伪造角色与其他成员表现', () => {
    const emptyOther = new Map<string, readonly StockSectorMembership[]>([
      [sector.id, members],
      [concept.id, []],
    ]);
    const core = build({
      membershipsByStock: stockMemberships,
      membersBySector: emptyOther,
    });
    const conceptTheme = core.lookups
      .find((entry) => entry.stockId === '600519.SH')
      ?.themes.find((theme) => theme.sectorId === concept.id);
    expect(conceptTheme?.roleKinds).toEqual([]);
    expect(conceptTheme?.peers).toEqual([]);
    expect(conceptTheme?.warnings.join(' ')).toContain('no_members');
  });
});

describe('不变量与空态', () => {
  it('空态给出原因、不携带时间线与反查，角色一律 unavailable', () => {
    const empty = buildMarketRoomCoreStocksEmpty({
      reason: 'no_batch',
      sector: null,
      latest: null,
      window: 'w15',
    });
    expect(empty.state).toBe('empty');
    expect(empty.emptyReason).toBe('no_batch');
    expect(empty.timeline).toEqual([]);
    expect(empty.lookups).toEqual([]);
    expect(empty.roles.ignition.status).toBe('unavailable');
    expect(empty.roles.ignition.reason).toContain('no_batch');
  });

  it('没有 active 成分时抛出不变量错误，不构造空角色', () => {
    expect(() =>
      buildMarketRoomCoreStocks({
        sector,
        members: [],
        batches,
        ladderSamples: ladderSamples(),
        window: 'w15',
        windowStart: null,
      }),
    ).toThrow('active 成分');
  });

  it('覆盖统计与时间线、反查数量一致', () => {
    const core = buildWithLookups();
    expect(core.coverage.batchCount).toBe(6);
    expect(core.coverage.ladderSampleCount).toBe(6);
    expect(core.coverage.ladderMissingCount).toBe(0);
    expect(core.coverage.lookupCount).toBe(core.lookups.length);
    expect(core.notes.join(' ')).toContain('#42');
  });
});
