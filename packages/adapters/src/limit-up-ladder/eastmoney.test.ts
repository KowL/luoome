import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { SourceExecutionError } from '../source-error.js';

/**
 * EastmoneySource.fetchLadder 委托测试（getTopicZTPool）。
 * 解析断言保留自原 EastmoneyLimitUpLadderAdapter 测试；传输错误收敛为 SourceExecutionError。
 * 全程 fetchImpl stub，不依赖网络。
 */

const POOL_FIXTURE = {
  data: {
    pool: [
      {
        c: '600001',
        n: '测试股份',
        p: 11000, // ×1000 → 11.00
        zdp: 10, // ×100 → 10%
        lbc: 3,
        fbt: 93000,
        lbt: 142842,
        hybk: '半导体',
      },
      {
        c: '000002',
        n: '首板股份',
        p: 5500, // → 5.50
        zdp: 9.98,
        lbc: 1,
        fbt: 92500,
        lbt: 92500,
        hybk: '地产',
      },
    ],
  },
};

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

/** 2026-07-24 上海 16:00（已收盘）。 */
const afterClose = () => new Date('2026-07-24T08:00:00.000Z');

describe('EastmoneySource.fetchLadder', () => {
  it('pool 字段映射：close=p/1000、pre_close 反推、level=lbc、时间 HH:MM:SS、行业', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(POOL_FIXTURE), { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl, clock: afterClose });
    const result = await source.fetchLadder('2026-07-24');

    expect(urls[0]).toContain('getTopicZTPool');
    expect(urls[0]).toContain('date=20260724');
    expect(result.date).toBe('2026-07-24');
    expect(result.entries).toHaveLength(2);

    const first = result.entries[0];
    expect(first?.code).toBe('600001');
    expect(first?.name).toBe('测试股份');
    expect(first?.close).toBe(11);
    expect(first?.pre_close).toBeCloseTo(10, 5);
    expect(first?.change_pct).toBeCloseTo(0.1, 5);
    expect(first?.level).toBe(3);
    expect(first?.limit_up_days).toBe(3);
    expect(first?.first_time).toBe('09:30:00');
    expect(first?.final_time).toBe('14:28:42');
    expect(first?.industry).toBe('半导体');
    expect(first?.limit_up_date).toBe('2026-07-24');

    const second = result.entries[1];
    expect(second?.level).toBe(1); // 首板
    expect(second?.close).toBe(5.5);
  });

  it('observedAt：已收盘的历史日为该日收盘时刻（15:00 +08:00）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(POOL_FIXTURE), { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl, clock: afterClose });
    const result = await source.fetchLadder('2026-07-24');
    expect(result.observedAt).toEqual(new Date('2026-07-24T07:00:00.000Z'));
  });

  it('observedAt：当日盘中为 fetchedAt（min(fetchedAt, 收盘)）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(POOL_FIXTURE), { status: 200 })),
    );
    // 2026-07-24 上海 10:00（盘中）
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-07-24T02:00:00.000Z'),
    });
    const result = await source.fetchLadder('2026-07-24');
    expect(result.observedAt).toEqual(new Date('2026-07-24T02:00:00.000Z'));
  });

  it('lbc 缺失或 <1 → level 缺省（uncategorized 由 manager 判定）；fbt=0 → 时间缺省', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              pool: [{ c: '600003', n: '缺字段', p: 8000, zdp: 10, lbc: 0, fbt: 0, lbt: null }],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const source = new EastmoneySource({ fetchImpl });
    const [entry] = (await source.fetchLadder('2026-07-24')).entries;
    expect(entry?.level).toBeUndefined();
    expect(entry?.first_time).toBeUndefined();
    expect(entry?.final_time).toBeUndefined();
    expect(entry?.industry).toBeUndefined();
  });

  it('非交易日 / 空 pool（data=null）→ 空 entries，不抛错', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: null }), { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchLadder('2026-07-25');
    expect(result.entries).toEqual([]);
  });

  it('非法条目（缺代码 / 价格非法）被剔除', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              pool: [
                { n: '无代码', p: 1000 },
                { c: '600004', p: 0 },
                { c: '600005', p: 9000, zdp: 10, lbc: 2 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchLadder('2026-07-24');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.code).toBe('600005');
  });

  it('HTTP 非 2xx → SourceExecutionError（upstream_error，含状态码）', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('boom', { status: 502 })));
    const source = new EastmoneySource({ fetchImpl });
    await expect(source.fetchLadder('2026-07-24')).rejects.toMatchObject({
      name: 'SourceExecutionError',
      kind: 'upstream_error',
    });
    await expect(source.fetchLadder('2026-07-24')).rejects.toThrow(/HTTP 502/);
  });

  it('网络错误 → SourceExecutionError（network）', async () => {
    const { fetchImpl } = stubFetch(() => Promise.reject(new TypeError('socket hang up')));
    const source = new EastmoneySource({ fetchImpl });
    await expect(source.fetchLadder('2026-07-24')).rejects.toMatchObject({ kind: 'network' });
  });

  it('响应非 JSON → SourceExecutionError（invalid_payload）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response('not-json', { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl });
    const error = await source.fetchLadder('2026-07-24').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceExecutionError);
    expect((error as SourceExecutionError).kind).toBe('invalid_payload');
  });

  it('days 参数被忽略（连板数由 pool lbc 直接给出）', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(POOL_FIXTURE), { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl });
    await source.fetchLadder('2026-07-24', { days: 30 });
    expect(urls[0]).not.toContain('days');
  });
});
