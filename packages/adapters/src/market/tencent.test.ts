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

    it('qt 快照第 4 段为昨收 → prevClose 填充；qt 失败 → 无 prevClose 不抛错', async () => {
      const rtBody = (code: string) =>
        `v_${code}="1~贵州茅台~600519~380~370~376~53135~31245~21890~~20260728161459~";`;
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

      const rtDown = new TencentAdapter({
        fetchImpl: ((url: string) =>
          String(url).includes('qt.gtimg.cn')
            ? Promise.reject(new Error('rt down'))
            : Promise.resolve(new Response(minuteBody('sh600519'), { status: 200 }))) as never,
      });
      const q2 = await rtDown.fetchQuote('600519');
      expect(q2.close).toBe(380);
      expect(q2.prevClose).toBeUndefined();
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
});
