import type { DailyBar, DateRange, MarketDataAdapterLike, Money, Quote } from '@luoome/core';
import { money } from '@luoome/core';

/**
 * 测试用可配置行情 adapter（v0.6 起，intraday-watch cost-threshold 单测专用）。
 *
 * 设计：每个 stockId → fixed close（测试断言期望值），其它字段用 close 推导。
 * 返回价格完全由测试调用方指定。
 */
export interface FixedQuoteMap {
  readonly [stockId: string]: Money | number;
}

export interface FixedQuoteAdapterOptions {
  readonly quotes: FixedQuoteMap;
  readonly clock?: () => Date;
  readonly source?: string;
}

export class FixedQuoteAdapter implements MarketDataAdapterLike {
  readonly name = 'fixed-quote-test';

  private readonly clock: () => Date;
  private readonly source: string;
  private readonly quotes: FixedQuoteMap;

  constructor(options: FixedQuoteAdapterOptions) {
    this.clock = options.clock ?? ((): Date => new Date('2026-07-21T02:30:00.000Z'));
    this.source = options.source ?? 'fixed-quote-test';
    this.quotes = options.quotes;
  }

  fetchQuote(stockCode: string): Promise<Quote> {
    const raw = this.quotes[stockCode];
    if (raw === undefined) {
      throw new Error(`FixedQuoteAdapter: 未配置 stockCode=${stockCode} 的价格`);
    }
    const close = money(Number(raw));
    return Promise.resolve({
      stockId: stockCode,
      ts: this.clock(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000_000,
      source: this.source,
    });
  }

  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const code of stockCodes) {
      const raw = this.quotes[code];
      if (raw === undefined) continue; // 缺失的 stock 让 batch_quote 走 unresolved 路径
      const q = await this.fetchQuote(code);
      out.set(code, q);
    }
    return out;
  }

  // cost-threshold 不需要日线；返回空数组避免误用。
  fetchDailyBars(_stockCode: string, _range: DateRange): Promise<DailyBar[]> {
    return Promise.resolve([]);
  }
}

/** 把 ctx 的 market adapter 替换为 FixedQuoteAdapter，返回新 ctx（不修改原 ctx）。 */
export const withFixedQuoteAdapter = <T extends { adapters: { market: MarketDataAdapterLike } }>(
  ctx: T,
  quotes: FixedQuoteMap,
): T => ({
  ...ctx,
  adapters: { ...ctx.adapters, market: new FixedQuoteAdapter({ quotes }) },
});
