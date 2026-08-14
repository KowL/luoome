import { describe, expect, it } from 'vitest';

import { SinaStockUniverseAdapter } from './sina.js';

describe('stock-universe/SinaStockUniverseAdapter', () => {
  it('按沪深分市场分页读取真实目录协议并生成完整快照', async () => {
    const requests: URL[] = [];
    const adapter = new SinaStockUniverseAdapter({
      clock: () => new Date('2026-08-13T08:20:00.000Z'),
      pageSize: 2,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const node = url.searchParams.get('node');
        if (url.pathname.includes('getHQNodeStockCount')) {
          return new Response(node === 'sh_a' ? '"3"' : '2');
        }
        const page = Number(url.searchParams.get('page'));
        const rows =
          node === 'sh_a'
            ? page === 1
              ? [
                  { symbol: 'sh600000', code: '600000', name: '浦发银行' },
                  { symbol: 'sh600519', code: '600519', name: '贵州茅台' },
                ]
              : [{ symbol: 'sh601318', code: '601318', name: '中国平安' }]
            : page === 1
              ? [
                  { symbol: 'sz000001', code: '000001', name: '平安银行' },
                  { symbol: 'sz002594', code: '002594', name: '比亚迪' },
                ]
              : [];
        return new Response(JSON.stringify(rows));
      }) as typeof fetch,
    });

    const snapshot = await adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ');

    expect(snapshot.source).toBe('sina');
    expect(snapshot.reportedTotal).toBe(5);
    expect(snapshot.entries.map((entry) => entry.stockId)).toEqual([
      '600000.SH',
      '600519.SH',
      '601318.SH',
      '000001.SZ',
      '002594.SZ',
    ]);
    expect(snapshot.entries.every((entry) => entry.listingStatus === 'unknown')).toBe(true);
    expect(requests.filter((url) => url.pathname.includes('getHQNodeStockCount'))).toHaveLength(2);
    expect(requests.filter((url) => url.searchParams.get('node') === 'sh_a')).toHaveLength(3);
    expect(requests.filter((url) => url.searchParams.get('node') === 'sz_a')).toHaveLength(2);
  });

  it('目录数量与分页结果不一致时拒绝 partial 快照', async () => {
    const adapter = new SinaStockUniverseAdapter({
      pageSize: 2,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('getHQNodeStockCount')) return new Response('2');
        if (url.searchParams.get('page') !== '1') return new Response('[]');
        return new Response(
          JSON.stringify([{ symbol: 'sh600000', code: '600000', name: '浦发银行' }]),
        );
      }) as typeof fetch,
    });

    await expect(adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ')).rejects.toThrow(
      'partial_data: sina sh_a ended at 1/2 entries',
    );
  });

  it('拒绝超出覆盖范围或 symbol/code 不一致的响应', async () => {
    const adapter = new SinaStockUniverseAdapter({
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes('getHQNodeStockCount')) return new Response('1');
        return new Response(
          JSON.stringify([{ symbol: 'sz000001', code: '000002', name: '平安银行' }]),
        );
      }) as typeof fetch,
    });

    await expect(adapter.fetchStockUniverse('HK_EQUITIES')).rejects.toThrow('unsupported_market');
    await expect(adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ')).rejects.toThrow(
      'invalid_payload: sina sh_a symbol/code mismatch',
    );
  });
});
