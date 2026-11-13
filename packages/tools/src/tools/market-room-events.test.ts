import {
  MARKET_DAY_POINTS,
  MarketDayFixtureAdapter,
  marketDayItems,
  TEST_STOCKS,
} from '@luoome/adapters/testing';
import type {
  LimitUpLadder,
  LimitUpLadderCompareResultLike,
  LimitUpLadderManagerLike,
  LimitUpLadderQuery,
  LimitUpLadderResultLike,
  RepositoryRegistry,
  SectorCatalogObservation,
  SourceStatus,
  StockSectorObservation,
  ToolContext,
} from '@luoome/core';
import {
  buildMarketSnapshotBatch,
  MARKET_ROOM_EVENT_DEFAULT_RULES,
  MarketRoomEventSchema,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listMarketRoomEventsTool, scanMarketRoomEvents } from './market-room-events.js';
import { collectMarketSnapshotTool } from './market-snapshot-batch.js';

/**
 * 六时点夹具 + 手工天梯样本：领涨组（早盘强、随后回落）与接力组（后段走强）。
 * 领涨组日涨幅始终为正，接力组从负转正并在 14:15 反超，因此默认阈值下只应产生一条换位事件。
 */

const TRADING_DATE = '2026-09-28';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);

const A_SHARE_STOCKS = TEST_STOCKS.filter(
  (stock) => stock.exchange === 'SH' || stock.exchange === 'SZ',
);
const LEADERS = [A_SHARE_STOCKS[0], A_SHARE_STOCKS[1], A_SHARE_STOCKS[2]].map(
  (stock) => stock?.id ?? '',
);
const FOLLOWERS = [A_SHARE_STOCKS[5], A_SHARE_STOCKS[7], A_SHARE_STOCKS[9]].map(
  (stock) => stock?.id ?? '',
);

const LEADER_TOPIC: SectorCatalogObservation = {
  kind: 'industry',
  vendorCode: '881201.TI',
  name: '领涨题材',
};
const FOLLOWER_TOPIC: SectorCatalogObservation = {
  kind: 'industry',
  vendorCode: '881202.TI',
  name: '接力题材',
};

const observation = (
  stockId: string,
  sectors: readonly SectorCatalogObservation[],
): StockSectorObservation => ({ stockId, sectors: [...sectors] });

const seedCatalog = async (repos: RepositoryRegistry): Promise<void> => {
  await repos.sectorCatalog.applySync({
    syncId: 'events-catalog',
    source: 'fuyao',
    appliedAt: at('09:00'),
    status: 'succeeded',
    catalog: [LEADER_TOPIC, FOLLOWER_TOPIC],
    catalogKinds: ['industry', 'concept'],
    observations: [
      ...LEADERS.map((stockId) => observation(stockId, [LEADER_TOPIC])),
      ...FOLLOWERS.map((stockId) => observation(stockId, [FOLLOWER_TOPIC])),
    ],
    stockStatuses: [],
    failures: [],
  });
};

const ladderFixture = (now: Date): LimitUpLadder => ({
  date: TRADING_DATE,
  total: 2,
  maxLevel: 2,
  source: 'eastmoney',
  levels: [
    {
      level: 2,
      name: '2 连板',
      count: 1,
      stocks: [
        {
          code: '688981',
          name: '中芯国际',
          industry: '半导体',
          ladderLevel: 2,
          uncategorized: false,
          firstTime: '09:31:00',
          finalTime: '09:31:00',
          reason: '半导体+国产替代',
          price: 110,
          rawClose: 110,
          corrected: false,
          changePct: 0.2,
          limitUpDate: TRADING_DATE,
          board: 'main_board',
        },
      ],
    },
    {
      level: 1,
      name: '首板',
      count: 1,
      stocks: [
        {
          code: '601318',
          name: '中国平安',
          industry: '保险',
          ladderLevel: 1,
          uncategorized: false,
          firstTime: '13:05:00',
          finalTime: '13:05:00',
          reason: '保险+金融科技',
          price: 61,
          rawClose: 61,
          corrected: false,
          changePct: 0.1,
          limitUpDate: TRADING_DATE,
          board: 'main_board',
        },
      ],
    },
  ],
  warnings: [],
  asOf: now,
});

