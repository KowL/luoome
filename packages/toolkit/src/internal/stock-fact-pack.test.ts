import { FakeMarketAdapter } from '@luoome/adapters/testing';
import {
  type DailyBar,
  type DateRange,
  type IndexQuote,
  type LLMAdapterLike,
  money,
  type Quote,
  stockCode,
  type ToolContext,
  type ToolContextMarketIntel,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../../../db/src/client.js';
import { getStockFactsTool } from '../tools/get-stock-facts.js';
import { buildStockFactPack, type StockFactPack } from './stock-facts.js';

const NOW = new Date('2026-11-24T07:30:00.000Z');
const DAY_MS = 86_400_000;
const STOCK_ID = '600519.SH';

class TestMarket extends FakeMarketAdapter {
  barsCount: number;

  constructor(options: { barsCount?: number; quoteClose?: number; source?: string } = {}) {
    super({ clock: () => NOW, source: options.source ?? 'test' });
    this.barsCount = options.barsCount ?? 120;
    this.quoteClose = options.quoteClose ?? 100;
  }

  quoteClose: number;

  override fetchQuote(stockCodeValue: string): Promise<Quote> {
    const close = money(this.quoteClose);
    return Promise.resolve({
      stockId: stockCodeValue,
      observedAt: NOW,
      fetchedAt: NOW,
      timestampSource: 'retrieval',
      ts: NOW,
      open: money(this.quoteClose - 1),
      high: money(this.quoteClose + 1),
      low: money(this.quoteClose - 2),
      close,
      volume: 1_000_000,
      prevClose: money(this.quoteClose - 2),
      source: 'test',
    });
  }

  override fetchDailyBars(stockCodeValue: string, range: DateRange): Promise<DailyBar[]> {
    const bars: DailyBar[] = [];
    for (let back = this.barsCount - 1; back >= 0; back -= 1) {
      const date = new Date(range.end.getTime() - back * DAY_MS);
      const index = this.barsCount - 1 - back;
      const close = money(100 + Math.sin(index / 7) * 5 + (index % 5) * 0.1);
      bars.push({
        stockId: stockCodeValue,
        date,
        open: money(close - 0.2),
        high: money(close + 0.5),
        low: money(close - 0.5),
        close,
        volume: 500_000 + index * 1_000,
        adjustment: 'qfq',
        source: 'test',
      });
    }
    return Promise.resolve(bars);
  }

  override fetchIntradayMinutes = (() =>
    Promise.resolve([
      {
        stockId: STOCK_ID,
        time: new Date(NOW.getTime() - 3_600_000),
        price: money(99.5),
        cumVolume: 100_000,
        source: 'test',
      },
      {
        stockId: STOCK_ID,
        time: NOW,
        price: money(100),
        cumVolume: 200_000,
        source: 'test',
      },
    ])) as unknown as FakeMarketAdapter['fetchIntradayMinutes'];

  override fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    return Promise.resolve([
      {
        code: '000001.SH',
        name: '上证指数',
        close: money(3000),
        change: 10,
        changePct: 0.0033,
        ts: NOW,
        source: 'test',
      },
    ]);
  }
}

class MissingQuoteMarket extends TestMarket {
  override fetchQuote(stockCodeValue: string): Promise<Quote> {
    return Promise.reject(new Error(`quote 502: ${stockCodeValue}`));
  }

