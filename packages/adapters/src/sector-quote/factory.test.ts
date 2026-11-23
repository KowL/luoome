import type { FetchSectorQuotesQuery, Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { createSectorQuoteManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseQuery: FetchSectorQuotesQuery = {
  sort: 'changePct',
  limit: 50,
};

const sectorFixture = {
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
        f128: '湖南白银',
        f140: '002716',
        f136: 10.03,
      },
    ],
  },
};

/** 新浪 newSinaHy 的 JS 包裹 + CSV 行；ASCII 名称足以验证路由与映射，GBK 见 sina.test.ts。 */
const sinaBody = (rows: readonly string[]): Response =>
  new Response(`var S_Finance_bankuai_sinaindustry = {${rows.join(',')}};`, { status: 200 });

const sinaRow = (code: string, name: string, changePct: string, amount: string): string =>
  `"${code}":"${code},${name},10,10.5,0.2,${changePct},100,${amount},sz002623,10.012,18.570,1.690,LEAD"`;

const stubFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const hostOf = (url: string) => new URL(url).hostname;

describe('createSectorQuoteManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 sector-quote manager（默认 eastmoney,sina）', () => {
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('sector-quote');
    expect(typeof m.fetchList).toBe('function');
    expect(m.sources).toEqual(['eastmoney', 'sina']);
  });

  it('配置未注册数据源 / 重复数据源时启动期失败，不做隐式 fallback', () => {
    expect(() =>
      createSectorQuoteManagerFromEnv(
        { LUOOME_SECTOR_QUOTE_SOURCES: 'tushare' },
        { logger: noopLogger },
      ),
    ).toThrow();
    expect(() =>
      createSectorQuoteManagerFromEnv(
        { LUOOME_SECTOR_QUOTE_SOURCES: 'sina,eastmoney,sina' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('显式顺序 sina,eastmoney 生效：新浪优先', async () => {
    const fetchImpl = (async (url: string) =>
      hostOf(String(url)) === 'vip.stock.finance.sina.com.cn'
        ? sinaBody([sinaRow('new_blhy', 'GLASS', '2.6157', '7662499219')])
        : new Response(JSON.stringify(sectorFixture), {
            status: 200,
          })) as unknown as typeof fetch;
    const m = createSectorQuoteManagerFromEnv(
      { LUOOME_SECTOR_QUOTE_SOURCES: 'sina,eastmoney' },
      { logger: noopLogger, fetchImpl },
    );

    expect(m.sources).toEqual(['sina', 'eastmoney']);
    const r = await m.fetchList(baseQuery);
    expect(r.ok).toBe(true);
    const data = r.data;
    if (data === undefined) return;
    expect(data.source).toBe('sina');
    expect(data.items[0]?.code).toBe('new_blhy');
    expect(data.items[0]?.changePct).toBeCloseTo(0.026157);
    expect(data.items[0]?.leadingStockCode).toBe('002623.SZ');
  });

  it('fetchImpl 返回 fixture 时 fetchList 返回映射后的列表（涨跌幅为小数）', async () => {
    const fetchImpl = stubFetch(sectorFixture);
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data;
    expect(data).toBeDefined();
    if (data === undefined) return;

    expect(data.source).toBe('eastmoney');
    expect(data.total).toBe(2);
    expect(data.items[0]?.code).toBe('BK1616');
    expect(data.items[0]?.changePct).toBeCloseTo(0.0868);
    expect(data.items[0]?.amount).toBe(12_729_206_234);
    expect(data.items[0]?.leadingStockName).toBe('湖南白银');
    expect(data.items[0]?.leadingStockChangePct).toBeCloseTo(0.1003);

    // 默认 sort=changePct → fid=f3
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain('fid=f3');
    expect(calledUrl).toContain('pz=50');
  });

  it('sort=amount 映射 fid=f6；limit 截断；空列表带 empty-list 警告', async () => {
    const fetchImpl = stubFetch(sectorFixture);
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl });

    const byAmount = await m.fetchList({ ...baseQuery, sort: 'amount' });
    expect(byAmount.ok).toBe(true);
    const calledUrl = String(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0],
    );
    expect(calledUrl).toContain('fid=f6');

    const truncated = await m.fetchList({ ...baseQuery, limit: 1 });
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.data?.total).toBe(1);

    const emptyFetch = stubFetch({ rc: 0, data: null });
    const m2 = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl: emptyFetch });
    const empty = await m2.fetchList(baseQuery);
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.data?.total).toBe(0);
      expect(empty.data?.warnings).toContain('empty-list');
    }
  });

  it('东财 502 → 回退新浪并标注实际来源，status() 逐源记录真实结果', async () => {
    const fetchImpl = (async (url: string) =>
      hostOf(String(url)) === 'vip.stock.finance.sina.com.cn'
        ? sinaBody([
            sinaRow('new_blhy', 'GLASS', '2.6157', '7662499219'),
            sinaRow('new_ljhy', 'LIQUOR', '-1.7262', '15162544223'),
          ])
        : new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl });

    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(true);
    const data = r.data;
    if (data === undefined) return;
    expect(data.source).toBe('sina');
    expect(data.total).toBe(2);
    expect(m.status()).toHaveLength(2);
    expect(m.status()[0]).toMatchObject({
      dataset: 'sector-quote',
      source: 'eastmoney',
      capabilityEnabled: true,
      configurationReady: true,
      lastErrorKind: 'upstream_error',
    });
    expect(m.status()[0]?.lastSuccessAt).toBeUndefined();
    expect(m.status()[1]).toMatchObject({
      dataset: 'sector-quote',
      source: 'sina',
      capabilityEnabled: true,
      configurationReady: true,
    });
    expect(m.status()[1]?.lastSuccessAt).toBeInstanceOf(Date);
    expect(m.status()[1]?.lastErrorKind).toBeUndefined();
  });

  it('两个源都失败时如实汇总各自原因', async () => {
    const fetchImpl = (async (url: string) =>
      hostOf(String(url)) === 'vip.stock.finance.sina.com.cn'
        ? new Response('sina down', { status: 500 })
        : new Response('eastmoney down', { status: 502 })) as unknown as typeof fetch;
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl });

    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(false);
    const error = r.error;
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.message).toContain('所有板块行情源均失败');
    expect(error.message).toContain('东方财富（eastmoney）');
    expect(error.message).toContain('新浪财经（sina）');
    expect(error.message).toContain('eastmoney: eastmoney sector-quote');
    expect(error.message).toContain('sina: sina sector-quote');
  });

  it('fetchImpl 抛错时返回 adapter_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const error = r.error;
    expect(error).toBeDefined();
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.adapter).toBe('sector-quote');
    expect(error.message).toContain('network down');
    expect(error.message).toContain('eastmoney');
  });

  it('status() 记录真实尝试与失败，不把不可达的源报成健康', async () => {
    const fetchImpl = (async () =>
      new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const m = createSectorQuoteManagerFromEnv(
      { LUOOME_SECTOR_QUOTE_SOURCES: 'eastmoney' },
      {
        logger: noopLogger,
        fetchImpl,
      },
    );

    await m.fetchList(baseQuery);

    expect(m.status()).toHaveLength(1);
    expect(m.status()[0]).toMatchObject({
      dataset: 'sector-quote',
      source: 'eastmoney',
      capabilityEnabled: true,
      configurationReady: true,
      lastErrorKind: 'upstream_error',
    });
    expect(m.status()[0]?.lastAttemptAt).toBeInstanceOf(Date);
    expect(m.status()[0]?.lastSuccessAt).toBeUndefined();
  });
});
