import {
  type DragonTigerList,
  DragonTigerListQuerySchema,
  type DragonTigerManagerLike,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { dragonTigerListTool } from './dragon-tiger.js';

const mkList = (date: string): DragonTigerList => ({
  date,
  total: 1,
  source: 'eastmoney',
  entries: [
    {
      code: '600547',
      name: '山东黄金',
      close: 37.05,
      changePct: 0.049575,
      turnoverRate: 0.041323,
      reason: '非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券',
      netAmount: 855648751.87,
      buyAmount: 3371674861.76,
      sellAmount: 2516026109.89,
      amount: 17302349779,
      tradeDate: date,
    },
  ],
  warnings: [],
  asOf: new Date(),
});

const mkManager = (fetchImpl: DragonTigerManagerLike['fetchList']): DragonTigerManagerLike => ({
  name: 'dragon-tiger',
  sources: ['eastmoney'],
  status: () => [],
  fetchList: fetchImpl,
});

describe('dragon_tiger_list tool', () => {
  const makeCtx = (manager: DragonTigerManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      dragonTiger: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await dragonTigerListTool.execute(
      DragonTigerListQuerySchema.parse({ date: '2026-08-21' }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回榜单', async () => {
    const list = mkList('2026-08-21');
    const manager = mkManager(vi.fn(async () => ({ ok: true, data: list })));
    const r = await dragonTigerListTool.execute(
      DragonTigerListQuerySchema.parse({ date: '2026-08-21' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.date).toBe('2026-08-21');
    expect(r.data.entries[0]?.code).toBe('600547');
  });

  it('manager 失败 → adapter_error 透传', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'dragon-tiger' as const,
          message: 'down',
          recoverable: false,
        },
      })),
    );
    const r = await dragonTigerListTool.execute(
      DragonTigerListQuerySchema.parse({ date: '2026-08-21' }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('dragon-tiger');
      expect(r.error.cause).toMatch(/down/);
    }
  });

  it('date 缺省 → 透传给 manager 解析', async () => {
    const fetchList = vi.fn(async () => ({ ok: true as const, data: mkList('2026-08-21') }));
    const manager = mkManager(fetchList);
    const r = await dragonTigerListTool.execute({}, makeCtx(manager));
    expect(r.ok).toBe(true);
    expect(fetchList).toHaveBeenCalledWith({});
  });
});
