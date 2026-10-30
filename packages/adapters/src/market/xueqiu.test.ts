import type { SourceErrorKind } from '@luoome/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { parseXueqiuDailyBars, parseXueqiuQuote, XueqiuAdapter } from './xueqiu.js';

const STOCK_ID = '300476.SZ';
const HOME_URL = 'https://www.xueqiu.com/';
const API_BASE = 'https://stock.xueqiu.com/v5/stock/';
const FETCHED_AT = new Date('2026-10-30T08:00:00.000Z');
const OBSERVED_AT = new Date('2026-10-30T07:00:00.000Z');

const quoteData = {
  symbol: 'SZ300476',
  timestamp: OBSERVED_AT.getTime(),
  current: 205.25,
  open: 200.5,
  high: 211.75,
  low: 197.25,
  volume: 1_234_567,
  amount: 251_234_567.89,
  turnover_rate: 1.25,
  last_close: 199.75,
  total_shares: 900_000_000,
  float_shares: 800_000_000,
  market_capital: 184_725_000_000,
  float_market_capital: 164_200_000_000,
  pe_ttm: 45.6,
  pe_forecast: 39.8,
  pe_lyr: 50.1,
  ps_ttm: 12.3,
  pb: 8.7,
};

const dailyColumns = ['timestamp', 'volume', 'open', 'high', 'low', 'close'];
const dailyData = (days: readonly string[] = ['2026-10-30', '2026-10-29', '2026-10-28']) => ({
  symbol: 'SZ300476',
  column: [...dailyColumns],
  item: days.map((day) => [Date.parse(`${day}T00:00:00+08:00`), 123_456, 200, 210, 195, 205]),
});
const success = (data: unknown) => Response.json({ error_code: 0, data });
const visitorResponse = (value = 'fixture') =>
  new Response('<html></html>', {
    headers: { 'set-cookie': `u=${value}; Domain=.xueqiu.com; Path=/; Max-Age=3600` },
  });

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | null;
}
type Respond = (request: RecordedRequest, call: number) => Response | Promise<Response>;
const mockTransport = (respond: Respond, visit: Respond = () => visitorResponse()) => {
  const homeRequests: RecordedRequest[] = [];
  const apiRequests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const cookie = new Headers(init?.headers).get('cookie');
    const request: RecordedRequest = { url, method, cookie };
    if (url === HOME_URL) {
      homeRequests.push(request);
      return visit(request, homeRequests.length);
    }
    if (!url.startsWith(API_BASE)) throw new Error(`Unexpected request: ${url}`);
    apiRequests.push(request);
    return respond(request, apiRequests.length);
  }) as unknown as typeof fetch;
  return { fetchImpl, homeRequests, apiRequests };
};

const sourceError = (kind: SourceErrorKind) =>
  expect.objectContaining({ name: 'SourceExecutionError', kind });

