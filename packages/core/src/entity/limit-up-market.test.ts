import { describe, expect, it } from 'vitest';

import {
  assertLimitUpMarketInvariants,
  buildLimitUpMarketView,
  deriveLimitUpMarketMetrics,
  deriveReasonDistribution,
  LIMIT_UP_REASON_OTHER,
  type LimitUpMarketSnapshot,
  LimitUpMarketSnapshotSchema,
  type LimitUpPoolEntry,
  limitUpLadderBandLabel,
} from './limit-up-market.js';

const makeEntry = (overrides: Partial<LimitUpPoolEntry> = {}): LimitUpPoolEntry => ({
  stockId: '600327.SH',
  code: '600327',
  name: '大东方',
  isSt: false,
  isNew: false,
  price: 7.18,
  changePct: 0.099541,
  limitUpTime: '14:56',
  openTimes: null,
  reason: '百货零售',
  continueDayText: '5连板',
  continueDayCnt: 5,
  sealMoney: 27_188_276,
  maxSealMoney: 27_188_276.24,
  ...overrides,
});

const makeSnapshot = (overrides: Partial<LimitUpMarketSnapshot> = {}): LimitUpMarketSnapshot => ({
  date: '2026-11-12',
  source: 'fuyao',
  asOf: new Date('2026-11-12T07:02:00Z'),
  dataAsOf: new Date('2026-11-12T07:00:00Z'),
  pool: { total: 1, entries: [makeEntry()] },
  statistics: null,
  ladder: null,
  warnings: [],
  ...overrides,
});

describe('deriveLimitUpMarketMetrics', () => {
  it('按 pool 与 statistics 各自口径聚合，不做互相覆盖', () => {
    const metrics = deriveLimitUpMarketMetrics(
      makeSnapshot({
        pool: {
          total: 3,
          entries: [
            makeEntry({
              sealMoney: 100,
              maxSealMoney: 200,
              continueDayCnt: 5,
              limitUpTime: '09:35',
            }),
            makeEntry({
              stockId: '603366.SH',
              code: '603366',
              sealMoney: 300,
              maxSealMoney: 400,
              continueDayCnt: 1,
              limitUpTime: '10:00',
            }),
            makeEntry({
              stockId: '600000.SH',
              code: '600000',
              sealMoney: 0,
              maxSealMoney: 0,
              continueDayCnt: 2,
              limitUpTime: null,
            }),
          ],
        },
        statistics: {
          tradeDate: '2026-11-12',
          sealRate: 0.51,
          openStockCount: 35,
          limitUpStockCount: 37,
          touchedLimitUpStockCount: 72,
          pageBoards: [],
          exactBoards: [],
        },
      }),
    );

    expect(metrics.poolCount).toBe(3);
    expect(metrics.consecutiveCount).toBe(2);
    expect(metrics.maxBoard).toBe(5);
    expect(metrics.sealAmount).toBe(400);
    expect(metrics.maxSealAmount).toBe(600);
    expect(metrics.sealRetentionRate).toBeCloseTo(400 / 600);
    // 只有两条有时间；10:00 计入早封（含边界）
    expect(metrics.earlySealRate).toBe(1);
    expect(metrics.sealRate).toBe(0.51);
    expect(metrics.openCount).toBe(35);
  });

  it('缺 pool / 缺 statistics 时 KPI 退化为 0 与 null，不抛错', () => {
    const metrics = deriveLimitUpMarketMetrics(makeSnapshot({ pool: null }));
    expect(metrics.poolCount).toBe(0);
    expect(metrics.maxBoard).toBe(0);
    expect(metrics.sealRetentionRate).toBeNull();
    expect(metrics.earlySealRate).toBeNull();
    expect(metrics.sealRate).toBeNull();
    expect(metrics.openCount).toBeNull();
  });

  it('封单留存分母为 0 → null（不返回 NaN）', () => {
    const metrics = deriveLimitUpMarketMetrics(
      makeSnapshot({
        pool: { total: 1, entries: [makeEntry({ sealMoney: 0, maxSealMoney: 0 })] },
      }),
    );
    expect(metrics.sealRetentionRate).toBeNull();
  });
});

