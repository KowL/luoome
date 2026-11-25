import {
  MARKET_DAY_POINTS,
  MARKET_DAY_TRADING_DATE,
  MarketDayFixtureAdapter,
  marketDayItems,
  TEST_STOCKS,
} from '@luoome/adapters/testing';
import {
  buildLimitUpLadderSample,
  buildMarketSnapshotBatch,
  type LimitUpLadder,
  LimitUpLadderSchema,
  type MarketSnapshotItem,
  type RepositoryRegistry,
  type SectorCatalogObservation,
  type StockSectorObservation,
  type ToolContext,
} from '@luoome/core';
import {
  type GetMarketRoomMainstreamInputT,
  getMarketRoomMainstreamTool,
} from '@luoome/toolkit/tools/market-room-mainstream.js';
import { describe, expect, it } from 'vitest';
import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const NOW = at('10:16');

const A_SHARE_IDS = marketDayItems(0).map((entry) => entry.id);
const AI_STOCKS = A_SHARE_IDS.slice(0, 3);
const CHIP_STOCKS = A_SHARE_IDS.slice(3, 5);
const ROBOT_STOCKS = A_SHARE_IDS.slice(5, 7);
/** 同时属于 AI 与半导体：用于验证父板块并集只计一次。 */
const CROSS_THEME_STOCK = A_SHARE_IDS[0] as string;

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

const concept = (vendorCode: string, name: string): SectorCatalogObservation => ({
  kind: 'concept',
  vendorCode,
  name,
});

const AI = concept('885728.TI', '人工智能');
const AI_APP = concept('886108.TI', 'AI应用');
const CHIP = concept('885756.TI', '芯片概念');
const ROBOT = concept('885517.TI', '机器人概念');
const MARKET_LABEL = concept('885338.TI', '融资融券');

const observation = (
  stockId: string,
  sectors: readonly SectorCatalogObservation[],
): StockSectorObservation => ({ stockId, sectors: [...sectors] });

const seedCatalog = async (
  repos: RepositoryRegistry,
  options: { readonly lateMember?: string } = {},
): Promise<void> => {
  const observations = [
    ...AI_STOCKS.map((stockId, index) =>
      observation(
        stockId,
        stockId === CROSS_THEME_STOCK ? [AI, AI_APP, CHIP] : index === 0 ? [AI, AI_APP] : [AI],
      ),
    ),
    ...CHIP_STOCKS.map((stockId) => observation(stockId, [CHIP])),
    ...ROBOT_STOCKS.map((stockId) => observation(stockId, [ROBOT])),
  ];
  await repos.sectorCatalog.applySync({
    syncId: 'sector-catalog-mainstream',
    source: 'fuyao',
    appliedAt: at('09:00'),
    status: 'succeeded',
    catalog: [AI, AI_APP, CHIP, ROBOT, MARKET_LABEL],
    catalogKinds: ['concept'],
    observations: [...observations, observation(A_SHARE_IDS[9] as string, [MARKET_LABEL])],
    stockStatuses: [],
    failures: [],
  });
  if (options.lateMember !== undefined) {
    await repos.sectorCatalog.applySync({
      syncId: 'sector-catalog-mainstream-late',
      source: 'fuyao',
      appliedAt: at('10:20'),
      status: 'succeeded',
      catalog: [AI, AI_APP, CHIP, ROBOT, MARKET_LABEL],
      catalogKinds: ['concept'],
      observations: [
        ...observations,
        observation(A_SHARE_IDS[9] as string, [MARKET_LABEL]),
        observation(options.lateMember, [AI]),
      ],
      stockStatuses: [],
      failures: [],
    });
  }
};

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, current) => sum + current, 0) / values.length;

const changePctOf = (items: readonly MarketSnapshotItem[], stockId: string): number => {
  const item = items.find((entry) => entry.id === stockId);
  if (item?.changePct === undefined) throw new Error(`fixture 缺 ${stockId} 的涨幅`);
  return item.changePct;
};

const dayMean = (items: readonly MarketSnapshotItem[], stockIds: readonly string[]): number =>
  meanOf(stockIds.map((stockId) => changePctOf(items, stockId)));

