import {
  MARKET_DAY_POINTS,
  MarketDayFixtureAdapter,
  marketDayItems,
} from '@luoome/adapters/testing';
import {
  buildMarketSnapshotBatch,
  type LimitUpLadder,
  type MarketSnapshotItem,
  type RepositoryRegistry,
  type SectorCatalogObservation,
  type StockSectorObservation,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  type GetMarketRoomSectorsInputT,
  getMarketRoomSectorsTool,
} from './market-room-sectors.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('10:16');

const A_SHARE_IDS = marketDayItems(0).map((entry) => entry.id);
const LEADERS = A_SHARE_IDS.slice(0, 3);
const FOLLOWERS = A_SHARE_IDS.slice(3);

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
const concept = (vendorCode: string, name: string): SectorCatalogObservation => ({
  kind: 'concept',
  vendorCode,
  name,
});

const LEADER_INDUSTRY = industry('881001.TI', '领涨组');
const FOLLOWER_INDUSTRY = industry('881002.TI', '接力组');
const OVERLAP_CONCEPT = concept('886001.TI', '重叠概念');

const observation = (
  stockId: string,
  sectors: readonly SectorCatalogObservation[],
): StockSectorObservation => ({ stockId, sectors: [...sectors] });

const seedCatalog = async (repos: RepositoryRegistry): Promise<void> => {
  await repos.sectorCatalog.applySync({
    syncId: 'sector-catalog-1',
    source: 'fuyao',
    appliedAt: at('09:00'),
    status: 'succeeded',
    catalog: [LEADER_INDUSTRY, FOLLOWER_INDUSTRY, OVERLAP_CONCEPT],
    catalogKinds: ['industry', 'concept'],
    observations: [
      ...LEADERS.map((stockId, index) =>
        observation(stockId, index === 0 ? [LEADER_INDUSTRY, OVERLAP_CONCEPT] : [LEADER_INDUSTRY]),
      ),
      ...FOLLOWERS.map((stockId, index) =>
        observation(
          stockId,
          index === 0 ? [FOLLOWER_INDUSTRY, OVERLAP_CONCEPT] : [FOLLOWER_INDUSTRY],
        ),
      ),
    ],
    stockStatuses: [],
    failures: [],
  });
};

const ladderOf = (codes: readonly string[]): LimitUpLadder => ({
  date: TRADING_DATE,
  total: codes.length,
  maxLevel: 1,
  source: 'eastmoney',
  levels: [
    {
      level: 1,
      name: '首板',
      count: codes.length,
      stocks: codes.map((code) => ({
        code,
        name: code,
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
      })),
    },
  ],
  warnings: [],
  asOf: at('10:16'),
});

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, current) => sum + current, 0) / values.length;

const changePctOf = (items: readonly MarketSnapshotItem[], stockId: string): number => {
  const item = items.find((entry) => entry.id === stockId);
  if (item?.changePct === undefined) throw new Error(`fixture 缺 ${stockId} 的涨幅`);
  return item.changePct;
};

const closeOf = (items: readonly MarketSnapshotItem[], stockId: string): number => {
  const item = items.find((entry) => entry.id === stockId);
  if (item?.close === undefined) throw new Error(`fixture 缺 ${stockId} 的价格`);
  return item.close;
};

const dayMean = (items: readonly MarketSnapshotItem[], stockIds: readonly string[]): number =>
  meanOf(stockIds.map((stockId) => changePctOf(items, stockId)));

const windowMean = (
  items: readonly MarketSnapshotItem[],
  startItems: readonly MarketSnapshotItem[],
  stockIds: readonly string[],
): number =>
  meanOf(
    stockIds.map((stockId) => (closeOf(items, stockId) / closeOf(startItems, stockId) - 1) * 100),
  );

const contextAt = async (
  clock: () => Date = () => new Date(NOW.getTime()),
): Promise<{ readonly ctx: ToolContext; readonly adapter: MarketDayFixtureAdapter }> => {
  const ctx = await buildTestContext({ clock });
  const adapter = new MarketDayFixtureAdapter({ clock });
  return { ctx, adapter };
};

const execute = async (ctx: ToolContext, input: GetMarketRoomSectorsInputT) => {
  const result = await getMarketRoomSectorsTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.ranking;
};

