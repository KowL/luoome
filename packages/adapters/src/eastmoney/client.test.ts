import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { getJson } from './client.js';

/**
 * eastmoney/client.ts 统一 HTTP 管道的错误词表映射
 * （docs/ddd/source-pluggability-and-observation-design.md §4.4）。
 */

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

const kindOf = async (fetchImpl: typeof fetch): Promise<string> => {
  try {
    await getJson('https://example.com/api', { timeoutMs: 1_000, fetchImpl });
    return 'no-throw';
  } catch (error) {
    expect(error).toBeInstanceOf(SourceExecutionError);
    return (error as SourceExecutionError).kind;
  }
};

describe('eastmoney getJson', () => {
  it('成功时返回解析后的 JSON', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ rc: 0 }), { status: 200 })),
    );
    const body = await getJson('https://example.com/api?x=1', { timeoutMs: 1_000, fetchImpl });
    expect(body).toEqual({ rc: 0 });
    expect(urls).toEqual(['https://example.com/api?x=1']);
  });

  it('fetch 拒绝 → network', async () => {
    const { fetchImpl } = stubFetch(() => Promise.reject(new TypeError('socket hang up')));
    expect(await kindOf(fetchImpl)).toBe('network');
  });

  it('主动超时（AbortController abort）→ timeout', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    expect(await kindOf(fetchImpl)).toBe('timeout');
  });

  it('HTTP 401 / 403 → permission', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('x', { status })));
      expect(await kindOf(fetchImpl)).toBe('permission');
    }
  });

  it('HTTP 429 → rate_limited', async () => {
    const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('x', { status: 429 })));
    expect(await kindOf(fetchImpl)).toBe('rate_limited');
  });

  it('HTTP 5xx / 其它非成功 → upstream_error', async () => {
    for (const status of [500, 502, 404]) {
      const { fetchImpl } = stubFetch(() => Promise.resolve(new Response('x', { status })));
      expect(await kindOf(fetchImpl)).toBe('upstream_error');
    }
  });

  it('响应非 JSON → invalid_payload', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response('not-json', { status: 200 })),
    );
    expect(await kindOf(fetchImpl)).toBe('invalid_payload');
  });
});
