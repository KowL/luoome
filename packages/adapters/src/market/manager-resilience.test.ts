import type { DailyBar, DateRange, Logger } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import type { FakeMarketAdapter } from '../testing/fake-market.js';
import { QuoteCache } from './cache.js';
import { createTestMarketDataManager } from './manager.test-helper.js';

/**
 * 真实行情链路容错深度测试（v0.6.2 起，docs/ddd/intraday-watch-design.md §'后续工作'）：
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
      observedAt: new Date('2026-07-21T02:30:00.000Z'),
      fetchedAt: new Date('2026-07-21T02:30:00.000Z'),
      timestampSource: 'retrieval' as const,
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
  emptyDailyBars = false;
  async fetchDailyBars(_code: string, range: DateRange): Promise<DailyBar[]> {
    this.fetchDailyBarsCalls += 1;
    if (this.failDailyBars) throw new Error('primary dailyBars fail');
    if (this.emptyDailyBars) return [];
    return [
      {
        stockId: '600519.SH',
        date: new Date('2026-07-20T00:00:00.000Z'),
        open: money(95),
        high: money(96),
        low: money(94),
        close: money(95),
        volume: 1000,
        adjustment: 'qfq' as const,
        source: 'resil-primary',
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
      observedAt: new Date('2026-07-21T02:30:00.000Z'),
      fetchedAt: new Date('2026-07-21T02:30:00.000Z'),
      timestampSource: 'retrieval' as const,
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
        adjustment: 'qfq' as const,
        source: 'resil-fallback',
      },
    ].filter((b) => b.date >= range.start && b.date <= range.end);
  }
}

class ResilFinal {
  readonly name = 'resil-final';
  callCount = 0;
  failDailyBars = false;
  async fetchQuote(code: string) {
    this.callCount += 1;
    return {
      stockId: code,
      observedAt: new Date('2026-07-21T02:30:00.000Z'),
      fetchedAt: new Date('2026-07-21T02:30:00.000Z'),
      timestampSource: 'retrieval' as const,
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
    if (this.failDailyBars) throw new Error('final dailyBars fail');
    return [
      {
        stockId: '600519.SH',
        date: new Date('2026-07-20T00:00:00.000Z'),
        open: money(93),
        high: money(94),
        low: money(92),
        close: money(93),
        volume: 888,
        adjustment: 'qfq',
        source: 'resil-final',
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
      const mgr = createTestMarketDataManager({
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
      const mgr = createTestMarketDataManager({
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
      const mgr = createTestMarketDataManager({
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
      const mgr = createTestMarketDataManager({
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
      const mgr = createTestMarketDataManager({
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

    it('交易日区间内 primary 返回空数组 → 视为 no_data 并 fallback', async () => {
      const primary = new ResilPrimary();
      primary.emptyDailyBars = true;
      const fallback = new ResilFallback();
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        logger: silentLogger,
      });

      const bars = await mgr.fetchDailyBars('600519.SH', range);

      expect(bars[0]?.source).toBe('resil-fallback');
      expect(primary.fetchDailyBarsCalls).toBe(1);
      expect(fallback.fetchDailyBarsCalls).toBe(1);
    });

    it('primary + fallback 都抛 → finalFallback（mock）', async () => {
      const primary = new ResilPrimary();
      primary.failDailyBars = true;
      const fallback = new ResilFallback();
      fallback.failDailyBars = true;
      const final = new ResilFinal();
      const mgr = createTestMarketDataManager({
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
      const mgr = createTestMarketDataManager({
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
      expect(final.callCount).toBe(afterFirst); // final 成功也进入统一缓存
    });

    it('final source 失败不建立 suppress，下一次仍完整尝试主备源', async () => {
      const primary = new ResilPrimary();
      primary.failDailyBars = true;
      const fallback = new ResilFallback();
      fallback.failDailyBars = true;
      const final = new ResilFinal();
      final.failDailyBars = true;
      const mgr = createTestMarketDataManager({
        primary,
        fallback,
        finalFallback: final,
        logger: silentLogger,
      });

      await expect(mgr.fetchDailyBars('600519.SH', range)).rejects.toThrow('final dailyBars fail');
      await expect(mgr.fetchDailyBars('600519.SH', range)).rejects.toThrow('final dailyBars fail');

      expect(primary.fetchDailyBarsCalls).toBe(2);
      expect(fallback.fetchDailyBarsCalls).toBe(2);
      expect(final.callCount).toBe(2);
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

/**
 * finalFallback（tushare 槽位）集成测试（docs/ddd/tushare-market-adapter-design.md §11.2）。
 * finalFallback 测试替身复用 FakeMarketAdapter（source: 'tushare'），不与真实 adapter 耦合；
 * tushare 私有协议由 tushare.test.ts 负责。
 */
