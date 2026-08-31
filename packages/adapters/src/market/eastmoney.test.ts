import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { SourceExecutionError } from '../source-error.js';
import { EastmoneyAdapterError, parseEastmoneyClist } from './eastmoney.js';

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
  f124: 1784876400,
  f57: '002594',
  f58: '比亚迪',
  f168: 0.69,
  f169: 100,
  f170: 0.95,
});

describe('market/eastmoney', () => {
  describe('fetchQuote', () => {
    it('成功解析 quote；source=eastmoney', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
        clock: () => new Date('2026-07-24T07:00:05.000Z'),
      });
      const q = await adapter.fetchQuote('002594');
      expect(q.close).toBeGreaterThan(0);
      expect(q.source).toBe('eastmoney');
      expect(q.volume).toBe(123456 * 100); // 手 → 股
      expect(q.observedAt).toEqual(new Date('2026-07-24T07:00:00.000Z'));
      expect(q.fetchedAt).toEqual(new Date('2026-07-24T07:00:05.000Z'));
      expect(q.timestampSource).toBe('upstream');
    });

    it('f60 昨收 → prevClose 填充；f60 缺失 → 无 prevClose', async () => {
      const withPrev = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
      });
      const q1 = await withPrev.fetchQuote('002594');
      expect(q1.prevClose).toBe(10400);

      const noF60 = makeQuoteOk();
      delete (noF60 as Record<string, unknown>).f60;
      const withoutPrev = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(noF60), { status: 200 })) as never,
      });
      const q2 = await withoutPrev.fetchQuote('002594');
      expect(q2.prevClose).toBeUndefined();
    });

    it('f48 成交额 / f168 换手率 → amount / turnoverRatePct 填充；缺失则省略', async () => {
      const withFields = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
      });
      const q1 = await withFields.fetchQuote('002594');
      expect(q1.amount).toBe(987654321);
      expect(q1.turnoverRatePct).toBe(0.69);

      const noFields = makeQuoteOk() as Record<string, unknown>;
      delete noFields.f48;
      delete noFields.f168;
      const withoutFields = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(noFields), { status: 200 })) as never,
      });
      const q2 = await withoutFields.fetchQuote('002594');
      expect(q2.amount).toBeUndefined();
      expect(q2.turnoverRatePct).toBeUndefined();
    });

    it('stockCode 带 exchange 后缀时仍能正确解析', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson(makeQuoteOk()), { status: 200 })) as never,
      });
      const q = await adapter.fetchQuote('002594.SZ');
      expect(q.stockId).toBe('002594.SZ');
    });

    it('rc != 0 时抛 EastmoneyAdapterError', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(JSON.stringify({ rc: -1 }), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });

    it('HTTP 500 时抛结构化传输错误（client 层，非 EastmoneyAdapterError）', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () =>
          new Response('oops', { status: 500, statusText: 'Server Error' })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(SourceExecutionError);
      await expect(adapter.fetchQuote('002594')).rejects.toMatchObject({
        kind: 'upstream_error',
      });
    });

    it('f43 缺失时抛错', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('002594')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });

    it('港股 5 位代码 → secid 116.xxxxx', async () => {
      let capturedUrl = '';
      const adapter = new EastmoneySource({
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
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(okJson({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('XYZ123')).rejects.toBeInstanceOf(EastmoneyAdapterError);
    });
  });

  describe('batchQuote', () => {
    it('并发拉多股；单条 rc=-1 失败不中断', async () => {
      let count = 0;
      const adapter = new EastmoneySource({
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

  describe('fetchBatchQuotes（原生批量）', () => {
    it('单次请求多 secid；缺漏标的不占位', async () => {
      const urls: string[] = [];
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          return Promise.resolve(
            new Response(
              okJson({
                diff: [
                  {
                    f12: '600519',
                    f13: '1',
                    f2: 1355.29,
                    f17: 1350,
                    f15: 1360,
                    f16: 1340,
                    f5: 1000,
                    f6: 100000,
                    f18: 1350,
                    f8: 0.5,
                    f124: 1755555555,
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }) as never,
      });
      const quotes = await adapter.fetchBatchQuotes(['600519', '002594']);
      // 一次请求包含两只的 secid；002594 无对应行 → 只返回 600519
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('secids=1.600519,0.002594');
      expect(quotes).toHaveLength(1);
      expect(quotes[0]?.stockId).toBe('600519');
      expect(quotes[0]?.close).toBe(1355.29);
    });
  });

  describe('fetchIntradayMinutes', () => {
    it('解析 trends2 指数分时，把单分钟量额累加为当日累计口径', async () => {
      let capturedUrl = '';
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          capturedUrl = String(url);
          return Promise.resolve(
            new Response(
              okJson({
                trends: [
                  '2026-08-31 09:30,3926.53,3926.53,3926.53,3926.53,100,1000.00,3926.53',
                  '2026-08-31 09:31,3928.00,3928.00,3928.00,3928.00,120,1300.00,3927.20',
                ],
              }),
              { status: 200 },
            ),
          );
        }) as never,
      });

      const points = await adapter.fetchIntradayMinutes('000001.SH');

      expect(capturedUrl).toContain('/api/qt/stock/trends2/get');
      expect(capturedUrl).toContain('secid=1.000001');
      expect(points).toEqual([
        {
          stockId: '000001.SH',
          time: new Date('2026-08-31T01:30:00.000Z'),
          price: 3926.53,
          cumVolume: 10_000,
          cumAmount: 1000,
          source: 'eastmoney',
        },
        {
          stockId: '000001.SH',
          time: new Date('2026-08-31T01:31:00.000Z'),
          price: 3928,
          cumVolume: 22_000,
          cumAmount: 2300,
          source: 'eastmoney',
        },
      ]);
    });
  });

  describe('fetchIndexQuotes', () => {
    it('并发解析 6 只主要指数；f58 名称为准', async () => {
      const adapter = new EastmoneySource({
        clock: () => new Date('2026-07-28T01:00:00.000Z'),
        fetchImpl: ((url: string) => {
          const secid = String(url).match(/secid=([\w.]+)/)?.[1] ?? '';
          const code = secid.split('.')[1] ?? secid;
          return Promise.resolve(
            new Response(
              okJson({ f43: 3500.5, f57: code, f58: `指数${code}`, f169: 12.3, f170: 0.35 }),
              { status: 200 },
            ),
          );
        }) as never,
      });
      const indices = await adapter.fetchIndexQuotes();
      expect(indices).toHaveLength(6);
      expect(indices.map((q) => q.code)).toEqual([
        '000001',
        '399001',
        '399006',
        '000300',
        '000688',
        'HSI',
      ]);
      const first = indices[0];
      expect(first?.name).toBe('指数000001');
      expect(first?.close).toBe(3500.5);
      expect(first?.change).toBe(12.3);
      expect(first?.changePct).toBe(0.35);
      expect(first?.source).toBe('eastmoney');
      expect(first?.ts.toISOString()).toBe('2026-07-28T01:00:00.000Z');
    });

    it('单只失败被跳过（rc=-1 / f43 缺失），其余正常返回', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          const secid = String(url).match(/secid=([\w.]+)/)?.[1] ?? '';
          const code = secid.split('.')[1] ?? secid;
          if (code === '399001') {
            return Promise.resolve(new Response(JSON.stringify({ rc: -1 }), { status: 200 }));
          }
          if (code === '000300') {
            return Promise.resolve(new Response(okJson({ f57: code, f58: 'x' }), { status: 200 }));
          }
          return Promise.resolve(
            new Response(okJson({ f43: 100, f57: code, f58: `指数${code}`, f169: 1, f170: 1 }), {
              status: 200,
            }),
          );
        }) as never,
      });
      const indices = await adapter.fetchIndexQuotes();
      expect(indices.map((q) => q.code)).toEqual(['000001', '399006', '000688', 'HSI']);
    });

    it('全部失败抛 EastmoneyAdapterError', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () => new Response(JSON.stringify({ rc: -1 }), { status: 200 })) as never,
      });
      await expect(adapter.fetchIndexQuotes()).rejects.toBeInstanceOf(EastmoneyAdapterError);
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
      const adapter = new EastmoneySource({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ rc: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('002594.SZ', range);
      expect(bars).toHaveLength(2);
      expect(bars[0]?.date.toISOString()).toContain('2026-07-01');
      expect(bars[0]?.open).toBe(100);
      expect(bars[1]?.close).toBe(108);
      expect(bars[0]?.volume).toBe(123_456_000); // 手 → 股（×100）
      expect(bars.every((bar) => bar.adjustment === 'qfq')).toBe(true);
      expect(bars.every((bar) => bar.sourceAdjFactor === undefined)).toBe(true);
    });

    it('非 6 字段行跳过；rc != 0 抛错', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ rc: -1, data: { klines: [] } }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('002594', range)).rejects.toBeInstanceOf(
        EastmoneyAdapterError,
      );
    });
  });

  describe('parseEastmoneyClist', () => {
    it('marketId 映射 1→SH / 0→SZ，其它丢弃；f2="-" 时省略 close 但保留条目', () => {
      const items = parseEastmoneyClist({
        rc: 0,
        data: {
          total: 4,
          diff: [
            { f12: '600519', f13: 1, f14: '贵州茅台', f2: 1486.2, f3: 1.2 },
            { f12: '000001', f13: 0, f14: '平安银行', f2: 11.5, f3: -0.5 },
            { f12: '830799', f13: 0, f14: '北交所股', f2: 5, f3: 0 },
            { f12: '200002', f13: 2, f14: 'B股', f2: 3, f3: 0 },
            { f12: '600000', f13: 1, f14: '浦发银行', f2: '-', f3: '-' },
          ],
        },
      });
      // f13=0 的北交所股在本接口 fs 范围外也不该出现，但 parse 只按 marketId 映射 → 保留；
      // f13=2（B 股）丢弃；f2='-' 保留但无 close。
      expect(items.map((i) => i.id)).toEqual(['600519.SH', '000001.SZ', '830799.SZ', '600000.SH']);
      expect(items[0]).toMatchObject({ close: 1486.2, changePct: 1.2 });
      expect(items[3]?.close).toBeUndefined();
      expect(items[3]?.changePct).toBeUndefined();
    });

    it('rc != 0 → 抛 EastmoneyAdapterError', () => {
      expect(() => parseEastmoneyClist({ rc: -1 })).toThrow(EastmoneyAdapterError);
    });
  });

  describe('fetchMarketSnapshot', () => {
    /** 生成一页 clist diff。 */
    const makePage = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        f12: String(600000 + from + i),
        f13: 1,
        f14: `测试股${from + i}`,
        f2: 10,
        f3: 1,
      }));

    it('满页继续翻页，不足一页停止；结果为多页合并', async () => {
      const requestedPages: number[] = [];
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          const pn = Number(new URL(url).searchParams.get('pn'));
          requestedPages.push(pn);
          const diff = pn === 1 ? makePage(0, 500) : makePage(500, 3);
          return Promise.resolve(
            new Response(JSON.stringify({ rc: 0, data: { total: 503, diff } }), { status: 200 }),
          );
        }) as never,
      });
      const items = await adapter.fetchMarketSnapshot();
      expect(requestedPages).toEqual([1, 2]);
      expect(items.length).toBe(503);
      expect(items[0]?.exchange).toBe('SH');
    });

    it('返回带分页完整性、来源和抓取时间的 envelope', async () => {
      const adapter = new EastmoneySource({
        clock: () => new Date('2026-07-28T08:00:00.000Z'),
        fetchImpl: ((url: string) => {
          const pn = Number(new URL(url).searchParams.get('pn'));
          const diff = pn === 1 ? makePage(0, 500) : makePage(500, 3);
          return Promise.resolve(
            new Response(JSON.stringify({ rc: 0, data: { total: 503, diff } }), { status: 200 }),
          );
        }) as never,
      });
      const snapshot = await adapter.fetchMarketSnapshotEnvelope();
      expect(snapshot).toMatchObject({
        source: 'eastmoney',
        coverage: 'CN_A_SHARES_SH_SZ',
        fetchedAt: new Date('2026-07-28T08:00:00.000Z'),
        completeness: {
          expectedCount: 503,
          receivedCount: 503,
          missingCount: 0,
          duplicateCount: 0,
          complete: true,
        },
      });
    });

    it('累计达到 total 时提前停止', async () => {
      const requestedPages: number[] = [];
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          const pn = Number(new URL(url).searchParams.get('pn'));
          requestedPages.push(pn);
          return Promise.resolve(
            new Response(JSON.stringify({ rc: 0, data: { total: 500, diff: makePage(0, 500) } }), {
              status: 200,
            }),
          );
        }) as never,
      });
      const items = await adapter.fetchMarketSnapshot();
      expect(requestedPages).toEqual([1]);
      expect(items.length).toBe(500);
    });

    it('任一页失败 → 抛结构化错误（不返回半拉子全集）', async () => {
      const adapter = new EastmoneySource({
        fetchImpl: ((url: string) => {
          const pn = Number(new URL(url).searchParams.get('pn'));
          if (pn === 2) return Promise.resolve(new Response('oops', { status: 500 }));
          return Promise.resolve(
            new Response(JSON.stringify({ rc: 0, data: { total: 1000, diff: makePage(0, 500) } }), {
              status: 200,
            }),
          );
        }) as never,
      });
      await expect(adapter.fetchMarketSnapshot()).rejects.toBeInstanceOf(SourceExecutionError);
    });
  });
});
