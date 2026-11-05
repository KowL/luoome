import {
  FetchSectorQuotesQuerySchema,
  FinancialSnapshotQuerySchema,
  LimitUpLadderQuerySchema,
} from '@luoome/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FuyaoClient } from './fuyao/client.js';
import { createLocalAdapters } from './local-adapters.js';
import type { MarketDumpStores } from './market-dump/types.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const clock = () => new Date('2026-11-04T00:00:00.000Z');

const baseOptions = { clock, logger: noopLogger };
const makeStores = (): MarketDumpStores => ({
  runs: {
    saveStarted: vi.fn(),
    findById: vi.fn(async () => null),
    listRecent: vi.fn(async () => []),
    findResumable: vi.fn(async () => null),
    advanceCheckpoint: vi.fn(),
    markDownloaded: vi.fn(),
    finish: vi.fn(),
  },
  rawDailyBars: {
    saveMany: vi.fn(),
    listRevisions: vi.fn(async () => []),
    listRevisionsForStocks: vi.fn(async () => []),
    summarizeArtifact: vi.fn(async () => ({ rows: 0, minDate: null, maxDate: null })),
  },
  corporateActionEvents: {
    saveMany: vi.fn(),
    listRevisions: vi.fn(async () => []),
    listRevisionsForStocks: vi.fn(async () => []),
    summarizeArtifact: vi.fn(async () => ({ rows: 0, minDate: null, maxDate: null })),
  },
});
afterEach(() => vi.unstubAllGlobals());

