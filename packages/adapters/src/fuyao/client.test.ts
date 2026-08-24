import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { FUYAO_DEFAULT_BASE_URL, FuyaoClient, fuyaoConfigFromEnv } from './client.js';

const TEST_KEY = 'test-fuyao-key-0001';

const config = (
  overrides: Partial<{
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    retries: number;
  }> = {},
) => ({
  baseUrl: 'https://fuyao.test',
  apiKey: TEST_KEY,
  timeoutMs: 1_000,
  retries: 1,
  ...overrides,
});

const okResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 0, message: 'success', request_id: 'r1', data }), {
    status: 200,
  });

const errorEnvelope = (code: number): Response =>
  new Response(JSON.stringify({ code, message: `err-${code}`, request_id: 'r1', data: null }), {
    status: 200,
  });

describe('fuyao/fuyaoConfigFromEnv', () => {
  it('FUYAO_API_KEY 缺失 → 抛错', () => {
    expect(() => fuyaoConfigFromEnv({})).toThrow(/FUYAO_API_KEY/);
    expect(() => fuyaoConfigFromEnv({ FUYAO_API_KEY: '  ' })).toThrow(/FUYAO_API_KEY/);
  });

  it('FUYAO_BASE_URL 缺省 → https://fuyao.aicubes.cn', () => {
    const parsed = fuyaoConfigFromEnv({ FUYAO_API_KEY: 'k' });
    expect(parsed.baseUrl).toBe(FUYAO_DEFAULT_BASE_URL);
    expect(parsed.apiKey).toBe('k');
  });

  it('FUYAO_BASE_URL 覆盖生效', () => {
    const parsed = fuyaoConfigFromEnv({ FUYAO_API_KEY: 'k', FUYAO_BASE_URL: 'https://proxy.test' });
    expect(parsed.baseUrl).toBe('https://proxy.test');
  });
});

describe('fuyao/FuyaoClient', () => {
  it('GET 携带 X-api-key 头并拼接 query；返回信封 items/timestamp', async () => {
    const calls: Array<{ url: string; apiKey: unknown }> = [];
    const client = new FuyaoClient(config(), {
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          apiKey: new Headers(init?.headers).get('X-api-key'),
        });
        return okResponse({ timestamp: 1000, item: [{ thscode: '600519.SH' }] });
      }) as never,
    });
    const data = await client.get('/api/a-share/prices/snapshot', { thscodes: '600519.SH' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://fuyao.test/api/a-share/prices/snapshot?thscodes=600519.SH');
    expect(calls[0]?.apiKey).toBe(TEST_KEY);
    expect(data.items).toEqual([{ thscode: '600519.SH' }]);
    expect(data.timestamp?.getTime()).toBe(1000);
  });

  it('4001 退避重试一次后成功', async () => {
    let calls = 0;
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? errorEnvelope(4001) : okResponse({ timestamp: 1000, item: [] });
      }) as never,
    });
    const data = await client.get('/api/x', { a: 1 });
    expect(calls).toBe(2);
    expect(data.items).toEqual([]);
  });

  it('4001 持续超限 → 重试耗尽抛 rate_limited', async () => {
    let calls = 0;
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => {
        calls += 1;
        return errorEnvelope(4001);
      }) as never,
    });
    await expect(client.get('/api/x', { a: 1 })).rejects.toMatchObject({
      name: 'SourceExecutionError',
      kind: 'rate_limited',
    });
    expect(calls).toBe(2);
  });

  it('非 4001 信封错误不重试（permission 一次即抛）', async () => {
    let calls = 0;
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => {
        calls += 1;
        return errorEnvelope(2001);
      }) as never,
    });
    await expect(client.get('/api/x', { a: 1 })).rejects.toMatchObject({ kind: 'permission' });
    expect(calls).toBe(1);
  });

  it('HTTP 非 200 → 按状态码映射（403→permission，500→upstream_error）', async () => {
    const forbidden = new FuyaoClient(config(), {
      fetchImpl: (async () => new Response('no', { status: 403 })) as never,
    });
    await expect(forbidden.get('/api/x', {})).rejects.toMatchObject({ kind: 'permission' });

    const broken = new FuyaoClient(config(), {
      fetchImpl: (async () => new Response('no', { status: 500 })) as never,
    });
    await expect(broken.get('/api/x', {})).rejects.toMatchObject({ kind: 'upstream_error' });
  });

  it('非 JSON 响应 → invalid_payload', async () => {
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as never,
    });
    await expect(client.get('/api/x', {})).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('fetch 拒绝 → network；AbortError → timeout；错误消息不泄漏 API key', async () => {
    const networkDown = new FuyaoClient(config(), {
      fetchImpl: (async () => {
        throw new Error('socket hangup');
      }) as never,
    });
    const networkError = await networkDown.get('/api/x', {}).catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(SourceExecutionError);
    expect((networkError as SourceExecutionError).kind).toBe('network');
    expect((networkError as SourceExecutionError).message).not.toContain(TEST_KEY);

    const slow = new FuyaoClient(config({ timeoutMs: 50 }), {
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        })) as never,
    });
    const timeoutError = await slow.get('/api/x', {}).catch((error: unknown) => error);
    expect((timeoutError as SourceExecutionError).kind).toBe('timeout');
    expect((timeoutError as SourceExecutionError).message).not.toContain(TEST_KEY);
  });
});
