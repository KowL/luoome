import { describe, expect, it } from 'vitest';

import { AdshareClient } from '../client.js';
import type { KLineBar, Quote, StockBasic } from '../schemas.js';
import { mockFetch } from './helpers.js';

function client(fetchMock: typeof fetch) {
  return new AdshareClient({
    url: 'https://adshare.test',
    apiKey: 'secret',
    retries: 0,
    fetchImpl: fetchMock,
  });
}

describe('Adshare endpoints', () => {
  it('searchStocks builds the query string and returns StockBasic[]', async () => {
    const fetchMock = mockFetch([
      {
        status: 200,
        body: { data: [{ ts_code: '600519.SH', name: '贵州茅台', industry: '白酒' }] },
      },
    ]);
    const stocks: StockBasic[] = await client(fetchMock).searchStocks({
      name: '贵州茅台',
      ts_code: '600519.SH',
      fields: ['ts_code', 'name', 'industry'],
      limit: 5,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/stock_basic');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: '贵州茅台',
      ts_code: '600519.SH',
      fields: 'ts_code,name,industry',
      limit: '5',
    });
    expect(stocks).toEqual([{ ts_code: '600519.SH', name: '贵州茅台', industry: '白酒' }]);
  });

  it('getKLine validates period and maps the response to KLineBar[]', async () => {
    const fetchMock = mockFetch([
      {
        status: 200,
        body: {
          data: [
            { ts_code: '600519.SH', trade_date: '20260723', open: 1, high: 3, low: 1, close: 2 },
          ],
        },
      },
    ]);
    const sdk = client(fetchMock);

    await expect(sdk.getKLine({ ts_code: '600519.SH', period: 'M' as 'D' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const bars: KLineBar[] = await sdk.getKLine({ ts_code: '600519.SH', period: 'D' });
    expect(bars).toEqual([
      { ts_code: '600519.SH', trade_date: '20260723', open: 1, high: 3, low: 1, close: 2 },
    ]);
  });

  it('getQuote returns a single Quote', async () => {
    const fetchMock = mockFetch([
      { status: 200, body: { data: { ts_code: '600519.SH', name: '贵州茅台', price: 1499 } } },
    ]);
    const quote: Quote = await client(fetchMock).getQuote('600519.SH');
    expect(quote).toEqual({ ts_code: '600519.SH', name: '贵州茅台', price: 1499 });
  });
});
