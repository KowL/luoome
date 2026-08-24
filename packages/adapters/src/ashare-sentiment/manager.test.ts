import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import {
  type AnyBinding,
  SourceRegistry,
  type SourceResultObservation,
} from '../source-registry.js';
import { AShareSentimentManager } from './manager.js';
import type { AShareSentimentCapabilityMap, AShareSentimentRawPool } from './types.js';

const now = new Date('2026-07-28T07:01:00.000Z');
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const sealedFixture: AShareSentimentRawPool = {
  ok: true,
  observedAt: new Date('2026-07-28T07:00:00.000Z'),
  fetchedAt: now,
  entries: [
    {
      stockId: '000002.SZ',
      name: '万科A',
      ladderLevel: 2,
      sealAmount: 80_000_000,
      openCount: 0,
      industry: '房地产',
      concepts: [],
    },
    {
      stockId: '600001.SH',
      name: '测试股份',
      ladderLevel: 1,
      sealAmount: null,
      openCount: null,
      industry: '半导体',
      concepts: [],
    },
  ],
};

const brokenFixture = (ok = true): AShareSentimentRawPool =>
  ok
    ? {
        ok: true,
        observedAt: new Date('2026-07-28T07:00:00.000Z'),
        fetchedAt: now,
        entries: [
          {
            stockId: '600519.SH',
            name: '贵州茅台',
            ladderLevel: 5,
            sealAmount: null,
            openCount: 2,
            industry: '白酒',
            concepts: [],
          },
          {
            stockId: '000002.SZ',
            name: '万科A',
            ladderLevel: 2,
            sealAmount: null,
            openCount: 1,
            industry: '房地产',
            concepts: [],
          },
        ],
      }
    : {
        ok: false,
        fetchedAt: now,
        errorKind: 'http_error',
        errorMessage: 'broken pool HTTP 502',
      };

interface FakePools {
  readonly sealed?: AShareSentimentRawPool | (() => Promise<AShareSentimentRawPool>);
  readonly broken?: AShareSentimentRawPool | (() => Promise<AShareSentimentRawPool>);
}

type PoolFn = () => Promise<AShareSentimentRawPool>;

/** §6.2：ok:true → success + observedAt；unsupported_date → ignored；其余 ok:false 按词表记 failure。 */
const observationOfPool = (pool: AShareSentimentRawPool): SourceResultObservation => {
  if (pool.ok) return { outcome: 'success', dataAsOf: pool.observedAt };
  if (pool.errorKind === 'unsupported_date') return { outcome: 'ignored' };
  return {
    outcome: 'failure',
    kind: pool.errorKind === 'invalid_response' ? 'invalid_payload' : 'network',
  };
};

const mkBindings = (
  poolsBySource: Record<string, FakePools>,
): {
  bindings: AnyBinding<AShareSentimentCapabilityMap>[];
  calls: Record<string, { sealed: number; broken: number }>;
} => {
  const calls: Record<string, { sealed: number; broken: number }> = {};
  const bindings: AnyBinding<AShareSentimentCapabilityMap>[] = [];
  for (const [source, pools] of Object.entries(poolsBySource)) {
    calls[source] = { sealed: 0, broken: 0 };
    for (const capability of ['sentiment-sealed-pool', 'sentiment-broken-pool'] as const) {
      const isSealed = capability === 'sentiment-sealed-pool';
      const fixture = isSealed ? pools.sealed : pools.broken;
      if (fixture === undefined) continue;
      bindings.push({
        capability,
        source,
        coverage: ['CN_A_SHARES_SH_SZ'],
        configurationReady: true,
        execute: async () => {
          const counter = calls[source];
          if (counter === undefined) throw new Error('unexpected');
          if (isSealed) counter.sealed += 1;
          else counter.broken += 1;
          return typeof fixture === 'function' ? await (fixture as PoolFn)() : fixture;
        },
        observationOf: observationOfPool,
      });
    }
  }
  return { bindings, calls };
};

