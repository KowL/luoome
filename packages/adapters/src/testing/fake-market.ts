import {
  type DailyBar,
  type DateRange,
  type MarketSnapshotItem,
  type MarketSourceStatus,
  money,
  type Quote,
  type StockSearchCandidate,
} from '@luoome/core';
import type { MarketDataAdapter } from '../market/types.js';
import { fixedTestClock, hashString, mulberry32 } from './deterministic.js';
import { findTestStock, TEST_STOCK_BASE_PRICES, TEST_STOCKS } from './fixtures.js';

export interface FakeMarketAdapterOptions {
  /** 注入时钟：quote 的 ts 与日线端点都取自它；默认固定到 DEFAULT_TEST_NOW。 */
  readonly clock?: () => Date;
  /** quote.source 字段，默认 'test'。 */
  readonly source?: string;
}

const DAY_MS = 86_400_000;
const DAILY_BARS_COUNT = 60;

/**
 * FakeMarketAdapter（docs/archive/MVP-TASK.md §2.5 / ARCHITECTURE §4.7）。
 * 不接任何真实行情源，输出完全 deterministic：
 * - 已知 fixture 股票：以 TEST_STOCK_BASE_PRICES 为基准生成固定 OHLC + 量；
 * - 未知代码：hash 代码生成稳定伪随机行情，多次调用结果一致；
 * - fetchDailyBars 固定生成 60 根 deterministic 日线（以 range.end 向前推）。
 */
export class FakeMarketAdapter implements MarketDataAdapter {
  readonly name = 'fake-market';

  private readonly clock: () => Date;
  private readonly source: string;

  constructor(options: FakeMarketAdapterOptions = {}) {
    this.clock = options.clock ?? fixedTestClock;
    this.source = options.source ?? 'test';
  }

  fetchQuote(stockCode: string): Promise<Quote> {
    const stock = findTestStock(stockCode);
    const base = this.basePriceFor(stockCode);
    const rand = mulberry32(hashString(`quote|${stockCode}`));

    const close = money(base);
    const open = money(base * (0.99 + rand() * 0.02));
    const high = money(Math.max(open, close) * (1.005 + rand() * 0.005));
    const low = money(Math.min(open, close) * (0.99 + rand() * 0.005));
    const volume = 1_000_000 + (hashString(`volume|${stockCode}`) % 9_000_000);

    const fetchedAt = this.clock();
    return Promise.resolve({
      stockId: stock ? stock.id : stockCode,
      observedAt: fetchedAt,
      fetchedAt,
      timestampSource: 'retrieval',
      ts: fetchedAt,
      open,
      high,
      low,
      close,
      volume,
      prevClose: money(base), // deterministic 昨收：与基准价一致（涨幅≈0）
      source: this.source,
    });
  }

  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    for (const code of stockCodes) {
      result.set(code, await this.fetchQuote(code));
    }
    return result;
  }

  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const stock = findTestStock(stockCode);
    const stockId = stock ? stock.id : stockCode;
    const base = this.basePriceFor(stockCode);
    const endMs = range.end.getTime();

    const bars: DailyBar[] = [];
    for (let back = DAILY_BARS_COUNT - 1; back >= 0; back--) {
      const date = new Date(endMs - back * DAY_MS);
      const dayKey = date.toISOString().slice(0, 10);
      const rand = mulberry32(hashString(`bar|${stockId}|${dayKey}`));

      // 正弦漂移 + 伪随机噪声：形状自然且完全 deterministic。
      const drift = Math.sin((DAILY_BARS_COUNT - 1 - back) / 7) * 0.08;
      const close = money(base * (1 + drift) * (0.98 + rand() * 0.04));
      const open = money(close * (0.99 + rand() * 0.02));
      const high = money(Math.max(open, close) * 1.005);
      const low = money(Math.min(open, close) * 0.995);
      const volume = 500_000 + Math.floor(rand() * 5_000_000);

      bars.push({
        stockId,
        date,
        open,
        high,
        low,
        close,
        volume,
        adjustment: 'qfq',
        source: this.source,
      });
    }
    return Promise.resolve(bars);
  }

  /**
   * 测试搜索（v0.8 起）：在 fixtures 里按 id / code / name 模糊匹配，
   * 与 StockRepository.search 同语义、完全 deterministic（真实源全挂时的兜底）。
   */
  searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return Promise.resolve([]);
    const result = TEST_STOCKS.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q),
    ).map((s) => ({ id: s.id, code: s.code, exchange: s.exchange, name: s.name }));
    return Promise.resolve(result);
  }

  /**
   * 全市场快照（测试投影）：返回 TEST_STOCKS 全集（与种子 stocks 一致，
   * 保证走快照路径与走本地库降级的测试行为相同），close 取基准价。
   */
  fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return Promise.resolve(
      TEST_STOCKS.map((s) => ({
        id: s.id,
        code: s.code,
        exchange: s.exchange,
        name: s.name,
        close: this.basePriceFor(s.id),
      })),
    );
  }

  fetchIndexQuotes(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: realtime-index'));
  }

  marketSourceStatus(): readonly MarketSourceStatus[] {
    const coverage = ['CN_A_SHARES_SH_SZ'] as const;
    return (['quote', 'daily-bars', 'search', 'market-snapshot'] as const).map((dataset) => ({
      dataset,
      source: this.source,
      coverage,
      capabilityEnabled: true,
      configurationReady: true,
    }));
  }

  /** 已知 fixture 取基准价；未知代码 hash 出 [5, 500) 的稳定伪随机价。 */
  private basePriceFor(stockCode: string): number {
    const stock = findTestStock(stockCode);
    if (stock) {
      const price = TEST_STOCK_BASE_PRICES[stock.id];
      if (price !== undefined) return price;
    }
    return 5 + (hashString(`base|${stockCode}`) % 49_500) / 100;
  }
}
