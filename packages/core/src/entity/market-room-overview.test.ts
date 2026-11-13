import { describe, expect, it } from 'vitest';
import { money } from '../types/branded.js';
import { buildLimitUpLadderSample } from './limit-up-ladder-sample.js';
import {
  buildMarketRoomAmount,
  buildMarketRoomBreadth,
  buildMarketRoomEmptyOverview,
  buildMarketRoomIndexes,
  buildMarketRoomLimitUp,
  buildMarketRoomOverview,
  buildMarketRoomReplayLimitUp,
  buildMarketRoomReplayOverview,
  MARKET_ROOM_COMPARE_TOLERANCE_MS,
  marketRoomCompareTarget,
  marketRoomEmptyReason,
  sameTimeOfDayOn,
} from './market-room-overview.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import { buildMarketSnapshotBatch } from './market-snapshot-batch.js';

const TRADING_DATE = '2026-09-28';

const item = (
  code: string,
  fields: { readonly changePct?: number; readonly amount?: number } = {},
): MarketSnapshotItem => ({
  id: `${code}.SH`,
  code,
  exchange: 'SH',
  name: `股票${code}`,
  ...(fields.changePct === undefined ? {} : { changePct: fields.changePct }),
  ...(fields.amount === undefined ? {} : { amount: fields.amount }),
});

const batchFor = (
  items: readonly MarketSnapshotItem[],
  options: { readonly sampledAt: string; readonly expectedCount?: number },
) => {
  const expectedCount = options.expectedCount ?? items.length;
  return buildMarketSnapshotBatch({
    sampledAt: new Date(options.sampledAt),
    snapshot: {
      coverage: 'CN_A_SHARES_SH_SZ',
      source: 'fixture-market',
      fetchedAt: new Date(options.sampledAt),
      items: [...items],
      completeness: {
        expectedCount,
        receivedCount: items.length,
        missingCount: expectedCount - items.length,
        duplicateCount: 0,
        complete: expectedCount === items.length,
      },
    },
  });
};

const quote = (
  code: string,
  name: string,
  changePct: number,
  ts = '2026-09-28T10:15:00+08:00',
) => ({
  code,
  name,
  close: money(3600),
  change: 12,
  changePct,
  ts: new Date(ts),
  source: 'fixture',
});

const limitUpDimension = (
  overrides: Partial<{
    status: 'complete' | 'partial' | 'unavailable';
    sealedCount: number;
    brokenCount: number;
    maxLadderLevel: number;
  }> = {},
) => {
  const status = overrides.status ?? 'complete';
  const warnings = status === 'complete' ? [] : ['sealed pool unavailable'];
  return {
    status,
    warnings,
    provenance: [
      {
        provider: 'fixture/limit-up',
        observedAt: new Date('2026-09-28T02:15:00.000Z'),
        fetchedAt: new Date('2026-09-28T02:15:00.000Z'),
        freshness: 'fresh' as const,
      },
    ],
    ...(status === 'complete'
      ? {
          value: {
            sealedCount: overrides.sealedCount ?? 12,
            brokenCount: overrides.brokenCount ?? 3,
            brokenRate: 0.2,
            maxLadderLevel: overrides.maxLadderLevel ?? 4,
            totalSealAmount: 1_000_000,
            boardDistribution: { '4': 1, '1': 11 },
            leaders: [],
          },
        }
      : {}),
  };
};

describe('sameTimeOfDayOn / marketRoomCompareTarget', () => {
  it('把采样时刻搬到目标交易日的同一上海时刻', () => {
    const sampledAt = new Date('2026-09-28T10:15:00+08:00');
    expect(sameTimeOfDayOn('2026-09-24', sampledAt).toISOString()).toBe('2026-09-24T02:15:00.000Z');
  });

  it('上一交易日跳过周末与节假日（09-25 中秋休市 → 09-24）', () => {
    const target = marketRoomCompareTarget(new Date('2026-09-28T10:15:00+08:00'));
    expect(target.tradingDate).toBe('2026-09-24');
    expect(target.sampledAt.toISOString()).toBe('2026-09-24T02:15:00.000Z');
  });

  it('容差小于一个批次间隔，避免拿相邻时点冒充同时点', () => {
    expect(MARKET_ROOM_COMPARE_TOLERANCE_MS).toBeLessThan(5 * 60_000);
    expect(MARKET_ROOM_COMPARE_TOLERANCE_MS).toBeGreaterThan(0);
  });
});