const executeOutput = async (ctx: ToolContext, input: GetMarketRoomMainstreamInputT) => {
  const result = await getMarketRoomMainstreamTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data;
};

const execute = async (ctx: ToolContext, input: GetMarketRoomMainstreamInputT) =>
  (await executeOutput(ctx, input)).mainstream;

const ladderSample = (input: {
  readonly time: string;
  readonly code: string;
  readonly level: number;
  readonly firstTime?: string;
}) => {
  const ladder: LimitUpLadder = LimitUpLadderSchema.parse({
    date: TRADING_DATE,
    total: 1,
    maxLevel: input.level,
    source: 'eastmoney',
    levels: [
      {
        level: input.level,
        name: `${input.level} 连板`,
        count: 1,
        stocks: [
          {
            code: input.code,
            name: input.code,
            industry: '--',
            ladderLevel: input.level,
            uncategorized: false,
            firstTime: input.firstTime ?? '09:35:00',
            finalTime: null,
            reason: '--',
            price: 10,
            rawClose: 10,
            corrected: false,
            changePct: 0.1,
            limitUpDate: TRADING_DATE,
            board: 'main_board',
          },
        ],
      },
    ],
    warnings: [],
    asOf: at(input.time),
  });
  return buildLimitUpLadderSample({ ladder, sampledAt: at(input.time) });
};

const themeOf = (map: Awaited<ReturnType<typeof execute>>, themeId: string) => {
  const found = map.parents
    .flatMap((parent) => parent.themes)
    .find((row) => row.themeId === themeId);
  if (found === undefined) throw new Error(`未找到标准题材 ${themeId}`);
  return found;
};

const parentOf = (map: Awaited<ReturnType<typeof execute>>, parentId: string) => {
  const found = map.parents.find((row) => row.parentId === parentId);
  if (found === undefined) throw new Error(`未找到父板块 ${parentId}`);
  return found;
};

