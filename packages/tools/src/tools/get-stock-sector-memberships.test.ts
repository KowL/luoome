import {
  GetStockSectorMembershipsQuerySchema,
  type SectorMembershipManagerLike,
  type SectorMembershipSnapshot,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { getStockSectorMembershipsTool } from './get-stock-sector-memberships.js';

const mkSnapshot = (): SectorMembershipSnapshot => ({
  total: 1,
  source: 'fuyao',
  items: [
    {
      stockId: '600519.SH',
      memberships: [{ sectorCode: '881273.TI', sectorName: '白酒', type: 'industry' }],
    },
  ],
  warnings: [],
  fetchedAt: new Date('2026-11-04T01:00:00.000Z'),
  contentHash: '0123456789abcdef',
});

const mkManager = (
  fetchImpl: SectorMembershipManagerLike['fetchMemberships'],
): SectorMembershipManagerLike => ({
  name: 'sector-membership',
  sources: ['fuyao'],
  fetchMemberships: fetchImpl,
  status: () => [],
});

describe('get_stock_sector_memberships tool', () => {
  const makeCtx = (manager: SectorMembershipManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      sectorMembership: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input（默认不装配）', async () => {
    const r = await getStockSectorMembershipsTool.execute(
      GetStockSectorMembershipsQuerySchema.parse({ stockIds: ['600519.SH'] }),
      makeCtx(undefined),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回关系快照（fetchedAt/source/contentHash 透传）', async () => {
    const manager = mkManager(vi.fn(async () => ({ ok: true as const, data: mkSnapshot() })));
    const r = await getStockSectorMembershipsTool.execute(
      { stockIds: ['600519.SH'] },
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('fuyao');
    expect(r.data.contentHash).toBe('0123456789abcdef');
    expect(r.data.items[0]?.memberships[0]?.sectorCode).toBe('881273.TI');
  });

  it('manager adapter_error → ToolError adapter_error', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'sector-membership' as const,
          message: 'fuyao down',
          recoverable: false,
        },
      })),
    );
    const r = await getStockSectorMembershipsTool.execute(
      { stockIds: ['600519.SH'] },
      makeCtx(manager),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('sector-membership');
      expect(r.error.cause).toMatch(/fuyao down/);
    }
  });

  it('越界输入 → invalid_input（空 stockIds / 超 100 只 / 非法代码 / 非法 type）', async () => {
    const manager = mkManager(vi.fn(async () => ({ ok: true as const, data: mkSnapshot() })));

    for (const bad of [
      { stockIds: [] },
      { stockIds: Array.from({ length: 101 }, (_, i) => `6005${String(i).padStart(2, '0')}.SH`) },
      { stockIds: ['600519'] },
      { stockIds: ['600519.SH'], type: 'unknown' },
    ]) {
      const r = await getStockSectorMembershipsTool.execute(bad, makeCtx(manager));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid_input');
    }
  });
});