  override batchQuote(): Promise<Map<string, Quote>> {
    return Promise.reject(new Error('quote 502'));
  }
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const makeContext = async (
  market: TestMarket,
  marketIntel?: ToolContextMarketIntel,
): Promise<{ ctx: ToolContext; close: () => void }> => {
  const handle = createDrizzleRepos(':memory:');
  await handle.repos.stock.save({
    id: STOCK_ID,
    code: stockCode('600519'),
    exchange: 'SH',
    name: '贵州茅台',
  });
  const ctx = {
    repos: handle.repos,
    adapters: {
      market,
      llm: {} as LLMAdapterLike,
      ...(marketIntel === undefined ? {} : { marketIntel }),
    },
    user: { id: 'test-user', defaultAccountId: '' },
    clock: () => NOW,
    logger: silentLogger,
  } as unknown as ToolContext;
  return { ctx, close: () => handle.close() };
};

const okSection = <K extends keyof Omit<StockFactPack, 'stock' | 'factDigest'>>(
  pack: StockFactPack,
  section: K,
): Extract<NonNullable<StockFactPack[K]>, { status: 'ok' }> => {
  const value = pack[section];
  expect(value?.status).toBe('ok');
  if (value?.status !== 'ok') throw new Error(`${section} unavailable: ${value?.reason}`);
  return value as Extract<NonNullable<StockFactPack[K]>, { status: 'ok' }>;
};

describe('buildStockFactPack', () => {
  it('returns dataAsOf and source for every ok section', async () => {
    const { ctx, close } = await makeContext(new TestMarket());
    try {
      const pack = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(pack).not.toBeNull();
      if (pack === null) return;

      for (const section of [
        'quote',
        'bars',
        'indicators',
        'intraday',
        'signals',
        'market',
      ] as const) {
        const fact = okSection(pack, section);
        expect(fact.dataAsOf).toBeInstanceOf(Date);
        expect(fact.source.length).toBeGreaterThan(0);
      }
      expect(pack.bars?.status).toBe('ok');
    } finally {
      close();
    }
  });

  it('produces a stable digest and changes it when a price or a bar changes', async () => {
    const market = new TestMarket();
    const { ctx, close } = await makeContext(market);
    try {
      const first = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      const second = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(first?.factDigest).toBe(second?.factDigest);

      market.quoteClose = 101;
      const priced = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(priced?.factDigest).not.toBe(first?.factDigest);

      market.barsCount = 119;
      const shorter = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(shorter?.factDigest).not.toBe(priced?.factDigest);
    } finally {
      close();
    }
  });

  it('degrades quote, sector 502, missing fuyao and account without throwing', async () => {
    const quoteContext = await makeContext(new MissingQuoteMarket());
    try {
      const pack = await buildStockFactPack(quoteContext.ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(pack?.quote?.status).toBe('unavailable');
      if (pack?.quote?.status === 'unavailable') {
        expect(pack.quote.reason.length).toBeGreaterThan(0);
      }
    } finally {
      quoteContext.close();
    }

    const marketIntel: ToolContextMarketIntel = {
      sectorQuote: {
        name: 'sector-quote',
        sources: ['eastmoney'],
        fetchList: async () => ({
          ok: false,
          error: {
            kind: 'adapter_error',
            adapter: 'sector-quote',
            message: 'eastmoney 502',
            recoverable: true,
          },
        }),
        status: () => [],
      },
    };
    const degraded = await makeContext(new TestMarket(), marketIntel);
    try {
      const pack = await buildStockFactPack(degraded.ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(pack?.sectorQuote?.status).toBe('unavailable');
      if (pack?.sectorQuote?.status === 'unavailable') {
        expect(pack.sectorQuote.reason).toContain('502');
      }
      expect(pack?.sectors?.status).toBe('unavailable');
      if (pack?.sectors?.status === 'unavailable') {
        expect(pack.sectors.reason).toContain('fuyao');
      }
      expect(pack?.account?.status).toBe('unavailable');
      if (pack?.account?.status === 'unavailable') {
        expect(pack.account.reason).toContain('账户');
      }
    } finally {
      degraded.close();
    }
  });

  it('gates MACD / MA60 / crossing fields at 26 bars and restores them at 120', async () => {
    const market = new TestMarket({ barsCount: 26 });
    const { ctx, close } = await makeContext(market);
    try {
      const shortPack = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      expect(shortPack?.bars?.status).toBe('ok');
      if (shortPack?.bars?.status === 'ok') {
        expect(shortPack.bars.data.requiredCount).toBe(120);
        expect(shortPack.bars.data.actualCount).toBe(26);
      }
      const shortIndicators = okSection(shortPack as StockFactPack, 'indicators');
      expect(shortIndicators.data.values.macdHist).toBeUndefined();
      expect(shortIndicators.data.values.macdDif).toBeUndefined();
      expect(shortIndicators.data.values.macdDea).toBeUndefined();
      expect(shortIndicators.data.values.ma60).toBeUndefined();
      expect(shortIndicators.data.values.daysSinceMa20CrossUp).toBeUndefined();
      expect(shortIndicators.data.actualCount).toBe(26);

      market.barsCount = 120;
      const fullPack = await buildStockFactPack(ctx, { stockId: STOCK_ID, asOf: NOW });
      const fullIndicators = okSection(fullPack as StockFactPack, 'indicators');
      expect(fullIndicators.data.values.macdHist).toBeTypeOf('number');
      expect(fullIndicators.data.values.ma60).toBeTypeOf('number');
      expect(fullIndicators.data.values.daysSinceMa20CrossUp).toBeTypeOf('number');
      expect(fullPack?.factDigest).not.toBe(shortPack?.factDigest);
    } finally {
      close();
    }
  });

  it('exposes a Zod-derived tool schema and compliant wording', () => {
    expect(getStockFactsTool.sideEffect).toBe('external');
    expect(getStockFactsTool.inputSchema.safeParse({ stockId: STOCK_ID }).success).toBe(true);
    expect(getStockFactsTool.inputSchema.safeParse({ stockId: '' }).success).toBe(false);
    expect(getStockFactsTool.description).toContain('仅技术研究，不构成投资建议');
    for (const banned of ['建议买入', '建议卖出', '建仓', '加仓', '减仓', '清仓']) {
      expect(getStockFactsTool.description).not.toContain(banned);
    }
  });
});