describe('deriveReasonDistribution', () => {
  it('按 reason 原文聚合，次数降序', () => {
    const buckets = deriveReasonDistribution([
      { reason: '百货零售' },
      { reason: '光模块' },
      { reason: '百货零售' },
      { reason: null },
    ]);
    expect(buckets).toEqual([
      { reason: '百货零售', count: 2 },
      { reason: '光模块', count: 1 },
      { reason: '未披露', count: 1 },
    ]);
  });

  it('超出 limit 的桶合并为「其他原因」并排末尾', () => {
    const buckets = deriveReasonDistribution(
      [{ reason: 'a' }, { reason: 'a' }, { reason: 'b' }, { reason: 'c' }, { reason: 'd' }],
      2,
    );
    expect(buckets).toEqual([
      { reason: 'a', count: 2 },
      { reason: 'b', count: 1 },
      { reason: LIMIT_UP_REASON_OTHER, count: 2 },
    ]);
  });
});

describe('limitUpLadderBandLabel', () => {
  it('低于 7 板用板数，7 板以上单独标注', () => {
    expect(limitUpLadderBandLabel('two')).toBe('2 板');
    expect(limitUpLadderBandLabel('six')).toBe('6 板');
    expect(limitUpLadderBandLabel('seven_plus')).toBe('7 板及以上');
  });
});

describe('assertLimitUpMarketInvariants', () => {
  it('接受合法快照', () => {
    expect(() => assertLimitUpMarketInvariants(makeSnapshot())).not.toThrow();
  });

  it('pool.total 小于条目数 → 抛错', () => {
    expect(() =>
      assertLimitUpMarketInvariants(makeSnapshot({ pool: { total: 0, entries: [makeEntry()] } })),
    ).toThrow(/pool.total/);
  });

  it('峰值封单额小于当前封单额 → 抛错', () => {
    expect(() =>
      assertLimitUpMarketInvariants(
        makeSnapshot({
          pool: { total: 1, entries: [makeEntry({ sealMoney: 100, maxSealMoney: 50 })] },
        }),
      ),
    ).toThrow(/maxSealMoney/);
  });

  it('ladder.days 出现窗口外日期 → 抛错', () => {
    expect(() =>
      assertLimitUpMarketInvariants(
        makeSnapshot({
          ladder: {
            length: 2,
            dateList: ['2026-11-12'],
            boardCaps: { two: 1, three: 0, four: 0, five: 0, six: 0, seven_plus: 0 },
            days: [
              {
                date: '2026-11-11',
                bands: [{ band: 'two', stocks: [] }],
              },
            ],
          },
        }),
      ),
    ).toThrow(/窗口外/);
  });
});

describe('buildLimitUpMarketView', () => {
  it('打包快照 + KPI + 原因分布，三者同源', () => {
    const view = buildLimitUpMarketView(
      makeSnapshot({
        pool: {
          total: 2,
          entries: [
            makeEntry({ sealMoney: 100, maxSealMoney: 100, continueDayCnt: 5 }),
            makeEntry({
              stockId: '603366.SH',
              code: '603366',
              reason: null,
              sealMoney: 0,
              maxSealMoney: 0,
            }),
          ],
        },
      }),
    );

    expect(view.snapshot.pool?.total).toBe(2);
    expect(view.metrics.poolCount).toBe(2);
    expect(view.metrics.maxBoard).toBe(5);
    expect(view.reasons).toEqual([
      { reason: '百货零售', count: 1 },
      { reason: '未披露', count: 1 },
    ]);
  });
});

describe('LimitUpMarketSnapshotSchema', () => {
  it('池条目允许 null 字段（价格 / 时间 / 开板次数 / 原因）', () => {
    const parsed = LimitUpMarketSnapshotSchema.safeParse(
      makeSnapshot({
        pool: {
          total: 1,
          entries: [
            makeEntry({
              price: null,
              changePct: null,
              limitUpTime: null,
              openTimes: null,
              reason: null,
            }),
          ],
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('拒绝非 SH/SZ 后缀的 stockId', () => {
    const parsed = LimitUpMarketSnapshotSchema.safeParse(
      makeSnapshot({
        pool: { total: 1, entries: [makeEntry({ stockId: '830799.BJ' })] },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});