const expectFailure = async (pending: Promise<unknown>, kind: SourceErrorKind) => {
  const error: unknown = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SourceExecutionError);
  expect(error).toMatchObject({ kind });
  return error as SourceExecutionError;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('parseXueqiuQuote', () => {
  it('maps the raw data.quote, preserving share/yuan units and valuation meanings', () => {
    expect(parseXueqiuQuote(quoteData, STOCK_ID, FETCHED_AT)).toEqual({
      stockId: STOCK_ID,
      observedAt: OBSERVED_AT,
      fetchedAt: FETCHED_AT,
      ts: OBSERVED_AT,
      timestampSource: 'upstream',
      open: 200.5,
      high: 211.75,
      low: 197.25,
      close: 205.25,
      volume: 1_234_567,
      amount: 251_234_567.89,
      turnoverRatePct: 1.25,
      prevClose: 199.75,
      totalShares: 900_000_000,
      floatShares: 800_000_000,
      totalMarketCap: 184_725_000_000,
      floatMarketCap: 164_200_000_000,
      peTtm: 45.6,
      peDynamic: 39.8,
      peStatic: 50.1,
      psTtm: 12.3,
      pb: 8.7,
      source: 'xueqiu',
    });
  });

  it.each([undefined, null])('uses honest retrieval provenance for timestamp=%s', (timestamp) => {
    const quote = parseXueqiuQuote({ ...quoteData, timestamp }, STOCK_ID, FETCHED_AT);
    expect(quote).toMatchObject({
      observedAt: FETCHED_AT,
      fetchedAt: FETCHED_AT,
      ts: FETCHED_AT,
      timestampSource: 'retrieval',
    });
  });

  it('keeps upstream provenance when the event time equals retrieval time', () => {
    const quote = parseXueqiuQuote(quoteData, STOCK_ID, OBSERVED_AT);
    expect(quote.timestampSource).toBe('upstream');
    expect(quote.observedAt).toEqual(quote.fetchedAt);
  });

  it.each([FETCHED_AT.getTime() + 1, Number.NaN, Infinity, 9e18, 'invalid', 0, -1])(
    'rejects future or malformed timestamps: %s',
    (timestamp) => {
      expect(() =>
        parseXueqiuQuote({ ...quoteData, timestamp }, STOCK_ID, FETCHED_AT),
      ).toThrowError(sourceError('invalid_payload'));
    },
  );

  describe.each(['current', 'open', 'high', 'low'])('%s', (field) => {
    it.each([undefined, null, Number.NaN, Infinity, -Infinity, '200'])(
      'rejects a missing or non-finite numeric price: %s',
      (value) => {
        expect(() =>
          parseXueqiuQuote({ ...quoteData, [field]: value }, STOCK_ID, FETCHED_AT),
        ).toThrowError(sourceError('invalid_payload'));
      },
    );

    it.each([0, -1])('does not manufacture a price from %s', (value) => {
      expect(() =>
        parseXueqiuQuote({ ...quoteData, [field]: value }, STOCK_ID, FETCHED_AT),
      ).toThrowError(sourceError('no_data'));
    });
  });

  it.each([undefined, null, -1, Number.NaN, Infinity, -Infinity, '123'])(
    'rejects missing or invalid volume: %s',
    (volume) => {
      expect(() => parseXueqiuQuote({ ...quoteData, volume }, STOCK_ID, FETCHED_AT)).toThrowError(
        sourceError('invalid_payload'),
      );
    },
  );

  it('retains genuine zero volume/amount/turnover and negative valuation ratios', () => {
    expect(
      parseXueqiuQuote(
        {
          ...quoteData,
          volume: 0,
          amount: 0,
          turnover_rate: 0,
          pe_ttm: -45.6,
          pe_forecast: -39.8,
          pe_lyr: -50.1,
          ps_ttm: -12.3,
          pb: -8.7,
        },
        STOCK_ID,
        FETCHED_AT,
      ),
    ).toMatchObject({
      volume: 0,
      amount: 0,
      turnoverRatePct: 0,
      peTtm: -45.6,
      peDynamic: -39.8,
      peStatic: -50.1,
      psTtm: -12.3,
      pb: -8.7,
    });
  });

  it.each([undefined, null])('leaves absent optional fields unknown: %s', (value) => {
    const optionalFields = [
      ['amount', 'amount'],
      ['turnover_rate', 'turnoverRatePct'],
      ['last_close', 'prevClose'],
      ['total_shares', 'totalShares'],
      ['float_shares', 'floatShares'],
      ['market_capital', 'totalMarketCap'],
      ['float_market_capital', 'floatMarketCap'],
      ['pe_ttm', 'peTtm'],
      ['pe_forecast', 'peDynamic'],
      ['pe_lyr', 'peStatic'],
      ['ps_ttm', 'psTtm'],
      ['pb', 'pb'],
    ] as const;
    const raw = {
      ...quoteData,
      ...Object.fromEntries(optionalFields.map(([key]) => [key, value])),
    };
    const quote = parseXueqiuQuote(raw, STOCK_ID, FETCHED_AT);
    for (const [, field] of optionalFields) expect(quote[field]).toBeUndefined();
  });

  it.each([
    { label: 'wrong stock', raw: { ...quoteData, symbol: 'SZ000001' } },
    { label: 'wrong exchange', raw: { ...quoteData, symbol: 'SH300476' } },
    { label: 'missing identity', raw: { ...quoteData, symbol: undefined } },
    { label: 'envelope instead of data.quote', raw: { error_code: 0, data: { quote: quoteData } } },
    { label: 'data instead of data.quote', raw: { quote: quoteData } },
    { label: 'null', raw: null },
    { label: 'array', raw: [] },
  ])('rejects $label', ({ raw }) => {
    expect(() => parseXueqiuQuote(raw, STOCK_ID, FETCHED_AT)).toThrowError(
      sourceError('invalid_payload'),
    );
  });
});

