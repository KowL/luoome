import { describe, expect, it } from 'vitest';

import type { TushareConfig } from './client.js';
import { tushareQuery } from './client.js';

/**
 * tushareQuery 传输层单元测试：POST body 形态、fields 拼接、重试与错误前缀。
 * 全程 fetchImpl stub，不依赖网络。
 */

const CONFIG: TushareConfig = {
  url: 'http://api.tushare.pro',
  token: 'test-token',
  timeoutMs: 1_000,
  retries: 0,
};

interface CapturedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const stubFetch = (
  handler: (call: CapturedCall) => Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const okEnvelope = (fields: readonly string[], items: ReadonlyArray<readonly unknown[]>) =>
  Promise.resolve(
    new Response(JSON.stringify({ code: 0, msg: null, data: { fields, items } }), {
      status: 200,
    }),
  );

describe('tushareQuery', () => {
  it('POST {api_name, token, params, fields}，返回按 fields 映射的行', async () => {
    const { fetchImpl, calls } = stubFetch(() => okEnvelope(['a'], [[1]]));
    const rows = await tushareQuery(
      'daily',
      { ts_code: '600519.SH', start_date: '20260720' },
      CONFIG,
      fetchImpl,
      ['ts_code', 'close'],
    );
    expect(calls[0]?.url).toBe('http://api.tushare.pro');
    expect(calls[0]?.body).toEqual({
      api_name: 'daily',
      token: 'test-token',
      params: { ts_code: '600519.SH', start_date: '20260720' },
      fields: 'ts_code,close',
    });
    expect(rows).toEqual([{ a: 1 }]);
  });

  it('params 中 undefined 键被剔除；fields 省略时不传', async () => {
    const { fetchImpl, calls } = stubFetch(() => okEnvelope([], []));
    await tushareQuery('stock_basic', { name: '茅', ts_code: undefined }, CONFIG, fetchImpl);
    expect(calls[0]?.body).toEqual({
      api_name: 'stock_basic',
      token: 'test-token',
      params: { name: '茅' },
    });
  });

  it('HTTP 4xx → tushare http，不重试', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(new Response('forbidden', { status: 403 })),
    );
    await expect(tushareQuery('daily', {}, { ...CONFIG, retries: 2 }, fetchImpl)).rejects.toThrow(
      /tushare http: 远端 403/,
    );
    expect(calls).toHaveLength(1);
  });

  it('HTTP 5xx → 指数退避重试，耗尽后抛错', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );
    await expect(tushareQuery('daily', {}, { ...CONFIG, retries: 1 }, fetchImpl)).rejects.toThrow(
      /tushare http: 远端 500/,
    );
    expect(calls).toHaveLength(2);
  });

  it('网络错误 → 重试耗尽后抛 tushare network', async () => {
    const { fetchImpl, calls } = stubFetch(() => Promise.reject(new TypeError('socket hang up')));
    await expect(tushareQuery('daily', {}, { ...CONFIG, retries: 1 }, fetchImpl)).rejects.toThrow(
      /tushare network/,
    );
    expect(calls).toHaveLength(2);
  });

  it('响应非 JSON → tushare parse', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response('not-json', { status: 200 })),
    );
    await expect(tushareQuery('daily', {}, CONFIG, fetchImpl)).rejects.toThrow(/tushare parse/);
  });

  it('envelope code≠0 → tushare upstream_error（含权限码 2002）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 2002, msg: '没有权限', data: { fields: [], items: [] } }),
          { status: 200 },
        ),
      ),
    );
    await expect(tushareQuery('rt_k', {}, CONFIG, fetchImpl)).rejects.toThrow(
      /tushare upstream_error: 2002 没有权限/,
    );
  });
});
