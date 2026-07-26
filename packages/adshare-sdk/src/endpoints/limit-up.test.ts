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

/** 远端真实响应形态（2026-07-24 实测）：已组装梯队 + camelCase entry。 */
const mkRemoteLadder = () => ({
  success: true,
  message: null,
  date: '2026-07-24',
  total: 3,
  maxLevel: 4,
  levels: [
    {
      level: 4,
      name: '4连板',
      count: 2,
      stocks: [
        {
          code: '002879',
          name: '长缆科技',
          level: 4,
          industry: '',
          firstTime: '',
          finalTime: '',
          reason: '',
          price: 18.05,
          changePct: 0.0999,
          limitUpDate: '2026-07-24',
        },
        {
          code: '603221',
          name: '爱丽家居',
          level: 4,
          industry: '家居',
          firstTime: '09:31:00',
          finalTime: '09:31:00',
          reason: '地产链',
          price: 14.0,
          changePct: 0.0998,
          limitUpDate: '2026-07-24',
        },
      ],
    },
    {
      level: 1,
      name: '首板',
      count: 1,
      stocks: [
        {
          code: '600519',
          name: '贵州茅台',
          industry: '白酒',
          firstTime: '10:30:00',
          finalTime: '14:50:00',
          reason: '涨价',
          price: 1850.0,
          changePct: 0.1,
          limitUpDate: '2026-07-24',
        },
      ],
    },
  ],
});

describe('fetchLimitUpLadder', () => {
  it('date 以 YYYYMMDD int 形态发送', async () => {
    const fetchImpl = mkFetchMock(async () =>
      mkOkJson({ success: true, date: '2026-07-24', levels: [] }),
    );
    await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      {
        date: '2026-07-24',
      },
      DEFAULT_OPTS,
    );
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('date=20260724');
    expect(calledUrl).not.toContain('2026-07-24');
  });

  it('levels 梯队拍平 + camelCase 映射 + pre_close 反推', async () => {
    const fetchImpl = mkFetchMock(async () => mkOkJson(mkRemoteLadder()));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-24' },
      DEFAULT_OPTS,
    );
    expect(result.date).toBe('2026-07-24');
    expect(result.entries).toHaveLength(3);

    const first = result.entries[0];
    expect(first?.code).toBe('002879');
    expect(first?.level).toBe(4);
    expect(first?.close).toBe(18.05);
    expect(first?.change_pct).toBe(0.0999);
    expect(first?.pre_close).toBeCloseTo(18.05 / 1.0999, 6);
    // 空字符串字段 → undefined（下游映射为 null / 哨兵）
    expect(first?.first_time).toBeUndefined();
    expect(first?.reason).toBeUndefined();
    expect(first?.industry).toBeUndefined();
    expect(first?.limit_up_date).toBe('2026-07-24');

    // stock 缺 level 时回退父层 level
    const third = result.entries[2];
    expect(third?.code).toBe('600519');
    expect(third?.level).toBe(1);
    expect(third?.first_time).toBe('10:30:00');
    expect(third?.reason).toBe('涨价');
  });

  it('非交易日空梯队：success + levels=[] 不抛错', async () => {
    const fetchImpl = mkFetchMock(async () =>
      mkOkJson({ success: true, date: '2026-07-26', total: 0, maxLevel: 0, levels: [] }),
    );
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-26' },
      DEFAULT_OPTS,
    );
    expect(result.entries).toHaveLength(0);
  });

  it('success=false 抛 HTTP_ERROR 并带远端 message', async () => {
    const fetchImpl = mkFetchMock(async () =>
      mkOkJson({ success: false, message: 'date out of range' }),
    );
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        {
          date: '2026-07-24',
        },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('4xx 抛 HTTP_ERROR', async () => {
    const fetchImpl = mkFetchMock(async () => mkHttp(422, { detail: [] }));
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        {
          date: '2026-07-24',
        },
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
        { date: '2026-07-24' },
        { timeoutMs: 1000, retries: 1 },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(attempts).toBe(2);
  });

  it('有 stocks 但全解析失败抛 PARSE_ERROR', async () => {
    const fetchImpl = mkFetchMock(async () =>
      mkOkJson({ success: true, levels: [{ level: 1, stocks: [{ foo: 'bar' }] }] }),
    );
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        {
          date: '2026-07-24',
        },
        DEFAULT_OPTS,
      ),
    ).rejects.toBeInstanceOf(AdshareError);
    await expect(
      fetchLimitUpLadder(
        TEST_URL,
        TEST_KEY,
        fetchImpl as unknown as typeof fetch,
        {
          date: '2026-07-24',
        },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'PARSE_ERROR' });
  });

  it('code / price 缺失的条目被跳过（不阻断整批）', async () => {
    const body = {
      success: true,
      date: '2026-07-24',
      levels: [
        {
          level: 1,
          stocks: [
            { code: '600519', price: 1850.0, changePct: 0.1 },
            { code: '', price: 100.0 },
            { price: 200.0 },
            { code: '000001', price: 10.0 },
          ],
        },
      ],
    };
    const fetchImpl = mkFetchMock(async () => mkOkJson(body));
    const result = await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-24' },
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
        {
          date: '2026/07/24',
        },
        DEFAULT_OPTS,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('days 参数透传', async () => {
    const fetchImpl = mkFetchMock(async () =>
      mkOkJson({ success: true, date: '2026-07-24', levels: [] }),
    );
    await fetchLimitUpLadder(
      TEST_URL,
      TEST_KEY,
      fetchImpl as unknown as typeof fetch,
      { date: '2026-07-24', days: 20 },
      DEFAULT_OPTS,
    );
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('days=20');
  });
});
