import { describe, expect, it } from 'vitest';
import type { MarketSnapshot, MarketSnapshotItem } from './market-snapshot.js';
import {
  assertMarketSnapshotBatchInvariants,
  buildMarketSnapshotBatch,
  MARKET_SNAPSHOT_BATCH_INTERVAL_MS,
  marketSnapshotBatchId,
  marketSnapshotBatchSampledAt,
} from './market-snapshot-batch.js';

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

const snapshot = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  coverage: 'CN_A_SHARES_SH_SZ',
  source: 'eastmoney',
  fetchedAt: new Date('2026-09-28T02:16:02.000Z'),
  observedAt: new Date('2026-09-28T02:16:00.000Z'),
  dataAsOf: new Date('2026-09-28T02:16:00.000Z'),
  items: [
    item(),
    item({
      id: '000001.SZ',
      code: '000001',
      exchange: 'SZ',
      name: '平安银行',
      amount: 1_200_000_000,
    }),
  ],
  completeness: {
    expectedCount: 2,
    receivedCount: 2,
    missingCount: 0,
    duplicateCount: 0,
    complete: true,
  },
  ...overrides,
});

describe('MarketSnapshotBatch', () => {
  it('采样时点对齐到批次间隔，批次身份由覆盖范围与采样时点稳定派生', () => {
    expect(MARKET_SNAPSHOT_BATCH_INTERVAL_MS).toBe(5 * 60_000);
    const sampledAt = marketSnapshotBatchSampledAt(new Date('2026-09-28T02:17:31.123Z'));
    expect(sampledAt).toEqual(new Date('2026-09-28T02:15:00.000Z'));
    expect(marketSnapshotBatchId({ coverage: 'CN_A_SHARES_SH_SZ', sampledAt })).toBe(
      'CN_A_SHARES_SH_SZ|2026-09-28T02:15:00.000Z',
    );
  });

  it('一次采集构造带来源、行情时间、抓取时间与覆盖计数的批次', () => {
    const batch = buildMarketSnapshotBatch({
      snapshot: snapshot(),
      sampledAt: new Date('2026-09-28T02:16:02.000Z'),
    });
    expect(batch).toMatchObject({
      coverage: 'CN_A_SHARES_SH_SZ',
      tradingDate: '2026-09-28',
      source: 'eastmoney',
      fetchedAt: new Date('2026-09-28T02:16:02.000Z'),
      observedAt: new Date('2026-09-28T02:16:00.000Z'),
      dataAsOf: new Date('2026-09-28T02:16:00.000Z'),
      completeness: snapshot().completeness,
      gaps: [],
    });
    expect(batch.sampledAt).toEqual(new Date('2026-09-28T02:15:00.000Z'));
    expect(batch.items.map((entry) => entry.amount)).toEqual([3_000_000_000, 1_200_000_000]);
    expect(() => assertMarketSnapshotBatchInvariants(batch)).not.toThrow();
  });

  it('上游缺行情时间时批次不填时间，成交额缺失记 unknown 而不是 0', () => {
    const withoutAmount = item({ amount: undefined });
    const {
      observedAt: _observedAt,
      dataAsOf: _dataAsOf,
      ...withoutTimes
    } = snapshot({
      items: [withoutAmount],
      completeness: {
        expectedCount: 1,
        receivedCount: 1,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      },
    });
    void _observedAt;
    void _dataAsOf;
    const batch = buildMarketSnapshotBatch({
      snapshot: withoutTimes as MarketSnapshot,
      sampledAt: new Date('2026-09-28T02:15:00.000Z'),
    });
    expect(batch.observedAt).toBeUndefined();
    expect(batch.dataAsOf).toBeUndefined();
    expect(batch.items[0]?.amount).toBeUndefined();
    expect(batch.items[0]).not.toHaveProperty('amount', 0);
    expect(batch.gaps).toEqual(['missing_amount: 1 只缺少成交额']);
  });

  it('不完整批次照常发布并标注缺失与重复缺口', () => {
    const batch = buildMarketSnapshotBatch({
      snapshot: snapshot({
        items: [item()],
        completeness: {
          expectedCount: 3,
          receivedCount: 1,
          missingCount: 2,
          duplicateCount: 1,
          complete: false,
        },
      }),
      sampledAt: new Date('2026-09-28T02:15:00.000Z'),
    });
    expect(batch.completeness.complete).toBe(false);
    expect(batch.gaps).toEqual([
      'missing_items: 期望 3 只，实收 1 只，缺 2 只',
      'duplicate_items: 丢弃重复 1 条',
    ]);
  });

  it('不变量拒绝与采样时点不一致的批次身份和伪造的完整标记', () => {
    const batch = buildMarketSnapshotBatch({
      snapshot: snapshot(),
      sampledAt: new Date('2026-09-28T02:15:00.000Z'),
    });
    expect(() =>
      assertMarketSnapshotBatchInvariants({
        ...batch,
        id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:10:00.000Z',
      }),
    ).toThrow(/批次 id/);
    expect(() =>
      assertMarketSnapshotBatchInvariants({
        ...batch,
        completeness: { ...batch.completeness, complete: false },
      }),
    ).toThrow(/complete/);
    expect(() =>
      assertMarketSnapshotBatchInvariants({
        ...batch,
        completeness: {
          ...batch.completeness,
          expectedCount: 3,
          missingCount: 1,
          complete: false,
        },
      }),
    ).toThrow(/missing_items/);
  });
});
