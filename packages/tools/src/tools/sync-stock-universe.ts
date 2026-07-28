import { MarketCoverageSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

const FRESH_ENOUGH_MS = 12 * 60 * 60 * 1000;

export const SyncStockUniverseInput = z.object({
  source: z.string().trim().min(1).optional(),
  coverage: MarketCoverageSchema.default('CN_A_SHARES_SH_SZ'),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export const SyncStockUniverseOutput = z.object({
  syncId: z.string(),
  source: z.string(),
  coverage: MarketCoverageSchema,
  status: z.enum(['succeeded', 'dry-run', 'skipped']),
  observedCount: z.number().int().nonnegative(),
  createdStocks: z.number().int().nonnegative(),
  updatedStocks: z.number().int().nonnegative(),
  reactivated: z.number().int().nonnegative(),
  markedMissing: z.number().int().nonnegative(),
  observedAt: z.coerce.date().nullable(),
});

export const syncStockUniverseTool = defineTool({
  name: 'sync_stock_universe',
  description: '从外部数据源拉取完整股票目录快照，校验后原子写入本地数据库',
  sideEffect: 'external',
  input: SyncStockUniverseInput,
  output: SyncStockUniverseOutput,
  handler: async (input, ctx) => {
    const manager = ctx.adapters.stockUniverse;
    if (manager === undefined) {
      return errAdapterError('stock-universe', '股票目录数据源未配置', true);
    }

    const syncId = crypto.randomUUID();
    const latest = await ctx.repos.stockUniverse.latestSuccessfulSync({
      ...(input.source === undefined ? {} : { source: input.source }),
      coverage: input.coverage,
    });
    if (
      !input.force &&
      latest?.finishedAt !== null &&
      latest?.finishedAt !== undefined &&
      ctx.clock().getTime() - latest.finishedAt.getTime() < FRESH_ENOUGH_MS
    ) {
      return {
        syncId,
        source: latest.source,
        coverage: input.coverage,
        status: 'skipped' as const,
        observedCount: latest.observedCount,
        createdStocks: 0,
        updatedStocks: 0,
        reactivated: 0,
        markedMissing: 0,
        observedAt: latest.observedAt,
      };
    }

    try {
      const snapshot = await manager.fetchStockUniverse({
        coverage: input.coverage,
        ...(input.source === undefined ? {} : { source: input.source }),
      });
      const previousSameSource = await ctx.repos.stockUniverse.latestSuccessfulSync({
        source: snapshot.source,
        coverage: snapshot.coverage,
      });
      if (
        previousSameSource !== null &&
        snapshot.entries.length < Math.ceil(previousSameSource.observedCount * 0.8)
      ) {
        throw new Error(
          `partial_data: 股票目录数量从 ${previousSameSource.observedCount} 骤降到 ${snapshot.entries.length}`,
        );
      }
      if (input.dryRun) {
        return {
          syncId,
          source: snapshot.source,
          coverage: snapshot.coverage,
          status: 'dry-run' as const,
          observedCount: snapshot.entries.length,
          createdStocks: 0,
          updatedStocks: 0,
          reactivated: 0,
          markedMissing: 0,
          observedAt: snapshot.observedAt,
        };
      }
      const summary = await ctx.repos.stockUniverse.applySnapshot({
        syncId,
        snapshot,
        appliedAt: ctx.clock(),
      });
      return {
        syncId,
        source: snapshot.source,
        coverage: snapshot.coverage,
        status: 'succeeded' as const,
        ...summary,
        observedAt: snapshot.observedAt,
      };
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return errAdapterError('stock-universe', cause, true);
    }
  },
});
