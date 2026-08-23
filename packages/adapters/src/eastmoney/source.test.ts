import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { EastmoneySource } from './source.js';

/**
 * EastmoneySource push2 → push2delay 传输层降级（source.ts 文件头注释）。
 * 以 fetchIndexQuotes 为代表路径：它经 marketJson 逐个拉 MAJOR_INDICES 快照。
 */

const INDEX_SNAPSHOT = {
  rc: 0,
  data: {
    f43: 3905.2,
    f57: '000001',
    f58: '上证指数',
    f60: 3903.72,
    f169: 1.48,
    f170: 0.04,
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

describe('EastmoneySource push2 阻断降级', () => {
  it('push2 network 失败 → 同 URL 换 push2delay 重试并成功', async () => {
    const { fetchImpl, urls } = stubFetch((url) =>
      url.includes('push2delay.eastmoney.com')
        ? okJson(INDEX_SNAPSHOT)
        : Promise.reject(new TypeError('socket hang up')),
    );
    const source = new EastmoneySource({ fetchImpl });

    const indices = await source.fetchIndexQuotes();

    expect(indices.length).toBe(6);
    expect(indices[0]?.close).toBe(3905.2);
    expect(urls.some((u) => u.includes('push2.eastmoney.com'))).toBe(true);
    expect(urls.some((u) => u.includes('push2delay.eastmoney.com'))).toBe(true);
    // 每次重试只换 host，路径与参数原样保留
    const first = urls[0] ?? '';
    const second = urls[1] ?? '';
    expect(second.replace('push2delay.eastmoney.com', 'push2.eastmoney.com')).toBe(first);
  });

  it('HTTP 5xx 属 upstream_error，不触发 push2delay 降级', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response('x', { status: 500 })),
    );
    const source = new EastmoneySource({ fetchImpl });

    await expect(source.fetchIndexQuotes()).rejects.toThrow(SourceExecutionError);
    expect(urls.every((u) => u.includes('push2.eastmoney.com'))).toBe(true);
    expect(urls.some((u) => u.includes('push2delay.eastmoney.com'))).toBe(false);
  });

  it('push2 与 push2delay 均 network 失败 → 抛错且两个 host 都尝试过', async () => {
    const { fetchImpl, urls } = stubFetch(() => Promise.reject(new TypeError('socket hang up')));
    const source = new EastmoneySource({ fetchImpl });

    await expect(source.fetchIndexQuotes()).rejects.toThrow(SourceExecutionError);
    expect(urls.some((u) => u.includes('push2.eastmoney.com'))).toBe(true);
    expect(urls.some((u) => u.includes('push2delay.eastmoney.com'))).toBe(true);
  });

  it('invalid_payload（200 非 JSON）不触发 push2delay 降级', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response('not-json', { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl });

    await expect(source.fetchIndexQuotes()).rejects.toThrow(SourceExecutionError);
    expect(urls.some((u) => u.includes('push2delay.eastmoney.com'))).toBe(false);
  });
});
