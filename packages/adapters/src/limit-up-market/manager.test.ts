import { describe, expect, it } from 'vitest';

import type { LimitUpMarketSections } from '../fuyao/limit-up-market.js';
import { LimitUpMarketManager, type LimitUpMarketPrimarySource } from './manager.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const poolEntry = {
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
};

const statistics = {
  tradeDate: '2026-11-12',
  sealRate: 0.5138888888888888,
  openStockCount: 35,
  limitUpStockCount: 37,
  touchedLimitUpStockCount: 72,
  pageBoards: [
    { level: 'one' as const, stockCount: 26, promotionRate: null },
    { level: 'two' as const, stockCount: 5, promotionRate: 0.08 },
  ],
  exactBoards: [{ boardNum: 5, stockCount: 2 }],
};

const ladder = {
  length: 30,
  dateList: ['2026-11-12', '2026-11-11'],
  boardCaps: { two: 5, three: 2, four: 0, five: 0, six: 0, seven_plus: 0 },
  days: [
    {
      date: '2026-11-12',
      bands: [
        {
          band: 'two' as const,
          stocks: [
            {
              stockId: '603135.SH',
              code: '603135',
              name: '中重科技',
              boardNum: 2,
              sealedNextDay: null,
            },
          ],
        },
      ],
    },
  ],
};

const sections = (overrides: Partial<LimitUpMarketSections> = {}): LimitUpMarketSections => ({
  date: '2026-11-12',
  pool: { total: 1, entries: [poolEntry] },
  poolError: null,
  statistics,
  statisticsError: null,
  ladder,
  ladderError: null,
  dataAsOf: new Date('2026-11-12T07:00:00Z'),
  ...overrides,
});

const stubSource = (
  result: LimitUpMarketSections | (() => Promise<LimitUpMarketSections>),
): LimitUpMarketPrimarySource & { readonly calls: string[] } => {
  const calls: string[] = [];
  return {
    name: 'fuyao',
    calls,
    fetchMarket: async (date: string) => {
      calls.push(date);
      return typeof result === 'function' ? result() : result;
    },
  };
};

const buildManager = (
  source: LimitUpMarketPrimarySource,
  opts: { readonly clock?: () => Date; readonly cacheTtlMs?: number } = {},
) =>
  new LimitUpMarketManager({
    primary: source,
    logger,
    clock: opts.clock ?? (() => new Date('2026-11-12T07:02:00Z')),
    ...(opts.cacheTtlMs === undefined ? {} : { cacheTtlMs: opts.cacheTtlMs }),
  });

describe('LimitUpMarketManager', () => {
  it('三维齐备 → ok，无 warning', async () => {
    const manager = buildManager(stubSource(sections()));
    const result = await manager.fetchMarket({ date: '2026-11-12' });

    expect(result.ok).toBe(true);
    expect(result.data?.warnings).toEqual([]);
    expect(result.data?.source).toBe('fuyao');
    expect(result.data?.asOf.toISOString()).toBe('2026-11-12T07:02:00.000Z');
    expect(result.data?.dataAsOf?.toISOString()).toBe('2026-11-12T07:00:00.000Z');
    expect(manager.sources).toEqual(['fuyao']);
  });

  it('空池（盘前 / 非交易日）→ ok + empty-pool，不当错误', async () => {
    const manager = buildManager(
      stubSource(
        sections({
          pool: { total: 0, entries: [] },
          statistics: { ...statistics, sealRate: null, limitUpStockCount: 0 },
        }),
      ),
    );
    const result = await manager.fetchMarket({ date: '2026-11-13' });

    expect(result.ok).toBe(true);
    expect(result.data?.warnings).toEqual(['empty-pool', 'empty-statistics']);
  });

  it('单维失败 → 该维 null + warning，其余照常返回', async () => {
    const manager = buildManager(
      stubSource(sections({ statistics: null, statisticsError: 'upstream_error: code=5001' })),
    );
    const result = await manager.fetchMarket({ date: '2026-11-12' });

    expect(result.ok).toBe(true);
    expect(result.data?.statistics).toBeNull();
    expect(result.data?.warnings).toEqual(['statistics-unavailable']);
    expect(result.data?.pool).not.toBeNull();
    expect(result.data?.ladder).not.toBeNull();
  });

  it('三维全失败 → adapter_error（不返回空看板）', async () => {
    const manager = buildManager(
      stubSource(
        sections({
          pool: null,
          poolError: 'network: down',
          statistics: null,
          statisticsError: 'timeout',
          ladder: null,
          ladderError: 'no_data',
          dataAsOf: null,
        }),
      ),
    );
    const result = await manager.fetchMarket({ date: '2026-11-12' });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('adapter_error');
    expect(result.error?.adapter).toBe('limit-up-market');
    expect(result.error?.message).toContain('network: down');
  });

  it('同日重复请求命中缓存，只打一次上游', async () => {
    const source = stubSource(sections());
    const manager = buildManager(source);

    await manager.fetchMarket({ date: '2026-11-12' });
    await manager.fetchMarket({ date: '2026-11-12' });

    expect(source.calls).toEqual(['2026-11-12']);
  });

  it('不变量被破坏 → 抛 InvariantError（由 tool 层映射为 invariant_violation）', async () => {
    const manager = buildManager(
      stubSource(sections({ pool: { total: 0, entries: [poolEntry] } })),
    );

    await expect(manager.fetchMarket({ date: '2026-11-12' })).rejects.toThrow(/pool.total/);
  });
});