class StubLadderManager implements LimitUpLadderManagerLike {
  readonly name = 'limit-up-ladder' as const;
  readonly sources = ['eastmoney'];
  calls = 0;

  constructor(private readonly clock: () => Date) {}

  fetchLadder(_query: LimitUpLadderQuery): Promise<LimitUpLadderResultLike> {
    this.calls += 1;
    return Promise.resolve({ ok: true, data: ladderFixture(this.clock()) });
  }

  compareLadder(): Promise<LimitUpLadderCompareResultLike> {
    return Promise.reject(new Error('unsupported_capability: compare'));
  }

  status(): readonly SourceStatus[] {
    return [];
  }
}

interface Harness {
  readonly ctx: ToolContext;
  readonly adapter: MarketDayFixtureAdapter;
  readonly setNow: (value: Date) => void;
}

const harness = async (): Promise<Harness> => {
  let now = MARKET_DAY_POINTS[0]?.at ?? at('09:35');
  const clock = (): Date => now;
  const base = await buildTestContext({ clock, limitUpLadder: new StubLadderManager(clock) });
  const adapter = new MarketDayFixtureAdapter({ clock });
  await seedCatalog(base.repos);
  return {
    ctx: { ...base, adapters: { ...base.adapters, market: adapter } },
    adapter,
    setNow: (value: Date) => {
      now = value;
    },
  };
};

const collect = (ctx: ToolContext) => collectMarketSnapshotTool.execute({}, ctx);

const runPoints = async (h: Harness, points: readonly { readonly at: Date }[]): Promise<void> => {
  for (const point of points) {
    h.setNow(point.at);
    const result = await collect(h.ctx);
    expect(result.ok).toBe(true);
  }
};

const eventsOf = (ctx: ToolContext) =>
  ctx.repos.marketRoomEvent.list({ tradingDate: TRADING_DATE });

const eventsView = async (ctx: ToolContext, input: object) => {
  const result = await listMarketRoomEventsTool.execute(input, ctx);
  if (!result.ok) throw new Error(`tool 返回错误：${JSON.stringify(result.error)}`);
  return result.data.view;
};

