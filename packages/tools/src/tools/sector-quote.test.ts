import {
  FetchSectorQuotesQuerySchema,
  type SectorQuoteList,
  type SectorQuoteManagerLike,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { fetchSectorQuotesTool } from './sector-quote.js';

const mkList = (): SectorQuoteList => ({
  total: 1,
  source: 'eastmoney',
  items: [
    {
      code: 'BK0732',
      name: '贵金属',
      price: 2837.18,
      changePct: 0.0599,
      change: 160.26,
      amount: 38_253_089_126,
      upCount: 12,
      downCount: 0,
      leadingStockName: '湖南白银',
      leadingStockCode: '002716',
      leadingStockChangePct: 0.1003,
    },
  ],
  warnings: [],
  asOf: new Date(),
});

const mkManager = (fetchImpl: SectorQuoteManagerLike['fetchList']): SectorQuoteManagerLike => ({
  name: 'sector-quote',
  sources: ['eastmoney'],
  fetchList: fetchImpl,
});

describe('fetch_sector_quotes tool', () => {
  const makeCtx = (manager: SectorQuoteManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      sectorQuote: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await fetchSectorQuotesTool.execute(
      FetchSectorQuotesQuerySchema.parse({}),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回列表', async () => {
    const manager = mkManager(vi.fn(async () => ({ ok: true, data: mkList() })));
    const r = await fetchSectorQuotesTool.execute(
      FetchSectorQuotesQuerySchema.parse({ sort: 'amount', limit: 10 }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.items[0]?.code).toBe('BK0732');
  });

  it('manager 失败 → adapter_error 透传', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'sector-quote' as const,
          message: 'down',
          recoverable: false,
        },
      })),
    );
    const r = await fetchSectorQuotesTool.execute(
      FetchSectorQuotesQuerySchema.parse({}),
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('sector-quote');
      expect(r.error.cause).toMatch(/down/);
    }
  });

  it('sort 默认 changePct、limit 默认 50；越界输入 → invalid_input', async () => {
    const fetchList = vi.fn(async () => ({ ok: true as const, data: mkList() }));
    const manager = mkManager(fetchList);
    const r = await fetchSectorQuotesTool.execute({}, makeCtx(manager));
    expect(r.ok).toBe(true);
    expect(fetchList).toHaveBeenCalledWith({
      sort: 'changePct',
      limit: 50,
      source: 'eastmoney',
    });

    const bad = await fetchSectorQuotesTool.execute({ limit: 0 }, makeCtx(manager));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.kind).toBe('invalid_input');
  });
});