describe('buildMarketRoomBreadth', () => {
  it('涨跌平与中位数从批次 items 派生，缺涨幅样本排除并计入缺失说明', () => {
    const batch = batchFor(
      [
        item('600000', { changePct: 1 }),
        item('600001', { changePct: -2 }),
        item('600002', { changePct: 0 }),
        item('600003', { changePct: 3 }),
        item('600004'),
      ],
      { sampledAt: '2026-09-28T10:15:00+08:00' },
    );
    const breadth = buildMarketRoomBreadth({ batch });

    expect(breadth.status).toBe('partial');
    expect(breadth.warnings[0]).toContain('missing_change_pct');
    expect(breadth.value).toMatchObject({
      advancing: 2,
      declining: 1,
      unchanged: 1,
      classifiedCount: 4,
      missingChangePctCount: 1,
      sampleCount: 5,
      expectedCount: 5,
      medianChangePct: 0.5,
    });
  });

  it('批次不完整时降级 partial，样本数与期望数分别保留', () => {
    const batch = batchFor([item('600000', { changePct: 1 })], {
      sampledAt: '2026-09-28T10:15:00+08:00',
      expectedCount: 3,
    });
    const breadth = buildMarketRoomBreadth({ batch });

    expect(breadth.status).toBe('partial');
    expect(breadth.warnings.join('|')).toContain('incomplete_batch');
    expect(breadth.value).toMatchObject({ sampleCount: 1, expectedCount: 3, classifiedCount: 1 });
  });

  it('全部缺涨幅时不给数字，标注 unavailable', () => {
    const batch = batchFor([item('600000'), item('600001')], {
      sampledAt: '2026-09-28T10:15:00+08:00',
    });
    const breadth = buildMarketRoomBreadth({ batch });

    expect(breadth.status).toBe('unavailable');
    expect(breadth.value).toBeUndefined();
    expect(breadth.warnings[0]).toContain('missing_change_pct');
  });

  it('完整样本判为 complete，中位数为奇数样本正中值', () => {
    const batch = batchFor(
      [
        item('600000', { changePct: 1 }),
        item('600001', { changePct: -2 }),
        item('600002', { changePct: 3 }),
      ],
      { sampledAt: '2026-09-28T10:15:00+08:00' },
    );
    const breadth = buildMarketRoomBreadth({ batch });

    expect(breadth).toMatchObject({ status: 'complete', warnings: [] });
    expect(breadth.value?.medianChangePct).toBe(1);
  });

  it('给定基准指数时标注指数与多数个股是否背离', () => {
    const batch = batchFor(
      [
        item('600000', { changePct: -1 }),
        item('600001', { changePct: -2 }),
        item('600002', { changePct: -3 }),
      ],
      { sampledAt: '2026-09-28T10:15:00+08:00' },
    );
    const divergent = buildMarketRoomBreadth({
      batch,
      benchmark: { code: '000001', name: '上证指数', changePct: 0.42 },
    });
    expect(divergent.value?.divergence).toEqual({
      indexCode: '000001',
      indexName: '上证指数',
      indexChangePct: 0.42,
      medianChangePct: -2,
      divergent: true,
    });

    const aligned = buildMarketRoomBreadth({
      batch,
      benchmark: { code: '000001', name: '上证指数', changePct: -0.42 },
    });
    expect(aligned.value?.divergence?.divergent).toBe(false);
  });

  it('没有基准指数时不编造背离结论', () => {
    const batch = batchFor([item('600000', { changePct: 1 })], {
      sampledAt: '2026-09-28T10:15:00+08:00',
    });
    expect(buildMarketRoomBreadth({ batch }).value?.divergence).toBeUndefined();
  });
});