const mkManager = (
  poolsBySource: Record<string, FakePools>,
  opts: { market?: unknown } = {},
): {
  manager: AShareSentimentManager;
  calls: Record<string, { sealed: number; broken: number }>;
} => {
  const { bindings, calls } = mkBindings(poolsBySource);
  const manager = new AShareSentimentManager({
    registry: new SourceRegistry<AShareSentimentCapabilityMap>(bindings, () => now),
    clock: () => now,
    logger,
    ...(opts.market === undefined ? {} : { market: opts.market as never }),
  });
  return { manager, calls };
};

const fixturePools = (brokenOk = true): Record<string, FakePools> => ({
  fixture: { sealed: sealedFixture, broken: brokenFixture(brokenOk) },
});

const INPUT = { date: '2026-07-28', coverage: 'CN_A_SHARES_SH_SZ' } as const;

describe('AShareSentimentManager', () => {
  it('聚合、跨池去重并生成封板分布、leader、热点与 provenance', async () => {
    const { manager } = mkManager(fixturePools());

    const result = await manager.fetch(INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp).toMatchObject({
      status: 'complete',
      value: {
        sealedCount: 2,
        brokenCount: 1,
        brokenRate: 1 / 3,
        maxLadderLevel: 2,
        totalSealAmount: null,
        boardDistribution: { '1': 1, '2': 1 },
      },
    });
    expect(result.data.limitUp.value?.leaders[0]).toMatchObject({
      stockId: '000002.SZ',
      ladderLevel: 2,
      sealAmount: 80_000_000,
      openCount: 0,
    });
    expect(result.data.themes).toMatchObject({
      status: 'partial',
      value: {
        industries: [
          { name: '白酒', count: 1 },
          { name: '半导体', count: 1 },
          { name: '房地产', count: 1 },
        ],
        concepts: [],
      },
    });
    expect(result.data.indexes.status).toBe('unavailable');
    expect(result.data.breadth.status).toBe('unavailable');
  });

  it('只用完整真实行情快照计算市场宽度', async () => {
    const market = {
      fetchMarketSnapshotEnvelope: vi.fn(async () => ({
        source: 'eastmoney',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        fetchedAt: now,
        items: [
          {
            id: '000001.SZ',
            code: '000001',
            exchange: 'SZ' as const,
            name: '平安银行',
            changePct: 1.2,
          },
          {
            id: '600000.SH',
            code: '600000',
            exchange: 'SH' as const,
            name: '浦发银行',
            changePct: -0.4,
          },
          {
            id: '600519.SH',
            code: '600519',
            exchange: 'SH' as const,
            name: '贵州茅台',
            changePct: 0,
          },
        ],
        completeness: {
          expectedCount: 3,
          receivedCount: 3,
          missingCount: 0,
          duplicateCount: 0,
          complete: true,
        },
      })),
    };
    const { manager } = mkManager(fixturePools(), { market });

    const result = await manager.fetch(INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.breadth).toMatchObject({
      status: 'complete',
      value: { advancing: 1, declining: 1, unchanged: 1, total: 3 },
    });
    expect(market.fetchMarketSnapshotEnvelope).toHaveBeenCalledTimes(1);
  });

  it('炸板端点失败时标 partial 且不携带无法完整表达的 limitUp value', async () => {
    const { manager } = mkManager(fixturePools(false));
    const result = await manager.fetch(INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('partial');
    expect(result.data.limitUp.value).toBeUndefined();
    expect(result.data.limitUp.warnings.join(' ')).toContain('broken pool HTTP 502');
    expect(result.data.themes.status).toBe('partial');
  });

  it('短 TTL 内复用按日期和 coverage 缓存的快照', async () => {
    const { manager, calls } = mkManager(fixturePools());
    await manager.fetch(INPUT);
    await manager.fetch(INPUT);
    expect(calls.fixture?.sealed).toBe(1);
    expect(calls.fixture?.broken).toBe(1);
  });

  it('主源单池失败时只对该池 fallback，并在 provenance 记录 fallbackFrom', async () => {
    const { manager, calls } = mkManager({
      fixture: { sealed: sealedFixture, broken: brokenFixture(false) },
      fallback: { sealed: sealedFixture, broken: brokenFixture(true) },
    });
    const result = await manager.fetch(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('complete');
    expect(result.data.limitUp.provenance[1]).toMatchObject({
      provider: 'fallback/broken-board',
      fallbackFrom: 'fixture/broken-board',
    });
    // 单池失败只对该池 fallback：fallback 源的 sealed capability 未被调用
    expect(calls.fallback?.sealed).toBe(0);
    expect(calls.fallback?.broken).toBe(1);
    // 两个 dataset 各自记录：sealed 成功，broken 主源失败 + fallback 成功
    const status = manager.status();
    const sealedStatus = status.find(
      (s) => s.dataset === 'sentiment-sealed-pool' && s.source === 'fixture',
    );
    const brokenPrimary = status.find(
      (s) => s.dataset === 'sentiment-broken-pool' && s.source === 'fixture',
    );
    const brokenFallback = status.find(
      (s) => s.dataset === 'sentiment-broken-pool' && s.source === 'fallback',
    );
    expect(sealedStatus?.lastErrorKind).toBeUndefined();
    expect(sealedStatus?.dataAsOf).toEqual(new Date('2026-07-28T07:00:00.000Z'));
    expect(brokenPrimary?.lastErrorKind).toBe('network'); // http_error → network（§4.4）
    expect(brokenFallback?.lastErrorKind).toBeUndefined();
  });

  it('双 dataset 全失败时 status() 各自记 failure，快照保持存量 warnings', async () => {
    const { manager } = mkManager({
      fixture: {
        sealed: {
          ok: false,
          fetchedAt: now,
          errorKind: 'network_error',
          errorMessage: 'sealed pool network down',
        },
        broken: brokenFixture(false),
      },
    });
    const result = await manager.fetch(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('unavailable');
    expect(result.data.limitUp.warnings.join(' ')).toContain('sealed pool network down');
    expect(result.data.limitUp.warnings.join(' ')).toContain('broken pool HTTP 502');

    const status = manager.status();
    const sealed = status.find((s) => s.dataset === 'sentiment-sealed-pool');
    const broken = status.find((s) => s.dataset === 'sentiment-broken-pool');
    expect(sealed?.lastErrorKind).toBe('network');
    expect(broken?.lastErrorKind).toBe('network');
    expect(sealed?.dataAsOf).toBeUndefined();
  });

  it('unsupported_date 池记 ignored（不写成功 / 错误 / 数据时间）', async () => {
    const { manager } = mkManager({
      fixture: {
        sealed: sealedFixture,
        broken: {
          ok: false,
          fetchedAt: now,
          errorKind: 'unsupported_date',
          errorMessage: 'eastmoney broken pool only supports the most recent 30 days',
        },
      },
    });
    const result = await manager.fetch(INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.limitUp.status).toBe('partial');

    const broken = manager
      .status()
      .find((s) => s.dataset === 'sentiment-broken-pool' && s.source === 'fixture');
    expect(broken?.lastAttemptAt).toBeDefined();
    expect(broken?.lastSuccessAt).toBeUndefined();
    expect(broken?.lastErrorKind).toBeUndefined();
    expect(broken?.dataAsOf).toBeUndefined();
  });

  it('周末不调用外部来源并返回 invalid_input', async () => {
    const { manager, calls } = mkManager(fixturePools());
    const result = await manager.fetch({
      date: '2026-07-25',
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(calls.fixture?.sealed).toBe(0);
    expect(calls.fixture?.broken).toBe(0);
  });
});