describe('get_market_room_sectors', () => {
  it('没有已发布批次时返回 no_batch 空态，不触发采集', async () => {
    const { ctx, adapter } = await contextAt();
    const ranking = await execute(
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
      { kind: 'industry', sort: 'day', window: 'w15' },
    );

    expect(ranking).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      kind: 'industry',
      sort: 'day',
      window: 'w15',
      anchor: null,
      rows: [],
    });
    expect(ranking.windows.w5.status).toBe('unavailable');
    expect(adapter.envelopeCalls).toBe(0);
  });

  it('行业榜按日涨幅排序：早盘领涨组仍领先，但 5 分钟窗口已转负', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    await ctx.repos.limitUpLadderSnapshot.save(ladderOf(['600519', '600036']));

    const dayRanking = await execute(
      {
        ...ctx,
        adapters: { ...ctx.adapters, market: new MarketDayFixtureAdapter({ clock: () => NOW }) },
      },
      { kind: 'industry', sort: 'day', window: 'w5' },
    );
    const p1Items = marketDayItems(1);
    const p2Items = marketDayItems(2);

    expect(dayRanking.state).toBe('ready');
    expect(dayRanking.tradingDate).toBe(TRADING_DATE);
    expect(dayRanking.anchor).toMatchObject({
      sampledAt: at('10:15'),
      complete: true,
      receivedCount: p2Items.length,
    });
    expect(dayRanking.coverage).toMatchObject({
      sectorCount: 2,
      rowCount: 2,
      omittedSectorCount: 0,
    });
    expect(dayRanking.rows.map((row) => row.name)).toEqual(['领涨组', '接力组']);

    const leaders = dayRanking.rows[0];
    const followers = dayRanking.rows[1];
    expect(leaders?.rank).toBe(1);
    expect(leaders?.day.value).toBeCloseTo(dayMean(p2Items, LEADERS), 4);
    expect(leaders?.day.advancing).toBe(LEADERS.length);
    expect(leaders?.day.sampleCount).toBe(LEADERS.length);
    expect(leaders?.day.memberCount).toBe(LEADERS.length);
    expect(leaders?.window5.value).toBeCloseTo(windowMean(p2Items, p1Items, LEADERS), 4);
    expect(leaders?.window5.value).toBeLessThan(0);
    expect(followers?.window5.value).toBeGreaterThan(0);
    expect(leaders?.limitUp.value).toBe(1);
    expect(followers?.limitUp.value).toBe(1);
    expect(dayRanking.turnover.status).toBe('complete');
    expect(leaders?.turnover.value).toBeGreaterThan(0);
    expect(dayRanking.windows.w5.status).toBe('complete');

    const windowRanking = await execute(
      {
        ...ctx,
        adapters: { ...ctx.adapters, market: new MarketDayFixtureAdapter({ clock: () => NOW }) },
      },
      { kind: 'industry', sort: 'window5', window: 'w5' },
    );
    expect(windowRanking.rows.map((row) => [row.name, row.rank])).toEqual([
      ['接力组', 1],
      ['领涨组', 2],
    ]);
    expect(windowRanking.rows[0]?.day.value).toBeLessThan(windowRanking.rows[1]?.day.value ?? 0);
  });

  it('概念切换只返回概念板块，重叠概念按自身成分计算、不与行业加总', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const ranking = await execute(ctx, { kind: 'concept', sort: 'day', window: 'w15' });

    expect(ranking.kind).toBe('concept');
    expect(ranking.coverage.sectorCount).toBe(1);
    expect(ranking.rows.map((row) => row.name)).toEqual(['重叠概念']);
    expect(ranking.rows[0]?.day.memberCount).toBe(2);
    const overlapIds = [LEADERS[0] as string, FOLLOWERS[0] as string];
    expect(ranking.rows[0]?.day.value).toBeCloseTo(dayMean(marketDayItems(2), overlapIds), 4);
    expect(ranking.notes.join(' ')).toContain('不可加总');
  });

  it('给定 at 取该时点及之前最近的批次，窗口按锚点回溯且不跨时点取未来批次', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:00', marketDayItems(0)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const historical = await execute(ctx, {
      kind: 'industry',
      sort: 'day',
      window: 'w5',
      at: at('10:12'),
    });
    expect(historical.anchor?.sampledAt).toEqual(at('10:10'));
    // 目标窗口起点 10:05 之前只有 10:00 的批次（间隔 10 分钟），5 分钟窗口不可比。
    expect(historical.windows.w5.status).toBe('unavailable');
    expect(historical.windows.w5.reason).toContain('window_start_missing');
    expect(historical.rows[0]?.window5.value).toBeNull();

    const exact = await execute(ctx, {
      kind: 'industry',
      sort: 'day',
      window: 'w15',
      at: at('10:15'),
    });
    expect(exact.anchor?.sampledAt).toEqual(at('10:15'));
    expect(exact.windows.w15.status).toBe('complete');
    expect(exact.windows.w15.startSampledAt).toEqual(at('10:00'));
    expect(exact.windows.w15.spanMs).toBe(15 * 60_000);
    expect(exact.rows[0]?.window15.value).not.toBeNull();

    const beforeOpen = await execute(ctx, {
      kind: 'industry',
      sort: 'day',
      window: 'w5',
      at: at('09:00'),
    });
    expect(beforeOpen.state).toBe('empty');
    expect(beforeOpen.emptyReason).toBe('no_batch');
  });

  it('没有天梯快照时封板数为 null + 原因，不写 0', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const ranking = await execute(ctx, { kind: 'industry', sort: 'day', window: 'w5' });

    expect(ranking.limitUp.status).toBe('unavailable');
    expect(ranking.limitUp.reason).toContain('limit_up_missing');
    expect(ranking.rows.every((row) => row.limitUp.value === null)).toBe(true);
    expect(ranking.rows.some((row) => row.limitUp.value === 0)).toBe(false);
  });

  it('目录未同步 / 目录无成分时返回明确空态', async () => {
    const { ctx } = await contextAt();
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const noCatalog = await execute(ctx, { kind: 'industry', sort: 'day', window: 'w15' });
    expect(noCatalog.state).toBe('empty');
    expect(noCatalog.emptyReason).toBe('no_sector_catalog');
    expect(noCatalog.anchor?.sampledAt).toEqual(at('10:15'));

    await ctx.repos.sectorCatalog.applySync({
      syncId: 'sector-catalog-empty',
      source: 'fuyao',
      appliedAt: at('09:00'),
      status: 'succeeded',
      catalog: [industry('881003.TI', '空板块')],
      catalogKinds: ['industry'],
      observations: [],
      stockStatuses: [],
      failures: [],
    });
    const noMembers = await execute(ctx, { kind: 'industry', sort: 'day', window: 'w15' });
    expect(noMembers.state).toBe('empty');
    expect(noMembers.emptyReason).toBe('no_members');
  });

  it('非交易日 / 盘前按总览口径返回空态，不拿上一交易日批次冒充当日盘面', async () => {
    const weekend = await buildTestContext({ clock: () => new Date('2026-09-26T02:00:00.000Z') });
    await seedCatalog(weekend.repos);
    await weekend.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    const nonTrading = await execute(weekend, { kind: 'industry', sort: 'day', window: 'w15' });
    expect(nonTrading.state).toBe('empty');
    expect(nonTrading.emptyReason).toBe('non_trading_day');

    const preOpen = await contextAt(() => at('09:10'));
    await seedCatalog(preOpen.ctx.repos);
    await preOpen.ctx.repos.marketSnapshotBatch.publish(
      batchOn('2026-09-24', '10:15', marketDayItems(2)),
    );
    // 盘前时钟 + 只有上一交易日批次：不拿旧批次冒充当日盘面。
    const preOpenRanking = await execute(preOpen.ctx, {
      kind: 'industry',
      sort: 'day',
      window: 'w15',
    });
    expect(preOpenRanking.state).toBe('empty');
    expect(preOpenRanking.emptyReason).toBe('pre_open');
  });

  it('窗口跨午休时不比较两端价格，占比随之缺失', async () => {
    const { ctx } = await contextAt(() => at('13:16'));
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('11:00', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('13:15', marketDayItems(2)));

    const ranking = await execute(ctx, { kind: 'industry', sort: 'day', window: 'w15' });

    expect(ranking.windows.w15.status).toBe('unavailable');
    expect(ranking.windows.w15.reason).toContain('window_crosses_lunch_break');
    expect(ranking.rows.every((row) => row.window15.value === null)).toBe(true);
    expect(ranking.turnover.status).toBe('unavailable');
    expect(ranking.rows.every((row) => row.turnover.value === null)).toBe(true);
    // 日涨幅只依赖锚点批次，跨午休不抹掉它。
    expect(ranking.rows[0]?.day.value).not.toBeNull();
  });

  it('六个模拟时点全部发布后，锚点始终取最近批次', async () => {
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

    const ranking = await execute(ctx, { kind: 'industry', sort: 'day', window: 'w15' });

    expect(ranking.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[5]?.at);
    expect(ranking.windows.w15.status).toBe('unavailable');
    const leaders = ranking.rows.find((row) => row.name === '领涨组');
    expect(leaders?.day.value).toBeCloseTo(dayMean(marketDayItems(5), LEADERS), 4);
    // 尾盘时接力组日涨幅更高，名次由口径与当下盘面决定。
    expect(ranking.rows[0]?.name).toBe('接力组');
  });
});
