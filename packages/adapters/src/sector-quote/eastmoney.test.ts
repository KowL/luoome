import { describe, expect, it } from 'vitest';

import { EastmoneySectorQuoteAdapter } from './eastmoney.js';

/**
 * EastmoneySectorQuoteAdapter 单元测试。
 * 全程 fetchImpl stub 模拟 clist/get 响应，不依赖网络。
 */

const SECTOR_FIXTURE = {
  rc: 0,
  data: {
    total: 2,
    diff: [
      {
        f2: 5599.4,
        f3: 8.68,
        f4: 447.44,
        f6: 12_729_206_234,
        f12: 'BK1616',
        f14: '白银',
        f104: 3,
        f105: 0,
        f124: 1_787_297_972,
        f128: '湖南白银',
        f140: '002716',
        f136: 10.03,
      },
      {
        f2: 2837.18,
        f3: 5.99,
        f4: 160.26,
        f6: 38_253_089_126,
        f12: 'BK0732',
        f14: '贵金属',
        f104: 12,
        f105: 0,
        f124: 1_787_297_972,
        f128: '湖南白银',
        f140: '002716',
        f136: 10.03,
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

const okJson = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('EastmoneySectorQuoteAdapter', () => {
  it('URL 构造：fs=m:90+t:2、fid 透传、pz=pageSize；字段映射：涨跌幅 /100 归一为小数', async () => {
    const { fetchImpl, urls } = stubFetch(() => okJson(SECTOR_FIXTURE));
    const adapter = new EastmoneySectorQuoteAdapter(fetchImpl);
    const result = await adapter.fetchList(50, 'f3');

    expect(urls[0]).toContain('clist/get');
    expect(urls[0]).toContain('fs=m%3A90%2Bt%3A2');
    expect(urls[0]).toContain('fid=f3');
    expect(urls[0]).toContain('pz=50');

    expect(result.items).toHaveLength(2);
    const first = result.items[0];
    expect(first?.code).toBe('BK1616');
    expect(first?.name).toBe('白银');
    expect(first?.price).toBe(5599.4);
    expect(first?.change_pct).toBeCloseTo(0.0868);
    expect(first?.change).toBe(447.44);
    expect(first?.amount).toBe(12_729_206_234);
    expect(first?.up_count).toBe(3);
    expect(first?.down_count).toBe(0);
    expect(first?.leading_stock_name).toBe('湖南白银');
    expect(first?.leading_stock_code).toBe('002716');
    expect(first?.leading_stock_change_pct).toBeCloseTo(0.1003);
  });

  it('缺领涨股 / 涨跌家数的条目保留为 undefined；缺 code/name/价格/涨跌幅的条目剔除', async () => {
    const { fetchImpl } = stubFetch(() =>
      okJson({
        rc: 0,
        data: {
          total: 3,
          diff: [
            { f2: 100, f3: 1.5, f4: 1.48, f6: 1_000_000, f12: 'BK0001', f14: '缺领涨股' },
            { f2: 100, f3: 1.5, f12: 'BK0002' }, // 缺名称
            { f2: 0, f3: 0, f12: 'BK0003', f14: '价格非法' },
          ],
        },
      }),
    );
    const adapter = new EastmoneySectorQuoteAdapter(fetchImpl);
    const result = await adapter.fetchList(50, 'f3');
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.code).toBe('BK0001');
    expect(item?.up_count).toBeUndefined();
    expect(item?.leading_stock_name).toBeUndefined();
  });

  it('data=null → 空列表；非 JSON / HTTP 非 2xx / 网络错误 → 抛错（manager 转 adapter_error）', async () => {
    const { fetchImpl: empty } = stubFetch(() => okJson({ rc: 0, data: null }));
    const result = await new EastmoneySectorQuoteAdapter(empty).fetchList(50, 'f3');
    expect(result.items).toEqual([]);

    const http502 = new EastmoneySectorQuoteAdapter((() =>
      Promise.resolve(new Response('boom', { status: 502 }))) as unknown as typeof fetch);
    await expect(http502.fetchList(50, 'f3')).rejects.toThrow(/HTTP 502/);

    const netErr = new EastmoneySectorQuoteAdapter((() =>
      Promise.reject(new TypeError('socket hang up'))) as unknown as typeof fetch);
    await expect(netErr.fetchList(50, 'f3')).rejects.toThrow(/请求失败/);

    const badJson = new EastmoneySectorQuoteAdapter((() =>
      Promise.resolve(new Response('not-json', { status: 200 }))) as unknown as typeof fetch);
    await expect(badJson.fetchList(50, 'f3')).rejects.toThrow(/不是有效 JSON/);
  });
});
