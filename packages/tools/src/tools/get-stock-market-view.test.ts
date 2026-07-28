import type { DailyBar, DateRange, MarketDataAdapterLike, Quote, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStockMarketViewTool } from './get-stock-market-view.js';

/**
 * tool/get_stock_market_view（docs/ddd/stock-market-view-detailed-design.md §14.2）。
 * ctx 用 buildTestContext（in-memory repos），market adapter 换成本地可控 stub。
 */

const DAY_MS = 86_400_000;
// 2026-07-21 周二 10:30 Asia/Shanghai → trading 时段。
const NOW = new Date('2026-07-21T02:30:00.000Z');
const TODAY = '2026-07-21';
const YESTERDAY = '2026-07-20';
const STOCK_ID = '002594.SZ';

const makeQuote = (stockId: string, ts: Date, overrides: Partial<Quote> = {}): Quote => ({
  stockId,
  observedAt: ts,
  fetchedAt: ts,
  timestampSource: 'retrieval',
  ts,
  open: money(104),
  high: money(107),
  low: money(103),
  close: money(106),
  volume: 2_000_000,
  source: 'eastmoney',
  ...overrides,
});

const makeBar = (
  stockId: string,
  date: string,
  close: number,
  overrides: Partial<DailyBar> = {},
): DailyBar => ({
  stockId,
  date: new Date(`${date}T00:00:00.000Z`),
  open: money(close - 0.5),
  high: money(close + 1),
  low: money(close - 1),
  close: money(close),
  volume: 1_000_000,
  adjustment: 'qfq',
  source: 'eastmoney',
  ...overrides,
});

/** 连续自然日 bars，endDate 收尾（含），close 逐日 +0.1。 */
const makeBars = (
  stockId: string,
  endDate: string,
  count: number,
  opts: { source?: string; startClose?: number } = {},
): DailyBar[] => {
  const endMs = new Date(`${endDate}T00:00:00.000Z`).getTime();
  const bars: DailyBar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(endMs - i * DAY_MS).toISOString().slice(0, 10);
    const close = (opts.startClose ?? 100) + (count - 1 - i) * 0.1;
    bars.push(makeBar(stockId, date, close, { source: opts.source ?? 'eastmoney' }));
  }
  return bars;
};

interface StubMarketOptions {
  readonly quote?: Quote;
  readonly quoteError?: Error;
  readonly bars?: readonly DailyBar[];
  readonly barsError?: Error;
}

class StubMarketAdapter implements MarketDataAdapterLike {
  readonly name = 'stub-market';
  quoteCalls = 0;
  barsCalls = 0;
  lastBarsRange: DateRange | null = null;

  constructor(private readonly opts: StubMarketOptions = {}) {}

  fetchQuote(stockCode: string): Promise<Quote> {
    this.quoteCalls += 1;
    if (this.opts.quoteError !== undefined) return Promise.reject(this.opts.quoteError);
    return Promise.resolve(this.opts.quote ?? makeQuote(stockCode, NOW));
  }

  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const code of stockCodes) out.set(code, await this.fetchQuote(code));
    return out;
  }

  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    this.barsCalls += 1;
    this.lastBarsRange = range;
    if (this.opts.barsError !== undefined) return Promise.reject(this.opts.barsError);
    return Promise.resolve([...(this.opts.bars ?? makeBars(stockCode, TODAY, 60))]);
  }

  searchStocks(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: search'));
  }

  fetchIndexQuotes(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: realtime-index'));
  }

  fetchMarketSnapshot(): Promise<never> {
    return Promise.reject(new Error('unsupported_capability: market-snapshot'));
  }

  marketSourceStatus(): readonly [] {
    return [];
  }
}

const buildCtx = async (
  market: StubMarketAdapter,
  clock: () => Date = () => new Date(NOW.getTime()),
): Promise<ToolContext> => {
  const ctx = await buildTestContext({ clock });
  return { ...ctx, adapters: { ...ctx.adapters, market } };
};

const callView = (ctx: ToolContext, input: Record<string, unknown>) =>
  getStockMarketViewTool.execute({ stockId: STOCK_ID, ...input }, ctx);