describe('parseXueqiuDailyBars', () => {
  it('uses dynamic columns, projects Shanghai dates to UTC midnight, and preserves share units', () => {
    const bars = parseXueqiuDailyBars(
      {
        symbol: 'SZ300476',
        column: ['close', 'amount', 'timestamp', 'low', 'volume', 'high', 'open'],
        item: [
          [205, null, Date.parse('2026-10-29T16:00:00Z'), 195, 123_456, 210, 200],
          [200, 0, Date.parse('2026-10-28T16:00:00Z'), 190, 0, 205, 195],
        ],
      },
      STOCK_ID,
    );
    expect(bars).toEqual([
      {
        stockId: STOCK_ID,
        date: new Date('2026-10-29T00:00:00Z'),
        open: 195,
        high: 205,
        low: 190,
        close: 200,
        volume: 0,
        adjustment: 'qfq',
        source: 'xueqiu',
      },
      {
        stockId: STOCK_ID,
        date: new Date('2026-10-30T00:00:00Z'),
        open: 200,
        high: 210,
        low: 195,
        close: 205,
        volume: 123_456,
        adjustment: 'qfq',
        source: 'xueqiu',
      },
    ]);
    expect(bars.every((bar) => bar.sourceAdjFactor === undefined)).toBe(true);
  });

  it('accepts a well-formed empty page', () => {
    expect(parseXueqiuDailyBars(dailyData([]), STOCK_ID)).toEqual([]);
  });

  it.each(dailyColumns)('rejects a missing required %s column even on an empty page', (field) => {
    expect(() =>
      parseXueqiuDailyBars(
        { ...dailyData([]), column: dailyColumns.filter((column) => column !== field) },
        STOCK_ID,
      ),
    ).toThrowError(sourceError('invalid_payload'));
  });

  it.each([
    { label: 'wrong stock', raw: { ...dailyData(), symbol: 'SH600519' } },
    { label: 'wrong exchange', raw: { ...dailyData(), symbol: 'SH300476' } },
    { label: 'missing symbol', raw: { ...dailyData(), symbol: undefined } },
    { label: 'envelope instead of data', raw: { error_code: 0, data: dailyData() } },
    { label: 'missing columns', raw: { ...dailyData(), column: undefined } },
    { label: 'duplicate columns', raw: { ...dailyData([]), column: [...dailyColumns, 'close'] } },
    { label: 'non-string column', raw: { ...dailyData([]), column: [...dailyColumns, null] } },
    { label: 'missing items', raw: { ...dailyData(), item: undefined } },
    { label: 'non-array items', raw: { ...dailyData(), item: {} } },
    { label: 'non-array row', raw: { ...dailyData(), item: [null] } },
    { label: 'short row', raw: { ...dailyData(), item: [[1, 2]] } },
    { label: 'duplicate trading day', raw: dailyData(['2026-10-30', '2026-10-30']) },
  ])('rejects $label', ({ raw }) => {
    expect(() => parseXueqiuDailyBars(raw, STOCK_ID)).toThrowError(sourceError('invalid_payload'));
  });

  it.each([
    { field: 'timestamp', value: null },
    { field: 'timestamp', value: 9e18 },
    { field: 'volume', value: -1 },
    { field: 'volume', value: Number.NaN },
    { field: 'volume', value: Infinity },
    { field: 'volume', value: null },
    { field: 'open', value: null },
    { field: 'high', value: Infinity },
    { field: 'low', value: '195' },
    { field: 'close', value: Number.NaN },
  ])('rejects malformed $field=$value without dropping bad rows', ({ field, value }) => {
    const raw = dailyData(['2026-10-29']);
    const invalidRow: unknown[] = [
      Date.parse('2026-10-30T00:00:00+08:00'),
      123,
      200,
      210,
      195,
      205,
    ];
    invalidRow[dailyColumns.indexOf(field)] = value;
    expect(() =>
      parseXueqiuDailyBars({ ...raw, item: [...raw.item, invalidRow] }, STOCK_ID),
    ).toThrowError(sourceError('invalid_payload'));
  });
});

