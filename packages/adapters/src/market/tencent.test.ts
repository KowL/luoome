import { stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { TencentAdapter, TencentAdapterError } from './tencent.js';

describe('market/tencent', () => {
  describe('fetchQuote', () => {
    // 真实 API 形状（2026-07 实测）：data 以 prefixed code 为 key，
    // 内层 data.data 是 "HHMM price volume amount" 分钟行数组
    const minuteBody = (code: string) =>
      JSON.stringify({
        code: 0,
        data: {
          [code]: {
            data: { date: '20260724', data: ['0930 375 100 37500.00', '1530 380 120 45600.00'] },
          },
        },
      });

    it('解析 minute 接口；source=tencent', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('hk00700'), { status: 200 })) as never,
        clock: () => new Date('2026-07-24T08:00:00.000Z'),
      });
      const q = await adapter.fetchQuote('00700');
      expect(q.close).toBe(380);
      expect(q.open).toBe(375);
      expect(q.high).toBe(380);
      expect(q.low).toBe(375);
      expect(q.volume).toBe(12_000); // 分钟量为累计口径：末行 120 手 × 100 = 股
      expect(q.amount).toBe(45600); // 分钟额同为累计口径：末行第四列（元）
      expect(q.source).toBe('tencent');
      expect(q.observedAt).toEqual(new Date('2026-07-24T07:30:00.000Z'));
      expect(q.fetchedAt).toEqual(new Date('2026-07-24T08:00:00.000Z'));
      expect(q.timestampSource).toBe('upstream');
    });

    it('缺价抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('00700')).rejects.toBeInstanceOf(TencentAdapterError);
    });

    it('qt 快照第 4 段为昨收、第 38 段为换手率 → 填充；qt 失败 → 两字段缺省不抛错', async () => {
      const segments = Array.from({ length: 39 }, () => '');
      segments[0] = '1';
      segments[1] = '贵州茅台';
      segments[2] = '600519';
      segments[4] = '370';
      segments[38] = '0.35';
      const rtBody = (code: string) => `v_${code}="${segments.join('~')}";`;
      const withRt = new TencentAdapter({
        fetchImpl: ((url: string) =>
          Promise.resolve(
            new Response(
              String(url).includes('qt.gtimg.cn') ? rtBody('sh600519') : minuteBody('sh600519'),
              { status: 200 },
            ),
          )) as never,
      });
      const q1 = await withRt.fetchQuote('600519');
      expect(q1.prevClose).toBe(370);
      expect(q1.turnoverRatePct).toBe(0.35);

      const rtDown = new TencentAdapter({
        fetchImpl: ((url: string) =>
          String(url).includes('qt.gtimg.cn')
            ? Promise.reject(new Error('rt down'))
            : Promise.resolve(new Response(minuteBody('sh600519'), { status: 200 }))) as never,
      });
      const q2 = await rtDown.fetchQuote('600519');
      expect(q2.close).toBe(380);
      expect(q2.prevClose).toBeUndefined();
      expect(q2.turnoverRatePct).toBeUndefined();
    });

    it('港股代码 → hk 前缀', async () => {
      const capturedUrls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrls.push(String(url));
          return Promise.resolve(new Response(minuteBody('hk00700'), { status: 200 }));
        }) as never,
      });
      await adapter.fetchQuote('00700');
      expect(capturedUrls[0]).toContain('code=hk00700');
    });

    it('SH 代码 → sh 前缀', async () => {
      const capturedUrls: string[] = [];
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrls.push(String(url));
          return Promise.resolve(new Response(minuteBody('sh600519'), { status: 200 }));
        }) as never,
      });
      await adapter.fetchQuote('600519');
      expect(capturedUrls[0]).toContain('code=sh600519');
    });
  });

  describe('fetchIntradayMinutes', () => {
    const minuteBody = (
      code: string,
      rows: string[] = ['0930 375 100 37500.00', '1530 380 120 45600.00'],
    ) =>
      JSON.stringify({
        code: 0,
        data: { [code]: { data: { date: '20260724', data: rows } } },
      });

    it('分钟行整行保留累计口径；time 由 date+HHMM 投影（上海时区）', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('sh600519'), { status: 200 })) as never,
      });
      const points = await adapter.fetchIntradayMinutes('600519');
      expect(points).toHaveLength(2);
      expect(points[0]).toMatchObject({
        stockId: '600519',
        price: 375,
        cumVolume: 10_000, // 100 手 × 100 = 股
        cumAmount: 37500,
        source: 'tencent',
      });
      expect(points[0]?.time).toEqual(new Date('2026-07-24T01:30:00.000Z'));
      expect(points[1]?.cumVolume).toBe(12_000);
    });

    it('空分钟数组 → 空序列（盘前 / 非交易日合法空态，不抛错）', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(minuteBody('sz002594', []), { status: 200 })) as never,
      });
      await expect(adapter.fetchIntradayMinutes('002594')).resolves.toEqual([]);
    });

    it('时间 / 价格非法的行丢弃', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(
            minuteBody('sh600519', [
              '09 375 100 37500.00',
              '0930 0 100 37500.00',
              '0931 376 101 37856.00',
            ]),
            {
              status: 200,
            },
          )) as never,
      });
      const points = await adapter.fetchIntradayMinutes('600519');
      expect(points).toHaveLength(1);
      expect(points[0]?.price).toBe(376);
    });
  });

  describe('fetchDailyBars', () => {
    it('解析 fqkline day 字段；按 range 过滤', async () => {
      // 真实 API 形状（2026-07 实测）：data 以 code 为 key，元素为字符串数组
      const data = {
        sh600519: {
          qfqday: [
            ['2026-07-01', '100', '105', '110', '95', '1234560'],
            ['2026-07-02', '105', '108', '109', '104', '1500000'],
            ['2026-06-30', '99', '100', '102', '98', '800000'], // 早于 range.start
          ],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('600519', range);
      expect(bars).toHaveLength(2);
      expect(bars[0]?.date.toISOString()).toContain('2026-07-01');
      expect(bars.every((bar) => bar.adjustment === 'qfq')).toBe(true);
    });

    it('qfqday 优先于 day', async () => {
      const data = {
        sh600519: {
          qfqday: [['2026-07-01', '100', '105', '110', '95', '100']],
          day: [['2026-07-01', '99', '99', '99', '99', '1']], // 不应被使用
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('600519', range);
      expect(bars[0]?.volume).toBe(10_000); // 100 手 × 100 = 股
    });

    it('只有 raw day 时拒绝伪装为 qfq', async () => {
      const data = {
        sh600519: {
          day: [['2026-07-01', '99', '99', '99', '99', '1']],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toThrow(
        /unsupported_adjustment/,
      );
    });

    it('指数只有 raw day 时按指数真实口径接受', async () => {
      const data = {
        sh000300: {
          day: [['2026-07-01', '3900', '3910', '3920', '3890', '1000']],
        },
      };
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      const bars = await adapter.fetchDailyBars('000300.SH', range);
      expect(bars).toHaveLength(1);
      expect(bars[0]).toMatchObject({ stockId: '000300.SH', close: 3910, adjustment: 'qfq' });
    });

    it('data 缺 code 节点 → 空数据抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toBeInstanceOf(
        TencentAdapterError,
      );
    });

    it('code != 0 抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ code: -1 }), { status: 200 })) as never,
      });
      const range = { start: new Date('2026-07-01'), end: new Date('2026-07-31') };
      await expect(adapter.fetchDailyBars('600519', range)).rejects.toBeInstanceOf(
        TencentAdapterError,
      );
    });
  });

  describe('fetchMarketSnapshotEnvelope', () => {
    const universe = {
      name: 'test-universe',
      coverage: ['CN_A_SHARES_SH_SZ'] as const,
      fetchStockUniverse: async () => ({
        source: 'test-universe',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: new Date('2026-08-13T07:30:00.000Z'),
        complete: true as const,
        reportedTotal: 2,
        entries: [
          {
            stockId: '600519.SH',
            code: stockCode('600519'),
            exchange: 'SH' as const,
            name: '贵州茅台',
            listingStatus: 'unknown' as const,
          },
          {
            stockId: '000001.SZ',
            code: stockCode('000001'),
            exchange: 'SZ' as const,
            name: '平安银行',
            listingStatus: 'unknown' as const,
          },
        ],
      }),
    };

    const snapshotLine = (exchange: string, code: string, close: string, changePct: string) => {
      const fields = Array.from({ length: 33 }, () => '');
      fields[0] = exchange === 'sh' ? '1' : '51';
      fields[1] = 'ignored by directory';
      fields[2] = code;
      fields[3] = close;
      fields[30] = '20260813161452';
      fields[32] = changePct;
      return `v_${exchange}${code}="${fields.join('~')}";`;
    };

    it('按真实目录批量请求并生成完整 envelope', async () => {
      const urls: string[] = [];
      const adapter = new TencentAdapter({
        stockUniverse: universe,
        marketSnapshotChunkSize: 1,
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          const body = String(url).includes('sh600519')
            ? snapshotLine('sh', '600519', '1355.29', '0.92')
            : snapshotLine('sz', '000001', '11.25', '0');
          return Promise.resolve(new Response(body, { status: 200 }));
        }) as never,
      });
      const snapshot = await adapter.fetchMarketSnapshotEnvelope();
      expect(snapshot.source).toBe('tencent');
      expect(snapshot.completeness).toEqual({
        expectedCount: 2,
        receivedCount: 2,
        missingCount: 0,
        duplicateCount: 0,
        complete: true,
      });
      expect(snapshot.items).toEqual([
        expect.objectContaining({ id: '600519.SH', close: 1355.29, changePct: 0.92 }),
        expect.objectContaining({ id: '000001.SZ', close: 11.25, changePct: 0 }),
      ]);
      expect(urls).toHaveLength(2);
      expect(urls.every((url) => url.startsWith('https://qt.gtimg.cn/q='))).toBe(true);
    });

    it('报价缺失时保留 partial envelope，不填充 0', async () => {
      const adapter = new TencentAdapter({
        stockUniverse: universe,
        fetchImpl: (async () =>
          new Response(snapshotLine('sh', '600519', '1355.29', '0.92'), { status: 200 })) as never,
      });
      const snapshot = await adapter.fetchMarketSnapshotEnvelope();
      expect(snapshot.completeness).toMatchObject({
        expectedCount: 2,
        receivedCount: 1,
        missingCount: 1,
        complete: false,
      });
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]).not.toHaveProperty('close', 0);
    });
  });
});
