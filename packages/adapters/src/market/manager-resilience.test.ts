import type { DailyBar, DateRange, Logger } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { MarketDataManager } from './manager.js';

/**
 * 真实行情链路容错深度测试（v0.6.2 起，docs/intraday-watch-design.md §'后续工作'）：
 * - batchQuote 部分失败（primary 局部抛错 → fallback 仅拉失败的那部分）
 * - fetchDailyBars primary/fallback/finalFallback 全路径
 * - 自定义 finalFallbackSuppressMs 行为
 *
 * 使用本地 stub（不需要 eastmoney.ts / tencent.ts 的具体实现），验证 manager
 * 自身的 fallback 编排。
 */

class ResilPrimary {
  readonly name = 'resil-primary';
  callCount = 0;
  /** 设置后，对该 stockId 抛错；其它走 ok 路径。 */
  failCodes: ReadonlySet<string> = new Set();
  async fetchQuote(code: string) {
    this.callCount += 1;
    if (this.failCodes.has(code)) throw new Error(`primary fail ${code}`);
    return {
      stockId: code,
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'eastmoney-stub',
    };
  }
  async batchQuote(codes: readonly string[]): Promise<Map<string, import('@luoome/core').Quote>> {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  fetchDailyBarsCalls = 0;
  failDailyBars = false;
  async fetchDailyBars(_code: string, range: DateRange): Promise<DailyBar[]> {
    this.fetchDailyBarsCalls += 1;
    if (this.failDailyBars) throw new Error('primary dailyBars fail');
    return [
      {
        stockId: '600519.SH',
        date: new Date('2026-07-20T00:00:00.000Z'),
        open: money(95),
        high: money(96),
        low: money(94),
        close: money(95),
        volume: 1000,
        adjFactor: 1,
      },
    ].filter((b) => b.date >= range.start && b.date <= range.end);
  }
}

class ResilFallback {
  readonly name = 'resil-fallback';
  callCount = 0;
  failDailyBars = false;
  async fetchQuote(code: string) {
    this.callCount += 1;
    return {
      stockId: code,
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'tencent-stub',
    };
  }
  async batchQuote(codes: readonly string[]): Promise<Map<string, import('@luoome/core').Quote>> {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  fetchDailyBarsCalls = 0;
  async fetchDailyBars(_code: string, range: DateRange): Promise<DailyBar[]> {
    this.fetchDailyBarsCalls += 1;
    if (this.failDailyBars) throw new Error('fallback dailyBars fail');
    return [
      {
        stockId: '600519.SH',
        date: new Date('2026-07-20T00:00:00.000Z'),
        open: money(94),
        high: money(95),
        low: money(93),
        close: money(94),
        volume: 999,
        adjFactor: 1,
      },
    ].filter((b) => b.date >= range.start && b.date <= range.end);
  }
}

class ResilFinal {
  readonly name = 'resil-final';
  callCount = 0;
  async fetchQuote(code: string) {
    this.callCount += 1;
    return {
      stockId: code,
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'mock-stub',
    };
  }
  async batchQuote(codes: readonly string[]): Promise<Map<string, import('@luoome/core').Quote>> {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  async fetchDailyBars(_code: string, _range: DateRange): Promise<DailyBar[]> {
    this.callCount += 1;
    return [
      {
        stockId: '600519.SH',
        date: new Date('2026-07-20T00:00:00.000Z'),
        open: money(93),
        high: money(94),
        low: money(92),
        close: money(93),
        volume: 888,
        adjFactor: 1,
      },
    ];
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const range: DateRange = {
  start: new Date('2026-07-19T00:00:00.000Z'),
  end: new Date('2026-07-21T00:00:00.000Z'),
};

describe('market/manager 真实行情链路容错（v0.6.2）', () => {
  describe('batchQuote 部分失败', () => {
    it('未配置最终兜底且所有实时源失败时，返回空结果而不是让持仓列表崩溃', async () => {
      const primary = new ResilPrimary();
      primary.failCodes = new Set(['A']);
      const fallback = new ResilFallback();
      fallback.fetchQuote = async () => {
        throw new Error('fallback fail A');
      };
      const mgr = new MarketDataManager({
        primary,
        fallback,
        logger: silentLogger,
      });

      await expect(mgr.batchQuote(['A'])).resolves.toEqual(new Map());
    });

    it('primary 对 A 抛错、B 抛错；C/D OK：fallback 仅补 A/B，其它来自 primary', async () => {
      const primary = new ResilPrimary();
      primary.failCodes = new Set(['A', 'B']);
      const fallback = new ResilFallback();
      const final = new ResilFinal();
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const result = await mgr.batchQuote(['A', 'B', 'C', 'D']);
      // 4 个 stockId 都返回
      expect(result.size).toBe(4);
      // primary 调用 4 次（A/B 各 throw 一次进 fallback，C/D 成功；计数仍 +1 因为 callCount 不区分 ok/throw）
      expect(primary.callCount).toBe(4);
      // A 和 B 走 fallback（被 catch 后单独 fetchQuote 一次）
      expect(fallback.callCount).toBe(2);
      // final 不应被调（primary + fallback 都成功覆盖 4 个 stock）
      expect(final.callCount).toBe(0);
      // source 检查
      expect(result.get('A')?.source).toBe('tencent-stub');
      expect(result.get('B')?.source).toBe('tencent-stub');
      expect(result.get('C')?.source).toBe('eastmoney-stub');
      expect(result.get('D')?.source).toBe('eastmoney-stub');
    });

    it('A 全部失败（primary+fallback 都 throw）→ finalFallback 兜底；其它 ok', async () => {
      const primary = new ResilPrimary();
      primary.failCodes = new Set(['A', 'B', 'C', 'D']);
      const fallback = new ResilFallback();
      // 让 fallback 也 throw（覆盖所有）
      fallback.failDailyBars = false; // 不影响 fetchQuote
      fallback.callCount = 0;
      const stubFetchQuote = fallback.fetchQuote.bind(fallback);
      fallback.fetchQuote = async (code: string) => {
        if (code === 'A') throw new Error('fallback fail A');
        return stubFetchQuote(code);
      };
      const final = new ResilFinal();
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const result = await mgr.batchQuote(['A', 'B']);
      // A 走 finalFallback；B 走 fallback OK
      expect(result.size).toBe(2);
      expect(result.get('A')?.source).toBe('mock-stub');
      expect(result.get('B')?.source).toBe('tencent-stub');
      expect(final.callCount).toBe(1);
    });
  });

  describe('fetchDailyBars fallback 链', () => {
    it('primary OK → 返回 primary 数据；fallback / final 不被调', async () => {
      const primary = new ResilPrimary();
      const fallback = new ResilFallback();
      const final = new ResilFinal();
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const bars = await mgr.fetchDailyBars('600519.SH', range);
      expect(bars).toHaveLength(1);
      expect(bars[0]?.close).toBe(95); // primary 数据
      expect(primary.fetchDailyBarsCalls).toBe(1);
      expect(fallback.fetchDailyBarsCalls).toBe(0);
      expect(final.callCount).toBe(0);
    });

    it('primary 抛错 → fallback 拿数据；primary 计数 +1、fallback 计数 +1', async () => {
      const primary = new ResilPrimary();
      primary.failDailyBars = true;
      const fallback = new ResilFallback();
      const final = new ResilFinal();
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const bars = await mgr.fetchDailyBars('600519.SH', range);
      // fallback close=94, primary 抛错 → 应返回 fallback 数据
      expect(bars[0]?.close).toBe(94);
      expect(primary.fetchDailyBarsCalls).toBe(1);
      expect(fallback.fetchDailyBarsCalls).toBe(1);
      expect(final.callCount).toBe(0);
    });

    it('primary + fallback 都抛 → finalFallback（mock）', async () => {
      const primary = new ResilPrimary();
      primary.failDailyBars = true;
      const fallback = new ResilFallback();
      fallback.failDailyBars = true;
      const final = new ResilFinal();
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });
      const bars = await mgr.fetchDailyBars('600519.SH', range);
      expect(bars[0]?.close).toBe(93); // mock 数据
      expect(final.callCount).toBe(1);
      // 注：primaryFailures / fallbackFailures 仅在 fetchQuote 路径里 increment
      // （manager.ts 实现如此），fetchDailyBars 失败不计入这俩计数。
      expect(mgr.stats().finalFallbackCalls).toBe(1);
    });

    it('suppress 窗口：第一次 fallback 也失败后，第二次 fetchDailyBars 不再尝试 primary/fallback', async () => {
      const primary = new ResilPrimary();
      primary.failDailyBars = true;
      const fallback = new ResilFallback();
      fallback.failDailyBars = true;
      const final = new ResilFinal();
      let nowMs = 0;
      const mgr = new MarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
        clock: () => new Date(nowMs),
        finalFallbackSuppressMs: 30 * 60 * 1000,
      });
      // 第一次：t=0，走完三层
      await mgr.fetchDailyBars('600519.SH', range);
      expect(primary.fetchDailyBarsCalls).toBe(1);
      expect(fallback.fetchDailyBarsCalls).toBe(1);
      const afterFirst = final.callCount;
      // 第二次：t=10 分钟，suppress 窗口内
      nowMs = 10 * 60 * 1000;
      await mgr.fetchDailyBars('600519.SH', range);
      expect(primary.fetchDailyBarsCalls).toBe(1); // 未增
      expect(fallback.fetchDailyBarsCalls).toBe(1); // 未增
      expect(final.callCount).toBe(afterFirst + 1); // 直接 mock
    });
  });

  describe('createMarketAdapterFromEnv + manager 端到端', () => {
    // 这里复用真实 adapter 链路（Eastmoney → Tencent → Mock），通过 fetchImpl mock
    // fetch 响应。验证整条 CLI 接入边界。
    it('LUOOME_MARKET_PROVIDER=real + 注入 fetchImpl：primary 完整响应路径', async () => {
      const { createMarketAdapterFromEnv } = await import('./factory.js');
      const adapter = createMarketAdapterFromEnv(
        { LUOOME_MARKET_PROVIDER: 'real' },
        {
          logger: silentLogger,
          fetchImpl: (async () =>
            new Response(
              JSON.stringify({
                rc: 0,
                data: { f43: 100.5, f44: 101, f45: 99.5, f46: 100, f47: 12345, f60: 99.8 },
              }),
              { status: 200 },
            )) as never,
        },
      );
      expect(adapter.name).toBe('manager');
      const q = await adapter.fetchQuote('002594.SZ');
      expect(q.close).toBe(100.5);
      expect(q.source).toBe('eastmoney');
    });
  });
});