describe('buildMarketRoomAmount', () => {
  const current = batchFor([item('600000', { amount: 60 }), item('600001', { amount: 40 })], {
    sampledAt: '2026-09-28T10:15:00+08:00',
  });

  it('与上一交易日同一时点对比给出放量结论与基准', () => {
    const previous = batchFor([item('600000', { amount: 50 }), item('600001', { amount: 30 })], {
      sampledAt: '2026-09-24T10:15:00+08:00',
    });
    const amount = buildMarketRoomAmount({ current, previous });

    expect(amount).toMatchObject({ status: 'complete', warnings: [] });
    expect(amount.value).toMatchObject({
      currentAmount: 100,
      currentSampleCount: 2,
      currentMissingAmountCount: 0,
      currentTotalCount: 2,
      comparison: {
        previousTradingDate: '2026-09-24',
        previousAmount: 80,
        previousSampleCount: 2,
        deltaAmount: 20,
        deltaPct: 25,
        verdict: 'expanded',
      },
    });
  });

  it('缩量按负号判定，持平时不称缩量', () => {
    const contracted = buildMarketRoomAmount({
      current,
      previous: batchFor([item('600000', { amount: 120 })], {
        sampledAt: '2026-09-24T10:15:00+08:00',
      }),
    });
    expect(contracted.value?.comparison).toMatchObject({ deltaAmount: -20, verdict: 'contracted' });

    const flat = buildMarketRoomAmount({
      current,
      previous: batchFor([item('600000', { amount: 100 })], {
        sampledAt: '2026-09-24T10:15:00+08:00',
      }),
    });
    expect(flat.value?.comparison).toMatchObject({ deltaAmount: 0, deltaPct: 0, verdict: 'flat' });
  });

  it('缺少上一交易日同时点批次时只给当日累计，不显示 0 或缩量', () => {
    const amount = buildMarketRoomAmount({ current, previous: null });

    expect(amount.status).toBe('partial');
    expect(amount.warnings[0]).toContain('missing_previous_batch');
    expect(amount.value?.currentAmount).toBe(100);
    expect(amount.value?.comparison).toBeUndefined();
  });

  it('上一批次不完整或口径不一致时不做对比', () => {
    const previous = batchFor([item('600000', { amount: 50 })], {
      sampledAt: '2026-09-24T10:15:00+08:00',
      expectedCount: 2,
    });
    const amount = buildMarketRoomAmount({ current, previous });

    expect(amount.status).toBe('partial');
    expect(amount.warnings.join('|')).toContain('previous_incomplete');
    expect(amount.value?.comparison).toBeUndefined();
  });

  it('当日有样本缺成交额时保留累计但标注口径', () => {
    const withMissing = batchFor([item('600000', { amount: 60 }), item('600001')], {
      sampledAt: '2026-09-28T10:15:00+08:00',
    });
    const amount = buildMarketRoomAmount({ current: withMissing, previous: null });

    expect(amount.value).toMatchObject({
      currentAmount: 60,
      currentSampleCount: 1,
      currentMissingAmountCount: 1,
      currentTotalCount: 2,
    });
  });

  it('当日全部缺成交额时判 unavailable，不给 0', () => {
    const amount = buildMarketRoomAmount({
      current: batchFor([item('600000')], { sampledAt: '2026-09-28T10:15:00+08:00' }),
      previous: null,
    });

    expect(amount.status).toBe('unavailable');
    expect(amount.value).toBeUndefined();
    expect(amount.warnings[0]).toContain('missing_amount');
  });
});

describe('buildMarketRoomIndexes / buildMarketRoomLimitUp', () => {
  it('指数只保留当日行情，跨日样本计入排除数并降级 partial', () => {
    const indexes = buildMarketRoomIndexes({
      tradingDate: TRADING_DATE,
      quotes: [
        quote('000001', '上证指数', 0.4),
        quote('HSI', '恒生指数', 1.1, '2026-09-27T16:00:00+08:00'),
      ],
      error: null,
    });

    expect(indexes.status).toBe('partial');
    expect(indexes.warnings[0]).toContain('index_quotes_filtered');
    expect(indexes.value?.values.map((entry) => entry.code)).toEqual(['000001']);
    expect(indexes.value?.excludedCount).toBe(1);
  });

  it('指数取数失败 / 空结果都给 unavailable 与原因', () => {
    const failed = buildMarketRoomIndexes({
      tradingDate: TRADING_DATE,
      quotes: null,
      error: 'unsupported_capability: realtime-index',
    });
    expect(failed).toMatchObject({ status: 'unavailable' });
    expect(failed.warnings[0]).toContain('index_quotes_failed');

    const empty = buildMarketRoomIndexes({ tradingDate: TRADING_DATE, quotes: [], error: null });
    expect(empty.status).toBe('unavailable');
    expect(empty.warnings[0]).toContain('index_quotes_empty');
  });

  it('情绪维度原样透传封板 / 炸板 / 最高连板，不重算', () => {
    const limitUp = buildMarketRoomLimitUp({
      dimension: limitUpDimension({ sealedCount: 21, brokenCount: 5, maxLadderLevel: 6 }),
      error: null,
    });
    expect(limitUp).toMatchObject({
      status: 'complete',
      warnings: [],
      value: { sealedCount: 21, brokenCount: 5, maxLadderLevel: 6 },
    });
  });

  it('情绪取数失败或维度不完整时不写 0', () => {
    const failed = buildMarketRoomLimitUp({ dimension: null, error: 'upstream down' });
    expect(failed.status).toBe('unavailable');
    expect(failed.warnings[0]).toContain('limit_up_failed');

    const partial = buildMarketRoomLimitUp({
      dimension: limitUpDimension({ status: 'partial' }),
      error: null,
    });
    expect(partial.status).toBe('partial');
    expect(partial.value).toBeUndefined();
    expect(partial.warnings.length).toBeGreaterThan(0);
  });
});

