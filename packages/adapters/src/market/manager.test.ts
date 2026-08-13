import type { Logger } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import type { FakeMarketAdapter } from '../testing/fake-market.js';
import { QuoteCache } from './cache.js';
import type { EastmoneyAdapter, EastmoneyAdapterError } from './eastmoney.js';
import { createTestMarketDataManager } from './manager.test-helper.js';
import type { TencentAdapter, TencentAdapterError } from './tencent.js';

// ---- 三个测试 adapter ----

class StubPrimary {
  readonly name = 'stub-primary';
  callCount = 0;
  failMode: 'ok' | 'throw' = 'ok';
  async fetchQuote(code: string) {
    this.callCount += 1;
    if (this.failMode === 'throw') throw new Error('primary fail');
    const fetchedAt = new Date();
    return {
      stockId: code,
      observedAt: fetchedAt,
      fetchedAt,
      timestampSource: 'retrieval' as const,
      ts: fetchedAt,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'eastmoney',
    };
  }
  async batchQuote(codes: readonly string[]) {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  async fetchDailyBars() {
    return [];
  }
}

class StubFallback {
  readonly name = 'stub-fallback';
  callCount = 0;
  failMode: 'ok' | 'throw' = 'throw'; // 默认失败
  async fetchQuote(code: string) {
    this.callCount += 1;
    if (this.failMode === 'throw') throw new Error('fallback fail');
    const fetchedAt = new Date();
    return {
      stockId: code,
      observedAt: fetchedAt,
      fetchedAt,
      timestampSource: 'retrieval' as const,
      ts: fetchedAt,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'tencent',
    };
  }
  async batchQuote(codes: readonly string[]) {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  async fetchDailyBars() {
    return [];
  }
}

class StubFinal {
  readonly name = 'stub-final';
  callCount = 0;
  async fetchQuote(code: string) {
    this.callCount += 1;
    const fetchedAt = new Date();
    return {
      stockId: code,
      observedAt: fetchedAt,
      fetchedAt,
      timestampSource: 'retrieval' as const,
      ts: fetchedAt,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'mock',
    };
  }
  async batchQuote(codes: readonly string[]) {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  async fetchDailyBars() {
    return [];
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('market/manager', () => {
  describe('fetchQuote 主路径', () => {
    it('primary 成功 → cache 命中后不再调 primary', async () => {
      const primary = new StubPrimary();
      const fallback = new StubFallback();
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const q1 = await mgr.fetchQuote('A');
      expect(q1.source).toBe('eastmoney');
      expect(primary.callCount).toBe(1);
      const q2 = await mgr.fetchQuote('A');
      expect(q2.source).toBe('eastmoney');
      expect(primary.callCount).toBe(1); // 命中缓存，未再调
      const stats = mgr.stats();
      expect(stats.cache.quote.hits).toBe(1);
      expect(stats.cache.quote.misses).toBe(1);
    });

    it('primary 失败 → 自动 fallback；fallback 成功', async () => {
      const primary = new StubPrimary();
      primary.failMode = 'throw';
      const fallback = new StubFallback();
      fallback.failMode = 'ok';
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const q = await mgr.fetchQuote('A');
      expect(q.source).toBe('tencent');
      expect(primary.callCount).toBe(1);
      expect(fallback.callCount).toBe(1);
      expect(final.callCount).toBe(0);
    });

    it('primary + fallback 都失败 → 走 finalFallback (mock)', async () => {
      const primary = new StubPrimary();
      primary.failMode = 'throw';
      const fallback = new StubFallback();
      fallback.failMode = 'throw';
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const q = await mgr.fetchQuote('A');
      expect(q.source).toBe('mock');
      expect(final.callCount).toBe(1);
      expect(mgr.stats().finalFallbackCalls).toBe(1);
    });

    it('finalFallback 抑制窗口：失败后 30 分钟内同一只股票直接走 mock，其它股票不受影响', async () => {
      const primary = new StubPrimary();
      primary.failMode = 'throw';
      const fallback = new StubFallback();
      fallback.failMode = 'throw';
      const final = new StubFinal();
      let nowMs = 0;
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
        clock: () => new Date(nowMs),
        // TTL=0 让缓存立即过期，逐次穿透到降级链
        quoteCache: new QuoteCache(1024, 0),
        finalFallbackSuppressMs: 30 * 60 * 1000,
      });
      // 第一次：t=0
      await mgr.fetchQuote('A');
      expect(primary.callCount).toBe(1);
      expect(fallback.callCount).toBe(1);
      expect(final.callCount).toBe(1);
      // 第二次：t=10 分钟（A 仍在抑制窗口）→ A 直达 mock
      nowMs = 10 * 60 * 1000;
      await mgr.fetchQuote('A');
      expect(primary.callCount).toBe(1); // 未自增
      expect(fallback.callCount).toBe(1); // 未自增
      expect(final.callCount).toBe(2);
      // 同一时刻的 B 不在 A 的窗口内：主备源照常尝试（抑制按股票隔离）
      await mgr.fetchQuote('B');
      expect(primary.callCount).toBe(2);
      expect(fallback.callCount).toBe(2);
      expect(final.callCount).toBe(3);
    });
  });

  describe('batchQuote', () => {
    it('部分命中缓存；其余并发 fetch', async () => {
      const primary = new StubPrimary();
      const fallback = new StubFallback();
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      // 预热 A 入缓存
      await mgr.fetchQuote('A');
      primary.callCount = 0;
      const result = await mgr.batchQuote(['A', 'B', 'C']);
      expect(result.size).toBe(3);
      // A 命中缓存；B、C 各调一次 primary
      expect(primary.callCount).toBe(2);
    });

    it('逐股 fallback 遵守 batchConcurrency 上限', async () => {
      let active = 0;
      let maxActive = 0;
      const primary = new StubPrimary();
      const fetchQuote = primary.fetchQuote.bind(primary);
      primary.fetchQuote = async (code: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await fetchQuote(code);
        } finally {
          active -= 1;
        }
      };
      const mgr = createTestMarketDataManager({
        primary,
        logger: silentLogger,
        batchConcurrency: 2,
      });

      await mgr.batchQuote(['A', 'B', 'C', 'D', 'E']);

      expect(maxActive).toBeLessThanOrEqual(2);
    });
  });

  describe('rate limiter', () => {
    it('limit=2 时 5 个并发 fetchQuote 触发等待；总耗时 ≥ 0（不严格验证 ms）', async () => {
      const primary = new StubPrimary();
      const fallback = new StubFallback();
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
        rateLimitPerSec: 2,
      });
      const start = Date.now();
      await Promise.all(['A', 'B', 'C', 'D', 'E'].map((c) => mgr.fetchQuote(c)));
      const elapsed = Date.now() - start;
      // 5 个请求，限速 2/s → 至少 2 秒（3 轮窗口）；给一点 buffer
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(primary.callCount).toBe(5);
    });
  });

