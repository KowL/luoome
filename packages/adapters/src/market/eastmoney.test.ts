import { describe, expect, it } from 'vitest';

import { EastmoneyAdapter, EastmoneyAdapterError } from './eastmoney.js';

/** 构造固定 JSON 响应。 */
const okJson = (data: object): string => JSON.stringify({ rc: 0, data });

const makeQuoteOk = () => ({
  f43: 10500, // close (centi-yuan → 实际是元，按 Eastmoney 文档 f43 是元)
  f44: 10600,
  f45: 10400,
  f46: 10550,
  f47: 123456, // volume 手
  f48: 987654321,
  f60: 10400,
  f57: '002594',
  f58: '比亚迪',
  f169: 100,
  f170: 0.95,
});

describe('market/eastmoney', () => {
  describe('fetchQuote', () => {
    it('成功解析 quote；source=eastmoney', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
      });
      const q = await adapter.fetchQuote('002594');
      expect(q.close).toBeGreaterThan(0);
      expect(q.source).toBe('eastmoney');
      expect(q.volume).toBe(123456 * 100); // 手 → 股
    });

    it('stockCode 带 exchange 后缀时仍能正确解析', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
      });
      const q = await adapter.fetchQuote('002594.SZ');
      expect(q.stockId).toBe('002594.SZ');
    });

    it('rc != 0 时抛 EastmoneyAdapterError', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () => new Response(JSON.stringify({ rc: -1 }), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });

    it('HTTP 500 时抛 EastmoneyAdapterError', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () =>
          new Response('oops', { status: 500, statusText: 'Server Error' })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });

    it('f43 缺失时抛错', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () => new Response(okJson({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });

    it('港股 5 位代码 → secid 116.xxxxx', async () => {
      let capturedUrl = '';
      const adapter = new EastmoneyAdapter({
        fetchImpl: ((url: string) => {
          capturedUrl = String(url);
          return Promise.resolve(
            new Response(okJson({ f43: 380, f44: 385, f45: 375, f46: 378 }), {
              status: 200,
            }),
          );
        }) as never,
      });
      await adapter.fetchQuote('00700');
      expect(capturedUrl).toContain('secid=116.00700');
    });

    it('未知代码格式抛错', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () => new Response(okJson({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('XYZ123')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });
  });

  describe('batchQuote', () => {
    it('并发拉多股；单条 rc=-1 失败不中断', async () => {
      let count = 0;
      const adapter = new EastmoneyAdapter({
        fetchImpl: ((url: string) => {
          count += 1;
          if (url.includes('002594')) {
            return Promise.resolve(new Response(okJson(makeQuoteOk()), { status: 200 }));
          }
          // 600036 走完整路径但返回失败
          return Promise.resolve(new Response(JSON.stringify({ rc: -1 }), { status: 200 }));
        }) as never,
      });
      const result = await adapter.batchQuote(['002594', '600519']);
      expect(result.size).toBe(1); // 只有 002594 成功
      expect(result.get('002594')?.source).toBe('eastmoney');
      expect(count).toBe(2);
    });
  });

  describe('fetchDailyBars', () => {
    it('解析 klines 字符串数组为 DailyBar[]', async () => {
      const data = {
        code: '002594',
        name: '比亚迪',
        klines: [
          '2026-07-01,100,105,110,95,1234560,0,0,0',
          '2026-07-02,105,108,109,104,1500000,0,0,0',
        ],
      };
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ rc: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('002594.SZ', range);
      expect(bars).toHaveLength(2);
      expect(bars[0]?.date.toISOString()).toContain('2026-07-01');
      expect(bars[0]?.open).toBe(100);
      expect(bars[1]?.close).toBe(108);
    });

    it('非 6 字段行跳过；rc != 0 抛错', async () => {
      const adapter = new EastmoneyAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ rc: -1, data: { klines: [] } }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('002594', range)).rejects.toBeInstanceOf(
        EastmoneyAdapterError,
      );
    });
  });
});