class AlwaysFailSource {
  readonly name = 'always-fail';
  quoteCalls = 0;
  dailyBarsCalls = 0;
  searchCalls = 0;
  constructor(private readonly searchBehavior: 'throw' | 'empty' = 'throw') {}
  fetchQuote(_code: string): Promise<import('@luoome/core').Quote> {
    this.quoteCalls += 1;
    return Promise.reject(new Error(`${this.name} quote fail`));
  }
  async batchQuote(codes: readonly string[]): Promise<Map<string, import('@luoome/core').Quote>> {
    const m = new Map();
    for (const c of codes) m.set(c, await this.fetchQuote(c));
    return m;
  }
  fetchDailyBars(_code: string, _range: DateRange): Promise<DailyBar[]> {
    this.dailyBarsCalls += 1;
    return Promise.reject(new Error(`${this.name} dailyBars fail`));
  }
  searchStocks(_query: string): Promise<import('@luoome/core').StockSearchCandidate[]> {
    this.searchCalls += 1;
    if (this.searchBehavior === 'empty') return Promise.resolve([]);
    return Promise.reject(new Error(`${this.name} search fail`));
  }
}

describe('market/manager finalFallback（tushare 槽位，v0.9）', () => {
  const makeTushareFinal = async (): Promise<FakeMarketAdapter> => {
    const { FakeMarketAdapter } = await import('../testing/fake-market.js');
    return new FakeMarketAdapter({ source: 'tushare' });
  };

  it('Eastmoney + Tencent 都失败、tushare 成功 → 返回 source=tushare', async () => {
    const primary = new AlwaysFailSource();
    const fallback = new AlwaysFailSource();
    const mgr = createTestMarketDataManager({
      primary,
      fallback,
      finalFallback: await makeTushareFinal(),
      logger: silentLogger,
    });
    const q = await mgr.fetchQuote('600519.SH');
    expect(q.source).toBe('tushare');
    expect(mgr.stats().finalFallbackCalls).toBe(1);
  });

  it('Eastmoney + Tencent + tushare 全失败 → 抛错', async () => {
    const mgr = createTestMarketDataManager({
      primary: new AlwaysFailSource(),
      fallback: new AlwaysFailSource(),
      finalFallback: new AlwaysFailSource(),
      logger: silentLogger,
    });
    await expect(mgr.fetchQuote('600519.SH')).rejects.toThrow(/quote fail/);
  });

  it('进入 finalFallback 后 30 分钟内仅该股票跳过主备源（per-key 隔离），其它股票不受影响', async () => {
    const primary = new AlwaysFailSource();
    const fallback = new AlwaysFailSource();
    let nowMs = 0;
    const mgr = createTestMarketDataManager({
      primary,
      fallback,
      finalFallback: await makeTushareFinal(),
      logger: silentLogger,
      clock: () => new Date(nowMs),
      // TTL=0 让缓存立即过期，逐次穿透到降级链，便于观察主备源调用次数
      quoteCache: new QuoteCache(1024, 0),
      finalFallbackSuppressMs: 30 * 60 * 1000,
    });
    // 第一次：t=0，走完三层（tushare 成功）
    const first = await mgr.fetchQuote('600519.SH');
    expect(first.source).toBe('tushare');
    expect(primary.quoteCalls).toBe(1);
    expect(fallback.quoteCalls).toBe(1);
    // 第二次：t=10 分钟，同一只股票在抑制窗口内 → 直达第三源
    nowMs = 10 * 60 * 1000;
    const second = await mgr.fetchQuote('600519.SH');
    expect(second.source).toBe('tushare');
    expect(primary.quoteCalls).toBe(1); // 未增：窗口内跳过主备源
    expect(fallback.quoteCalls).toBe(1);
    // 同一时刻换一只股票：不在该股的窗口内，主备源照常尝试（不熔断全池）
    const third = await mgr.fetchQuote('000001.SZ');
    expect(third.source).toBe('tushare');
    expect(primary.quoteCalls).toBe(2);
    expect(fallback.quoteCalls).toBe(2);
    expect(mgr.stats().finalFallbackCalls).toBe(3); // 尝试次数，非成功次数
  });

  it('Eastmoney 成功时 finalFallbackCalls = 0', async () => {
    const primary = new ResilPrimary();
    const mgr = createTestMarketDataManager({
      primary,
      fallback: new ResilFallback(),
      finalFallback: await makeTushareFinal(),
      logger: silentLogger,
    });
    const q = await mgr.fetchQuote('600519.SH');
    expect(q.source).toBe('eastmoney-stub');
    expect(mgr.stats().finalFallbackCalls).toBe(0);
  });

  it('searchStocks 主源返回空数组 → 不触发 fallback 到 tushare', async () => {
    const primary = new AlwaysFailSource('empty');
    const fallback = new AlwaysFailSource();
    const mgr = createTestMarketDataManager({
      primary,
      fallback,
      finalFallback: await makeTushareFinal(),
      logger: silentLogger,
    });
    await expect(mgr.searchStocks('600519')).resolves.toEqual([]);
    expect(primary.searchCalls).toBe(1);
    expect(fallback.searchCalls).toBe(0);
    expect(mgr.stats().finalFallbackCalls).toBe(0);
  });

  it('searchStocks 主备源抛错 → 触发 fallback 到 tushare', async () => {
    const mgr = createTestMarketDataManager({
      primary: new AlwaysFailSource(),
      fallback: new AlwaysFailSource(),
      finalFallback: await makeTushareFinal(),
      logger: silentLogger,
    });
    const candidates = await mgr.searchStocks('600519');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.id === '600519.SH')).toBe(true);
    expect(mgr.stats().finalFallbackCalls).toBe(1);
  });
});