  describe('stats', () => {
    it('输出 primary/fallback/final 调用计数 + 缓存命中率', async () => {
      const primary = new StubPrimary();
      primary.failMode = 'throw'; // 触发 fallback 路径
      const fallback = new StubFallback();
      fallback.failMode = 'throw'; // fallback 也失败 → finalFallback
      const final = new StubFinal();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      await mgr.fetchQuote('A');
      await mgr.fetchQuote('A'); // cache hit
      const stats = mgr.stats();
      expect(stats.primaryCalls).toBe(1);
      expect(stats.fallbackCalls).toBe(1);
      expect(stats.finalFallbackCalls).toBe(1);
      expect(stats.cache.quote.hits).toBe(1);
    });
  });

  describe('fetchIndexQuotes', () => {
    const indexQuote = (source: string) => ({
      code: '000001',
      name: '上证指数',
      close: money(3500),
      change: 12.3,
      changePct: 0.35,
      ts: new Date(),
      source,
    });

    const indexCapable = (name: string, failMode: 'ok' | 'throw') => ({
      name,
      callCount: 0,
      fetchQuote: () => Promise.reject(new Error('unused')),
      batchQuote: () => Promise.resolve(new Map()),
      fetchDailyBars: () => Promise.resolve([]),
      fetchIndexQuotes() {
        this.callCount += 1;
        if (failMode === 'throw') return Promise.reject(new Error(`${name} fail`));
        return Promise.resolve([indexQuote(name)]);
      },
    });

    it('primary 实现时直接用 primary，不触碰 fallback', async () => {
      const primary = indexCapable('stub-primary', 'ok');
      const fallback = indexCapable('stub-fallback', 'ok');
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        logger: silentLogger,
      });
      const indices = await mgr.fetchIndexQuotes();
      expect(indices[0]?.source).toBe('stub-primary');
      expect(primary.callCount).toBe(1);
      expect(fallback.callCount).toBe(0);
    });

    it('primary 失败 → 路由到 fallback；fallback 未实现则跳过', async () => {
      const primary = indexCapable('stub-primary', 'throw');
      const fallback = new StubFallback(); // 未实现 fetchIndexQuotes
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        logger: silentLogger,
      });
      await expect(mgr.fetchIndexQuotes()).rejects.toThrow('stub-primary fail');

