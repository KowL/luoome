import type { SectorCatalogAdapterLike } from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncSectorCatalogWorkflow } from './sync-sector-catalog.js';

describe('workflow/sync-sector-catalog', () => {
  it('只通过 sync_sector_catalog tool 完成目录与成分同步', async () => {
    const adapter: SectorCatalogAdapterLike = {
      name: 'fuyao',
      fetchSectorCatalog: async (kind) => [
        {
          kind,
          vendorCode: kind === 'industry' ? '881273.TI' : '886042.TI',
          name: kind === 'industry' ? '白酒' : '白酒概念',
        },
      ],
      fetchStockSectors: async (stockIds) => ({
        observations: stockIds.map((stockId) => ({
          stockId,
          sectors: [{ kind: 'industry', vendorCode: '881273.TI', name: '白酒' }],
        })),
        failures: [],
      }),
    };
    const ctx = await buildTestContext({
      clock: () => new Date('2026-11-03T00:20:00.000Z'),
      sectorCatalog: adapter,
    });
    await seedTestStockUniverse(ctx, { limit: 2 });

    const result = await syncSectorCatalogWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('succeeded');
    expect(result.data.observedStocks).toBe(2);
    expect(await ctx.repos.sectorCatalog.listByStock({ stockIds: ['600519.SH'] })).toHaveLength(1);
  });
});
