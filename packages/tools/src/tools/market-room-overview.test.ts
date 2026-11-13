import {
  MARKET_DAY_POINTS,
  MarketDayFixtureAdapter,
  marketDaySnapshot,
} from '@luoome/adapters/testing';
import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  buildMarketSnapshotBatch,
  type IndexQuote,
  type MarketSnapshotItem,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getMarketRoomOverviewTool } from './market-room-overview.js';

const NOW = new Date('2026-09-28T10:16:00+08:00');
const TRADING_DATE = '2026-09-28';

const item = (
  code: string,
  fields: { readonly changePct?: number; readonly amount?: number },
): MarketSnapshotItem => ({
  id: `${code}.SH`,
  code,
  exchange: 'SH',
  name: `股票${code}`,
  ...(fields.changePct === undefined ? {} : { changePct: fields.changePct }),
  ...(fields.amount === undefined ? {} : { amount: fields.amount }),
});

const batchOf = (sampledAt: string, items: readonly MarketSnapshotItem[]) =>
  buildMarketSnapshotBatch({
    sampledAt: new Date(sampledAt),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'fixture-market',
      fetchedAt: new Date(sampledAt),
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

const sentimentSnapshot = (
  limitUp: Partial<{ status: 'complete' | 'partial'; sealedCount: number }> = {},
): AShareSentimentSnapshot => {
  const status = limitUp.status ?? 'complete';
  return {
    date: TRADING_DATE,
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: new Date('2026-09-28T02:15:00.000Z'),
    indexes: {
      status: 'unavailable',
      provenance: [
        {
          provider: 'luoome/market-index',
          observedAt: NOW,
          fetchedAt: NOW,
          freshness: 'unavailable',
          errorKind: 'not_requested',
        },
      ],
      warnings: ['composed by tool'],
    },
    breadth: {
      status: 'unavailable',
      provenance: [
        {
          provider: 'luoome/market-snapshot',
          observedAt: NOW,
          fetchedAt: NOW,
          freshness: 'unavailable',
          errorKind: 'not_requested',
        },
      ],
      warnings: ['not requested'],
    },
    limitUp: {
      status,
      provenance: [
        {
          provider: 'eastmoney/limit-up',
          observedAt: new Date('2026-09-28T02:15:00.000Z'),
          fetchedAt: NOW,
          freshness: 'fresh',
        },
      ],
      warnings: status === 'complete' ? [] : ['sealed pool unavailable'],
      ...(status === 'complete'
        ? {
            value: {
              sealedCount: limitUp.sealedCount ?? 18,
              brokenCount: 4,
              brokenRate: 4 / 22,
              maxLadderLevel: 5,
              totalSealAmount: 1_200_000_000,
              boardDistribution: { '5': 1, '1': 17 },
              leaders: [],
            },
          }
        : {}),
    },
    themes: {
      status: 'unavailable',
      provenance: [
        {
          provider: 'eastmoney/limit-up',
          observedAt: NOW,
          fetchedAt: NOW,
          freshness: 'unavailable',
          errorKind: 'not_requested',
        },
      ],
      warnings: ['not requested'],
    },
  };
};

const sentimentManager = (snapshot = sentimentSnapshot()): AShareSentimentManagerLike => ({
  status: () => [],
  fetch: async (input) => ({ ok: true, data: { ...snapshot, date: input.date } }),
});

class NoIndexMarketAdapter extends MarketDayFixtureAdapter {
  override fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    return Promise.reject(new Error('unsupported_capability: realtime-index'));
  }
}

const contextAt = async (clock: () => Date, sentiment?: AShareSentimentManagerLike) => {
  const ctx = await buildTestContext({
    clock,
    ...(sentiment === undefined ? {} : { ashareSentiment: sentiment }),
  });
  const adapter = new MarketDayFixtureAdapter({ clock });
  return { ctx, adapter };
};

describe('get_market_room_overview', () => {
  it('没有已发布批次时返回 no_batch 空态，不采集、不拉外部情绪', async () => {
    let sentimentCalls = 0;
    const base = sentimentManager();
    const manager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async (input) => {
        sentimentCalls += 1;
        return base.fetch(input);
      },
    };
    const { ctx, adapter } = await contextAt(() => new Date(NOW.getTime()), manager);
    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      tradingDate: TRADING_DATE,
      latestBatch: null,
    });
    for (const dimension of [
      result.data.overview.coverage,
      result.data.overview.breadth,
      result.data.overview.amount,
      result.data.overview.limitUp,
      result.data.overview.indexes,
    ]) {
      expect(dimension.status).toBe('unavailable');
    }
    expect(adapter.envelopeCalls).toBe(0);
    expect(sentimentCalls).toBe(0);
  });

  it('读取最近已发布批次组合总览，昨日同时点对比与情绪维度直接复用', async () => {
    const { ctx, adapter } = await contextAt(() => new Date(NOW.getTime()), sentimentManager());
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-24T10:15:00+08:00', [
        item('600000', { changePct: 0.5, amount: 50 }),
        item('600001', { changePct: -0.5, amount: 30 }),
      ]),
    );
    const published = await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-28T10:15:00+08:00', [
        item('600000', { changePct: 2, amount: 60 }),
        item('600001', { changePct: -1, amount: 40 }),
      ]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const overview = result.data.overview;
    expect(overview.state).toBe('ready');
    expect(overview.latestBatch?.sampledAt.getTime()).toBe(published.batch.sampledAt.getTime());
    expect(overview.coverage).toMatchObject({
      status: 'complete',
      value: {
        tradingDate: TRADING_DATE,
        sampledAt: published.batch.sampledAt,
        source: 'fixture-market',
        receivedCount: 2,
        expectedCount: 2,
        complete: true,
      },
    });
    expect(overview.breadth.value).toMatchObject({
      advancing: 1,
      declining: 1,
      unchanged: 0,
      classifiedCount: 2,
      missingChangePctCount: 0,
      medianChangePct: 0.5,
    });
    expect(overview.amount.value).toMatchObject({
      currentAmount: 100,
      currentSampleCount: 2,
      comparison: {
        previousTradingDate: '2026-09-24',
        previousAmount: 80,
        deltaPct: 25,
        verdict: 'expanded',
      },
    });
    expect(overview.limitUp.value).toMatchObject({
      sealedCount: 18,
      brokenCount: 4,
      maxLadderLevel: 5,
    });
    expect(overview.indexes.status).toBe('complete');
    expect(overview.indexes.value?.values.length).toBeGreaterThan(0);
    // 页面读取只消费已发布批次：不触发新的采集。
    expect(adapter.envelopeCalls).toBe(0);
  });

  it('盘前即使有上一交易日批次也返回空态，不把旧数据当当日盘面', async () => {
    const { ctx, adapter } = await contextAt(
      () => new Date('2026-09-28T09:10:00+08:00'),
      sentimentManager(),
    );
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-24T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview).toMatchObject({
      state: 'empty',
      emptyReason: 'pre_open',
      latestBatch: { tradingDate: '2026-09-24' },
    });
    expect(result.data.overview.breadth.status).toBe('unavailable');
  });

  it('非交易日返回 non_trading_day 空态', async () => {
    const { ctx, adapter } = await contextAt(
      () => new Date('2026-09-26T10:00:00+08:00'),
      sentimentManager(),
    );
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-24T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview.emptyReason).toBe('non_trading_day');
  });

  it('情绪取数失败只降级该维度，其余维度照常给出', async () => {
    const failing: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async () => ({
        ok: false,
        error: { kind: 'adapter_error', message: 'upstream down', recoverable: true },
      }),
    };
    const { ctx, adapter } = await contextAt(() => new Date(NOW.getTime()), failing);
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-28T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview.limitUp.status).toBe('unavailable');
    expect(result.data.overview.limitUp.warnings[0]).toContain('limit_up_failed');
    expect(result.data.overview.breadth.status).toBe('complete');
    expect(result.data.overview.indexes.status).toBe('complete');
  });

  it('未注入情绪 manager 时该维度 unavailable，不编造封板家数', async () => {
    const { ctx, adapter } = await contextAt(() => new Date(NOW.getTime()));
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-28T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview.limitUp).toMatchObject({ status: 'unavailable' });
    expect(result.data.overview.limitUp.value).toBeUndefined();
  });

  it('指数取数失败只降级指数维度，不伪造指数对照', async () => {
    const { ctx } = await contextAt(() => new Date(NOW.getTime()), sentimentManager());
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-28T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );
    const market = new NoIndexMarketAdapter({ clock: () => new Date(NOW.getTime()) });

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.overview.indexes.status).toBe('unavailable');
    expect(result.data.overview.indexes.warnings[0]).toContain('index_quotes_failed');
    expect(result.data.overview.breadth.value?.divergence).toBeUndefined();
  });

  it('缺少昨日同时点批次时只给当日累计，不写 0 也不下缩量结论', async () => {
    const { ctx, adapter } = await contextAt(() => new Date(NOW.getTime()), sentimentManager());
    await ctx.repos.marketSnapshotBatch.publish(
      batchOf('2026-09-28T10:15:00+08:00', [item('600000', { changePct: 1, amount: 10 })]),
    );

    const result = await getMarketRoomOverviewTool.execute(
      {},
      { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const amount = result.data.overview.amount;
    expect(amount.status).toBe('partial');
    expect(amount.value?.currentAmount).toBe(10);
    expect(amount.value?.comparison).toBeUndefined();
    expect(amount.warnings[0]).toContain('missing_previous_batch');
  });

  it('全市场批次夹具可作为总览的演示输入（六时点任一时点都能读出）', async () => {
    for (const [index, point] of MARKET_DAY_POINTS.entries()) {
      const { ctx, adapter } = await contextAt(
        () => new Date(point.at.getTime() + 60_000),
        sentimentManager(),
      );
      const snapshot = marketDaySnapshot(index);
      await ctx.repos.marketSnapshotBatch.publish(
        buildMarketSnapshotBatch({ snapshot, sampledAt: point.at }),
      );

      const result = await getMarketRoomOverviewTool.execute(
        {},
        { ...ctx, adapters: { ...ctx.adapters, market: adapter } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const overview = result.data.overview;
      expect(overview.state).toBe('ready');
      expect(overview.coverage.value?.sampledAt.getTime()).toBe(point.at.getTime());
      expect(overview.breadth.value?.sampleCount).toBe(snapshot.items.length);
      expect(overview.breadth.value?.classifiedCount).toBe(snapshot.items.length);
      expect(overview.amount.value?.currentSampleCount).toBe(snapshot.items.length);
    }
  });
});