describe('marketRoomEmptyReason / buildMarketRoomOverview', () => {
  const latest = batchFor([item('600000', { changePct: 1, amount: 10 })], {
    sampledAt: '2026-09-24T14:50:00+08:00',
  });

  it('没有任何已发布批次 → no_batch', () => {
    expect(marketRoomEmptyReason(new Date('2026-09-28T10:15:00+08:00'), null)).toBe('no_batch');
  });

  it('当日已有批次 → 无需空态', () => {
    const today = batchFor([item('600000', { changePct: 1, amount: 10 })], {
      sampledAt: '2026-09-28T10:15:00+08:00',
    });
    expect(marketRoomEmptyReason(new Date('2026-09-28T10:16:00+08:00'), today)).toBeNull();
  });

  it('交易日盘前 / 盘中缺当日批次 / 非交易日分别给出不同空态原因', () => {
    expect(marketRoomEmptyReason(new Date('2026-09-28T09:10:00+08:00'), latest)).toBe('pre_open');
    expect(marketRoomEmptyReason(new Date('2026-09-28T10:30:00+08:00'), latest)).toBe(
      'no_today_batch',
    );
    expect(marketRoomEmptyReason(new Date('2026-09-26T10:30:00+08:00'), latest)).toBe(
      'non_trading_day',
    );
  });

  it('空态不伪造当日数据：各维度 unavailable 且带原因，只保留最近批次时间', () => {
    const overview = buildMarketRoomEmptyOverview({
      now: new Date('2026-09-28T09:10:00+08:00'),
      latest,
      reason: 'pre_open',
    });

    expect(overview).toMatchObject({
      state: 'empty',
      emptyReason: 'pre_open',
      tradingDate: TRADING_DATE,
      latestBatch: { tradingDate: '2026-09-24' },
    });
    for (const dimension of [
      overview.coverage,
      overview.breadth,
      overview.amount,
      overview.limitUp,
      overview.indexes,
    ]) {
      expect(dimension.status).toBe('unavailable');
      expect(dimension.value).toBeUndefined();
      expect(dimension.warnings[0]).toContain('pre_open');
    }
  });

  it('ready 状态组合四个维度并标注覆盖与数据更新时间', () => {
    const today = batchFor(
      [item('600000', { changePct: 2, amount: 60 }), item('600001', { changePct: -1, amount: 40 })],
      { sampledAt: '2026-09-28T10:15:00+08:00' },
    );
    const previous = batchFor([item('600000', { amount: 50 }), item('600001', { amount: 30 })], {
      sampledAt: '2026-09-24T10:15:00+08:00',
    });
    const overview = buildMarketRoomOverview({
      now: new Date('2026-09-28T10:16:00+08:00'),
      latest: today,
      previous,
      indexQuotes: [quote('000001', '上证指数', 0.4)],
      indexError: null,
      limitUp: limitUpDimension(),
      limitUpError: null,
    });

    expect(overview.state).toBe('ready');
    expect(overview.emptyReason).toBeUndefined();
    expect(overview.coverage).toMatchObject({
      status: 'complete',
      value: {
        source: 'fixture-market',
        tradingDate: TRADING_DATE,
        sampledAt: today.sampledAt,
        receivedCount: 2,
        expectedCount: 2,
      },
    });
    expect(overview.breadth.value).toMatchObject({ medianChangePct: 0.5, classifiedCount: 2 });
    expect(overview.amount.value?.comparison).toMatchObject({
      deltaAmount: 20,
      verdict: 'expanded',
    });
    expect(overview.limitUp.value).toMatchObject({ sealedCount: 12, brokenCount: 3 });
    expect(overview.indexes.value?.values).toHaveLength(1);
  });

  it('单个维度失败不拖垮其它维度', () => {
    const today = batchFor([item('600000', { changePct: 2, amount: 60 })], {
      sampledAt: '2026-09-28T10:15:00+08:00',
    });
    const overview = buildMarketRoomOverview({
      now: new Date('2026-09-28T10:16:00+08:00'),
      latest: today,
      previous: null,
      indexQuotes: null,
      indexError: 'upstream down',
      limitUp: null,
      limitUpError: 'upstream down',
    });

    expect(overview.state).toBe('ready');
    expect(overview.breadth.status).toBe('complete');
    expect(overview.amount.status).toBe('partial');
    expect(overview.indexes.status).toBe('unavailable');
    expect(overview.limitUp.status).toBe('unavailable');
  });
});