      const primary2 = indexCapable('stub-primary', 'throw');
      const fallback2 = indexCapable('stub-fallback', 'ok');
      const mgr2 = createTestMarketDataManager({
        primary: primary2,
        fallback: fallback2,
        logger: silentLogger,
      });
      const indices = await mgr2.fetchIndexQuotes();
      expect(indices[0]?.source).toBe('stub-fallback');
    });

    it('所有源都未实现 → 明确抛错', async () => {
      const mgr = createTestMarketDataManager({
        primary: new StubPrimary(),
        fallback: new StubFallback(),
        logger: silentLogger,
      });
      await expect(mgr.fetchIndexQuotes()).rejects.toThrow(
        'unsupported_capability: realtime-index',
      );
    });

    it('显式第三 realtime source 可兜底；前序成功则不调用', async () => {
      const primary = indexCapable('stub-primary', 'throw');
      const additionalSource = indexCapable('explicit-index-source', 'ok');
      const mgr = createTestMarketDataManager({
        primary,
        fallback: new StubFallback(), // 未实现 fetchIndexQuotes
        additionalSource,
        logger: silentLogger,
      });
      const indices = await mgr.fetchIndexQuotes();
      expect(indices[0]?.source).toBe('explicit-index-source');
      expect(additionalSource.callCount).toBe(1);

      // 链上已成功：后续显式来源不被触碰
      const primary2 = indexCapable('stub-primary', 'ok');
      const additionalSource2 = indexCapable('explicit-index-source', 'ok');
      const mgr2 = createTestMarketDataManager({
        primary: primary2,
        fallback: new StubFallback(),
        additionalSource: additionalSource2,
        logger: silentLogger,
      });
      const indices2 = await mgr2.fetchIndexQuotes();
      expect(indices2[0]?.source).toBe('stub-primary');
      expect(additionalSource2.callCount).toBe(0);
    });

    it('显式第三 realtime source 也失败 → 抛最后错误', async () => {
      const mgr = createTestMarketDataManager({
        primary: indexCapable('stub-primary', 'throw'),
        fallback: new StubFallback(),
        additionalSource: indexCapable('explicit-index-source', 'throw'),
        logger: silentLogger,
      });
      await expect(mgr.fetchIndexQuotes()).rejects.toThrow('explicit-index-source fail');
    });
  });
});

describe('market/manager fetchMarketSnapshot', () => {
  const SNAPSHOT = [
    { id: '600519.SH', code: '600519', exchange: 'SH' as const, name: '贵州茅台', close: 1486.2 },
  ];

  class SnapshotSource {
    readonly name: string;
    callCount = 0;
    fail = false;
    constructor(name: string) {
      this.name = name;
    }
    async fetchQuote(): Promise<never> {
      throw new Error('unused');
    }
    async batchQuote() {
      return new Map();
    }
    async fetchDailyBars() {
      return [];
    }
    async fetchMarketSnapshot() {
      this.callCount += 1;
      if (this.fail) throw new Error('snapshot fail');
      return SNAPSHOT;
    }
  }

  it('primary 实现 → 用 primary；TTL 内第二次调用走缓存', async () => {
    const primary = new SnapshotSource('p');
    const fallback = new SnapshotSource('f');
    const mgr = createTestMarketDataManager({ primary, fallback, logger: silentLogger });
    const a = await mgr.fetchMarketSnapshot();
    expect(a).toEqual(SNAPSHOT);
    const b = await mgr.fetchMarketSnapshot();
    expect(b).toEqual(SNAPSHOT);
    expect(primary.callCount).toBe(1); // 第二次命中 TTL 缓存
    expect(fallback.callCount).toBe(0);
  });

  it('marketSnapshotTtlMs=0 → 不缓存，每次重新拉取', async () => {
    const primary = new SnapshotSource('p');
    const mgr = createTestMarketDataManager({
      primary,
      fallback: new SnapshotSource('f'),
      logger: silentLogger,
      marketSnapshotTtlMs: 0,
    });
    await mgr.fetchMarketSnapshot();
    await mgr.fetchMarketSnapshot();
    expect(primary.callCount).toBe(2);
  });

  it('primary 未实现该方法 → 路由到 fallback', async () => {
    const primary = new StubPrimary();
    const fallback = new SnapshotSource('f');
    const mgr = createTestMarketDataManager({ primary, fallback, logger: silentLogger });
    const items = await mgr.fetchMarketSnapshot();
    expect(items).toEqual(SNAPSHOT);
    expect(fallback.callCount).toBe(1);
  });

  it('primary 抛错 → fallback 兜底', async () => {
    const primary = new SnapshotSource('p');
    primary.fail = true;
    const fallback = new SnapshotSource('f');
    const mgr = createTestMarketDataManager({ primary, fallback, logger: silentLogger });
    const items = await mgr.fetchMarketSnapshot();
    expect(items).toEqual(SNAPSHOT);
    expect(fallback.callCount).toBe(1);
  });

  it('没有任何源实现 → 明确抛错（调用方降级本地股票库）', async () => {
    const mgr = createTestMarketDataManager({
      primary: new StubPrimary(),
      fallback: new StubFallback(),
      logger: silentLogger,
    });
    await expect(mgr.fetchMarketSnapshot()).rejects.toThrow(
      'unsupported_capability: market-snapshot',
    );
  });
});

// 显式 import 以确保 type-only 引用被 vite 保留（避免误删 unused import 警告）
export type {
  EastmoneyAdapter,
  EastmoneyAdapterError,
  FakeMarketAdapter,
  TencentAdapter,
  TencentAdapterError,
};
