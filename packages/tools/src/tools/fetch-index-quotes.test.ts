import type { IndexQuote, MarketDataAdapterLike, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { fetchIndexQuotesTool } from './fetch-index-quotes.js';

const indexQuoteFixture = (code: string, name: string): IndexQuote => ({
  code,
  name,
  close: money(3500.5),
  change: 12.3,
  changePct: 0.35,
  ts: new Date('2026-07-28T01:00:00.000Z'),
  source: 'eastmoney',
});

/** 在测试 ctx 的 market adapter 上叠加 fetchIndexQuotes 实现。 */
const withIndexQuotes = (
  ctx: ToolContext,
  fetchIndexQuotes: MarketDataAdapterLike['fetchIndexQuotes'],
): ToolContext => ({
  ...ctx,
  adapters: {
    ...ctx.adapters,
    market: {
      name: 'stub-market',
      fetchQuote: (code) => ctx.adapters.market.fetchQuote(code),
      batchQuote: (codes) => ctx.adapters.market.batchQuote(codes),
      fetchDailyBars: (code, range) => ctx.adapters.market.fetchDailyBars(code, range),
      ...(fetchIndexQuotes === undefined ? {} : { fetchIndexQuotes }),
    },
  },
});

describe('tool/fetch_index_quotes', () => {
  it('正常路径：返回数据源给出的指数列表', async () => {
    const ctx = await buildTestContext();
    const res = await fetchIndexQuotesTool.execute(
      {},
      withIndexQuotes(ctx, () =>
        Promise.resolve([
          indexQuoteFixture('000001', '上证指数'),
          indexQuoteFixture('399001', '深证成指'),
        ]),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unsupported).toBeUndefined();
    expect(res.data.indices).toHaveLength(2);
    expect(res.data.indices[0]?.code).toBe('000001');
    expect(res.data.indices[0]?.name).toBe('上证指数');
    expect(res.data.indices[0]?.close).toBe(3500.5);
  });

  it('降级路径：数据源未实现 fetchIndexQuotes → unsupported: true', async () => {
    const ctx = await buildTestContext(); // FakeMarketAdapter 不实现该方法
    const res = await fetchIndexQuotesTool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.indices).toEqual([]);
    expect(res.data.unsupported).toBe(true);
  });

  it('错误路径：adapter 抛错 → adapter_error', async () => {
    const ctx = await buildTestContext();
    const res = await fetchIndexQuotesTool.execute(
      {},
      withIndexQuotes(ctx, () => Promise.reject(new Error('eastmoney down'))),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('adapter_error');
  });
});
