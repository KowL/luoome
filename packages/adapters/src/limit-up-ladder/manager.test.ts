import type { LimitUpLadderQuery, Logger } from '@luoome/core';
import { LimitUpLadderQuerySchema } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { LimitUpLadderManager } from './manager.js';
import type {
  LimitUpLadderCapabilityMap,
  LimitUpLadderFetchResult,
  LimitUpLadderRawEntry,
} from './types.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const FIXED_OBSERVED_AT = new Date('2026-07-25T07:00:00.000Z');

/** fake binding 的传输实现：保持旧 adapter 测试的 {date, entries} 形状，observedAt 由包装层补齐。 */
type FakeFetch = (
  date: string,
  opts?: { readonly days?: number },
) => Promise<{ readonly date: string; readonly entries: LimitUpLadderRawEntry[] }>;

/** §6.2：observedAt 透传为 dataAsOf；合法空池也是 success。 */
const mkBinding = (name: string, impl: FakeFetch): AnyBinding<LimitUpLadderCapabilityMap> => ({
  capability: 'limit-up-ladder',
  source: name,
  coverage: ['CN_A_SHARES_SH_SZ'],
  configurationReady: true,
  execute: async ({ date, days }): Promise<LimitUpLadderFetchResult> => ({
    observedAt: FIXED_OBSERVED_AT,
    ...(await impl(date, { days })),
  }),
  observationOf: (result) => ({ outcome: 'success', dataAsOf: result.observedAt }),
});

interface ManagerTestOpts {
  readonly clock: () => Date;
  readonly holidaysProvider?: () => Promise<ReadonlyMap<number, ReadonlySet<string>>>;
  readonly isWeekendFn?: (d: Date) => boolean;
}

const mkManager = (
  fetches: readonly (readonly [string, FakeFetch])[],
  opts: ManagerTestOpts,
): LimitUpLadderManager =>
  new LimitUpLadderManager({
    registry: new SourceRegistry<LimitUpLadderCapabilityMap>(
      fetches.map(([name, impl]) => mkBinding(name, impl)),
      opts.clock,
    ),
    logger: noopLogger,
    clock: opts.clock,
    holidaysProvider: opts.holidaysProvider ?? (async () => new Map()),
    ...(opts.isWeekendFn === undefined ? {} : { isWeekendFn: opts.isWeekendFn }),
  });

const mkRawEntry = (
  partial: { code: string; close: number } & Partial<LimitUpLadderRawEntry>,
): LimitUpLadderRawEntry => partial;

const query = (input: {
  date: string;
  days?: number;
  includeUncategorized?: boolean;
  source?: string;
}): LimitUpLadderQuery => LimitUpLadderQuerySchema.parse(input);

const compareQuery = (): Omit<LimitUpLadderQuery, 'date'> => {
  const full = LimitUpLadderQuerySchema.parse({ date: '2026-07-25', days: 15 });
  const { date: _omit, ...rest } = full;
  void _omit;
  return rest;
};

