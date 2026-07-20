import { describe, expect, it } from 'vitest';

import { TencentAdapter, TencentAdapterError } from './tencent.js';

describe('market/tencent', () => {
  describe('fetchQuote', () => {
    it('解析 minute 接口；source=tencent', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ data: { data: { now: 380, open: 375 } } }), {
            status: 200,
          })) as never,
      });
      const q = await adapter.fetchQuote('00700');
      expect(q.close).toBe(380);
      expect(q.source).toBe('tencent');
    });

    it('缺价抛错', async () => {
      const adapter = new TencentAdapter({
        fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as never,
      });
      await expect(adapter.fetchQuote('00700')).rejects.toBeInstanceOf(TencentAdapterError);
    });

    it('港股代码 → hk 前缀', async () => {
      let capturedUrl = '';
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrl = String(url);
          return Promise.resolve(
            new Response(JSON.stringify({ data: { data: { now: 380, open: 375 } } }), {
              status: 200,
            }),
          );
        }) as never,
      });
      await adapter.fetchQuote('00700');
      expect(capturedUrl).toContain('code=hk00700');
    });

    it('SH 代码 → sh 前缀', async () => {
      let capturedUrl = '';
      const adapter = new TencentAdapter({
        fetchImpl: ((url: string) => {
          capturedUrl = String(url);
          return Promise.resolve(
            new Response(JSON.stringify({ data: { data: { now: 10, open: 9.9 } } }), {
              status: 200,
            }),
          );
        }) as never,
      });
      await adapter.fetchQuote('600519');
      expect(capturedUrl).toContain('code=sh600519');
    });
  });

  describe('fetchDailyBars', () => {
    it('解析 fqkline day 字段；按 range 过滤', async () => {
      // 真实 API 形状（2026-07 实测）：data 以 code 为 key，元素为字符串数组
      const data = {
        sh600519: {
          day: [
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
      expect(bars[0]?.volume).toBe(100);
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
