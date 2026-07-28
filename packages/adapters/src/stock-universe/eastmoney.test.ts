import { describe, expect, it } from 'vitest';

import { EastmoneyStockUniverseAdapter } from './eastmoney.js';

describe('stock-universe/EastmoneyStockUniverseAdapter', () => {
  it('按稳定代码排序拉完全部分页并返回完整快照', async () => {
    const urls: URL[] = [];
    const adapter = new EastmoneyStockUniverseAdapter({
      clock: () => new Date('2026-07-28T08:20:00.000Z'),
      pageSize: 2,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        const page = Number(url.searchParams.get('pn'));
        const diff =
          page === 1
            ? [
                { f12: '002594', f13: 0, f14: '比亚迪' },
                { f12: '600519', f13: 1, f14: '贵州茅台' },
              ]
            : [{ f12: '601318', f13: 1, f14: '中国平安' }];
        return new Response(JSON.stringify({ rc: 0, data: { total: 3, diff } }));
      }) as typeof fetch,
    });

    const snapshot = await adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ');

    expect(snapshot.complete).toBe(true);
    expect(snapshot.reportedTotal).toBe(3);
    expect(snapshot.entries.map((entry) => entry.stockId)).toEqual([
      '002594.SZ',
      '600519.SH',
      '601318.SH',
    ]);
    expect(snapshot.observedAt).toEqual(new Date('2026-07-28T08:20:00.000Z'));
    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get('fid')).toBe('f12');
    expect(urls[0]?.searchParams.get('fields')).toBe('f12,f13,f14');
  });
});