describe('scan-on-publish：扩散 / 分化 / 换位事件', () => {
  it('批次发布后扫描六时点样本，换位事件只落一条且证据可追溯', async () => {
    const h = await harness();
    await runPoints(h, MARKET_DAY_POINTS);

    const events = await eventsOf(h.ctx);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing rotation event');
    expect(event.kind).toBe('rotation');
    expect(event.sector.name).toBe('接力题材');
    expect(event.sampledAt).toEqual(at('14:15'));
    expect(event.recordedAt).toEqual(at('14:15'));
    expect(event.thresholds).toEqual(MARKET_ROOM_EVENT_DEFAULT_RULES.rotation);
    expect(event.status).toBe('complete');
    expect(event.evidence.ranking.dayRank).toBe(1);
    expect(event.evidence.breadth.status).toBe('complete');
    expect(event.evidence.breadth.advanceRatio).toBe(100);
    expect(event.evidence.window.changePct).not.toBeNull();
    expect(event.evidence.turnover.sharePct).not.toBeNull();
    expect(event.evidence.rotation?.from.sector.name).toBe('领涨题材');
    expect(event.evidence.rotation?.to.sector.name).toBe('接力题材');
    expect(event.evidence.rotation?.leadSamples).toHaveLength(2);
    expect(event.evidence.ladder.status).toBe('complete');
    expect(event.evidence.ladder.sealedCount).toBe(2);
    expect(event.evidence.ladder.stocks.map((stock) => stock.code)).toEqual(['688981', '601318']);
    expect(event.evidence.ladder.stocks.map((stock) => stock.reason)).toEqual([
      '半导体+国产替代',
      '保险+金融科技',
    ]);
    expect(event.evidence.keywords.map((keyword) => keyword.text)).toEqual([
      '半导体',
      '国产替代',
      '保险',
      '金融科技',
    ]);
    expect(event.evidence.members.memberCount).toBe(3);
    expect(event.verification.status).toBe('verified');
    // 输出 schema 可解析，说明落库内容与工具出参契约一致。
    expect(() => MarketRoomEventSchema.parse(event)).not.toThrow();
  });

  it('重复扫描与同批次重试都不新增事件', async () => {
    const h = await harness();
    await runPoints(h, MARKET_DAY_POINTS);
    const before = await eventsOf(h.ctx);

    await scanMarketRoomEvents(h.ctx, TRADING_DATE);
    await scanMarketRoomEvents(h.ctx, TRADING_DATE);
    h.setNow(at('14:50'));
    const retry = await collect(h.ctx);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.created).toBe(false);
    expect((await eventsOf(h.ctx)).map((event) => event.id)).toEqual(
      before.map((event) => event.id),
    );
  });

  it('事件写入失败只加 warning，不阻塞批次发布，下次扫描补写', async () => {
    const h = await harness();
    await runPoints(h, MARKET_DAY_POINTS.slice(0, 4));
    const repo = h.ctx.repos.marketRoomEvent as unknown as {
      save: (event: unknown) => Promise<unknown>;
    };
    const originalSave = repo.save;
    repo.save = async () => {
      throw new Error('disk full');
    };
    try {
      h.setNow(at('14:15'));
      const failed = await collect(h.ctx);
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(
        failed.data.warnings.some((warning) => warning.startsWith('market_room_event_save_failed')),
      ).toBe(true);
      expect(await eventsOf(h.ctx)).toHaveLength(0);
    } finally {
      repo.save = originalSave;
    }

    h.setNow(at('14:50'));
    const recovered = await collect(h.ctx);
    expect(recovered.ok).toBe(true);
    const events = await eventsOf(h.ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.recordedAt).toEqual(at('14:50'));
  });

  it('回放按 knownAt 截断：之后才记录的事件不出现在更早的事件列表里', async () => {
    const h = await harness();
    await runPoints(h, MARKET_DAY_POINTS.slice(0, 4));
    const repo = h.ctx.repos.marketRoomEvent as unknown as {
      save: (event: unknown) => Promise<unknown>;
    };
    const originalSave = repo.save;
    repo.save = async () => {
      throw new Error('disk full');
    };
    try {
      h.setNow(at('14:15'));
      const failed = await collect(h.ctx);
      expect(failed.ok).toBe(true);
    } finally {
      repo.save = originalSave;
    }
    h.setNow(at('14:50'));
    const recovered = await collect(h.ctx);
    expect(recovered.ok).toBe(true);

    const events = await eventsOf(h.ctx);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('missing rotation event');
    // 事件检测样本是 14:15，但 14:50 才补写：更早的已知时点不得看到它。
    expect(event.sampledAt).toEqual(at('14:15'));
    expect(event.recordedAt).toEqual(at('14:50'));

    const beforeKnown = await eventsView(h.ctx, { knownAt: at('14:15') });
    expect(beforeKnown.state).toBe('empty');
    expect(beforeKnown.emptyReason).toBe('no_events');
    expect(beforeKnown.filters.knownAt).toEqual(at('14:15'));
    expect(beforeKnown.events).toEqual([]);

    const atKnown = await eventsView(h.ctx, { knownAt: at('14:50') });
    expect(atKnown.state).toBe('ready');
    expect(atKnown.events.map((item) => item.id)).toEqual([event.id]);
    expect(atKnown.notes.join(' ')).toContain('knownAt');

    // 回放读取不触发采集，也不写入新事件。
    const callsBefore = h.adapter.envelopeCalls;
    const countBefore = (await eventsOf(h.ctx)).length;
    await eventsView(h.ctx, { knownAt: at('14:15') });
    await eventsView(h.ctx, { knownAt: at('14:50') });
    expect(h.adapter.envelopeCalls).toBe(callsBefore);
    expect((await eventsOf(h.ctx)).length).toBe(countBefore);
  });

  it('目录读取失败只返回扫描 warning，不抛异常', async () => {
    const h = await harness();
    h.setNow(at('09:35'));
    await collect(h.ctx);
    const catalog = h.ctx.repos.sectorCatalog as unknown as {
      listSectors: () => Promise<unknown>;
    };
    const originalList = catalog.listSectors;
    catalog.listSectors = async () => {
      throw new Error('catalog unavailable');
    };
    try {
      const warnings = await scanMarketRoomEvents(h.ctx, TRADING_DATE);
      expect(warnings).toEqual([
        'market_room_event_scan_failed: 读取板块目录失败 catalog unavailable',
      ]);
    } finally {
      catalog.listSectors = originalList;
    }
  });
});