describe('createLocalAdapters', () => {
  it('各域真实请求共用 Fuyao 并发预算，权限失败逐 capability 观测且不发外部请求', async () => {
    const gate = Promise.withResolvers<void>();
    const saturated = Promise.withResolvers<void>();
    const paths: string[] = [];
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      paths.push(new URL(String(input)).pathname);
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) saturated.resolve();
      await gate.promise;
      active -= 1;
      return Response.json({ code: 2003, message: 'permission denied', data: null });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const adapters = createLocalAdapters({
      ...baseOptions,
      marketDumpStores: makeStores(),
      env: {
        LUOOME_MARKET_PROVIDER: 'real',
        FUYAO_API_KEY: 'fixture',
        FUYAO_BASE_URL: 'https://fuyao.example.test',
        FUYAO_MAX_CONCURRENCY: '2',
        FUYAO_MIN_INTERVAL_MS: '1',
        LUOOME_MARKET_SOURCES: 'fuyao',
        LUOOME_LIMIT_UP_LADDER_SOURCES: 'fuyao',
        LUOOME_DRAGON_TIGER_SOURCES: 'fuyao',
        LUOOME_ASHARE_SENTIMENT_SOURCES: 'fuyao',
        LUOOME_NEWS_SOURCES: 'fuyao',
        LUOOME_FUYAO_NEWS_TAG_ID: 'fixture',
        LUOOME_SECTOR_QUOTE_SOURCES: 'fuyao',
        LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao',
        LUOOME_FINANCIAL_SNAPSHOT_SOURCES: 'fuyao',
        LUOOME_MARKET_DUMP_SOURCES: 'fuyao',
      },
    });
    const requests = Promise.allSettled([
      adapters.market.fetchQuote('600519.SH'),
      adapters.limitUpLadder.fetchLadder(
        LimitUpLadderQuerySchema.parse({ date: '2026-11-03', source: 'fuyao' }),
      ),
      adapters.dragonTiger.fetchList({ date: '2026-11-03', source: 'fuyao' }),
      adapters.ashareSentiment.fetch({ date: '2026-11-03', coverage: 'CN_A_SHARES_SH_SZ' }),
      adapters.news.fetchNews({ page: 1, limit: 10, source: 'fuyao' }),
      adapters.sectorQuote.fetchList(FetchSectorQuotesQuerySchema.parse({ source: 'fuyao' })),
      adapters.sectorMembership?.fetchMemberships({ stockIds: ['600519.SH'] }),
      adapters.financialSnapshot?.fetchSnapshot(
        FinancialSnapshotQuerySchema.parse({ stockId: '600519.SH' }),
      ),
      adapters.marketDump?.sync({ kind: 'daily-k-10d' }),
    ]);
    try {
      await saturated.promise;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
    }
    await requests;
    expect(peak).toBe(2);
    expect(new Set(paths)).toEqual(
      new Set([
        '/api/a-share/prices/snapshot',
        '/api/a-share/special-data/limit-up-pool',
        '/api/a-share/special-data/limit-break-pool',
        '/api/a-share/special-data/dragon-tiger-list',
        '/api/news/flash/list',
        '/api/a-share-index/catalog/ths-index-list',
        '/api/a-share-index/constituents/ths-index-list-by-stock',
        '/api/a-share/financials/income-statements',
        '/api/a-share/financials/balance-sheets',
        '/api/a-share/financials/cash-flow-statements',
        '/api/dump/market-dumps/daily-k-10d/download-url',
      ]),
    );
    expect(adapters.limitUpLadder.status()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'fuyao', lastErrorKind: 'permission' }),
      ]),
    );
    expect(await adapters.marketDump?.status()).toEqual([]);
  });
  it('默认装配：无 fuyao 能力启用时不创建共享 FuyaoClient，新能力端口缺省关闭', () => {
    const adapters = createLocalAdapters({
      env: { LUOOME_MARKET_PROVIDER: 'real' },
      ...baseOptions,
    });
    expect(adapters.sources.eastmoney).toBeDefined();
    expect(adapters.sources.fuyao).toBeUndefined();
    expect(adapters.market).toBeDefined();
    expect(adapters.sectorMembership).toBeUndefined();
    expect(adapters.financialSnapshot).toBeUndefined();
    expect(adapters.marketDump).toBeUndefined();
  });

  it('fuyao 能力显式启用时创建进程级共享 FuyaoClient（同一实例分发到各域）', () => {
    const adapters = createLocalAdapters({
      env: {
        LUOOME_MARKET_PROVIDER: 'real',
        FUYAO_API_KEY: 'k',
        LUOOME_LIMIT_UP_LADDER_SOURCES: 'fuyao',
        LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao',
        LUOOME_FINANCIAL_SNAPSHOT_SOURCES: 'fuyao',
      },
      ...baseOptions,
    });
    const shared = adapters.sources.fuyao;
    expect(shared).toBeInstanceOf(FuyaoClient);
    expect(adapters.limitUpLadder.sources).toEqual(['fuyao']);
    expect(adapters.sectorMembership?.sources).toEqual(['fuyao']);
    expect(adapters.financialSnapshot?.sources).toEqual(['fuyao']);
  });

  it.each([
    'LUOOME_MARKET_SOURCES',
    'LUOOME_LIMIT_UP_LADDER_SOURCES',
    'LUOOME_DRAGON_TIGER_SOURCES',
    'LUOOME_ASHARE_SENTIMENT_SOURCES',
    'LUOOME_NEWS_SOURCES',
    'LUOOME_SECTOR_QUOTE_SOURCES',
    'LUOOME_SECTOR_MEMBERSHIP_SOURCES',
    'LUOOME_FINANCIAL_SNAPSHOT_SOURCES',
    'LUOOME_MARKET_DUMP_SOURCES',
  ])('%s 显式启用且凭据缺失或空白时启动失败', (key) => {
    for (const apiKey of [undefined, '   ']) {
      expect(() =>
        createLocalAdapters({
          env: { LUOOME_MARKET_PROVIDER: 'real', [key]: ' fuyao ', FUYAO_API_KEY: apiKey },
          ...baseOptions,
        }),
      ).toThrow(/FUYAO_API_KEY/);
    }
  });

  it('仅有凭据不会启用 Fuyao 或发起探测请求', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const adapters = createLocalAdapters({
      env: { LUOOME_MARKET_PROVIDER: 'real', FUYAO_API_KEY: 'fixture' },
      ...baseOptions,
      marketDumpStores: makeStores(),
    });
    expect(adapters.sources.fuyao).toBeUndefined();
    expect(adapters.marketDump).toBeUndefined();
    expect(adapters.financialSnapshot).toBeUndefined();
    expect(adapters.sectorMembership).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('market-dump：未注入仓储组时不装配；注入后仍须 LUOOME_MARKET_DUMP_SOURCES 显式启用', () => {
    const stores = makeStores();
    // 无仓储 → 即使显式启用也不装配（装配侧未接线）
    const withoutStores = createLocalAdapters({
      env: {
        LUOOME_MARKET_PROVIDER: 'real',
        FUYAO_API_KEY: 'k',
        LUOOME_MARKET_DUMP_SOURCES: 'fuyao',
      },
      ...baseOptions,
    });
    expect(withoutStores.marketDump).toBeUndefined();
    // 有仓储但未显式启用 → 不装配
    const disabled = createLocalAdapters({
      env: { LUOOME_MARKET_PROVIDER: 'real', FUYAO_API_KEY: 'k' },
      ...baseOptions,
      marketDumpStores: stores,
    });
    expect(disabled.marketDump).toBeUndefined();
    // 仓储 + 显式启用 → 装配
    const enabled = createLocalAdapters({
      env: {
        LUOOME_MARKET_PROVIDER: 'real',
        FUYAO_API_KEY: 'k',
        LUOOME_MARKET_DUMP_SOURCES: 'fuyao',
      },
      ...baseOptions,
      marketDumpStores: stores,
    });
    expect(enabled.marketDump?.name).toBe('market-dump');
  });
});
