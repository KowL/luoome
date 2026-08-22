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
  source: 'eastmoney',
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

const stubFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('createSectorQuoteManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 sector-quote manager', () => {
    const m = createSectorQuoteManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('sector-quote');
    expect(typeof m.fetchList).toBe('function');
    expect(m.sources).toEqual(['eastmoney']);
  });

  it('配置未注册数据源时启动期失败，不做隐式 Eastmoney fallback', () => {
    expect(() =>
      createSectorQuoteManagerFromEnv(
        { LUOOME_SECTOR_QUOTE_SOURCES: 'tushare' },
        { logger: noopLogger },
      ),
    ).toThrow();
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
  });
});