describe('get_market_room_mainstream', () => {
  it('没有已发布批次时返回 no_batch 空态，不触发采集', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    const adapter = new MarketDayFixtureAdapter({ clock: () => NOW });
    const map = await execute(
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
      { sort: 'day', window: 'w15' },
    );

    expect(map).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      sort: 'day',
      window: 'w15',
      anchor: null,
      parents: [],
    });
    expect(adapter.envelopeCalls).toBe(0);
  });

  it('固定父板块全部返回，科技下跌日仍有全部分类与并集行情', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const map = await execute(ctx, { sort: 'day', window: 'w15' });
    const items = marketDayItems(2);

    expect(map.state).toBe('ready');
    expect(map.parents.map((row) => row.name)).toEqual([
      '科技',
      '新能源',
      '汽车与智能出行',
      '医药医疗',
      '消费',
      '周期资源',
      '金融',
      '军工与高端制造',
      '地产基建',
      '公用事业与交通运输',
      '农业',
    ]);
    expect(map.coverage).toMatchObject({
      parentCount: 11,
      catalogConceptCount: 5,
      unmappedConceptCount: 1,
    });
    expect(map.coverage.unmappedConcepts).toEqual([{ vendorCode: '885338.TI', name: '融资融券' }]);

    const tech = parentOf(map, 'tech');
    expect(tech.themes.map((row) => row.name)).toEqual(
      expect.arrayContaining(['AI与算力', '半导体', '软件与信创', '消费电子', '机器人/智能制造']),
    );

    const ai = themeOf(map, 'ai-computing');
    expect(ai.sources.map((source) => source.vendorCode)).toEqual(['885728.TI', '886108.TI']);
    expect(ai.day.memberCount).toBe(AI_STOCKS.length);
    expect(ai.day.value).toBeCloseTo(dayMean(items, AI_STOCKS), 4);

    const chip = themeOf(map, 'semiconductor');
    expect(chip.day.memberCount).toBe(CHIP_STOCKS.length + 1);
    expect(chip.missingVendorCodes.length).toBeGreaterThan(0);

    // 父板块是子题材并集：A_SHARE_IDS[2] 同时在 AI 与半导体，只计一次。
    const techIds = [...new Set([...AI_STOCKS, ...CHIP_STOCKS, ...ROBOT_STOCKS])];
    expect(tech.day.memberCount).toBe(techIds.length);
    expect(tech.day.value).toBeCloseTo(dayMean(items, techIds), 4);

    const energy = parentOf(map, 'new-energy');
    expect(energy.themes.length).toBeGreaterThan(0);
    expect(energy.themes.every((row) => row.sources.length === 0)).toBe(true);
    expect(energy.themes.every((row) => row.missingVendorCodes.length > 0)).toBe(true);
    expect(energy.day.memberCount).toBe(0);
    expect(energy.day.value).toBeNull();
  });

  it('按日涨幅 / 窗口涨幅排序，缺样本不补零', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const day = await execute(ctx, { sort: 'day', window: 'w15' });
    expect(themeOf(day, 'ai-computing').day.value).not.toBeNull();
    const sortedThemes = parentOf(day, 'tech').themes.filter((row) => row.day.value !== null);
    for (let index = 1; index < sortedThemes.length; index += 1) {
      expect(
        (sortedThemes[index - 1]?.day.value ?? 0) >= (sortedThemes[index]?.day.value ?? 0),
      ).toBe(true);
    }

    const window5 = await execute(ctx, { sort: 'window5', window: 'w5' });
    expect(window5.sort).toBe('window5');
    expect(window5.windows.w5.status).toBe('complete');
    expect(themeOf(window5, 'ai-computing').window5.value).not.toBeNull();

    expect(day.limitUp.status).toBe('unavailable');
    expect(day.limitUp.reason).toContain('limit_up_missing');
    expect(themeOf(day, 'ai-computing').limitUp.value).toBeNull();
  });

  it('给定 at 使用当时生效的目录与成分，之后纳入的股票不计入历史', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    const lateMember = A_SHARE_IDS[8] as string;
    await seedCatalog(ctx.repos, { lateMember });
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const historical = await execute(ctx, {
      sort: 'day',
      window: 'w15',
      at: at('10:15'),
    });
    expect(historical.anchor?.sampledAt).toEqual(at('10:15'));
    expect(themeOf(historical, 'ai-computing').day.memberCount).toBe(AI_STOCKS.length);

    const latest = await execute(ctx, { sort: 'day', window: 'w15' });
    expect(themeOf(latest, 'ai-computing').day.memberCount).toBe(AI_STOCKS.length + 1);

    const atAdmission = await execute(ctx, {
      sort: 'day',
      window: 'w15',
      at: at('10:20'),
    });
    expect(themeOf(atAdmission, 'ai-computing').day.memberCount).toBe(AI_STOCKS.length + 1);
  });

  it('目录未同步 / 无成分时返回明确空态', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const noCatalog = await execute(ctx, { sort: 'day', window: 'w15' });
    expect(noCatalog.state).toBe('empty');
    expect(noCatalog.emptyReason).toBe('no_sector_catalog');

    await ctx.repos.sectorCatalog.applySync({
      syncId: 'sector-catalog-mainstream-empty',
      source: 'fuyao',
      appliedAt: at('09:00'),
      status: 'succeeded',
      catalog: [AI],
      catalogKinds: ['concept'],
      observations: [],
      stockStatuses: [],
      failures: [],
    });
    const noMembers = await execute(ctx, { sort: 'day', window: 'w15' });
    expect(noMembers.state).toBe('empty');
    expect(noMembers.emptyReason).toBe('no_members');
  });

  it('六个模拟时点全部发布后，锚点始终取最近批次', async () => {
    const ctx = await buildTestContext({
      clock: () => MARKET_DAY_POINTS[5]?.at ?? NOW,
    });
    await seedCatalog(ctx.repos);
    for (const [index, point] of MARKET_DAY_POINTS.entries()) {
      const shanghai = new Date(point.at.getTime() + 8 * 60 * 60 * 1000);
      const time = `${String(shanghai.getUTCHours()).padStart(2, '0')}:${String(
        shanghai.getUTCMinutes(),
      ).padStart(2, '0')}`;
      await ctx.repos.marketSnapshotBatch.publish(
        batchOn(MARKET_DAY_TRADING_DATE, time, marketDayItems(index)),
      );
    }

    const map = await execute(ctx, { sort: 'day', window: 'w15' });
    expect(map.anchor?.sampledAt).toEqual(MARKET_DAY_POINTS[5]?.at);
    expect(map.state).toBe('ready');
    expect(map.parents.length).toBe(11);
  });
});

