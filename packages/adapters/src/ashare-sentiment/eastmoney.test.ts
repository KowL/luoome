import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';

/**
 * EastmoneySource.fetchSealedPool / fetchBrokenPool 委托测试。
 * 解析断言保留自原 EastmoneyAShareSentimentAdapter 测试；
 * 池级失败收敛为 ok:false 池（存量结果契约），全程 fetchImpl stub，不依赖网络。
 */

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

const INPUT = { date: '2026-07-28', coverage: 'CN_A_SHARES_SH_SZ' } as const;

describe('EastmoneySource 情绪双池', () => {
  it('分别读取封板和炸板 fixture，并规范化代码、连板、封单与开板次数', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('getTopicZBPool') ? BROKEN_FIXTURE : SEALED_FIXTURE;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-07-28T07:01:00.000Z'),
    });

    const sealed = await source.fetchSealedPool(INPUT);
    const broken = await source.fetchBrokenPool(INPUT);

    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes('getTopicZTPool'))).toBe(true);
    expect(urls.some((url) => url.includes('getTopicZBPool'))).toBe(true);
    expect(sealed.ok && sealed.entries[0]).toMatchObject({
      stockId: '000002.SZ',
      ladderLevel: 2,
      sealAmount: 80_000_000,
      openCount: 0,
      industry: '房地产',
    });
    expect(sealed.ok && sealed.entries[1]?.sealAmount).toBeNull();
    expect(broken.ok && broken.entries[0]).toMatchObject({
      stockId: '600519.SH',
      ladderLevel: 5,
      sealAmount: null,
      openCount: 2,
    });
  });

  it('ok 池的 observedAt：已收盘交易日为当日收盘时刻', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 })) as unknown as typeof fetch;
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-07-28T08:00:00.000Z'), // 上海 16:00，已收盘
    });
    const sealed = await source.fetchSealedPool(INPUT);
    expect(sealed.ok && sealed.observedAt).toEqual(new Date('2026-07-28T07:00:00.000Z'));
  });

  it('单个端点失败时保留错误上下文（ok:false + errorKind），不影响另一个端点', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('getTopicZBPool')) {
        return new Response('upstream failed', { status: 502 });
      }
      return new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 });
    }) as typeof fetch;
    const source = new EastmoneySource({ fetchImpl });

    const sealed = await source.fetchSealedPool(INPUT);
    const broken = await source.fetchBrokenPool(INPUT);

    expect(sealed.ok).toBe(true);
    expect(broken).toMatchObject({
      ok: false,
      errorKind: 'http_error',
    });
    expect(broken.ok || broken.errorMessage).toContain('HTTP 502');
  });

  it('网络拒绝 → network_error；非 JSON → invalid_response（存量池词表）', async () => {
    const netSource = new EastmoneySource({
      fetchImpl: (() => Promise.reject(new TypeError('socket hang up'))) as never,
    });
    const netPool = await netSource.fetchSealedPool(INPUT);
    expect(netPool).toMatchObject({ ok: false, errorKind: 'network_error' });

    const badJsonSource = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('not-json', { status: 200 }))) as never,
    });
    const badJsonPool = await badJsonSource.fetchSealedPool(INPUT);
    expect(badJsonPool).toMatchObject({ ok: false, errorKind: 'invalid_response' });
  });

  it('上游成功返回空池时保留 complete 空集合，不转换为 unavailable', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: null }), { status: 200 })) as unknown as typeof fetch;
    const source = new EastmoneySource({ fetchImpl });
    const sealed = await source.fetchSealedPool(INPUT);
    const broken = await source.fetchBrokenPool(INPUT);

    expect(sealed).toMatchObject({ ok: true, entries: [] });
    expect(broken).toMatchObject({ ok: true, entries: [] });
  });

  it('超过炸板池 30 天查询窗口时不请求该端点，也不把缺失伪装成空集合', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(SEALED_FIXTURE), { status: 200 });
    }) as typeof fetch;
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-07-28T07:01:00.000Z'),
    });
    const sealed = await source.fetchSealedPool({ date: '2026-06-01', coverage: INPUT.coverage });
    const broken = await source.fetchBrokenPool({ date: '2026-06-01', coverage: INPUT.coverage });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('getTopicZTPool');
    expect(sealed.ok).toBe(true);
    expect(broken).toMatchObject({
      ok: false,
      errorKind: 'unsupported_date',
    });
  });
});
