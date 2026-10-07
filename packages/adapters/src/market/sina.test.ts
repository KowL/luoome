import { describe, expect, it } from 'vitest';

import { SinaAdapter } from './sina.js';

describe('market/SinaAdapter', () => {
  it('将 raw 日线与真实 qfq 因子合成为 qfq DailyBar，成交量保持股', async () => {
    const urls: string[] = [];
    const adapter = new SinaAdapter({
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/qfq.js')) {
          return new Response(
            'var sh600519qfq={"total":2,"data":[{"d":"2026-01-01","f":"1.0"},{"d":"2025-01-01","f":"2.0"}]}; /* generated */',
          );
        }
        return new Response(
          JSON.stringify([
            {
              day: '2025-06-30',
              open: '100',
              high: '120',
              low: '80',
              close: '110',
              volume: '1234',
            },
            {
              day: '2026-02-02',
              open: '100',
              high: '120',
              low: '80',
              close: '110',
              volume: '5678',
            },
          ]),
        );
      }) as unknown as typeof fetch,
    });

    const bars = await adapter.fetchDailyBars('600519.SH', {
      start: new Date('2025-06-01T00:00:00.000Z'),
      end: new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ close: 55, volume: 1234, adjustment: 'qfq', source: 'sina' });
    expect(bars[1]).toMatchObject({ close: 110, volume: 5678, adjustment: 'qfq', source: 'sina' });
    expect(urls.some((url) => url.includes('symbol=sh600519'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/sh600519/qfq.js'))).toBe(true);
  });

  it('指数没有公司行动因子时直接使用 raw day，仍标记为 qfq 等价口径', async () => {
    let calls = 0;
    const adapter = new SinaAdapter({
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify([
            {
              day: '2026-08-12',
              open: '3900',
              high: '3950',
              low: '3880',
              close: '3920',
              volume: '100',
            },
          ]),
        );
      }) as unknown as typeof fetch,
    });

    const bars = await adapter.fetchDailyBars('000300.SH', {
      start: new Date('2026-08-01T00:00:00.000Z'),
      end: new Date('2026-08-13T00:00:00.000Z'),
    });

    expect(calls).toBe(1);
    expect(bars[0]).toMatchObject({ close: 3920, adjustment: 'qfq' });
  });

  it('因子响应缺失时拒绝把 raw 行伪装成 qfq', async () => {
    const adapter = new SinaAdapter({
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/qfq.js')) return new Response('var sh600519qfq={"data":[]};');
        return new Response(
          JSON.stringify([
            { day: '2026-08-12', open: '100', high: '101', low: '99', close: '100', volume: '10' },
          ]),
        );
      }) as unknown as typeof fetch,
    });

    await expect(
      adapter.fetchDailyBars('600519.SH', {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ).rejects.toThrow('unsupported_adjustment');
  });

  describe('fetchQuote / fetchBatchQuotes（hq.sinajs.cn）', () => {
    /** hq 文本行真实布局（2026-10-05 实盘）：[1]今开 [2]昨收 [3]最新 [4]高 [5]低 [8]量(股) [9]额(元) [30]日期 [31]时间。 */
    const HQ_LINE =
      'var hq_str_sh600519="贵州茅台,1239.530,1235.580,1258.620,1268.000,1236.050,1258.620,1258.650,3833098,4797246636.000,1445,1258.620,100,1258.440,100,1258.160,200,1258.050,4100,1258.000,200,1258.650,300,1258.660,100,1258.680,200,1258.690,8000,1258.750,2026-09-30,15:34:59,00,";';
    const hqWith = (overrides: Record<number, string>): string => {
      const fields = HQ_LINE.split('"')[1]?.split(',') ?? [];
      Object.assign(fields, overrides);
      return `var hq_str_sh600519="${fields.join(',')}";`;
    };

    it('解析快照字段；volume 已是股不转换；observedAt 按上游时间', async () => {
      const adapter = new SinaAdapter({
        fetchImpl: (async () => new Response(HQ_LINE)) as unknown as typeof fetch,
        clock: () => new Date('2026-09-30T08:00:00.000Z'),
      });
      const quote = await adapter.fetchQuote('600519.SH');
      expect(quote).toMatchObject({
        stockId: '600519.SH',
        open: 1239.53,
        prevClose: 1235.58,
        close: 1258.62,
        high: 1268.0,
        low: 1236.05,
        volume: 3_833_098, // 新浪 volume 已是股
        amount: 4_797_246_636,
        source: 'sina',
        timestampSource: 'upstream',
      });
      expect(quote.observedAt).toEqual(new Date('2026-09-30T07:34:59.000Z')); // 15:34:59 +08:00
    });

    it('请求带 Referer 头（无 Referer 上游 403）', async () => {
      let seenReferer: string | null = null;
      const adapter = new SinaAdapter({
        fetchImpl: (async (_input: unknown, init?: RequestInit) => {
          seenReferer = new Headers(init?.headers).get('Referer');
          return new Response(HQ_LINE);
        }) as unknown as typeof fetch,
      });
      await adapter.fetchQuote('600519');
      expect(seenReferer).toBe('https://finance.sina.com.cn');
    });

    it('停牌缺价（最新价为 0）抛 no_data', async () => {
      const suspended = HQ_LINE.replace(',1258.620,1268.000,', ',0.000,0.000,');
      const adapter = new SinaAdapter({
        fetchImpl: (async () => new Response(suspended)) as unknown as typeof fetch,
      });
      await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/no_data/);
    });

    it('批量单次请求；缺行 / 缺价只丢弃该只', async () => {
      const urls: string[] = [];
      const szLine =
        'var hq_str_sz000001="平安银行,11.20,11.25,11.30,11.40,11.10,11.30,11.31,5000000,56500000.000,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-09-30,15:35:00,00,";';
      const adapter = new SinaAdapter({
        fetchImpl: ((input: unknown) => {
          urls.push(String(input));
          return Promise.resolve(new Response(`${HQ_LINE}\n${szLine}`));
        }) as unknown as typeof fetch,
      });
      const quotes = await adapter.fetchBatchQuotes(['600519.SH', '000001.SZ', '999999.SH']);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('sh600519,sz000001,sh999999');
      expect(quotes.map((q) => q.stockId)).toEqual(['600519.SH', '000001.SZ']);
      expect(quotes[1]).toMatchObject({ close: 11.3, prevClose: 11.25, source: 'sina' });
    });

    it('HTTP 错误抛 SinaAdapterError', async () => {
      const adapter = new SinaAdapter({
        fetchImpl: (async () => new Response('x', { status: 403 })) as unknown as typeof fetch,
      });
      await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/403/);
    });

    it.each([{ 1: '' }, { 4: '1200' }, { 8: '' }, { 8: '-1' }])(
      '缺失 OHLCV 和矛盾价格拒绝而不合成行情：%j',
      async (overrides) => {
        const adapter = new SinaAdapter({
          fetchImpl: (async () => new Response(hqWith(overrides))) as unknown as typeof fetch,
        });
        await expect(adapter.fetchQuote('600519.SH')).rejects.toMatchObject({
          kind: 'invalid_payload',
        });
      },
    );

    it('真实零成交量和金额保留；非法日期不能变成 upstream 时间', async () => {
      const adapter = new SinaAdapter({
        fetchImpl: (async () =>
          new Response(hqWith({ 8: '0', 9: '0', 30: '2026-02-30' }))) as unknown as typeof fetch,
        clock: () => new Date('2026-09-30T08:00:00.000Z'),
      });
      const quote = await adapter.fetchQuote('600519.SH');
      expect(quote).toMatchObject({ volume: 0, amount: 0, timestampSource: 'retrieval' });
      expect(quote.observedAt).toEqual(quote.fetchedAt);
    });

    it('HTTP 200 错误页仍是 invalid_payload；空报价行是合法缺失', async () => {
      const invalid = new SinaAdapter({
        fetchImpl: (async () => new Response('<html>blocked</html>')) as unknown as typeof fetch,
      });
      await expect(invalid.fetchBatchQuotes(['600519.SH'])).rejects.toMatchObject({
        kind: 'invalid_payload',
      });
      const empty = new SinaAdapter({
        fetchImpl: (async () => new Response('var hq_str_sh600519="";')) as unknown as typeof fetch,
      });
      await expect(empty.fetchBatchQuotes(['600519.SH'])).resolves.toEqual([]);
    });

    it('批量坏行只影响对应股票，保留其它正常报价供 manager 补齐', async () => {
      const invalid = hqWith({ 8: '' }).replaceAll('sh600519', 'sz000001');
      const adapter = new SinaAdapter({
        fetchImpl: (async () => new Response(`${HQ_LINE}\n${invalid}`)) as unknown as typeof fetch,
      });
      const quotes = await adapter.fetchBatchQuotes(['600519.SH', '000001.SZ']);
      expect(quotes.map((quote) => quote.stockId)).toEqual(['600519.SH']);
    });
  });
});
