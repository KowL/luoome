import {
  MARKET_DAY_POINTS,
  MarketDayFixtureAdapter,
  marketDayItems,
} from '@luoome/adapters/testing';
import {
  buildLimitUpLadderSample,
  buildMarketSnapshotBatch,
  type LimitUpLadder,
  type LimitUpLadderEntry,
  type LimitUpLadderSample,
  type RepositoryRegistry,
  type SectorCatalogObservation,
  type StockSectorObservation,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  type GetMarketRoomCoreStocksInputT,
  getMarketRoomCoreStocksTool,
} from './market-room-core-stocks.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('14:50');
const POINT_TIMES = MARKET_DAY_POINTS.map((point) =>
  point.at.toLocaleTimeString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  }),
);

const batchOf = (pointIndex: number) => {
  const point = MARKET_DAY_POINTS[pointIndex];
  if (point === undefined) throw new Error(`夹具时点越界: ${pointIndex}`);
  const items = marketDayItems(pointIndex);
  return buildMarketSnapshotBatch({
    sampledAt: point.at,
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'market-day-fixture',
      fetchedAt: point.at,
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
};

const batches = MARKET_DAY_POINTS.map((_point, index) => batchOf(index));

const industry = (vendorCode: string, name: string): SectorCatalogObservation => ({
  kind: 'industry',
  vendorCode,
  name,
});
const concept = (vendorCode: string, name: string): SectorCatalogObservation => ({
  kind: 'concept',
  vendorCode,
  name,
});

const CORE_INDUSTRY = industry('881001.TI', '测试题材');
const CORE_CONCEPT = concept('886001.TI', '科技概念');

const LEAD_ID = '600519.SH';
const FOLLOWER_ID = '600036.SH';

const observation = (
  stockId: string,
  sectors: readonly SectorCatalogObservation[],
): StockSectorObservation => ({ stockId, sectors: [...sectors] });

const seedCatalog = async (repos: RepositoryRegistry): Promise<void> => {
  await repos.sectorCatalog.applySync({
    syncId: 'core-stocks-catalog',
    source: 'fuyao',
    appliedAt: at('09:00'),
    status: 'succeeded',
    catalog: [CORE_INDUSTRY, CORE_CONCEPT],
    catalogKinds: ['industry', 'concept'],
    observations: [
      observation(LEAD_ID, [CORE_INDUSTRY, CORE_CONCEPT]),
      observation(FOLLOWER_ID, [CORE_INDUSTRY, CORE_CONCEPT]),
    ],
    stockStatuses: [],
    failures: [],
  });
};

interface LadderSeed {
  readonly code: string;
  readonly level: number;
  readonly firstTime: string;
}

const ladderAt = (time: string, seed: readonly LadderSeed[]): LimitUpLadderSample => {
  const entries: LimitUpLadderEntry[] = seed.map((entry) => ({
    code: entry.code,
    name: entry.code,
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
      return { level, name: level === 1 ? '首板' : `${level} 连板`, count: stocks.length, stocks };
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

const LADDER_SEEDS: Readonly<Record<string, readonly LadderSeed[]>> = {
  '09:35': [
    { code: '600519', level: 2, firstTime: '09:31:00' },
    { code: '300750', level: 1, firstTime: '09:45:00' },
  ],
  '10:15': [
    { code: '600519', level: 2, firstTime: '09:31:00' },
    { code: '300750', level: 1, firstTime: '09:45:00' },
  ],
  '11:00': [{ code: '600519', level: 2, firstTime: '09:31:00' }],
  '13:15': [{ code: '600036', level: 1, firstTime: '13:05:00' }],
  '14:15': [{ code: '600036', level: 1, firstTime: '13:05:00' }],
  '14:50': [{ code: '600036', level: 1, firstTime: '13:05:00' }],
};

const ladderSamples = () => POINT_TIMES.map((time) => ladderAt(time, LADDER_SEEDS[time] ?? []));

const contextAt = async (
  clock: () => Date = () => new Date(NOW.getTime()),
): Promise<{ readonly ctx: ToolContext; readonly adapter: MarketDayFixtureAdapter }> => {
  const ctx = await buildTestContext({ clock });
  const adapter = new MarketDayFixtureAdapter({ clock });
  return { ctx, adapter };
};

const withMarket = (ctx: ToolContext, adapter: MarketDayFixtureAdapter): ToolContext => ({
  ...ctx,
  adapters: { ...ctx.adapters, market: adapter },
});

const sectorId = async (ctx: ToolContext, name: string): Promise<string> => {
  const sectors = await ctx.repos.sectorCatalog.listSectors({ state: 'active' });
  const id = sectors.find((entry) => entry.name === name)?.id;
  if (id === undefined) throw new Error(`缺少板块: ${name}`);
  return id;
};

const seedBatches = async (ctx: ToolContext): Promise<void> => {
  for (const batch of batches) await ctx.repos.marketSnapshotBatch.publish(batch);
  for (const sample of ladderSamples()) await ctx.repos.limitUpLadderSample.save(sample);
};

const execute = async (ctx: ToolContext, input: GetMarketRoomCoreStocksInputT) => {
  const result = await getMarketRoomCoreStocksTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.coreStocks;
};

describe('get_market_room_core_stocks', () => {
  it('返回三个核心角色、入选证据与时间线，读取不触发采集', async () => {
    const { ctx, adapter } = await contextAt();
    await seedCatalog(ctx.repos);
    await seedBatches(ctx);
    const target = await sectorId(ctx, '测试题材');

    const core = await execute(withMarket(ctx, adapter), { sectorId: target });

    expect(core.state).toBe('ready');
    expect(core.sector?.name).toBe('测试题材');
    expect(core.anchor?.sampledAt).toEqual(at('14:50'));
    expect(core.window).toBe('w15');
    expect(core.roles.ignition.status).toBe('assigned');
    expect(core.roles.ignition.holders[0]?.code).toBe('600519');
    expect(core.roles.turnover.status).toBe('assigned');
    expect(core.roles.turnover.holders[0]?.code).toBe('600036');
    expect(core.roles.height.status).toBe('assigned');
    expect(core.roles.height.holders[0]?.code).toBe('600036');
    for (const kind of ['ignition', 'turnover', 'height'] as const) {
      for (const holder of core.roles[kind].holders) {
        expect(holder.evidence.length).toBeGreaterThan(0);
      }
    }

    const kinds = core.timeline.map((event) => event.kind);
    expect(kinds).toContain('appear');
    expect(kinds).toContain('rotate');
    expect(kinds).toContain('open_board');
    expect(core.timeline.every((event) => event.sampledAt instanceof Date)).toBe(true);
    expect(core.timeline.every((event) => event.basis.length > 0)).toBe(true);

    expect(core.lookups.map((lookup) => lookup.stockId).sort()).toEqual(['600036.SH', '600519.SH']);
    const lead = core.lookups.find((lookup) => lookup.stockId === LEAD_ID);
    expect(lead?.themeCount).toBe(2);
    expect(lead?.pullsMultipleThemes).toBe(true);
    expect(lead?.themes.some((theme) => theme.name === '科技概念')).toBe(true);
    expect(
      lead?.themes
        .find((theme) => theme.name === '科技概念')
        ?.peers.some((peer) => peer.code === '600036'),
    ).toBe(true);
    expect(adapter.envelopeCalls).toBe(0);
  });

  it('at 只返回该时点及之前的事实，之后的开板与换位不提前出现', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await seedBatches(ctx);
    const target = await sectorId(ctx, '测试题材');

    const core = await execute(ctx, { sectorId: target, at: at('10:15') });

    expect(core.anchor?.sampledAt).toEqual(at('10:15'));
    expect(core.roles.ignition.status).toBe('assigned');
    expect(core.roles.ignition.holders[0]?.code).toBe('600519');
    expect(core.roles.turnover.status).toBe('unavailable');
    expect(core.roles.height.holders[0]?.code).toBe('600519');
    expect(core.timeline.some((event) => event.kind === 'rotate')).toBe(false);
    expect(core.timeline.some((event) => event.kind === 'open_board')).toBe(false);
    expect(core.timeline.every((event) => event.sampledAt <= at('10:15'))).toBe(true);
    expect(core.coverage.batchCount).toBe(2);
  });

  it('kind 只筛选反查范围，不影响角色计算', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await seedBatches(ctx);
    const target = await sectorId(ctx, '测试题材');

    const core = await execute(ctx, { sectorId: target, kind: 'height' });

    expect(core.roles.height.status).toBe('assigned');
    expect(core.lookups.map((lookup) => lookup.stockId)).toEqual([FOLLOWER_ID]);
  });

  it('天梯样本缺失时高度标为空，其余角色照常复算', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    for (const batch of batches) await ctx.repos.marketSnapshotBatch.publish(batch);
    const target = await sectorId(ctx, '测试题材');

    const core = await execute(ctx, { sectorId: target });

    expect(core.roles.height.status).toBe('unavailable');
    expect(core.roles.height.reason).toContain('missing_limit_up_sample');
    expect(core.roles.turnover.status).toBe('assigned');
    expect(core.coverage.ladderSampleCount).toBe(0);
    expect(core.coverage.ladderMissingCount).toBe(6);
  });

  it('天梯样本读取失败不阻塞角色与时间线，备注来源错误', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    for (const batch of batches) await ctx.repos.marketSnapshotBatch.publish(batch);
    const target = await sectorId(ctx, '测试题材');
    Object.defineProperty(ctx.repos, 'limitUpLadderSample', {
      value: {
        save: () => Promise.reject(new Error('unused')),
        findById: () => Promise.resolve(null),
        findAtOrBefore: () => Promise.resolve(null),
        listByTradingDate: () => Promise.reject(new Error('sample store down')),
      },
      configurable: true,
    });

    const core = await execute(ctx, { sectorId: target });

    expect(core.state).toBe('ready');
    expect(core.notes.some((note) => note.includes('ladder_samples_unavailable'))).toBe(true);
    expect(core.roles.height.status).toBe('unavailable');
  });

  it('尚无批次、目录未同步、板块不存在与无成分各有明确空态', async () => {
    const noBatch = await contextAt();
    expect((await execute(noBatch.ctx, { sectorId: 'sector-test-industry' })).emptyReason).toBe(
      'no_batch',
    );

    const noCatalog = await contextAt();
    await seedBatches(noCatalog.ctx);
    expect((await execute(noCatalog.ctx, { sectorId: 'sector-test-industry' })).emptyReason).toBe(
      'no_sector_catalog',
    );

    const notFound = await contextAt();
    await seedCatalog(notFound.ctx.repos);
    await seedBatches(notFound.ctx);
    expect((await execute(notFound.ctx, { sectorId: 'missing-sector' })).emptyReason).toBe(
      'sector_not_found',
    );

    const noMembers = await contextAt();
    await seedCatalog(noMembers.ctx.repos);
    await noMembers.ctx.repos.sectorCatalog.applySync({
      syncId: 'core-stocks-empty-sector',
      source: 'fuyao',
      appliedAt: at('09:10'),
      status: 'succeeded',
      catalog: [industry('881009.TI', '空题材')],
      catalogKinds: ['industry'],
      observations: [],
      stockStatuses: [],
      failures: [],
    });
    await seedBatches(noMembers.ctx);
    const emptySector = await sectorId(noMembers.ctx, '空题材');
    expect((await execute(noMembers.ctx, { sectorId: emptySector })).emptyReason).toBe(
      'no_members',
    );
  });

  it('参数不合法按 invalid_input 返回', async () => {
    const { ctx } = await contextAt();
    const missing = await getMarketRoomCoreStocksTool.execute(
      {} as GetMarketRoomCoreStocksInputT,
      ctx,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.kind).toBe('invalid_input');

    const invalidKind = await getMarketRoomCoreStocksTool.execute(
      {
        sectorId: 'sector-test-industry',
        kind: 'futures',
      } as unknown as GetMarketRoomCoreStocksInputT,
      ctx,
    );
    expect(invalidKind.ok).toBe(false);
    if (invalidKind.ok) return;
    expect(invalidKind.error.kind).toBe('invalid_input');
  });
});
