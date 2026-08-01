import { describe, expect, it } from 'vitest';

import { TushareStockUniverseAdapter } from './tushare.js';

const envelope = (items: readonly (readonly unknown[])[]): Response =>
  new Response(
    JSON.stringify({
      code: 0,
      msg: null,
      data: {
        fields: [
          'ts_code',
          'symbol',
          'name',
          'area',
          'industry',
          'market',
          'list_date',
          'delist_date',
        ],
        items,
      },
    }),
  );

describe('stock-universe/TushareStockUniverseAdapter', () => {
  it('合并 L/P/D 三种上市状态为一个完整目录快照', async () => {
    const statuses: string[] = [];
    const adapter = new TushareStockUniverseAdapter({
      clock: () => new Date('2026-07-28T08:20:00.000Z'),
      config: {
        url: 'https://tushare.test',
        token: 'test-token',
        timeoutMs: 100,
        retries: 0,
      },
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { params: { list_status: string } };
        statuses.push(body.params.list_status);
        if (body.params.list_status === 'L') {
          return envelope([
            ['600519.SH', '600519', '贵州茅台', '贵州', '白酒', '主板', '20010827', null],
          ]);
        }
        if (body.params.list_status === 'P') {
          return envelope([
            ['000001.SZ', '000001', '平安银行', '深圳', '银行', '主板', '19910403', null],
          ]);
        }
        return envelope([
          ['000002.SZ', '000002', '万科A', '深圳', '房地产', '主板', '19910129', '20261231'],
        ]);
      }) as typeof fetch,
    });

    const snapshot = await adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ');

    expect(statuses).toEqual(['L', 'P', 'D']);
    expect(snapshot.reportedTotal).toBe(3);
    expect(snapshot.entries.map((entry) => entry.listingStatus)).toEqual([
      'listed',
      'suspended',
      'delisted',
    ]);
    expect(snapshot.entries[0]?.industry).toBe('白酒');
    expect(snapshot.entries[2]?.delistDate).toEqual(new Date('2026-12-31T00:00:00.000Z'));
  });

  it('上游忽略 list_status 返回重复全集时按 stockId 去重，先出现的状态优先', async () => {
    const adapter = new TushareStockUniverseAdapter({
      clock: () => new Date('2026-07-28T08:20:00.000Z'),
      config: {
        url: 'https://tushare.test',
        token: 'test-token',
        timeoutMs: 100,
        retries: 0,
      },
      fetchImpl: (async (_input: unknown, _init?: RequestInit) =>
        envelope([
          ['600519.SH', '600519', '贵州茅台', '贵州', '白酒', '主板', '20010827', null],
          ['000001.SZ', '000001', '平安银行', '深圳', '银行', '主板', '19910403', null],
        ])) as unknown as typeof fetch,
    });

    const snapshot = await adapter.fetchStockUniverse('CN_A_SHARES_SH_SZ');

    expect(snapshot.reportedTotal).toBe(2);
    expect(snapshot.entries.map((entry) => entry.stockId)).toEqual(['600519.SH', '000001.SZ']);
    expect(snapshot.entries.every((entry) => entry.listingStatus === 'listed')).toBe(true);
  });
});
