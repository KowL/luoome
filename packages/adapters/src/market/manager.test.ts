import type { Logger } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import type { EastmoneyAdapter, EastmoneyAdapterError } from './eastmoney.js';
import { MarketDataManager } from './manager.js';
import type { MockMarketAdapter } from './mock.js';
import type { TencentAdapter, TencentAdapterError } from './tencent.js';

// ---- 三个测试 adapter ----

class StubPrimary {
  readonly name = 'stub-primary';
  callCount = 0;
  failMode: 'ok' | 'throw' = 'ok';
  async fetchQuote(code: string) {
    this.callCount += 1;
    if (this.failMode === 'throw') throw new Error('primary fail');
    return {
      stockId: code,
      ts: new Date(),
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
    return {
      stockId: code,
      ts: new Date(),
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
    return {
      stockId: code,
      ts: new Date(),
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
      const mgr = new MarketDataManager({
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
      const mgr = new MarketDataManager({
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
      const mgr = new MarketDataManager({
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

    it('finalFallback 抑制窗口：第一次失败后 30 分钟内直接走 mock', async () => {
      const primary = new StubPrimary();
      primary.failMode = 'throw';
      const fallback = new StubFallback();
      fallback.failMode = 'throw';
      const final = new StubFinal();
      let nowMs = 0;
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
        clock: () => new Date(nowMs),
        finalFallbackSuppressMs: 30 * 60 * 1000,
      });
      // 第一次：t=0
      await mgr.fetchQuote('A');
      expect(primary.callCount).toBe(1);
      expect(fallback.callCount).toBe(1);
      expect(final.callCount).toBe(1);
      // 第二次：t=10 分钟（仍在抑制窗口）
      nowMs = 10 * 60 * 1000;
      await mgr.fetchQuote('B');
      expect(primary.callCount).toBe(1); // 未自增
      expect(fallback.callCount).toBe(1); // 未自增
      expect(final.callCount).toBe(2);
    });
  });

  describe('batchQuote', () => {
    it('部分命中缓存；其余并发 fetch', async () => {
      const primary = new StubPrimary();
      const fallback = new StubFallback();
      const final = new StubFinal();
      const mgr = new MarketDataManager({
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
  });

  describe('rate limiter', () => {
    it('limit=2 时 5 个并发 fetchQuote 触发等待；总耗时 ≥ 0（不严格验证 ms）', async () => {
      const primary = new StubPrimary();
      const fallback = new StubFallback();
      const final = new StubFinal();
      const mgr = new MarketDataManager({
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
      const mgr = new MarketDataManager({
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
});

// 显式 import 以确保 type-only 引用被 vite 保留（避免误删 unused import 警告）
export type {
  EastmoneyAdapter,
  EastmoneyAdapterError,
  MockMarketAdapter,
  TencentAdapter,
  TencentAdapterError,
};
