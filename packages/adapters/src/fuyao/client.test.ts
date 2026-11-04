import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import {
  FUYAO_DEFAULT_BASE_URL,
  FuyaoClient,
  type FuyaoClientLogEntry,
  fuyaoConfigFromEnv,
} from './client.js';
import { FuyaoRequestCoordinator } from './request-coordinator.js';

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

/** 手动推进的假时钟 + sleep：sleep 调用记录时长并立即推进时钟，测试零真实等待。 */
const fakeClockSleep = (
  start = 1_000_000,
): { clock: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } => {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
  };
};

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

  it('FUYAO_RATE_LIMIT_MAX_RETRIES 覆盖重试上限，非法值启动期拒绝', () => {
    expect(
      fuyaoConfigFromEnv({ FUYAO_API_KEY: 'k', FUYAO_RATE_LIMIT_MAX_RETRIES: '4' }).retries,
    ).toBe(4);
    expect(() =>
      fuyaoConfigFromEnv({ FUYAO_API_KEY: 'k', FUYAO_RATE_LIMIT_MAX_RETRIES: '0' }),
    ).toThrow(/FUYAO_RATE_LIMIT_MAX_RETRIES/);
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

  it('4001 退避重试一次后成功（共享冷却只等待一次 1s 级退避）', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    let calls = 0;
    const client = new FuyaoClient(config(), {
      clock,
      sleep,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? errorEnvelope(4001) : okResponse({ timestamp: 1000, item: [] });
      }) as never,
    });
    const data = await client.get('/api/x', { a: 1 });
    expect(calls).toBe(2);
    expect(data.items).toEqual([]);
    // 等待只发生一次（协调器冷却），时长为 1s 级退避（1000-1499ms），不再有 client 侧二次 sleep。
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(sleeps[0]).toBeLessThan(1_500);
  });

  it('4001 持续超限 → 重试耗尽抛 rate_limited（每次重试各一次冷却）', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    let calls = 0;
    const client = new FuyaoClient(config(), {
      clock,
      sleep,
      fetchImpl: (async () => {
        calls += 1;
        return errorEnvelope(4001);
      }) as never,
    });
    await expect(client.get('/api/x', { a: 1 })).rejects.toMatchObject({
      name: 'SourceExecutionError',
      kind: 'rate_limited',
    });
    expect(calls).toBe(2); // retries=1 → 初次 + 1 次重试
    expect(sleeps).toHaveLength(1); // 只有通往重试的那次冷却；耗尽后不再等待
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(sleeps[0]).toBeLessThan(1_500);
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

describe('fuyao/FuyaoClient.getData', () => {
  it('返回未知形状 data + requestId，不做 item[] 校验（非列表 data 原样透出）', async () => {
    const payload = { download_url: 'https://s3.test/x.parquet', expires_in: 300, rows: 12 };
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => okResponse(payload)) as never,
    });
    const result = await client.getData('/api/dump/market-dumps/url', { kind: 'daily-k' });
    expect(result.data).toEqual(payload);
    expect(result.requestId).toBe('r1');
  });

  it('data 为数组 / 标量也原样透出（领域自行 Zod 校验）', async () => {
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => okResponse([1, 2, 3])) as never,
    });
    const result = await client.getData('/api/x', {});
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('get() 对非 item[] data → invalid_payload；getData 不拦截', async () => {
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () => okResponse({ items: [{ thscode: '600519.SH' }] })) as never,
    });
    await expect(client.get('/api/x', {})).rejects.toMatchObject({ kind: 'invalid_payload' });
    const result = await client.getData('/api/x', {});
    expect(result.data).toEqual({ items: [{ thscode: '600519.SH' }] });
  });

  it('畸形信封：非对象 / 缺 code / code 非整数 → invalid_payload', async () => {
    const nonObject = new FuyaoClient(config(), {
      fetchImpl: (async () => new Response(JSON.stringify([1, 2]), { status: 200 })) as never,
    });
    await expect(nonObject.getData('/api/x', {})).rejects.toMatchObject({
      kind: 'invalid_payload',
    });

    const missingCode = new FuyaoClient(config(), {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: 'ok', data: {} }), { status: 200 })) as never,
    });
    await expect(missingCode.getData('/api/x', {})).rejects.toMatchObject({
      kind: 'invalid_payload',
    });

    const floatCode = new FuyaoClient(config(), {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 0.5, data: {} }), { status: 200 })) as never,
    });
    await expect(floatCode.getData('/api/x', {})).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('code=0 且 data=null → no_data', async () => {
    const client = new FuyaoClient(config(), {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 0, message: 'empty', request_id: 'r1', data: null }), {
          status: 200,
        })) as never,
    });
    await expect(client.getData('/api/x', {})).rejects.toMatchObject({ kind: 'no_data' });
  });

  it('2001/2003 → permission，不重试', async () => {
    for (const code of [2001, 2003]) {
      let calls = 0;
      const client = new FuyaoClient(config(), {
        fetchImpl: (async () => {
          calls += 1;
          return errorEnvelope(code);
        }) as never,
      });
      await expect(client.getData('/api/x', {})).rejects.toMatchObject({ kind: 'permission' });
      expect(calls).toBe(1);
    }
  });

  it('重试为零时限流仍暂停其他领域的共享队列', async () => {
    const { clock, sleep } = fakeClockSleep();
    const coordinator = new FuyaoRequestCoordinator(
      { maxConcurrency: 1, minIntervalMs: 0, rateLimitCooldownMs: 30_000, rateLimitMaxRetries: 0 },
      { clock, sleep },
    );
    const starts: number[] = [];
    const client = new FuyaoClient(config({ retries: 0 }), {
      clock,
      coordinator,
      fetchImpl: (async () => {
        starts.push(clock());
        return starts.length === 1
          ? new Response('limited', { status: 429, headers: { 'retry-after': '7' } })
          : okResponse({ ok: true });
      }) as never,
    });
    const limited = client.getData('/api/domain-a', {});
    const next = client.getData('/api/domain-b', {});
    await expect(limited).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(next).resolves.toMatchObject({ data: { ok: true } });
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBeGreaterThanOrEqual(1_007_000);
  });

  it('429 带 Retry-After 秒数 → 冷却窗口按 Retry-After（不叠加 1s/5s 退避）', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    let calls = 0;
    const client = new FuyaoClient(config(), {
      clock,
      sleep,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('limited', {
            status: 429,
            headers: { 'retry-after': '7' },
          });
        }
        return okResponse({ ok: true });
      }) as never,
    });
    const result = await client.getData('/api/x', {});
    expect(result.data).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7_000]); // 仅 Retry-After 一次等待，无二次退避
  });

  it('429 带 Retry-After HTTP-date → 按时钟换算冷却', async () => {
    const start = 1_000_000;
    const { clock, sleep, sleeps } = fakeClockSleep(start);
    let calls = 0;
    const client = new FuyaoClient(config(), {
      clock,
      sleep,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('limited', {
            status: 429,
            headers: { 'retry-after': new Date(start + 3_000).toUTCString() },
          });
        }
        return okResponse({ ok: true });
      }) as never,
    });
    await client.getData('/api/x', {});
    expect(calls).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('429 无 Retry-After → 默认共享冷却；重试耗尽抛 rate_limited', async () => {
    const { clock, sleep, sleeps } = fakeClockSleep();
    let calls = 0;
    const client = new FuyaoClient(config({ retries: 2 }), {
      clock,
      sleep,
      fetchImpl: (async () => {
        calls += 1;
        return new Response('limited', { status: 429 });
      }) as never,
    });
    await expect(client.getData('/api/x', {})).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(calls).toBe(3); // 初次 + 2 次重试
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it('日志只含脱敏字段：requestId/path/durationMs/errorKind，不泄漏 API key', async () => {
    const entries: FuyaoClientLogEntry[] = [];
    let calls = 0;
    const client = new FuyaoClient(config(), {
      logger: (entry) => entries.push(entry),
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? errorEnvelope(4001) : okResponse({ timestamp: 1, item: [] });
      }) as never,
      // 真实时钟即可：本用例不断言等待时长，只断言日志字段。
      ...fakeClockSleep(),
    });
    await client.get('/api/x', { a: 1 });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.errorKind).toBe('rate_limited');
    expect(entries[0]?.requestId).toBeUndefined();
    expect(entries[1]?.requestId).toBe('r1');
    expect(entries[1]?.errorKind).toBeUndefined();
    for (const entry of entries) {
      expect(entry.path).toBe('/api/x');
      expect(JSON.stringify(entry)).not.toContain(TEST_KEY);
    }
  });
});
