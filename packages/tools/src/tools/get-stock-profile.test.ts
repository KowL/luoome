import type { StockProfileManagerLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { GetStockProfileInput, getStockProfileTool } from './get-stock-profile.js';

const mkManager = (
  fetchImpl: StockProfileManagerLike['fetchProfile'],
): StockProfileManagerLike => ({
  name: 'stock-profile',
  sources: ['eastmoney'],
  status: () => [],
  fetchProfile: fetchImpl,
});

const mkCtx = (manager: StockProfileManagerLike | undefined) =>
  ({
    repos: {} as never,
    adapters: { market: {} as never, llm: {} as never },
    stockProfile: manager,
    user: { id: 'u1', defaultAccountId: 'a1' },
    clock: () => new Date(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }) as never;

describe('get_stock_profile tool', () => {
  it('返回上游档案原样事实', async () => {
    const manager = mkManager(async (query) => ({
      ok: true,
      data: {
        stockId: query.stockId,
        source: 'eastmoney',
        asOf: '2026-10-30T00:00:00.000Z',
        holders: [
          {
            endDate: '2026-10-09',
            holderNum: 274138,
            changePct: -0.018429,
            avgShares: 3182.91,
            avgMarketValue: 645144.57,
          },
        ],
        concepts: [
          {
            code: 'BK0877',
            name: 'PCB',
            boardType: null,
            precise: true,
            rank: 28,
            reason: null,
          },
        ],
      },
    }));
    const result = await getStockProfileTool.execute({ stockId: '300476.SZ' }, mkCtx(manager));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holders[0]?.holderNum).toBe(274138);
    expect(result.data.concepts[0]?.name).toBe('PCB');
  });

  it('未注入 manager 时返回 invalid_input', async () => {
    const result = await getStockProfileTool.execute({ stockId: '300476.SZ' }, mkCtx(undefined));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('manager 失败时返回 adapter_error', async () => {
    const manager = mkManager(async () => ({
      ok: false,
      error: {
        kind: 'adapter_error' as const,
        adapter: 'stock-profile' as const,
        message: 'upstream down',
        recoverable: true,
      },
    }));
    const result = await getStockProfileTool.execute({ stockId: '300476.SZ' }, mkCtx(manager));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
  });

  it('股票代码格式非法时输入校验失败', () => {
    expect(GetStockProfileInput.safeParse({ stockId: 'not-a-stock' }).success).toBe(false);
  });
});