describe('XueqiuAdapter visitor session', () => {
  it.each([
    { stockId: STOCK_ID, symbol: 'SZ300476' },
    { stockId: '600519.SH', symbol: 'SH600519' },
  ])(
    'bootstraps parent-domain visitor cookies and fetches $stockId',
    async ({ stockId, symbol }) => {
      const transport = mockTransport(() => success({ quote: { ...quoteData, symbol } }));
      const adapter = new XueqiuAdapter({
        fetchImpl: transport.fetchImpl,
        clock: () => FETCHED_AT,
      });

      expect(adapter.name).toBe('xueqiu');
      expect(await adapter.fetchQuote(stockId)).toMatchObject({
        stockId,
        source: 'xueqiu',
        close: 205.25,
      });
      expect(transport.homeRequests).toHaveLength(1);
      expect(transport.homeRequests[0]?.method).toBe('GET');
      expect(transport.homeRequests[0]?.cookie).toBeNull();
      expect(transport.apiRequests).toHaveLength(1);
      const request = transport.apiRequests[0] as RecordedRequest;
      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE}quote.json`);
      expect(url.searchParams.get('symbol')).toBe(symbol);
      expect(request.method).toBe('GET');
      expect(request.cookie).toBe('u=fixture');
    },
  );
});

describe('XueqiuAdapter transport', () => {
  const barsFor = (days: readonly string[]) =>
    success({
      symbol: 'SZ300476',
      column: [...dailyColumns],
      item: days.map((day) => [Date.parse(`${day}T00:00:00+08:00`), 1_000, 200, 210, 195, 205]),
    });

  it('requests before-adjusted daily bars and pages backwards until the range start', async () => {
    const pages = [
      ['2026-10-30', '2026-10-25'],
      ['2026-10-10', '2026-09-30'],
    ];
    const transport = mockTransport(() =>
      barsFor(pages[(transport.apiRequests.length - 1) % 2] ?? []),
    );
    const adapter = new XueqiuAdapter({ fetchImpl: transport.fetchImpl, clock: () => FETCHED_AT });

    const bars = await adapter.fetchDailyBars(STOCK_ID, {
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-10-30T00:00:00Z'),
    });

    expect(transport.apiRequests).toHaveLength(2);
    const [first, second] = transport.apiRequests.map((request) => new URL(request.url));
    expect(first?.pathname).toBe('/v5/stock/chart/kline.json');
    expect(first?.searchParams.get('period')).toBe('day');
    expect(first?.searchParams.get('type')).toBe('before');
    expect(first?.searchParams.get('count')).toBe('-500');
    expect(first?.searchParams.get('symbol')).toBe('SZ300476');
    // 第二页游标必须早于第一页最早一根，避免同页重取。
    expect(Number(second?.searchParams.get('begin'))).toBeLessThan(
      Number(first?.searchParams.get('begin')),
    );
    expect(bars.map((bar) => bar.date.toISOString().slice(0, 10))).toEqual([
      '2026-10-10',
      '2026-10-25',
      '2026-10-30',
    ]);
    expect(bars.every((bar) => bar.adjustment === 'qfq' && bar.source === 'xueqiu')).toBe(true);
  });

  it('rejects a non-advancing cursor instead of looping forever', async () => {
    const transport = mockTransport(() => barsFor(['2026-10-30', '2026-10-29']));
    const adapter = new XueqiuAdapter({ fetchImpl: transport.fetchImpl, clock: () => FETCHED_AT });

    await expectFailure(
      adapter.fetchDailyBars(STOCK_ID, {
        start: new Date('2025-01-01T00:00:00Z'),
        end: new Date('2026-10-30T00:00:00Z'),
      }),
      'invalid_payload',
    );
  });

  it('rebuilds an expired visitor session once and then succeeds', async () => {
    const transport = mockTransport(
      (_request, call) =>
        call === 1
          ? Response.json({ error_code: 400016, error_description: '会话失效' })
          : success({ quote: quoteData }),
      (_request, call) =>
        new Response('<html></html>', {
          headers: { 'set-cookie': `u=visitor-${call}; Domain=.xueqiu.com; Path=/` },
        }),
    );
    const adapter = new XueqiuAdapter({ fetchImpl: transport.fetchImpl, clock: () => FETCHED_AT });

    expect((await adapter.fetchQuote(STOCK_ID)).close).toBe(205.25);
    expect(transport.homeRequests).toHaveLength(2);
    expect(transport.apiRequests).toHaveLength(2);
    expect(transport.apiRequests[1]?.cookie).toBe('u=visitor-2');
  });

  it('surfaces a permission error when the rebuilt session is rejected again', async () => {
    const transport = mockTransport(() => Response.json({ error_code: 400016 }));
    const adapter = new XueqiuAdapter({ fetchImpl: transport.fetchImpl, clock: () => FETCHED_AT });

    await expectFailure(adapter.fetchQuote(STOCK_ID), 'permission');
    expect(transport.apiRequests).toHaveLength(2);
  });

  it('classifies transport failures without inventing prices', async () => {
    const httpFailure = mockTransport(() => new Response(null, { status: 503 }));
    await expectFailure(
      new XueqiuAdapter({ fetchImpl: httpFailure.fetchImpl }).fetchQuote(STOCK_ID),
      'upstream_error',
    );

    const networkFailure = new XueqiuAdapter({
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expectFailure(networkFailure.fetchQuote(STOCK_ID), 'network');
  });

  it('rejects markets the source does not cover', async () => {
    const transport = mockTransport(() => success({ quote: quoteData }));
    const adapter = new XueqiuAdapter({ fetchImpl: transport.fetchImpl, clock: () => FETCHED_AT });

    await expectFailure(adapter.fetchQuote('300476.BJ'), 'unsupported_market');
    expect(transport.homeRequests).toHaveLength(0);
  });
});
