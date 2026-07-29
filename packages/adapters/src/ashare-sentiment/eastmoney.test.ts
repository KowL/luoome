import { describe, expect, it } from 'vitest';

import { EastmoneyAShareSentimentAdapter } from './eastmoney.js';

const SEALED_FIXTURE = {
  data: {
    pool: [
      {
        c: '000002',
        n: '万科A',
        lbc: 2,
        fund: 80_000_000,
        zbc: 0,
        hybk: '房地产',
      },
      {
        c: '600001',
        n: '测试股份',
        lbc: 1,
        fund: null,
        hybk: '半导体',
      },
    ],
  },
};

const BROKEN_FIXTURE = {
  data: {
    pool: [
      { c: '600519', n: '贵州茅台', zbc: 2, zttj: { days: 5, ct: 5 }, hybk: '白酒' },
      { c: '000002', n: '万科A', zbc: 1, zttj: { days: 2, ct: 2 }, hybk: '房地产' },
    ],
  },
};

describe('EastmoneyAShareSentimentAdapter', () => {
  it('分别读取封板和炸板 fixture，并规范化代码、连板、封单与开板次数', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('getTopicZBPool') ? BROKEN_FIXTURE : SEALED_FIXTURE;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const adapter = new EastmoneyAShareSentimentAdapter(
      fetchImpl,
      10_000,
      () => new Date('2026-07-28T07:01:00.000Z'),
    );

    const result = await adapter.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes('getTopicZTPool'))).toBe(true);
    expect(urls.some((url) => url.includes('getTopicZBPool'))).toBe(true);
    expect(result.sealed.ok && result.sealed.entries[0]).toMatchObject({
      stockId: '000002.SZ',
      ladderLevel: 2,
      sealAmount: 80_000_000,
      openCount: 0,
      industry: '房地产',
    });
    expect(result.sealed.ok && result.sealed.entries[1]?.sealAmount).toBeNull();
    expect(result.broken.ok && result.broken.entries[0]).toMatchObject({
      stockId: '600519.SH',
      ladderLevel: 5,
      sealAmount: null,
      openCount: 2,
    });
  });

  it('单个端点失败时保留另一个端点的真实结果和错误上下文', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('getTopicZBPool')) {
        return new Response('upstream failed', { status: 502 });
      }
      return new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 });
    }) as typeof fetch;
    const adapter = new EastmoneyAShareSentimentAdapter(fetchImpl);

    const result = await adapter.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(result.sealed.ok).toBe(true);
    expect(result.broken).toMatchObject({
      ok: false,
      errorKind: 'http_error',
    });
    expect(result.broken.ok || result.broken.errorMessage).toContain('HTTP 502');
  });

  it('上游成功返回空池时保留 complete 空集合，不转换为 unavailable', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: null }), { status: 200 })) as unknown as typeof fetch;
    const adapter = new EastmoneyAShareSentimentAdapter(fetchImpl);
    const result = await adapter.fetch({
      date: '2026-07-28',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(result.sealed).toMatchObject({ ok: true, entries: [] });
    expect(result.broken).toMatchObject({ ok: true, entries: [] });
  });

  it('超过炸板池 30 天查询窗口时不请求该端点，也不把缺失伪装成空集合', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 });
    }) as typeof fetch;
    const adapter = new EastmoneyAShareSentimentAdapter(
      fetchImpl,
      10_000,
      () => new Date('2026-07-28T07:01:00.000Z'),
    );
    const result = await adapter.fetch({
      date: '2026-06-01',
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('getTopicZTPool');
    expect(result.broken).toMatchObject({
      ok: false,
      errorKind: 'unsupported_date',
    });
  });
});