describe('get_market_room_mainstream 核心股与成分读模型', () => {
  const codeOf = (stockId: string) => stockId.split('.')[0] as string;

  const stockBoardOf = (data: Awaited<ReturnType<typeof executeOutput>>, themeId: string) => {
    const found = data.stockBoard.themes.find((theme) => theme.themeId === themeId);
    if (found === undefined) throw new Error(`未找到 ${themeId} 核心股`);
    return found;
  };

  it('与题材地图使用同一 anchor，代表股有中文名、核心股不超过 5 只', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedCatalog(ctx.repos);
    await seedTestStockUniverse(ctx);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:00', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:10', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));
    await ctx.repos.limitUpLadderSample.save(
      ladderSample({ time: '10:15', code: codeOf(CROSS_THEME_STOCK), level: 2 }),
    );

    const data = await executeOutput(ctx, { sort: 'day', window: 'w15' });
    expect(data.stockBoard.state).toBe('ready');
    expect(data.stockBoard.anchor?.sampledAt).toEqual(data.mainstream.anchor?.sampledAt);
    expect(data.stockBoard.window).toBe('w15');

    const anchorItems = marketDayItems(2);
    const leaderId = [...AI_STOCKS].sort((left, right) => {
      const leftChange = anchorItems.find((item) => item.id === left)?.changePct ?? 0;
      const rightChange = anchorItems.find((item) => item.id === right)?.changePct ?? 0;
      return rightChange - leftChange;
    })[0];
    const leaderName = TEST_STOCKS.find((stock) => stock.id === leaderId)?.name;
    const ai = stockBoardOf(data, 'ai-computing');
    expect(ai.representative?.name).toBe(leaderName);
    expect(ai.representative?.nameSource).toBe('stock_universe');
    expect(ai.representative?.roles).toContain('leader');
    const heightName = TEST_STOCKS.find((stock) => stock.id === CROSS_THEME_STOCK)?.name;
    expect(ai.coreStocks.find((row) => row.name === heightName)?.roles).toContain('height');
    expect(ai.coreStocks.length).toBeGreaterThan(0);
    expect(ai.coreStocks.length).toBeLessThanOrEqual(5);
    expect(ai.coreStocks[0]?.window15ChangePct).not.toBeNull();
    expect(ai.share.denominator).not.toBeNull();
    expect(ai.coreStocks.every((row) => row.name !== null)).toBe(true);
    expect(ai.constituents.every((row) => row.name !== null)).toBe(true);
    expect(ai.ladder.status).toBe('complete');
    expect(ai.ladder.brokenBoardStatus).toBe('unavailable');
    expect(ai.constituents.every((row) => row.brokenBoard === null)).toBe(true);
  });

  it('没有 stockUniverse 时中文名缺失，不用快照代码占位', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedCatalog(ctx.repos);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:00', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const data = await executeOutput(ctx, { sort: 'day', window: 'w15' });
    const ai = stockBoardOf(data, 'ai-computing');
    expect(ai.representative?.name).toBeNull();
    expect(ai.representative?.nameSource).toBeNull();
    expect(ai.coverage.unnamedCount).toBeGreaterThan(0);
    expect(data.stockBoard.coverage.universeCount).toBe(0);
  });

  it('给定 at 时核心股与题材地图都只使用该时点及之前的批次', async () => {
    const ctx = await buildTestContext({ clock: () => new Date(NOW.getTime()) });
    await seedCatalog(ctx.repos);
    await seedTestStockUniverse(ctx);
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:00', marketDayItems(1)));
    await ctx.repos.marketSnapshotBatch.publish(batchOf('10:15', marketDayItems(2)));

    const data = await executeOutput(ctx, {
      sort: 'day',
      window: 'w15',
      at: at('10:15'),
    });
    expect(data.stockBoard.anchor?.sampledAt).toEqual(at('10:15'));
    expect(data.mainstream.anchor?.sampledAt).toEqual(at('10:15'));
    const ai = stockBoardOf(data, 'ai-computing');
    expect(ai.constituents.length).toBe(AI_STOCKS.length);
  });
});
