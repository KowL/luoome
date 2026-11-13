import type {
  SectorCatalogAdapterLike,
  SectorCatalogObservation,
  SectorSyncFailure,
  StockSectorObservation,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { getStockSectorMembershipsTool } from './get-stock-sector-memberships.js';
import { syncSectorCatalogTool } from './sync-sector-catalog.js';

const NOW = new Date('2026-11-03T00:20:00.000Z');

const industry: SectorCatalogObservation = {
  kind: 'industry',
  vendorCode: '881273.TI',
  name: '白酒',
};
const concept: SectorCatalogObservation = {
  kind: 'concept',
  vendorCode: '886042.TI',
  name: '白酒概念',
};

interface AdapterState {
  conceptCatalogFails: boolean;
  observedStocks: string[];
  failures: SectorSyncFailure[];
  sectorsByStock?: Record<string, SectorCatalogObservation[]>;
  emptyConceptCatalog?: boolean;
}

const makeAdapter = (state: AdapterState): SectorCatalogAdapterLike => ({
  name: 'fuyao',
  fetchSectorCatalog: async (kind) => {
    if (kind === 'concept' && state.conceptCatalogFails) {
      throw new Error('fuyao upstream_error: concept catalog failed');
    }
    if (kind === 'concept' && state.emptyConceptCatalog === true) return [];
    return [kind === 'industry' ? industry : concept];
  },
  fetchStockSectors: async (): Promise<{
    observations: readonly StockSectorObservation[];
    failures: readonly SectorSyncFailure[];
  }> => ({
    observations: state.observedStocks.map((stockId) => ({
      stockId,
      sectors: state.sectorsByStock?.[stockId] ?? [industry, concept],
    })),
    failures: state.failures,
  }),
});

const readMemberships = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  stockId: string,
  input: { includeMissing?: boolean; kinds?: Array<'industry' | 'concept'> } = {},
) => {
  const result = await getStockSectorMembershipsTool.execute(
    {
      stockIds: [stockId],
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.includeMissing === undefined ? {} : { includeMissing: input.includeMissing }),
    },
    ctx,
  );
  if (!result.ok) throw new Error(`read memberships failed: ${JSON.stringify(result.error)}`);
  return result.data;
};

