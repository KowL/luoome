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
  type GetMarketRoomSectorDetailInputT,
  getMarketRoomSectorDetailTool,
} from './market-room-sector-detail.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('10:16');

const A_SHARE_IDS = marketDayItems(0).map((entry) => entry.id);
const LEADERS = A_SHARE_IDS.slice(0, 3);
const FOLLOWERS = A_SHARE_IDS.slice(3);

const batchOn = (date: string, time: string, items: readonly MarketSnapshotItem[]) => {
  const sampledAt = new Date(`${date}T${time}+08:00`);
  return buildMarketSnapshotBatch({
    sampledAt,
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'market-day-fixture',
      fetchedAt: sampledAt,
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
    syncId: 'sector-detail-catalog',
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

const sectorIdOf = async (ctx: ToolContext, name: string): Promise<string> => {
  const sectors = await ctx.repos.sectorCatalog.listSectors({ state: 'active' });
  const sector = sectors.find((entry) => entry.name === name);
  if (sector === undefined) throw new Error(`fixture 缺板块 ${name}`);
  return sector.id;
};

const contextAt = async (
  clock: () => Date = () => new Date(NOW.getTime()),
): Promise<{ readonly ctx: ToolContext; readonly adapter: MarketDayFixtureAdapter }> => {
  const ctx = await buildTestContext({ clock });
  const adapter = new MarketDayFixtureAdapter({ clock });
  return { ctx, adapter };
};

const execute = async (ctx: ToolContext, input: Partial<GetMarketRoomSectorDetailInputT>) => {
  const result = await getMarketRoomSectorDetailTool.execute(
    { sectorId: '', window: 'w15', compareSectorIds: [], ...input },
    ctx,
  );
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.detail;
};

const publishMarketDay = async (
  ctx: ToolContext,
  itemsAt: (pointIndex: number) => readonly MarketSnapshotItem[] = marketDayItems,
): Promise<void> => {
  for (const [index, point] of MARKET_DAY_POINTS.entries()) {
    const items = itemsAt(index);
    await ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({
        sampledAt: point.at,
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'market-day-fixture',
          fetchedAt: point.at,
          items: [...items],
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
};

const requireValue = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('expected value');
  return value;
};

describe('get_market_room_sector_detail', () => {
  it('六个模拟时点生成走势序列，method 标注成分等权合成而非板块指数', async () => {
    const { ctx } = await contextAt(() => MARKET_DAY_POINTS[5]?.at ?? NOW);
    await seedCatalog(ctx.repos);
    await publishMarketDay(ctx);
    const sectorId = await sectorIdOf(ctx, '领涨组');

    const detail = await execute(ctx, { sectorId, window: 'w15' });

    expect(detail.state).toBe('ready');
    expect(detail.sector?.name).toBe('领涨组');
    expect(detail.tradingDate).toBe(TRADING_DATE);
    expect(detail.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[5]?.at);
    const trend = requireValue(detail.trend);
    expect(trend.method).toBe('constituent_equal_weight');
    expect(trend.indexFallbackReason).toContain('不用大盘指数冒充');
    expect(trend.points).toHaveLength(MARKET_DAY_POINTS.length);
    expect(trend.points[0]?.value).toBe(100);
    expect(trend.coverage).toMatchObject({
      batchCount: 6,
      pointCount: 6,
      availablePointCount: 6,
      baseSampledAt: MARKET_DAY_POINTS[0]?.at,
    });
    expect(detail.coverage).toMatchObject({
      batchCount: 6,
      trendPointCount: 6,
      memberCount: LEADERS.length,
      comparisonCount: 0,
      unresolvedComparisonCount: 0,
    });
    expect(detail.leaderOrder.length).toBe(6);

    const breadth = requireValue(detail.breadth);
    expect(breadth.sampleCount).toBe(LEADERS.length);
    expect(breadth.advanceRatio).not.toBeNull();
    expect(requireValue(detail.day).value).not.toBeNull();
    // 六个模拟时点不是 5 / 15 分钟等距，窗口口径按既有规则标缺失，占比随之缺失。
    expect(detail.windows.w15.status).toBe('unavailable');
    expect(requireValue(detail.turnover).value).toBeNull();
    expect(requireValue(detail.limitUp).value).toBeNull();
    expect(detail.members).toHaveLength(LEADERS.length);
  });

  it('对照板块并列序列并标出领先顺序变化时点，未收录板块进入未解析清单', async () => {
    const { ctx } = await contextAt(() => MARKET_DAY_POINTS[5]?.at ?? NOW);
    await seedCatalog(ctx.repos);
    // 通用夹具只有日涨幅接力；早盘额外抬升，才能在首样本归一化后形成真实交叉。
    await publishMarketDay(ctx, (index) =>
      marketDayItems(index).map((item) => {
        if ((index !== 1 && index !== 2) || !LEADERS.includes(item.id)) return item;
        return {
          ...item,
          close: Math.round(requireValue(item.close) * 1.03 * 100) / 100,
          changePct:
            Math.round(((1 + requireValue(item.changePct) / 100) * 1.03 - 1) * 10_000) / 100,
        };
      }),
    );
    const leaders = await sectorIdOf(ctx, '领涨组');
    const followers = await sectorIdOf(ctx, '接力组');
    const overlap = await sectorIdOf(ctx, '重叠概念');

    const detail = await execute(ctx, {
      sectorId: leaders,
      compareSectorIds: [followers, overlap, 'missing-sector', followers],
      window: 'w15',
    });

    expect(detail.comparisons.map((series) => series.name)).toEqual(['接力组', '重叠概念']);
    expect(detail.unresolvedSectorIds).toEqual(['missing-sector']);
    expect(detail.leaderOrder).toHaveLength(6);
    expect(detail.leaderOrder.some((point) => point.reordered)).toBe(true);
    const early = requireValue(detail.leaderOrder[1]);
    const handoff = requireValue(detail.leaderOrder[3]);
    expect(early.entries.map((entry) => entry.name)).toEqual(['领涨组', '重叠概念', '接力组']);
    expect(handoff.entries.map((entry) => entry.name)).toEqual(['接力组', '重叠概念', '领涨组']);
    expect(handoff.reordered).toBe(true);
    expect(handoff.previousOrder).toEqual([leaders, overlap, followers]);

    const last = detail.leaderOrder.at(-1);
    expect(last?.entries[0]?.name).toBe('接力组');
    expect(detail.notes.join(' ')).toContain('comparison_unresolved');
    expect(detail.notes.join(' ')).toContain('不产出事件');
  });

  it('日涨幅接力不等于归一化走势换位，接力组从首个可比较时点起始终领先时不误报交叉', async () => {
    const { ctx } = await contextAt(() => MARKET_DAY_POINTS[5]?.at ?? NOW);
    await seedCatalog(ctx.repos);
    await publishMarketDay(ctx);
    const leaders = await sectorIdOf(ctx, '领涨组');
    const followers = await sectorIdOf(ctx, '接力组');
    const detail = await execute(ctx, { sectorId: leaders, compareSectorIds: [followers] });
    const dayChanges = (index: number, stockIds: readonly string[]) =>
      marketDayItems(index)
        .filter((item) => stockIds.includes(item.id))
        .map((item) => requireValue(item.changePct));
    expect(Math.min(...dayChanges(0, LEADERS))).toBeGreaterThan(
      Math.max(...dayChanges(0, FOLLOWERS)),
    );
    expect(Math.max(...dayChanges(5, LEADERS))).toBeLessThan(Math.min(...dayChanges(5, FOLLOWERS)));
    const leaderTrend = requireValue(detail.trend);
    const followerTrend = requireValue(detail.comparisons[0]);
    expect(leaderTrend.points[0]?.value).toBe(100);
    expect(followerTrend.points[0]?.value).toBe(100);
    for (let index = 1; index < MARKET_DAY_POINTS.length; index++) {
      expect(requireValue(leaderTrend.points[index]?.value)).toBeLessThan(100);
      expect(requireValue(followerTrend.points[index]?.value)).toBeGreaterThan(100);
      expect(detail.leaderOrder[index]?.entries[0]?.sectorId).toBe(followers);
    }
    expect(detail.leaderOrder.slice(2).every((point) => !point.reordered)).toBe(true);
  });

  it('给定 at 只使用该时点及之前的批次，走势与领先顺序同步截断', async () => {
    const { ctx } = await contextAt(() => MARKET_DAY_POINTS[5]?.at ?? NOW);
    await seedCatalog(ctx.repos);
    await publishMarketDay(ctx);
    const leaders = await sectorIdOf(ctx, '领涨组');

    const detail = await execute(ctx, { sectorId: leaders, at: at('11:00'), window: 'w15' });

    expect(detail.anchor?.sampledAt).toEqual(at('11:00'));
    expect(detail.trend?.points.map((point) => point.sampledAt)).toEqual([
      MARKET_DAY_POINTS[0]?.at,
      MARKET_DAY_POINTS[1]?.at,
      MARKET_DAY_POINTS[2]?.at,
    ]);
    expect(detail.leaderOrder).toHaveLength(3);
    expect(detail.coverage.batchCount).toBe(3);
  });

  it('回放按当时生效的成分：之后才纳入的成员不出现在该时点的详情里', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    const leaders = await sectorIdOf(ctx, '领涨组');
    const lateMember = FOLLOWERS[1] as string;
    await ctx.repos.sectorCatalog.applySync({
      syncId: 'sector-detail-catalog-late',
      source: 'fuyao',
      appliedAt: at('10:20'),
      status: 'succeeded',
      catalog: [LEADER_INDUSTRY, FOLLOWER_INDUSTRY, OVERLAP_CONCEPT],
      catalogKinds: ['industry', 'concept'],
      observations: [
        ...LEADERS.map((stockId, index) =>
          observation(
            stockId,
            index === 0 ? [LEADER_INDUSTRY, OVERLAP_CONCEPT] : [LEADER_INDUSTRY],
          ),
        ),
        ...FOLLOWERS.map((stockId, index) =>
          observation(
            stockId,
            index === 0 ? [FOLLOWER_INDUSTRY, OVERLAP_CONCEPT] : [FOLLOWER_INDUSTRY],
          ),
        ),
        observation(lateMember, [LEADER_INDUSTRY]),
      ],
      stockStatuses: [],
      failures: [],
    });

    const historical = await execute(ctx, {
      sectorId: leaders,
      at: at('10:15'),
      window: 'w5',
    });
    expect(historical.coverage.memberCount).toBe(LEADERS.length);
    expect([...historical.members.map((member) => member.stockId)].sort()).toEqual(
      [...LEADERS].sort(),
    );
    expect(historical.members.some((member) => member.stockId === lateMember)).toBe(false);

    const atAdmission = await execute(ctx, {
      sectorId: leaders,
      at: at('10:25'),
      window: 'w5',
    });
    expect(atAdmission.coverage.memberCount).toBe(LEADERS.length + 1);
    expect(atAdmission.members.map((member) => member.stockId)).toContain(lateMember);

    const latest = await execute(ctx, { sectorId: leaders, window: 'w5' });
    expect(latest.coverage.memberCount).toBe(LEADERS.length + 1);
  });

  it('窗口两端批次齐全时给出成分窗口涨幅与成交额增量占比，封板数来自天梯', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    await ctx.repos.limitUpLadderSnapshot.save(ladderOf(['600519', '600036']));
    const leaders = await sectorIdOf(ctx, '领涨组');

    const detail = await execute(ctx, { sectorId: leaders, window: 'w5' });

    expect(detail.windows.w5).toMatchObject({
      status: 'complete',
      startSampledAt: at('10:10'),
      spanMs: 5 * 60_000,
    });
    const windowMetric = requireValue(detail.windowMetric);
    expect(windowMetric.value).toBeLessThan(0);
    expect(windowMetric.sampleCount).toBe(LEADERS.length);
    const turnover = requireValue(detail.turnover);
    expect(turnover.value).toBeGreaterThan(0);
    expect(requireValue(detail.limitUp).value).toBe(1);
    const sealed = detail.members.filter((member) => member.sealed === true);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.ladderLevel).toBe(1);
    const shares = detail.members
      .map((member) => member.windowAmountSharePct)
      .filter((share): share is number => share !== null);
    expect(shares).toHaveLength(LEADERS.length);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 2);
    expect(detail.members.every((member) => member.windowChangePct !== null)).toBe(true);
  });

  it('缺样本批次让走势时点标 partial，成分缺价时窗口涨幅为 null 而不是 0', async () => {
    const { ctx } = await contextAt();
    await seedCatalog(ctx.repos);
    const partialItems = marketDayItems(2).filter((entry) => entry.id !== LEADERS[0]);
    const sampledAt = at('10:15');
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({
        sampledAt,
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'market-day-fixture',
          fetchedAt: sampledAt,
          items: [...partialItems],
          completeness: {
            expectedCount: A_SHARE_IDS.length,
            receivedCount: partialItems.length,
            missingCount: A_SHARE_IDS.length - partialItems.length,
            duplicateCount: 0,
            complete: false,
          },
        },
      }),
    );
    const leaders = await sectorIdOf(ctx, '领涨组');

    const detail = await execute(ctx, { sectorId: leaders, window: 'w5' });

    const point = detail.trend?.points.at(-1);
    expect(point?.sampleCount).toBe(LEADERS.length - 1);
    expect(point?.missingCount).toBe(1);
    expect(point?.status).toBe('partial');
    expect(point?.warnings.join(' ')).toContain('missing_trend_price');
    const missingMember = detail.members.find((member) => member.stockId === LEADERS[0]);
    expect(missingMember?.inBatch).toBe(false);
    expect(missingMember?.name).toBeNull();
    expect(missingMember?.dayChangePct).toBeNull();
    expect(missingMember?.windowChangePct).toBeNull();
    expect(missingMember?.dayChangePct).not.toBe(0);
  });

  it('无批次 / 盘前 / 非交易日 / 目录缺失 / 板块不存在分别返回明确空态', async () => {
    const noBatch = await contextAt();
    const emptyBatch = await execute(noBatch.ctx, { sectorId: 'sector-x', window: 'w15' });
    expect(emptyBatch).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      trend: null,
      members: [],
    });

    const weekend = await contextAt(() => new Date('2026-09-26T02:00:00.000Z'));
    await seedCatalog(weekend.ctx.repos);
    await weekend.ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    const nonTrading = await execute(weekend.ctx, { sectorId: 'sector-x', window: 'w15' });
    expect(nonTrading.emptyReason).toBe('non_trading_day');

    const preOpen = await contextAt(() => at('09:10'));
    await seedCatalog(preOpen.ctx.repos);
    await preOpen.ctx.repos.marketSnapshotBatch.publish(
      batchOn('2026-09-24', '10:15', marketDayItems(2)),
    );
    const preOpenDetail = await execute(preOpen.ctx, { sectorId: 'sector-x', window: 'w15' });
    expect(preOpenDetail.emptyReason).toBe('pre_open');

    const ready = await contextAt();
    await ready.ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    const noCatalog = await execute(ready.ctx, { sectorId: 'sector-x', window: 'w15' });
    expect(noCatalog.emptyReason).toBe('no_sector_catalog');
    expect(noCatalog.anchor?.sampledAt).toEqual(at('10:15'));

    await seedCatalog(ready.ctx.repos);
    const notFound = await execute(ready.ctx, { sectorId: 'sector-x', window: 'w15' });
    expect(notFound.emptyReason).toBe('sector_not_found');
    expect(notFound.sector).toBeNull();
  });

  it('板块没有 active 成分时返回 no_members，不伪造走势', async () => {
    const { ctx } = await contextAt();
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    await ctx.repos.sectorCatalog.applySync({
      syncId: 'sector-detail-empty-catalog',
      source: 'fuyao',
      appliedAt: at('09:00'),
      status: 'succeeded',
      catalog: [industry('881003.TI', '空板块')],
      catalogKinds: ['industry'],
      observations: [],
      stockStatuses: [],
      failures: [],
    });
    const sectorId = await sectorIdOf(ctx, '空板块');

    const detail = await execute(ctx, { sectorId, window: 'w15' });

    expect(detail.emptyReason).toBe('no_members');
    expect(detail.sector?.name).toBe('空板块');
    expect(detail.trend).toBeNull();
  });
});
