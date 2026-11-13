import {
  MARKET_DAY_POINTS,
  MarketDayFixtureAdapter,
  marketDayItems,
} from '@luoome/adapters/testing';
import {
  buildMarketSnapshotBatch,
  type MarketSnapshotItem,
  type RepositoryRegistry,
  type SectorCatalogObservation,
  type StockSectorObservation,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  type GetMarketRoomAmountDistributionInputT,
  getMarketRoomAmountDistributionTool,
} from './market-room-amount-distribution.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('10:16');

const A_SHARE_IDS = marketDayItems(0).map((entry) => entry.id);
const LEADERS = A_SHARE_IDS.slice(0, 3);
const FOLLOWERS = A_SHARE_IDS.slice(3, 6);
const OTHERS = A_SHARE_IDS.slice(6, 9);

const batchOn = (date: string, time: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: new Date(`${date}T${time}+08:00`),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'market-day-fixture',
      fetchedAt: new Date(`${date}T${time}+08:00`),
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

const batchOf = (time: string, items: readonly MarketSnapshotItem[]) =>
  batchOn(TRADING_DATE, time, items);

const industry = (vendorCode: string, name: string): SectorCatalogObservation => ({
  kind: 'industry',
  vendorCode,
  name,
});

const LEADER_INDUSTRY = industry('881001.TI', '领涨组');
const FOLLOWER_INDUSTRY = industry('881002.TI', '接力组');
const OTHER_INDUSTRY = industry('881003.TI', '其它组');
const OVERLAP_CONCEPT: SectorCatalogObservation = {
  kind: 'concept',
  vendorCode: '886001.TI',
  name: '重叠概念',
};

const observation = (
  stockId: string,
  sectors: readonly SectorCatalogObservation[],
): StockSectorObservation => ({ stockId, sectors: [...sectors] });

const seedCatalog = async (repos: RepositoryRegistry): Promise<void> => {
  await repos.sectorCatalog.applySync({
    syncId: 'amount-sector-catalog',
    source: 'fuyao',
    appliedAt: at('09:00'),
    status: 'succeeded',
    catalog: [LEADER_INDUSTRY, FOLLOWER_INDUSTRY, OTHER_INDUSTRY],
    catalogKinds: ['industry'],
    observations: [
      ...LEADERS.map((stockId) => observation(stockId, [LEADER_INDUSTRY])),
      ...FOLLOWERS.map((stockId) => observation(stockId, [FOLLOWER_INDUSTRY])),
      ...OTHERS.map((stockId) => observation(stockId, [OTHER_INDUSTRY])),
    ],
    stockStatuses: [],
    failures: [],
  });
};

const contextAt = async (
  clock: () => Date = () => new Date(NOW.getTime()),
): Promise<{ readonly ctx: ToolContext; readonly adapter: MarketDayFixtureAdapter }> => {
  const ctx = await buildTestContext({ clock });
  const adapter = new MarketDayFixtureAdapter({ clock });
  return { ctx, adapter };
};

const execute = async (ctx: ToolContext, input: GetMarketRoomAmountDistributionInputT) => {
  const result = await getMarketRoomAmountDistributionTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.distribution;
};

const publishPoint = async (ctx: ToolContext, index: number, time: string): Promise<void> => {
  await ctx.repos.marketSnapshotBatch.publish(batchOf(time, marketDayItems(index)));
};

describe('get_market_room_amount_distribution', () => {
  it('没有已发布批次时返回 no_batch 空态，不触发采集', async () => {
    const { ctx, adapter } = await contextAt();
    const distribution = await execute(
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
      { kind: 'industry', window: 'w15' },
    );

    expect(distribution).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      kind: 'industry',
      window: 'w15',
      anchor: null,
      tradingDate: null,
      rows: [],
    });
    expect(distribution.concentration.status).toBe('unavailable');
    expect(adapter.envelopeCalls).toBe(0);
  });

  it('5 分钟窗口给出占比、百分点环比与 CR3，占比不可加总写进口径', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await publishPoint(ctx, 0, '10:00');
    await publishPoint(ctx, 1, '10:05');
    await publishPoint(ctx, 2, '10:10');
    await publishPoint(ctx, 3, '10:15');

    const distribution = await execute(ctx, { kind: 'industry', window: 'w5' });

    expect(distribution.state).toBe('ready');
    expect(distribution.anchor?.sampledAt).toEqual(at('10:15'));
    expect(distribution.windows.current).toMatchObject({
      status: 'complete',
      startSampledAt: at('10:10'),
      spanMs: 5 * 60_000,
    });
    expect(distribution.windows.previous).toMatchObject({
      status: 'complete',
      startSampledAt: at('10:05'),
      spanMs: 5 * 60_000,
    });
    expect(distribution.turnover.current.status).toBe('complete');
    expect(distribution.turnover.current.marketAmountDelta).toBeGreaterThan(0);
    expect(distribution.turnover.previous.marketAmountDelta).toBeGreaterThan(0);

    expect(distribution.rows.map((row) => row.name).sort()).toEqual(
      ['其它组', '接力组', '领涨组'].sort(),
    );
    const leaders = distribution.rows.find((row) => row.name === '领涨组');
    expect(leaders?.rank).not.toBeNull();
    expect(leaders?.share.value).toBeGreaterThan(0);
    expect(leaders?.share.value).toBeLessThan(100);
    expect(leaders?.deltaPp.status).toBe('complete');
    expect(leaders?.deltaPp.value).not.toBeNull();

    expect(distribution.concentration.basis).toBe('CR3');
    expect(distribution.concentration.status).toBe('complete');
    expect(distribution.concentration.value).not.toBeNull();
    expect(distribution.concentration.value ?? 0).toBeLessThanOrEqual(100);
    expect(distribution.concentration.top).toHaveLength(3);
    expect(distribution.notes.join(' ')).toContain('不可加总');
  });

  it('回放按当时生效的成分计算占比，之后才纳入的股票不进该时点的分母', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await publishPoint(ctx, 1, '10:05');
    await publishPoint(ctx, 2, '10:10');
    await publishPoint(ctx, 3, '10:15');
    const lateMember = FOLLOWERS[0] as string;
    await ctx.repos.sectorCatalog.applySync({
      syncId: 'amount-sector-catalog-late',
      source: 'fuyao',
      appliedAt: at('10:20'),
      status: 'succeeded',
      catalog: [LEADER_INDUSTRY, FOLLOWER_INDUSTRY, OTHER_INDUSTRY],
      catalogKinds: ['industry'],
      observations: [
        ...LEADERS.map((stockId) => observation(stockId, [LEADER_INDUSTRY])),
        ...FOLLOWERS.map((stockId) => observation(stockId, [FOLLOWER_INDUSTRY])),
        ...OTHERS.map((stockId) => observation(stockId, [OTHER_INDUSTRY])),
        observation(lateMember, [LEADER_INDUSTRY, FOLLOWER_INDUSTRY]),
      ],
      stockStatuses: [],
      failures: [],
    });

    const historical = await execute(ctx, { kind: 'industry', window: 'w5', at: at('10:15') });
    expect(historical.anchor?.sampledAt).toEqual(at('10:15'));
    expect(historical.rows.find((row) => row.name === '领涨组')?.share.memberCount).toBe(
      LEADERS.length,
    );

    const atAdmission = await execute(ctx, { kind: 'industry', window: 'w5', at: at('10:25') });
    expect(atAdmission.anchor?.sampledAt).toEqual(at('10:15'));
    expect(atAdmission.rows.find((row) => row.name === '领涨组')?.share.memberCount).toBe(
      LEADERS.length + 1,
    );

    const latest = await execute(ctx, { kind: 'industry', window: 'w5' });
    expect(latest.rows.find((row) => row.name === '领涨组')?.share.memberCount).toBe(
      LEADERS.length + 1,
    );
  });

  it('概念与行业共用成分：各自按自身成分独立计算，不把占比加总', async () => {
    const { ctx } = await contextAt();
    await ctx.repos.sectorCatalog.applySync({
      syncId: 'amount-concept-catalog',
      source: 'fuyao',
      appliedAt: at('09:00'),
      status: 'succeeded',
      catalog: [LEADER_INDUSTRY, OVERLAP_CONCEPT],
      catalogKinds: ['industry', 'concept'],
      observations: LEADERS.map((stockId, index) =>
        observation(stockId, index === 0 ? [LEADER_INDUSTRY, OVERLAP_CONCEPT] : [LEADER_INDUSTRY]),
      ),
      stockStatuses: [],
      failures: [],
    });
    await publishPoint(ctx, 1, '10:05');
    await publishPoint(ctx, 2, '10:10');
    await publishPoint(ctx, 3, '10:15');

    const industryDistribution = await execute(ctx, { kind: 'industry', window: 'w5' });
    const conceptDistribution = await execute(ctx, { kind: 'concept', window: 'w5' });

    expect(industryDistribution.rows).toHaveLength(1);
    expect(conceptDistribution.rows).toHaveLength(1);
    const industryRow = industryDistribution.rows[0];
    const conceptRow = conceptDistribution.rows[0];
    expect(conceptRow?.share.memberCount).toBe(1);
    expect(conceptRow?.share.value).toBeGreaterThan(0);
    // 概念只有一个成分，占比不可能等于行业占比；两者相加也不构成全市场。
    expect((conceptRow?.share.value ?? 0) + (industryRow?.share.value ?? 0)).toBeLessThan(100);
    expect(conceptDistribution.concentration.status).toBe('unavailable');
    expect(conceptDistribution.concentration.reason).toContain(
      'concentration_insufficient_sectors',
    );
  });

  it('at 取该时点及之前最近的批次；窗口按锚点回溯，不读未来批次', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await publishPoint(ctx, 0, '10:00');
    await publishPoint(ctx, 1, '10:05');
    await publishPoint(ctx, 2, '10:10');
    await publishPoint(ctx, 3, '10:15');

    const historical = await execute(ctx, {
      kind: 'industry',
      window: 'w5',
      at: at('10:11'),
    });
    expect(historical.anchor?.sampledAt).toEqual(at('10:10'));
    expect(historical.windows.current.startSampledAt).toEqual(at('10:05'));
    expect(historical.windows.previous.startSampledAt).toEqual(at('10:00'));
    expect(historical.windows.previous.status).toBe('complete');

    const tooEarly = await execute(ctx, {
      kind: 'industry',
      window: 'w5',
      at: at('10:01'),
    });
    expect(tooEarly.anchor?.sampledAt).toEqual(at('10:00'));
    expect(tooEarly.windows.current.status).toBe('unavailable');
    expect(tooEarly.rows.every((row) => row.share.value === null)).toBe(true);
  });

  it('跨午休与上一窗口缺起点都按缺失返回原因，不补零', async () => {
    const lunch = await contextAt(() => at('13:16'));
    await seedCatalog(lunch.ctx.repos);
    await lunch.ctx.repos.marketSnapshotBatch.publish(batchOf('11:00', marketDayItems(1)));
    await lunch.ctx.repos.marketSnapshotBatch.publish(batchOf('13:15', marketDayItems(2)));

    const lunchDistribution = await execute(lunch.ctx, { kind: 'industry', window: 'w15' });
    expect(lunchDistribution.windows.current.reason).toContain('window_crosses_lunch_break');
    expect(lunchDistribution.rows.every((row) => row.share.value === null)).toBe(true);
    expect(lunchDistribution.rows.every((row) => row.deltaPp.value === null)).toBe(true);

    const short = await contextAt();
    await seedCatalog(short.ctx.repos);
    await publishPoint(short.ctx, 2, '10:10');
    await publishPoint(short.ctx, 3, '10:15');
    const shortDistribution = await execute(short.ctx, { kind: 'industry', window: 'w5' });
    expect(shortDistribution.windows.current.status).toBe('complete');
    expect(shortDistribution.windows.previous.status).toBe('unavailable');
    expect(shortDistribution.rows.every((row) => row.deltaPp.value === null)).toBe(true);
    expect(shortDistribution.rows.every((row) => row.share.value !== null)).toBe(true);
  });

  it('目录未同步 / 目录无成分 / 盘前 / 非交易日返回明确空态', async () => {
    const { ctx } = await contextAt();
    await publishPoint(ctx, 3, '10:15');
    const noCatalog = await execute(ctx, { kind: 'industry', window: 'w15' });
    expect(noCatalog.emptyReason).toBe('no_sector_catalog');

    await ctx.repos.sectorCatalog.applySync({
      syncId: 'amount-empty-catalog',
      source: 'fuyao',
      appliedAt: at('09:00'),
      status: 'succeeded',
      catalog: [industry('881009.TI', '空板块')],
      catalogKinds: ['industry'],
      observations: [],
      stockStatuses: [],
      failures: [],
    });
    const noMembers = await execute(ctx, { kind: 'industry', window: 'w15' });
    expect(noMembers.emptyReason).toBe('no_members');

    const preOpen = await contextAt(() => at('09:10'));
    await seedCatalog(preOpen.ctx.repos);
    await preOpen.ctx.repos.marketSnapshotBatch.publish(
      batchOn('2026-09-24', '10:15', marketDayItems(2)),
    );
    const preOpenDistribution = await execute(preOpen.ctx, { kind: 'industry', window: 'w15' });
    expect(preOpenDistribution.emptyReason).toBe('pre_open');

    const weekend = await buildTestContext({
      clock: () => new Date('2026-09-26T02:00:00.000Z'),
    });
    await seedCatalog(weekend.repos);
    await weekend.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    const weekendDistribution = await execute(weekend, { kind: 'industry', window: 'w15' });
    expect(weekendDistribution.emptyReason).toBe('non_trading_day');
  });

  it('六个模拟时点全部发布后按最近批次计算，窗口随锚点回溯', async () => {
    const { ctx } = await contextAt(() => MARKET_DAY_POINTS[5]?.at ?? NOW);
    await seedCatalog(ctx.repos);
    for (const [index, point] of MARKET_DAY_POINTS.entries()) {
      await ctx.repos.marketSnapshotBatch.publish(
        buildMarketSnapshotBatch({
          sampledAt: point.at,
          snapshot: {
            coverage: 'CN_A_SHARES_SH_SZ',
            source: 'market-day-fixture',
            fetchedAt: point.at,
            items: [...marketDayItems(index)],
            completeness: {
              expectedCount: A_SHARE_IDS.length,
              receivedCount: A_SHARE_IDS.length,
              missingCount: 0,
              duplicateCount: 0,
              complete: true,
            },
          },
        }),
      );
    }

    const distribution = await execute(ctx, { kind: 'industry', window: 'w15' });
    expect(distribution.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[5]?.at);
    // 演示时点间隔不是 15 分钟：窗口失败要写明原因，而不是拿相邻时点凑数。
    expect(distribution.windows.current.status).toBe('unavailable');
    expect(distribution.windows.current.reason).toContain('window_start_missing');
    expect(distribution.rows.every((row) => row.share.value === null)).toBe(true);
  });
});
