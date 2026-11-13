import type {
  DailyBar,
  DateRange,
  LimitUpLadder,
  LimitUpLadderCompareResultLike,
  LimitUpLadderManagerLike,
  LimitUpLadderResultLike,
  MarketDataAdapterLike,
  MarketSnapshot,
  MarketSnapshotItem,
  MarketSourceStatus,
  MinuteBar,
  Quote,
  SourceStatus,
  StockSearchCandidate,
  ToolContext,
} from '@luoome/core';
import { type MarketSnapshotCompleteness, MarketSnapshotSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { collectMarketSnapshotTool, getMarketSnapshotBatchTool } from './market-snapshot-batch.js';

const NOW = new Date('2026-09-28T10:16:02+08:00');

const item = (overrides: Partial<MarketSnapshotItem> = {}): MarketSnapshotItem => ({
  id: '600519.SH',
  code: '600519',
  exchange: 'SH',
  name: '贵州茅台',
  close: 1500,
  changePct: 1.2,
  amount: 3_000_000_000,
  ...overrides,
});

const completeness = (
  overrides: Partial<MarketSnapshotCompleteness> = {},
): MarketSnapshotCompleteness => ({
  expectedCount: 2,
  receivedCount: 2,
  missingCount: 0,
  duplicateCount: 0,
  complete: true,
  ...overrides,
});

const makeEnvelope = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  MarketSnapshotSchema.parse({
    coverage: 'CN_A_SHARES_SH_SZ',
    source: 'stub-market',
    fetchedAt: new Date('2026-09-28T10:16:02+08:00'),
    observedAt: new Date('2026-09-28T10:16:00+08:00'),
    dataAsOf: new Date('2026-09-28T10:16:00+08:00'),
    items: [
      item(),
      item({
        id: '000001.SZ',
        code: '000001',
        exchange: 'SZ',
        name: '平安银行',
        amount: 900_000_000,
      }),
    ],
    completeness: completeness(),
    ...overrides,
  });

class StubMarketAdapter implements MarketDataAdapterLike {
  readonly name = 'stub-market';
  envelopeCalls = 0;

  constructor(private readonly respond: () => Promise<MarketSnapshot>) {}

  fetchMarketSnapshotEnvelope(): Promise<MarketSnapshot> {
    this.envelopeCalls += 1;
    return this.respond();
  }

  fetchQuote(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: quote'));
  }

  batchQuote(): Promise<Map<string, Quote>> {
    return Promise.reject(new Error('unsupported_capability: batch-quote'));
  }

  fetchDailyBars(_stockId: string, _range: DateRange): Promise<DailyBar[]> {
    return Promise.reject(new Error('unsupported_capability: daily-bars'));
  }

  searchStocks(): Promise<StockSearchCandidate[]> {
    return Promise.reject(new Error('unsupported_capability: search'));
  }

  fetchIndexQuotes(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: realtime-index'));
  }

  fetchIntradayMinutes(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: intraday-minutes'));
  }

  fetchMinuteBars(): Promise<MinuteBar[]> {
    return Promise.reject(new Error('unsupported_capability: minute-bars'));
  }

  fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return Promise.reject(new Error('unsupported_capability: market-snapshot'));
  }

  marketSourceStatus(): readonly MarketSourceStatus[] {
    return [];
  }
}

const ladderFixture = (overrides: Partial<LimitUpLadder> = {}): LimitUpLadder => ({
  date: '2026-09-28',
  total: 1,
  maxLevel: 1,
  source: 'eastmoney',
  levels: [
    {
      level: 1,
      name: '首板',
      count: 1,
      stocks: [
        {
          code: '600519',
          name: '贵州茅台',
          industry: '白酒',
          ladderLevel: 1,
          uncategorized: false,
          firstTime: '10:00:00',
          finalTime: '10:00:00',
          reason: '测试事实',
          price: 1500,
          rawClose: 1500,
          corrected: false,
          changePct: 0.1,
          limitUpDate: '2026-09-28',
          board: 'main_board',
        },
      ],
    },
  ],
  warnings: [],
  asOf: new Date('2026-09-28T10:16:05+08:00'),
  ...overrides,
});

class StubLadderManager implements LimitUpLadderManagerLike {
  readonly name = 'limit-up-ladder';
  readonly sources = ['eastmoney'];
  calls = 0;
  result: LimitUpLadderResultLike;

