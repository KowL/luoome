import { describe, expect, it } from 'vitest';

import { FuyaoClient } from './client.js';
import { FuyaoLimitUpAdapter } from './limit-up.js';

const config = { baseUrl: 'https://fuyao.test', apiKey: 'x', timeoutMs: 1_000, retries: 0 };

const stubFetch = (handler: (url: string) => Response) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve(handler(String(url)));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 0, message: 'success', data }), { status: 200 });

describe('FuyaoLimitUpAdapter', () => {
  it('涨停池分页拉全并按 date_ms/size 请求；只保留池成员与连板计数', async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1'
        ? envelope({
            timestamp: 1_762_000_000_000,
            pagination: { total: 3, pages: 2, size: 200, page: 1 },
            item: [
              { thscode: '600000.SH', continue_day_cnt: 2, open_times: 1 },
              { thscode: '000001.SZ', continue_day_cnt: 1 },
            ],
          })
        : envelope({
            timestamp: 1_762_000_000_000,
            pagination: { total: 3, pages: 2, size: 200, page: 2 },
            item: [{ thscode: '300001.SZ', continue_day_cnt: 3 }],
          });
    });
    const adapter = new FuyaoLimitUpAdapter(
      new FuyaoClient(config, { fetchImpl }),
      () => new Date('2026-11-12T08:05:00.000Z'),
    );

    const result = await adapter.fetchLimitUpPool('2026-11-12');

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/api/a-share/special-data/limit-up-pool');
    expect(urls[0]).toContain('date_ms=1794412800000');
    expect(urls[0]).toContain('size=200');
    expect(result.rows).toEqual([
      { stockId: '600000.SH', continueDayCnt: 2 },
      { stockId: '000001.SZ', continueDayCnt: 1 },
      { stockId: '300001.SZ', continueDayCnt: 3 },
    ]);
    expect(result.publishedAt.toISOString()).toBe('2025-11-01T12:26:40.000Z');
  });

  it('炸板池返回 stockId 集合；没有 timestamp 时回退到抓取时间', async () => {
    const { fetchImpl } = stubFetch(() =>
      envelope({
        pagination: { total: 2, pages: 1, size: 200, page: 1 },
        item: [{ thscode: '600519.SH' }, { thscode: '000002.SZ' }],
      }),
    );
    const fetchedAt = new Date('2026-11-12T08:05:00.000Z');
    const adapter = new FuyaoLimitUpAdapter(
      new FuyaoClient(config, { fetchImpl }),
      () => fetchedAt,
    );

    const result = await adapter.fetchLimitBreakPool('2026-11-12');

    expect(result.stockIds).toEqual(['600519.SH', '000002.SZ']);
    expect(result.publishedAt).toEqual(fetchedAt);
  });

  it('非标准代码直接拒绝，不把上游脏数据写进 PIT', async () => {
    const { fetchImpl } = stubFetch(() =>
      envelope({
        pagination: { total: 1, pages: 1, size: 200, page: 1 },
        item: [{ thscode: '600000' }],
      }),
    );
    const adapter = new FuyaoLimitUpAdapter(new FuyaoClient(config, { fetchImpl }));

    await expect(adapter.fetchLimitUpPool('2026-11-12')).rejects.toThrow('行形状不符');
  });
});