describe('回放（asOf）', () => {
  const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
  const anchor = batchFor(
    [item('600000', { changePct: 2, amount: 60 }), item('600001', { changePct: -1, amount: 40 })],
    { sampledAt: '2026-09-28T10:15:00+08:00' },
  );
  const previous = batchFor(
    [item('600000', { changePct: 1, amount: 50 }), item('600001', { changePct: -0.5, amount: 30 })],
    { sampledAt: '2026-09-24T10:15:00+08:00' },
  );
  const sample = buildLimitUpLadderSample({
    sampledAt: at('10:15'),
    ladder: {
      date: TRADING_DATE,
      total: 18,
      maxLevel: 5,
      source: 'eastmoney',
      levels: [],
      warnings: [],
      asOf: at('10:15'),
    },
  });

  it('按锚点批次取宽度与量能，指数与炸板数没有历史快照时缺失且不写 0', () => {
    const overview = buildMarketRoomReplayOverview({
      asOf: at('10:17'),
      anchor,
      previous,
      limitUpSample: sample,
    });

    expect(overview).toMatchObject({
      state: 'ready',
      asOf: at('10:17'),
      tradingDate: TRADING_DATE,
      latestBatch: { tradingDate: TRADING_DATE, sampledAt: anchor.sampledAt },
    });
    expect(overview.breadth.value?.medianChangePct).toBe(0.5);
    expect(overview.amount.value?.comparison?.previousTradingDate).toBe('2026-09-24');
    expect(overview.limitUp).toMatchObject({
      status: 'partial',
      value: { sealedCount: 18, brokenCount: null, maxLadderLevel: 5 },
    });
    expect(overview.limitUp.warnings.join(' ')).toContain('broken_count_unavailable');
    expect(overview.indexes.status).toBe('unavailable');
    expect(overview.indexes.value).toBeUndefined();
    expect(overview.indexes.warnings.join(' ')).toContain('index_quotes_replay_unavailable');
  });

  it('没有天梯样本与昨日批次时按缺失返回，并给出原因', () => {
    const overview = buildMarketRoomReplayOverview({
      asOf: at('10:17'),
      anchor,
      previous: null,
      limitUpSample: null,
    });

    expect(overview.limitUp.status).toBe('unavailable');
    expect(overview.limitUp.value).toBeUndefined();
    expect(overview.limitUp.warnings.join(' ')).toContain('limit_up_sample_missing');
    expect(overview.amount.status).toBe('partial');
    expect(overview.amount.warnings.join(' ')).toContain('missing_previous_batch');
    expect(buildMarketRoomReplayLimitUp({ sample })).toMatchObject({
      status: 'partial',
      value: { sealedCount: 18, brokenCount: null, maxLadderLevel: 5 },
    });
    expect(buildMarketRoomReplayLimitUp({ sample: null })).toEqual(overview.limitUp);
  });

  it('早于最早可信样本的空态带 asOf，交易日跟随回放时点', () => {
    const empty = buildMarketRoomEmptyOverview({
      now: at('11:00'),
      latest: null,
      reason: 'no_batch',
      asOf: at('09:00'),
    });

    expect(empty).toMatchObject({
      state: 'empty',
      emptyReason: 'no_batch',
      asOf: at('09:00'),
      tradingDate: TRADING_DATE,
      latestBatch: null,
    });
    expect(empty.breadth.value).toBeUndefined();
    expect(() =>
      buildMarketRoomEmptyOverview({ now: at('09:00'), latest: anchor, reason: 'pre_open' }),
    ).toThrow();
  });
});
