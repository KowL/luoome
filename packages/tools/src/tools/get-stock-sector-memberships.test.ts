import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStockSectorMembershipsTool } from './get-stock-sector-memberships.js';

const NOW = new Date('2026-11-03T00:20:00.000Z');

const seedSectors = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.sectorCatalog.applySync({
    syncId: 'sector-read-1',
    source: 'fuyao',
    appliedAt: NOW,
    status: 'succeeded',
    catalog: [
      { kind: 'industry', vendorCode: '881273.TI', name: '白酒' },
      { kind: 'concept', vendorCode: '886042.TI', name: '白酒概念' },
    ],
    catalogKinds: ['industry', 'concept'],
    observations: [
      {
        stockId: '600519.SH',
        sectors: [
          { kind: 'industry', vendorCode: '881273.TI', name: '白酒' },
          { kind: 'concept', vendorCode: '886042.TI', name: '白酒概念' },
        ],
      },
    ],
    stockStatuses: [{ stockId: '600519.SH', status: 'listed' }],
    failures: [],
  });
};

describe('tool/get_stock_sector_memberships', () => {
  it('按股票反查行业与概念，含内部标识、供应商代码、来源与时点', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSectors(ctx);

    const result = await getStockSectorMembershipsTool.execute({ stockIds: ['600519.SH'] }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toEqual([]);
    expect(result.data.memberships.map((item) => `${item.kind}:${item.vendorCode}`)).toEqual([
      'concept:886042.TI',
      'industry:881273.TI',
    ]);
    const [concept] = result.data.memberships;
    expect(concept).toMatchObject({
      stockId: '600519.SH',
      name: '白酒概念',
      source: 'fuyao',
      state: 'active',
      memberStatus: 'listed',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      missingSince: null,
    });
    expect(concept?.sectorId).not.toBe(concept?.vendorCode);
  });

  it('可按分类过滤，默认隐藏已退出成分、includeMissing 时可见', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSectors(ctx);
    await ctx.repos.sectorCatalog.applySync({
      syncId: 'sector-read-2',
      source: 'fuyao',
      appliedAt: new Date(NOW.getTime() + 86_400_000),
      status: 'succeeded',
      catalog: [
        { kind: 'industry', vendorCode: '881273.TI', name: '白酒' },
        { kind: 'concept', vendorCode: '886042.TI', name: '白酒概念' },
      ],
      catalogKinds: ['industry', 'concept'],
      observations: [
        {
          stockId: '600519.SH',
          sectors: [{ kind: 'industry', vendorCode: '881273.TI', name: '白酒' }],
        },
      ],
      stockStatuses: [{ stockId: '600519.SH', status: 'listed' }],
      failures: [],
    });

    const active = await getStockSectorMembershipsTool.execute(
      { stockIds: ['600519.SH'], kinds: ['concept'] },
      ctx,
    );
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.data.memberships).toEqual([]);
    expect(active.data.warnings).toEqual(['empty-list']);

    const all = await getStockSectorMembershipsTool.execute(
      { stockIds: ['600519.SH'], kinds: ['concept'], includeMissing: true },
      ctx,
    );
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.memberships[0]).toMatchObject({ state: 'missing', memberStatus: 'listed' });
  });

  it('未知股票返回空列表并提示不证明股票不存在', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const result = await getStockSectorMembershipsTool.execute({ stockIds: ['000001.SZ'] }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.memberships).toEqual([]);
    expect(result.data.warnings).toEqual(['empty-list']);
  });

  it('非法 stockId 或超过 100 只 → invalid_input', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    expect((await getStockSectorMembershipsTool.execute({ stockIds: ['600519'] }, ctx)).ok).toBe(
      false,
    );
    expect((await getStockSectorMembershipsTool.execute({ stockIds: [] }, ctx)).ok).toBe(false);
    const tooMany = Array.from(
      { length: 101 },
      (_, index) => `6${String(index).padStart(5, '0')}.SH`,
    );
    const result = await getStockSectorMembershipsTool.execute({ stockIds: tooMany }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
