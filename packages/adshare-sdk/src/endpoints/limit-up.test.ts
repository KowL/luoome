import { describe, expect, it, vi } from 'vitest';

import { AdshareError } from '../errors.js';

import { fetchLimitUpLadder } from './limit-up.js';

const TEST_URL = 'http://8.148.216.30:8888';
const TEST_KEY = 'test-key';
const DEFAULT_OPTS = { timeoutMs: 10_000, retries: 2 };

/** 构造 fetch 替身；测试全部把它赋给 vi.fn() 后作为 typeof fetch 传入。 */
type FetchMock = ReturnType<typeof vi.fn>;
const mkFetchMock = (impl: (url: string, init?: RequestInit) => Promise<Response>): FetchMock =>
  vi.fn(impl) as unknown as FetchMock;

const mkOkJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  }) as unknown as Response;

const mkHttp = (status: number, body: unknown = {}) =>
  ({
    ok: false,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  }) as unknown as Response;

describe('fetchLimitUpLadder', () => {
  it('200 + 合法 items 解析成功', async () => {
    const body = {
      date: '2026-07-25',
      entries: [
        {
          code: '600519',
          name: '贵州茅台',
          industry: '白酒',
          level: 2,
          first_time: '10:30:00',
          final_time: '14:50:00',
          reason: '涨价',
          close: 1850.0,
          pre_close: 1681.8,
          change_pct: 0.1,
          limit_up_date: '2026-07-25',
          high: 1850.0,
        },
      ],
    };
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.date).toBe('2026-07-25');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.code).toBe('600519');
    expect(result.entries[0]!.level).toBe(2);
    expect(result.entries[0]!.close).toBe(1850.0);
    expect(result.entries[0]!.pre_close).toBe(1681.8);
    expect(result.entries[0]!.high).toBe(1850.0);
  });

  it('{ data: [...] } 包裹形态解析成功', async () => {
    const body = {
      date: '2026-07-25',
      data: [{ code: '300750', name: '宁德时代', close: 500.0, level: 1 }],
    };
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.entries[0]!.code).toBe('300750');
  });

  it('{ fields, items } 形态解析成功', async () => {
    const body = {
      date: '2026-07-25',
      fields: ['code', 'close', 'level'],
      items: [['600519', 1850.0, 2]],
    };
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.entries[0]!.code).toBe('600519');
    expect(result.entries[0]!.close).toBe(1850.0);
    expect(result.entries[0]!.level).toBe(2);
  });

  it('直接数组形态解析成功', async () => {
    const body = [{ code: '000001', close: 10.0 }];
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.entries[0]!.code).toBe('000001');
  });

  it('4xx 抛 HTTP_ERROR', async () => {
    const fetchImpl = mkFetchMock(async () => mkHttp(404));
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        { date: '2026-07-25' },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('5xx 重试耗尽后抛 HTTP_ERROR', async () => {
    let attempts = 0;
    const fetchImpl = mkFetchMock(async () => {
      attempts += 1;
      return mkHttp(503);
    });
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        { date: '2026-07-25' },
        { timeoutMs: 1000, retries: 1 },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(attempts).toBe(2);
  });

  it('空 items 不抛错', async () => {
    const fetchImpl = mkFetchMock(async () => mkOkJson({ date: '2026-07-25', entries: [] }));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.entries).toHaveLength(0);
  });

  it('全条目解析失败抛 PARSE_ERROR', async () => {
    const fetchImpl = mkFetchMock(async () => mkOkJson({ entries: [{ foo: 'bar' }] }));
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        { date: '2026-07-25' },
        DEFAULT_OPTS,
      ),
    ).rejects.toBeInstanceOf(AdshareError);
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        { date: '2026-07-25' },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('code / close 缺失的条目被跳过（不阻断整批）', async () => {
    const body = {
      date: '2026-07-25',
      entries: [
        { code: '600519', close: 1850.0 },
        { code: '', close: 100.0 },
        { close: 200.0 },
        { code: '000001', close: 10.0 },
      ],
    };
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25' },
      DEFAULT_OPTS,
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.code)).toEqual(['600519', '000001']);
  });

  it('date 非法格式抛 INVALID_INPUT', async () => {
    const fetchImpl = mkFetchMock(async () => mkOkJson({}));
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        { date: '2026/07/25' },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('days 参数透传', async () => {
    const fetchImpl = mkFetchMock(async () => mkOkJson({ date: '2026-07-25', entries: [] }));
    await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-25', days: 20 },
      DEFAULT_OPTS,
    );
    const calledUrl = fetchImpl.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('days=20');
  });
});