describe('list_market_room_events', () => {
  it('默认跟随最近批次的交易日，并按种类 / 板块 / 时段过滤', async () => {
    const h = await harness();
    await runPoints(h, MARKET_DAY_POINTS);
    const events = await eventsOf(h.ctx);
    const event = events[0];
    if (event === undefined) throw new Error('missing rotation event');

    const all = await eventsView(h.ctx, {});
    expect(all.state).toBe('ready');
    expect(all.tradingDate).toBe(TRADING_DATE);
    expect(all.filters).toEqual({
      date: null,
      from: null,
      to: null,
      kind: null,
      sectorId: null,
      knownAt: null,
    });
    expect(all.counts).toEqual({ total: 1, diffusion: 0, divergence: 0, rotation: 1 });
    expect(all.events.map((item) => item.id)).toEqual([event.id]);
    expect(all.notes.length).toBeGreaterThan(0);

    expect((await eventsView(h.ctx, { kind: 'rotation' })).counts.total).toBe(1);
    const diffusion = await eventsView(h.ctx, { kind: 'diffusion' });
    expect(diffusion.state).toBe('empty');
    expect(diffusion.emptyReason).toBe('no_events');

    expect((await eventsView(h.ctx, { sectorId: event.sector.sectorId })).counts.total).toBe(1);
    expect((await eventsView(h.ctx, { sectorId: 'missing-sector' })).emptyReason).toBe('no_events');

    const inRange = await eventsView(h.ctx, {
      date: TRADING_DATE,
      from: at('14:00'),
      to: at('14:20'),
    });
    expect(inRange.counts.total).toBe(1);
    const afterRange = await eventsView(h.ctx, { from: at('14:20') });
    expect(afterRange.state).toBe('empty');
    expect(afterRange.emptyReason).toBe('no_events');
    expect(afterRange.tradingDate).toBe(TRADING_DATE);

    // 次日已发布批次但还没有事件时，默认跟随最近批次，不回退到昨日事件。
    const nextDay = new Date('2026-09-29T09:35:00+08:00');
    const items = MARKET_DAY_POINTS[0] === undefined ? [] : marketDayItems(0);
    await h.ctx.repos.marketSnapshotBatch.publish(
      buildMarketSnapshotBatch({
        sampledAt: nextDay,
        snapshot: {
          coverage: 'CN_A_SHARES_SH_SZ',
          source: 'market-day-fixture',
          fetchedAt: nextDay,
          items: [...items],
          completeness: {
            expectedCount: items.length,
            receivedCount: items.length,
            missingCount: 0,
            duplicateCount: 0,
            complete: true,
          },
        },
      }),
    );
    const next = await eventsView(h.ctx, {});
    expect(next.tradingDate).toBe('2026-09-29');
    expect(next.emptyReason).toBe('no_events');
  });

  it('无批次与参数冲突分别返回空态与 invalid_input', async () => {
    const base = await buildTestContext({ clock: () => at('14:50') });
    const empty = await eventsView(base, {});
    expect(empty.state).toBe('empty');
    expect(empty.emptyReason).toBe('no_batch');
    expect(empty.tradingDate).toBeNull();

    const h = await harness();
    h.setNow(at('09:35'));
    await collect(h.ctx);
    const noEvents = await eventsView(h.ctx, {});
    expect(noEvents.emptyReason).toBe('no_events');
    expect(noEvents.tradingDate).toBe(TRADING_DATE);

    const invalid = await listMarketRoomEventsTool.execute(
      { from: at('14:20'), to: at('14:10') },
      h.ctx,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.kind).toBe('invalid_input');

    const badDate = await listMarketRoomEventsTool.execute({ date: '2026/09/28' }, h.ctx);
    expect(badDate.ok).toBe(false);
  });
});
