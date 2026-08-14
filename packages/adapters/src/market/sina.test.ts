import { describe, expect, it } from 'vitest';

import { SinaAdapter } from './sina.js';

describe('market/SinaAdapter', () => {
  it('将 raw 日线与真实 qfq 因子合成为 qfq DailyBar，成交量保持股', async () => {
    const urls: string[] = [];
    const adapter = new SinaAdapter({
      fetchImpl: (async (input) => {
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
      }) as typeof fetch,
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
      fetchImpl: (async (input) => {
        if (String(input).endsWith('/qfq.js')) return new Response('var sh600519qfq={"data":[]};');
        return new Response(
          JSON.stringify([
            { day: '2026-08-12', open: '100', high: '101', low: '99', close: '100', volume: '10' },
          ]),
        );
      }) as typeof fetch,
    });

    await expect(
      adapter.fetchDailyBars('600519.SH', {
        start: new Date('2026-08-01T00:00:00.000Z'),
        end: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ).rejects.toThrow('unsupported_adjustment');
  });
});