describe('tool/sync_sector_catalog', () => {
  it('同步目录与成分，按股票反查含来源与时点，重复执行不产生重复关系', async () => {
    const state: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: ['600519.SH', '300750.SZ'],
      failures: [],
    };
    const ctx = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(state),
    });
    await seedTestStockUniverse(ctx, { limit: 2 });

    const first = await syncSectorCatalogTool.execute({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toMatchObject({
      source: 'fuyao',
      status: 'succeeded',
      kinds: ['industry', 'concept'],
      observedSectors: 2,
      observedStocks: 2,
      createdSectors: 2,
      renamedSectors: 0,
      retiredSectors: 0,
      createdMemberships: 4,
      removedMemberships: 0,
      reactivatedMemberships: 0,
      failures: [],
    });
    expect(first.data.observedAt).toEqual(NOW);

    const memberships = await readMemberships(ctx, '600519.SH');
    expect(memberships.memberships.map((item) => `${item.kind}:${item.vendorCode}`)).toEqual([
      'concept:886042.TI',
      'industry:881273.TI',
    ]);
    expect(memberships.memberships[0]).toMatchObject({
      stockId: '600519.SH',
      source: 'fuyao',
      name: '白酒概念',
      state: 'active',
      memberStatus: 'listed',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });

    const again = await syncSectorCatalogTool.execute({}, ctx);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.createdSectors).toBe(0);
    expect(again.data.createdMemberships).toBe(0);
    expect(await readMemberships(ctx, '600519.SH')).toMatchObject({
      memberships: [{ lastSeenAt: NOW }, { lastSeenAt: NOW }],
    });
    expect((await readMemberships(ctx, '300750.SZ')).memberships).toHaveLength(2);
  });

  it('部分响应失败：未观测股票保持成分，失败分类不下线目录', async () => {
    const state: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: ['600519.SH', '300750.SZ'],
      failures: [],
    };
    const ctx = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(state),
    });
    await seedTestStockUniverse(ctx, { limit: 2 });
    await syncSectorCatalogTool.execute({}, ctx);

    state.conceptCatalogFails = true;
    state.observedStocks = ['600519.SH'];
    state.sectorsByStock = { '600519.SH': [industry] };
    state.failures = [
      { scope: 'memberships', kind: null, message: 'fuyao network: batch 300750.SZ failed' },
    ];

    const partial = await syncSectorCatalogTool.execute({}, ctx);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.status).toBe('partial');
    expect(partial.data.failures).toHaveLength(2);
    expect(partial.data.retiredSectors).toBe(0);

    // 未被观测的 300750.SZ 不退出，仍是两条 active 成分。
    expect((await readMemberships(ctx, '300750.SZ')).memberships).toHaveLength(2);
    // concept 目录请求失败 → 不下线。
    expect(await ctx.repos.sectorCatalog.listSectors({ kinds: ['concept'] })).toHaveLength(1);
    // 被观测到的 600519.SH 少了概念关系 → 只退这一条。
    expect(
      (await readMemberships(ctx, '600519.SH', { includeMissing: true })).memberships.map(
        (item) => `${item.vendorCode}:${item.state}`,
      ),
    ).toEqual(['886042.TI:missing', '881273.TI:active']);
  });

  it('目录空响应不视为全部下线', async () => {
    const state: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: ['600519.SH', '300750.SZ'],
      failures: [],
    };
    const ctx = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(state),
    });
    await seedTestStockUniverse(ctx, { limit: 2 });
    await syncSectorCatalogTool.execute({}, ctx);

    state.emptyConceptCatalog = true;
    state.sectorsByStock = {
      '600519.SH': [industry],
      '300750.SZ': [industry],
    };
    const result = await syncSectorCatalogTool.execute({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('partial');
    expect(result.data.retiredSectors).toBe(0);
    expect(await ctx.repos.sectorCatalog.listSectors({ kinds: ['concept'] })).toHaveLength(1);
  });

  it('dryRun 只抓取不落库', async () => {
    const state: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: ['600519.SH', '300750.SZ'],
      failures: [],
    };
    const ctx = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(state),
    });
    await seedTestStockUniverse(ctx, { limit: 2 });

    const result = await syncSectorCatalogTool.execute({ dryRun: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      status: 'dry-run',
      observedSectors: 2,
      observedStocks: 2,
      createdSectors: 0,
      createdMemberships: 0,
    });
    expect(await ctx.repos.sectorCatalog.listSectors()).toEqual([]);
    expect((await readMemberships(ctx, '600519.SH')).memberships).toEqual([]);
  });

  it('未配置数据源或本地目录为空时明确失败', async () => {
    const emptyUniverse = await buildTestContext({ clock: () => NOW });
    const missingAdapter = await syncSectorCatalogTool.execute({}, emptyUniverse);
    expect(missingAdapter.ok).toBe(false);
    if (missingAdapter.ok) return;
    expect(missingAdapter.error.kind).toBe('adapter_error');

    const emptyState: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: [],
      failures: [],
    };
    const noUniverse = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(emptyState),
    });
    const result = await syncSectorCatalogTool.execute({}, noUniverse);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('停牌股票不被删除，只更新成分状态', async () => {
    const state: AdapterState = {
      conceptCatalogFails: false,
      observedStocks: ['600519.SH', '300750.SZ'],
      failures: [],
    };
    const ctx = await buildTestContext({
      clock: () => NOW,
      sectorCatalog: makeAdapter(state),
    });
    await seedTestStockUniverse(ctx, { limit: 2 });
    await syncSectorCatalogTool.execute({}, ctx);

    // 300750.SZ 停牌：目录标记 suspended，本轮反查没有返回它。
    const members = await ctx.repos.stockUniverse.listCurrentMembers({
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'sync-suspended',
      appliedAt: NOW,
      snapshot: {
        source: 'test-universe',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: NOW,
        complete: true,
        reportedTotal: 2,
        entries: members.map(({ stock }) => ({
          stockId: stock.id,
          code: stock.code,
          exchange: stock.exchange,
          name: stock.name,
          listingStatus: stock.id === '300750.SZ' ? ('suspended' as const) : ('listed' as const),
        })),
      },
    });
    state.observedStocks = ['600519.SH'];
    await syncSectorCatalogTool.execute({}, ctx);

    const suspended = await readMemberships(ctx, '300750.SZ');
    expect(suspended.memberships).toHaveLength(2);
    expect(suspended.memberships.every((item) => item.state === 'active')).toBe(true);
    expect(suspended.memberships.every((item) => item.memberStatus === 'suspended')).toBe(true);
    expect(
      (await ctx.repos.sectorCatalog.listChanges({ stockId: '300750.SZ' })).map(
        (change) => change.kind,
      ),
    ).toEqual(['member-entered', 'member-entered']);
  });
});