describe('LimitUpLadderManager', () => {
  describe('fetchLadder', () => {
    it('主源成功：返回映射+过滤+修正后 ladder', async () => {
      // 2026-07-25 是周六 → 非交易日，需要把节假日历设为空且 isWeekend 返回 false
      const m = mkManager(
        [
          [
            'eastmoney',
            async (_date, _opts) => ({
              date: '2026-07-25',
              entries: [
                {
                  code: '600519',
                  name: '贵州茅台',
                  industry: '白酒',
                  level: 2,
                  close: 1850,
                  pre_close: 1681.8,
                  change_pct: 0.1,
                  first_time: '10:30:00',
                  final_time: '14:50:00',
                  reason: '涨价',
                  limit_up_date: '2026-07-25',
                  high: 1850,
                },
                {
                  code: '300750',
                  name: '宁德时代',
                  industry: '锂电池',
                  level: 1,
                  close: 500,
                  pre_close: 454.5,
                  change_pct: 0.1,
                  limit_up_date: '2026-07-25',
                  high: 500,
                },
              ],
            }),
          ],
        ],
        {
          clock: () => new Date('2026-07-25T05:00:00Z'), // Shanghai 13:00 → 盘中
          isWeekendFn: () => false,
        },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.source).toBe('eastmoney');
      expect(r.data.total).toBe(2);
      expect(r.data.levels).toHaveLength(2);
      expect(r.data.levels[0]?.level).toBe(2);
      expect(r.data.levels[0]?.stocks[0]?.code).toBe('600519');
      expect(r.data.levels[1]?.level).toBe(1);
      expect(r.data.maxLevel).toBe(2);
    });

    it('rawClose == high 且涨幅 ∈ [9.8%, 10%) 触发 8.58% 修正', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async (_d) => ({
              date: '2026-07-25',
              entries: [
                // 触板: close=10.99, high=10.99, pre_close=10 → pct=0.099 → 修正到 10.858
                {
                  code: '600001',
                  name: '触板股',
                  close: 10.99,
                  pre_close: 10,
                  high: 10.99,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
              ],
            }),
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = r.data.levels[0]?.stocks[0];
      expect(e).toBeDefined();
      if (!e) return;
      expect(e.corrected).toBe(true);
      expect(e.price).toBeCloseTo(10 * 1.0858, 5);
      expect(e.rawClose).toBe(10.99);
      expect(r.data.warnings).toContainEqual(expect.stringMatching(/corrected entries/));
    });

    it('真涨停 (涨幅 >= 10%) 不触发修正', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async (_d) => ({
              date: '2026-07-25',
              entries: [
                {
                  code: '600002',
                  name: '涨停股',
                  close: 11,
                  pre_close: 10,
                  high: 11,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
              ],
            }),
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = r.data.levels[0]?.stocks[0];
      expect(e?.corrected).toBe(false);
      expect(e?.price).toBe(11);
    });

    it('非交易日返回空 ladder + warnings=["non-trading-day"]，不写观测', async () => {
      const fetchMock = vi.fn(async () => ({ date: '2026-07-25', entries: [] }));
      const m = mkManager([['eastmoney', fetchMock]], {
        clock: () => new Date('2026-07-25T05:00:00Z'),
        isWeekendFn: () => true, // 永远周末
      });
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.levels).toHaveLength(0);
      expect(r.data.total).toBe(0);
      expect(r.data.maxLevel).toBe(0);
      expect(r.data.source).toBe('eastmoney'); // 本地早退：配置首项
      expect(r.data.warnings).toEqual(['non-trading-day']);
      expect(fetchMock).not.toHaveBeenCalled();
      // 早退不写观测（§4.6）
      const status = m.status();
      expect(status).toHaveLength(1);
      expect(status[0]?.dataset).toBe('limit-up-ladder');
      expect(status[0]?.source).toBe('eastmoney');
      expect(status[0]?.lastAttemptAt).toBeUndefined();
    });

    it('节假日日期同样返回 non-trading-day', async () => {
      const m = mkManager([['eastmoney', vi.fn(async () => ({ date: 'x', entries: [] }))]], {
        clock: () => new Date('2026-07-25T05:00:00Z'),
        holidaysProvider: async () => new Map([[2026, new Set(['2026-07-25'] as string[])]]),
        isWeekendFn: () => false,
      });
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.warnings).toEqual(['non-trading-day']);
    });

    it('唯一源失败：返回 adapter_error', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async () => {
              throw new Error('eastmoney down');
            },
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('adapter_error');
      expect(r.error.adapter).toBe('limit-up-ladder');
      expect(r.error.message).toMatch(/all sources failed/);
      expect(r.error.message).toContain('eastmoney down');
    });

    it('主源失败 + fallback 成功：走 fallback，结果记录实际 source', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async () => {
              throw new Error('eastmoney down');
            },
          ],
          [
            'stub-fallback',
            async () => ({
              date: '2026-07-25',
              entries: [
                {
                  code: '600003',
                  name: 'fallback 股',
                  close: 100,
                  pre_close: 90.91,
                  high: 100,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
              ],
            }),
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.levels[0]?.stocks[0]?.code).toBe('600003');
      expect(r.data.source).toBe('stub-fallback'); // provenance 来自成功 handle
    });

    it('显式 query.source 只尝试该源；未启用源返回 adapter_error', async () => {
      const primaryMock = vi.fn(async () => ({ date: '2026-07-25', entries: [] }));
      const fallbackMock = vi.fn(async () => ({
        date: '2026-07-25',
        entries: [
          mkRawEntry({
            code: '600003',
            name: 'fallback 股',
            close: 100,
            pre_close: 90.91,
            high: 100,
            level: 1,
            limit_up_date: '2026-07-25',
          }),
        ],
      }));
      const m = mkManager(
        [
          ['eastmoney', primaryMock],
          ['stub-fallback', fallbackMock],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );

      const routed = await m.fetchLadder(
        query({ date: '2026-07-25', days: 15, source: 'stub-fallback' }),
      );
      expect(routed.ok).toBe(true);
      if (routed.ok) expect(routed.data.source).toBe('stub-fallback');
      expect(primaryMock).not.toHaveBeenCalled();
      expect(fallbackMock).toHaveBeenCalledTimes(1);

      const disabled = await m.fetchLadder(
        query({ date: '2026-07-25', days: 15, source: 'tushare' }),
      );
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');
    });

    it('主源 + fallback 双失败：返回 adapter_error', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async () => {
              throw new Error('eastmoney down');
            },
          ],
          [
            'stub-fallback',
            async () => {
              throw new Error('stub-fallback down');
            },
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toMatch(/all sources failed \(eastmoney → stub-fallback\)/);
      expect(r.error.message).toContain('stub-fallback down');
    });

    it('status()：成功后记录 dataAsOf，失败后保留旧 dataAsOf 并记 lastErrorKind', async () => {
      let fail = false;
      const m = mkManager(
        [
          [
            'eastmoney',
            async () => {
              if (fail) throw new Error('eastmoney down');
              return {
                date: '2026-07-25',
                entries: [
                  mkRawEntry({
                    code: '600009',
                    name: 'A',
                    close: 10,
                    pre_close: 9.09,
                    high: 10,
                    level: 1,
                    limit_up_date: '2026-07-25',
                  }),
                ],
              };
            },
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      const afterSuccess = m.status()[0];
      expect(afterSuccess?.lastSuccessAt).toBeDefined();
      expect(afterSuccess?.dataAsOf).toEqual(FIXED_OBSERVED_AT);
      expect(afterSuccess?.lastErrorKind).toBeUndefined();

      fail = true;
      const failed = await m.fetchLadder(query({ date: '2026-07-26', days: 15 }));
      expect(failed.ok).toBe(false);
      const afterFailure = m.status()[0];
      expect(afterFailure?.lastErrorKind).toBe('upstream_error'); // 非结构化异常收口
      expect(afterFailure?.dataAsOf).toEqual(FIXED_OBSERVED_AT); // 旧 dataAsOf 保留供诊断
    });

    it('当日盘中：60s TTL 命中', async () => {
      const fetchMock = vi.fn(async () => ({
        date: '2026-07-25',
        entries: [
          {
            code: '600004',
            name: 'A',
            close: 10,
            pre_close: 9.09,
            high: 10,
            level: 1,
            limit_up_date: '2026-07-25',
          },
        ],
      }));
      const clock = vi.fn(() => new Date('2026-07-25T05:00:00Z')); // Shanghai 13:00 盘中
      const m = mkManager([['eastmoney', fetchMock]], { clock, isWeekendFn: () => false });
      const r1 = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      const r2 = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r1.ok && r2.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // 第二次命中缓存
    });

    it('当日盘后：Infinity TTL 命中', async () => {
      const fetchMock = vi.fn(async () => ({
        date: '2026-07-25',
        entries: [
          {
            code: '600005',
            name: 'A',
            close: 10,
            pre_close: 9.09,
            high: 10,
            level: 1,
            limit_up_date: '2026-07-25',
          },
        ],
      }));
      const m = mkManager([['eastmoney', fetchMock]], {
        clock: () => new Date('2026-07-25T11:00:00Z'), // Shanghai 19:00 盘后
        isWeekendFn: () => false,
      });
      await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('跨日查询：永久命中各自 key', async () => {
      const fetchMock = vi.fn(async (date: string) => ({
        date,
        entries: [
          {
            code: '600006',
            name: 'A',
            close: 10,
            pre_close: 9.09,
            high: 10,
            level: 1,
            limit_up_date: date,
          },
        ],
      }));
      const m = mkManager([['eastmoney', fetchMock]], {
        clock: () => new Date('2026-07-25T05:00:00Z'),
        isWeekendFn: () => false,
      });
      await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      await m.fetchLadder(query({ date: '2026-07-24', days: 15 }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('科创 / 北交所 / ST 默认过滤', async () => {
      const m = mkManager(
        [
          [
            'eastmoney',
            async (_d) => ({
              date: '2026-07-25',
              entries: [
                {
                  code: '600007',
                  name: '主板股',
                  close: 10,
                  high: 10,
                  pre_close: 9.09,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
                {
                  code: '688981',
                  name: '科创股',
                  close: 10,
                  high: 10,
                  pre_close: 9.09,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
                {
                  code: '830799',
                  name: '北交所股',
                  close: 10,
                  high: 10,
                  pre_close: 9.09,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
                {
                  code: '600008',
                  name: 'ST大集',
                  close: 10,
                  high: 10,
                  pre_close: 9.09,
                  level: 1,
                  limit_up_date: '2026-07-25',
                },
              ],
            }),
          ],
        ],
        { clock: () => new Date('2026-07-25T05:00:00Z'), isWeekendFn: () => false },
      );
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.total).toBe(1);
      expect(r.data.levels[0]?.stocks[0]?.code).toBe('600007');
      expect(r.data.warnings).toContainEqual(expect.stringMatching(/filtered: 3/));
    });

    it('空 entries 不报错，返回 warnings=[empty-ladder]', async () => {
      const m = mkManager([['eastmoney', async (_d) => ({ date: '2026-07-25', entries: [] })]], {
        clock: () => new Date('2026-07-25T05:00:00Z'),
        isWeekendFn: () => false,
      });
      const r = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.warnings).toEqual(['empty-ladder']);
      expect(r.data.total).toBe(0);
    });

    it('includeUncategorized 默认隐藏 level 缺失 entry，true 时显示（共享同一缓存）', async () => {
      const fetchMock = vi.fn(async () => ({
        date: '2026-07-25',
        entries: [
          {
            code: '600020',
            name: '有层级',
            close: 10,
            high: 10,
            pre_close: 9.09,
            level: 2,
            limit_up_date: '2026-07-25',
          },
          {
            code: '600021',
            name: '缺层级',
            close: 10,
            high: 10,
            pre_close: 9.09,
            limit_up_date: '2026-07-25',
          },
        ],
      }));
      const m = mkManager([['eastmoney', fetchMock]], {
        clock: () => new Date('2026-07-25T05:00:00Z'),
        isWeekendFn: () => false,
      });
      const hidden = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
      expect(hidden.ok).toBe(true);
      if (!hidden.ok) return;
      expect(hidden.data.total).toBe(1);
      expect(hidden.data.levels[0]?.stocks[0]?.code).toBe('600020');

      const shown = await m.fetchLadder(
        query({ date: '2026-07-25', days: 15, includeUncategorized: true }),
      );
      expect(shown.ok).toBe(true);
      if (!shown.ok) return;
      expect(shown.data.total).toBe(2);
      const unc = shown.data.levels.flatMap((lv) => lv.stocks).find((s) => s.code === '600021');
      expect(unc?.uncategorized).toBe(true);
      expect(unc?.ladderLevel).toBe(1); // 缺 level 回退首板
      // cache key 不含 includeUncategorized：两次查询共享一次远端拉取
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('盘前空 ladder 短 TTL：数据更新后可重新拉取', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-07-25T00:00:00Z')); // Shanghai 08:00 盘前
        let calls = 0;
        const fetchMock = vi.fn(async () => {
          calls += 1;
          return {
            date: '2026-07-25',
            entries:
              calls === 1
                ? []
                : [
                    {
                      code: '600022',
                      name: 'A',
                      close: 10,
                      high: 10,
                      pre_close: 9.09,
                      level: 1,
                      limit_up_date: '2026-07-25',
                    },
                  ],
          };
        });
        const m = mkManager([['eastmoney', fetchMock]], {
          clock: () => new Date(),
          isWeekendFn: () => false,
        });
        const r1 = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
        expect(r1.ok).toBe(true);
        if (!r1.ok) return;
        expect(r1.data.warnings).toContain('empty-ladder');

        vi.setSystemTime(new Date('2026-07-25T00:01:01Z')); // 61s 后，盘前短 TTL 已过期
        const r2 = await m.fetchLadder(query({ date: '2026-07-25', days: 15 }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(r2.ok).toBe(true);
        if (!r2.ok) return;
        expect(r2.data.total).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('compareLadder', () => {
    const buildManager = () =>
      mkManager(
        [
          [
            'eastmoney',
            async (date: string) => ({
              date,
              entries:
                date === '2026-07-25'
                  ? [
                      mkRawEntry({
                        code: '600010',
                        name: 'A',
                        close: 10,
                        pre_close: 9.09,
                        high: 10,
                        level: 5,
                        limit_up_date: date,
                      }),
                    ]
                  : [
                      mkRawEntry({
                        code: '600011',
                        name: 'B',
                        close: 10,
                        pre_close: 9.09,
                        high: 10,
                        level: 5,
                        limit_up_date: date,
                      }),
                    ],
            }),
          ],
        ],
        {
          clock: () => new Date('2026-07-25T05:00:00Z'),
          isWeekendFn: () => false,
        },
      );

    it('curr + prev 成功：返回 diff', async () => {
      const m = buildManager();
      const r = await m.compareLadder('2026-07-25', '2026-07-24', compareQuery());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.curr.levels[0]?.stocks[0]?.code).toBe('600010');
      expect(r.data.prev.levels[0]?.stocks[0]?.code).toBe('600011');
      expect(r.data.diff.totalDelta).toBe(0);
      expect(r.data.diff.maxLevelDelta).toBe(0);
      expect(r.data.diff.topLevelAdded).toEqual(['600010']);
      expect(r.data.diff.topLevelRemoved).toEqual(['600011']);
      expect(r.data.diff.topLevelRetained).toEqual([]);
    });
  });
});