  constructor(result: LimitUpLadderResultLike) {
    this.result = result;
  }

  fetchLadder(): Promise<LimitUpLadderResultLike> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }

  compareLadder(): Promise<LimitUpLadderCompareResultLike> {
    return Promise.reject(new Error('unsupported_capability: compare'));
  }

  status(): readonly SourceStatus[] {
    return [];
  }
}

const buildCtx = async (
  market: StubMarketAdapter,
  now: Date = NOW,
  limitUpLadder?: LimitUpLadderManagerLike,
): Promise<ToolContext> => {
  const base = await buildTestContext({
    clock: () => new Date(now.getTime()),
    ...(limitUpLadder === undefined ? {} : { limitUpLadder }),
  });
  return { ...base, adapters: { ...base.adapters, market } };
};

const savedLadder = (ctx: ToolContext): Promise<LimitUpLadder | null> =>
  ctx.repos.limitUpLadderSnapshot.findByDate({ date: '2026-09-28', source: 'eastmoney' });

const collect = (ctx: ToolContext) => collectMarketSnapshotTool.execute({}, ctx);
const readLatest = (ctx: ToolContext) => getMarketSnapshotBatchTool.execute({}, ctx);

describe('tool/collect_market_snapshot', () => {
  it('一次采集发布一个带来源、行情时间、抓取时间与计数的批次', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.batch).toMatchObject({
      id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:15:00.000Z',
      coverage: 'CN_A_SHARES_SH_SZ',
      tradingDate: '2026-09-28',
      sampledAt: new Date('2026-09-28T02:15:00.000Z'),
      source: 'stub-market',
      fetchedAt: new Date('2026-09-28T02:16:02.000Z'),
      observedAt: new Date('2026-09-28T02:16:00.000Z'),
      completeness: completeness(),
      gaps: [],
    });
    expect(result.data.batch.items.map((entry) => entry.amount)).toEqual([
      3_000_000_000, 900_000_000,
    ]);
    expect(market.envelopeCalls).toBe(1);
  });

  it('同一批次重试复用已发布内容，不重复采集或改写抓取时间', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ladder = new StubLadderManager({ ok: true, data: ladderFixture() });
    const ctx = await buildCtx(market, NOW, ladder);
    const first = await collect(ctx);
    const second = await collect(ctx);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.created).toBe(false);
    expect(second.data.batch).toEqual(first.data.batch);
    expect(market.envelopeCalls).toBe(1);
    // 天梯只在发布新批次时刷新，同批次重试不重复访问上游。
    expect(ladder.calls).toBe(1);
  });

  it('批次发布后同步保存当日连板天梯快照', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ladder = new StubLadderManager({ ok: true, data: ladderFixture() });
    const ctx = await buildCtx(market, NOW, ladder);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.warnings).toEqual([]);
    expect(ladder.calls).toBe(1);
    expect(await savedLadder(ctx)).toEqual(ladderFixture());
  });

  it('天梯刷新失败不阻塞批次发布，结果带 warning', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ladder = new StubLadderManager({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'limit-up-ladder',
        message: 'upstream down',
        recoverable: true,
      },
    });
    const ctx = await buildCtx(market, NOW, ladder);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0]).toContain('limit_up_ladder_refresh_failed');
    expect(result.data.warnings[0]).toContain('upstream down');
    const latest = await readLatest(ctx);
    expect(latest.ok && latest.data.batch?.id).toBe(result.data.batch.id);
    expect(await savedLadder(ctx)).toBeNull();
  });

  it('未配置天梯 manager 时批次照常发布并显式提示', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.warnings[0]).toContain('limit_up_ladder_unavailable');
  });

  it('同日重复采集把天梯快照覆盖为最新', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ladder = new StubLadderManager({ ok: true, data: ladderFixture() });
    const ctx = await buildCtx(market, NOW, ladder);
    await collect(ctx);
    const latestLadder = ladderFixture({
      total: 2,
      asOf: new Date('2026-09-28T10:21:05+08:00'),
    });
    ladder.result = { ok: true, data: latestLadder };
    const laterBase = await buildCtx(market, new Date('2026-09-28T10:21:00+08:00'), ladder);
    const later = { ...laterBase, repos: ctx.repos };
    const result = await collect(later);
    expect(result.ok).toBe(true);
    expect(ladder.calls).toBe(2);
    expect(await savedLadder(ctx)).toEqual(latestLadder);
  });

  it('非交易时段发布批次但不写天梯', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ladder = new StubLadderManager({ ok: true, data: ladderFixture() });
    const ctx = await buildCtx(market, new Date('2026-09-28T12:00:00+08:00'), ladder);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.warnings).toEqual([]);
    expect(ladder.calls).toBe(0);
    expect(await savedLadder(ctx)).toBeNull();
  });

  it('下一个采样时点是新批次，读取端返回最近的已发布批次', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ctx = await buildCtx(market);
    const first = await collect(ctx);
    const later = await buildCtx(market, new Date('2026-09-28T10:21:00+08:00'));
    // 复用同一仓储，确保“最近批次”跨请求可见。
    const laterCtx = { ...later, repos: ctx.repos };
    const second = await collect(laterCtx);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.created).toBe(true);
    expect(second.data.batch.sampledAt).toEqual(new Date('2026-09-28T02:20:00.000Z'));
    const latest = await readLatest(laterCtx);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.data.batch?.id).toBe(second.data.batch.id);
  });

  it('不完整信封照常发布并标注缺失缺口，完整标记沿用既有契约', async () => {
    const market = new StubMarketAdapter(async () =>
      makeEnvelope({
        items: [item()],
        completeness: completeness({
          expectedCount: 3,
          receivedCount: 1,
          missingCount: 2,
          complete: false,
        }),
      }),
    );
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.batch.completeness).toMatchObject({
      expectedCount: 3,
      receivedCount: 1,
      missingCount: 2,
      complete: false,
    });
    expect(result.data.batch.gaps).toEqual(['missing_items: 期望 3 只，实收 1 只，缺 2 只']);
  });

  it('缺成交额只记 unknown 并写入缺口说明，不写 0', async () => {
    const market = new StubMarketAdapter(async () =>
      makeEnvelope({
        items: [
          item(),
          item({
            id: '000001.SZ',
            code: '000001',
            exchange: 'SZ',
            name: '平安银行',
            amount: undefined,
          }),
        ],
      }),
    );
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.batch.items[1]?.amount).toBeUndefined();
    expect(result.data.batch.items[1]).not.toHaveProperty('amount', 0);
    expect(result.data.batch.gaps).toEqual(['missing_amount: 1 只缺少成交额']);
  });

  it('上游不提供行情时间时批次保持缺失', async () => {
    const withoutTimes = makeEnvelope();
    const { observedAt: _observedAt, dataAsOf: _dataAsOf, ...rest } = withoutTimes;
    void _observedAt;
    void _dataAsOf;
    const market = new StubMarketAdapter(async () => rest);
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.batch.observedAt).toBeUndefined();
    expect(result.data.batch.dataAsOf).toBeUndefined();
    expect(result.data.batch.fetchedAt).toBeInstanceOf(Date);
  });

  it('采集失败按 adapter_error 返回，不产生空批次', async () => {
    const market = new StubMarketAdapter(() => Promise.reject(new Error('upstream down')));
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
    const latest = await readLatest(ctx);
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(latest.data.batch).toBeNull();
  });

  it('上游覆盖范围不符时拒绝发布', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope({ coverage: 'CN_A_SHARES_BJ' }));
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'adapter_error' });
    if (result.error.kind !== 'adapter_error') return;
    expect(result.error.cause).toContain('coverage_mismatch');
  });

  it('空快照不发布批次', async () => {
    const empty: MarketSnapshot = {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'stub-market',
      fetchedAt: new Date('2026-09-28T10:16:02+08:00'),
      items: [],
      completeness: completeness({
        expectedCount: 0,
        receivedCount: 0,
        missingCount: 0,
        complete: false,
      }),
    };
    const market = new StubMarketAdapter(async () => empty);
    const ctx = await buildCtx(market);
    const result = await collect(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
    const latest = await readLatest(ctx);
    expect(latest.ok && latest.data.batch).toBeNull();
  });
});

describe('tool/get_market_snapshot_batch', () => {
  it('尚无已发布批次时返回 null，不触发采集', async () => {
    const market = new StubMarketAdapter(async () => makeEnvelope());
    const ctx = await buildCtx(market);
    const result = await readLatest(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.batch).toBeNull();
    expect(market.envelopeCalls).toBe(0);
  });
});