describe('tool/get_stock_market_view', () => {
  it('1. 完整 Stock.id 正常返回（stock/quote/candles/indicators/dataStatus）', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stock).toMatchObject({
      id: STOCK_ID,
      code: '002594',
      name: '比亚迪',
      exchange: 'SZ',
    });
    expect(res.data.quote.quote.close).toBe(106);
    expect(res.data.quote.previousClose).not.toBeNull();
    expect(res.data.quote.change).not.toBeNull();
    expect(res.data.candles.length).toBeGreaterThan(20);
    const last = res.data.candles.at(-1);
    expect(last?.date).toBe(TODAY);
    expect(last?.completeness).toBe('live');
    expect(res.data.indicatorsAsOf).toBe(TODAY);
    expect(res.data.dataStatus.freshness).toBe('fresh');
    expect(res.data.dataStatus.retrieval).toBe('live');
    expect(res.data.dataStatus.marketSession).toBe('trading');
    expect(res.data.dataStatus.sources).toEqual(['eastmoney']);
  });

  it('2. 纯代码从 repo 解析', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, { stockId: '002594' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stock.id).toBe(STOCK_ID);
  });

  it('3. 完整新 Stock.id + stockName 自动登记', async () => {
    const market = new StubMarketAdapter();
    const ctx = await buildCtx(market);
    const res = await callView(ctx, { stockId: '601398.SH', stockName: '工商银行' });
    expect(res.ok).toBe(true);
    expect((await ctx.repos.stock.findById('601398.SH'))?.name).toBe('工商银行');
    expect(market.quoteCalls).toBe(1);
    expect(market.barsCalls).toBe(1);
  });

  it('4. 1m/3m/6m/1y 范围归一化（自然日对齐 UTC 零点）', async () => {
    const expectedDays = { '1m': 35, '3m': 100, '6m': 190, '1y': 370 } as const;
    for (const [range, days] of Object.entries(expectedDays)) {
      const market = new StubMarketAdapter();
      const ctx = await buildCtx(market);
      const res = await callView(ctx, { range });
      expect(res.ok).toBe(true);
      const end = new Date(`${TODAY}T00:00:00.000Z`);
      expect(market.lastBarsRange?.end.getTime()).toBe(end.getTime());
      expect(market.lastBarsRange?.start.getTime()).toBe(end.getTime() - days * DAY_MS);
    }
  });

  it('5. Quote 和 bars 成功后写 repository', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    const quote = await ctx.repos.quote.latestByStock(STOCK_ID);
    expect(quote?.close).toBe(106);
    const bars = await ctx.repos.dailyBar.findInRange(
      STOCK_ID,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(bars.length).toBe(60);
    expect(bars[0]?.source).toBe('eastmoney');
  });

  it('6. Quote 主源 + Tencent bars fallback：sources 去重含两源 + provider-fallback', async () => {
    const market = new StubMarketAdapter({
      bars: makeBars(STOCK_ID, TODAY, 30, { source: 'tencent' }),
    });
    const ctx = await buildCtx(market);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dataStatus.sources).toEqual(['eastmoney', 'tencent']);
    expect(res.data.dataStatus.warnings).toContain('provider-fallback');
  });

  it('7. Quote 外部失败 → DB 回退 + stale + quote-local-fallback', async () => {
    const dbQuote = makeQuote(STOCK_ID, new Date(`${YESTERDAY}T06:00:00.000Z`), {
      source: 'eastmoney',
      close: money(101),
    });
    const market = new StubMarketAdapter({ quoteError: new Error('quote upstream down') });
    const ctx = await buildCtx(market);
    await ctx.repos.quote.save(dbQuote);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quote.quote.close).toBe(101);
    expect(res.data.dataStatus.retrieval).toBe('local-fallback');
    expect(res.data.dataStatus.freshness).toBe('stale');
    expect(res.data.dataStatus.warnings).toContain('quote-local-fallback');
  });

  it('8. bars 外部失败 → DB 回退 + stale + bars-local-fallback', async () => {
    const market = new StubMarketAdapter({ barsError: new Error('kline upstream down') });
    const ctx = await buildCtx(market);
    await ctx.repos.dailyBar.saveMany(makeBars(STOCK_ID, YESTERDAY, 30));
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dataStatus.retrieval).toBe('local-fallback');
    expect(res.data.dataStatus.freshness).toBe('stale');
    expect(res.data.dataStatus.warnings).toContain('bars-local-fallback');
    expect(res.data.candles.length).toBe(31); // 30 收盘 bar + 今日 live candle
  });

  it('9. Quote 无外部也无 DB → adapter_error（recoverable）', async () => {
    const market = new StubMarketAdapter({ quoteError: new Error('all sources down') });
    const ctx = await buildCtx(market);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
    if (res.error.kind === 'adapter_error') expect(res.error.recoverable).toBe(true);
  });

  it('10. bars 无外部也无 DB → adapter_error（recoverable）', async () => {
    const market = new StubMarketAdapter({ barsError: new Error('all sources down') });
    const ctx = await buildCtx(market);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
    if (res.error.kind === 'adapter_error') expect(res.error.recoverable).toBe(true);
  });

  it('11. 昨收严格排除今日 bar', async () => {
    const bars = [
      ...makeBars(STOCK_ID, YESTERDAY, 30), // 最后一根 close = 100 + 29*0.1 = 102.9
      makeBar(STOCK_ID, TODAY, 999), // 今日未收盘 bar，绝不能当昨收
    ];
    const ctx = await buildCtx(new StubMarketAdapter({ bars }));
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quote.previousClose).toBeCloseTo(102.9, 4);
    expect(res.data.quote.change).toBeCloseTo(106 - 102.9, 4);
  });

  it('12. 今日远端 DailyBar 被 Quote candle 替换（同日只保留一根 live）', async () => {
    const bars = [...makeBars(STOCK_ID, YESTERDAY, 30), makeBar(STOCK_ID, TODAY, 999)];
    const ctx = await buildCtx(new StubMarketAdapter({ bars }));
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const todayCandles = res.data.candles.filter((c) => c.date === TODAY);
    expect(todayCandles).toHaveLength(1);
    expect(todayCandles[0]?.completeness).toBe('live');
    expect(todayCandles[0]?.close).toBe(106); // Quote 的值，不是远端 999
  });

  it('13. 历史 Quote（本地回退，非今日）不伪造当日 candle', async () => {
    const oldQuote = makeQuote(STOCK_ID, new Date('2026-07-17T06:00:00.000Z'), {
      close: money(99),
    });
    const bars = makeBars(STOCK_ID, YESTERDAY, 30);
    const market = new StubMarketAdapter({
      quoteError: new Error('quote down'),
      bars,
    });
    const ctx = await buildCtx(market);
    await ctx.repos.quote.save(oldQuote);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.candles.some((c) => c.date === TODAY)).toBe(false);
    expect(res.data.candles.at(-1)?.date).toBe(YESTERDAY);
    expect(res.data.candles.at(-1)?.completeness).toBe('closed');
    const expectedPrevious = bars.filter((bar) => bar.date < new Date('2026-07-17')).at(-1)?.close;
    expect(res.data.quote.previousClose).toBe(expectedPrevious);
    expect(res.data.quote.change).toBeCloseTo(99 - (expectedPrevious ?? 0), 4);
  });

  it('14. 少于 20 根 bars → bars-insufficient + freshness=unknown', async () => {
    const market = new StubMarketAdapter({ bars: makeBars(STOCK_ID, TODAY, 5) });
    const ctx = await buildCtx(market);
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dataStatus.warnings).toContain('bars-insufficient');
    expect(res.data.dataStatus.freshness).toBe('unknown');
    expect(res.data.dataStatus.retrieval).toBe('live');
  });

  it('15. 同日 bars 去重留最后 + 按日期升序', async () => {
    const base = makeBars(STOCK_ID, YESTERDAY, 30);
    const dup = makeBar(STOCK_ID, '2026-07-15', 555); // 与 base 中该日重复，须出现在输入最后
    const shuffled = [base[10] as DailyBar, base[0] as DailyBar, ...base.slice(1), dup];
    const ctx = await buildCtx(new StubMarketAdapter({ bars: shuffled }));
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dates = res.data.candles.map((c) => c.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    expect(new Set(dates).size).toBe(dates.length);
    expect(res.data.candles.find((c) => c.date === '2026-07-15')?.close).toBe(555);
  });

  it('16. 输出最多 260 根 candles', async () => {
    const market = new StubMarketAdapter({ bars: makeBars(STOCK_ID, TODAY, 300) });
    const ctx = await buildCtx(market);
    const res = await callView(ctx, { range: '1y' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.candles.length).toBe(260);
    expect(res.data.candles.at(-1)?.date).toBe(TODAY);
  });

  it('17. 指标与输出 candles 同源：indicatorsAsOf = 最后 candle 日期，ma5 可复算', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const last = res.data.candles.at(-1);
    expect(res.data.indicatorsAsOf).toBe(last?.date);
    const closes = res.data.candles.slice(-5).map((c) => c.close);
    const expectedMa5 = closes.reduce((a, b) => a + b, 0) / closes.length;
    expect(res.data.indicators.ma5).toBeCloseTo(expectedMa5, 6);
  });

  it('18. 非交易日 / 收盘后 / 午休 / 盘前 session 状态正确', async () => {
    const cases = [
      // 2026-07-25 周六 10:30 Shanghai
      { now: '2026-07-25T02:30:00.000Z', session: 'non-trading-day' },
      // 2026-10-01 周四（国庆节假日）10:30 Shanghai
      { now: '2026-10-01T02:30:00.000Z', session: 'non-trading-day' },
      // 周二 16:00 Shanghai → 已收盘
      { now: '2026-07-21T08:00:00.000Z', session: 'closed' },
      // 周二 12:00 Shanghai → 午休
      { now: '2026-07-21T04:00:00.000Z', session: 'midday-break' },
      // 周二 09:00 Shanghai → 盘前
      { now: '2026-07-21T01:00:00.000Z', session: 'pre-open' },
    ] as const;
    for (const c of cases) {
      const ctx = await buildCtx(new StubMarketAdapter(), () => new Date(c.now));
      const res = await callView(ctx, {});
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.data.dataStatus.marketSession).toBe(c.session);
      expect(res.data.dataStatus.warnings).toContain('market-closed');
    }
  });

  it('19. 盘前 / 非交易日：live Quote 不生成当日 candle（retrieval 时间不代表成交）', async () => {
    const cases = [
      // 周二 09:00 Shanghai → 盘前
      { now: '2026-07-21T01:00:00.000Z', session: 'pre-open' },
      // 周六 10:30 Shanghai → 非交易日
      { now: '2026-07-25T02:30:00.000Z', session: 'non-trading-day' },
    ] as const;
    for (const c of cases) {
      const clockNow = new Date(c.now);
      const today = c.now.slice(0, 10);
      const yesterday = new Date(clockNow.getTime() - DAY_MS).toISOString().slice(0, 10);
      const quote = makeQuote(STOCK_ID, clockNow); // 盘前抓到的快照，ts 是今天
      const bars = makeBars(STOCK_ID, yesterday, 30);
      const ctx = await buildCtx(new StubMarketAdapter({ quote, bars }), () => clockNow);
      const res = await callView(ctx, {});
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.data.dataStatus.marketSession).toBe(c.session);
      expect(res.data.candles.some((candle) => candle.date === today)).toBe(false);
      expect(res.data.candles.at(-1)?.date).toBe(yesterday);
      expect(res.data.candles.at(-1)?.completeness).toBe('closed');
      expect(res.data.dataStatus.barsAsOf).toBe(yesterday);
      // quote 卡片照常展示，只是不拼成 K 线
      expect(res.data.quote.quote.close).toBe(106);
    }
  });

  it('错误路径：range 不合法 → invalid_input', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, { range: '5m' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });

  it('错误路径：股票无法解析 → not_found', async () => {
    const ctx = await buildCtx(new StubMarketAdapter());
    const res = await callView(ctx, { stockId: 'NOPE' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('not_found');
  });

  it('OHLC 关系非法的 bar 被丢弃，不拖垮整页', async () => {
    const bars = [
      ...makeBars(STOCK_ID, YESTERDAY, 30),
      makeBar(STOCK_ID, TODAY, 10, { high: money(5) }), // high < open/close → 非法
    ];
    const ctx = await buildCtx(new StubMarketAdapter({ bars }));
    const res = await callView(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 非法今日 bar 被丢弃后由 Quote candle 顶替当日；历史 30 根完整
    expect(res.data.candles.length).toBe(31);
    expect(res.data.candles.filter((c) => c.date === TODAY)).toHaveLength(1);
  });

  it('外部日线非空但全部非法时回退到本地有效缓存', async () => {
    const invalid = makeBar(STOCK_ID, YESTERDAY, 101, { high: money(90) });
    const ctx = await buildCtx(new StubMarketAdapter({ bars: [invalid] }));
    await ctx.repos.dailyBar.saveMany(makeBars(STOCK_ID, YESTERDAY, 30));

    const res = await callView(ctx, {});

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.dataStatus.retrieval).toBe('local-fallback');
    expect(res.data.dataStatus.warnings).toContain('bars-local-fallback');
    expect(res.data.candles.length).toBeGreaterThan(20);
  });

  it('外部日线非空但全部越界且无缓存时返回 adapter_error', async () => {
    const outOfRange = makeBar(STOCK_ID, '2020-01-01', 101);
    const ctx = await buildCtx(new StubMarketAdapter({ bars: [outOfRange] }));

    const res = await callView(ctx, {});

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
  });
});
