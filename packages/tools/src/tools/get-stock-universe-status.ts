import { MarketCoverageSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetStockUniverseStatusInput = z.object({
  coverage: MarketCoverageSchema.default('CN_A_SHARES_SH_SZ'),
});

const LastSuccessSchema = z.object({
  source: z.string(),
  observedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  observedCount: z.number().int().nonnegative(),
});

export const GetStockUniverseStatusOutput = z.object({
  coverage: MarketCoverageSchema,
  sources: z.array(z.string()),
  activeCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  freshness: z.enum(['fresh', 'stale', 'unknown', 'unavailable']),
  lastSuccess: LastSuccessSchema.nullable(),
});

export const getStockUniverseStatusTool = defineTool({
  name: 'get_stock_universe_status',
  description: '查询本地股票目录覆盖范围、同步时间、active/missing 数量与新鲜度',
  sideEffect: 'read',
  input: GetStockUniverseStatusInput,
  output: GetStockUniverseStatusOutput,
  handler: async (input, ctx) => {
    const [latest, active, missing] = await Promise.all([
      ctx.repos.stockUniverse.latestSuccessfulSync({ coverage: input.coverage }),
      ctx.repos.stockUniverse.listCurrent({
        coverage: input.coverage,
        status: 'active',
      }),
      ctx.repos.stockUniverse.listCurrent({
        coverage: input.coverage,
        status: 'missing',
      }),
    ]);
    const sources = [...(ctx.adapters.stockUniverse?.sources ?? [])];
    const freshness =
      latest?.finishedAt === null || latest?.finishedAt === undefined
        ? sources.length === 0
          ? ('unavailable' as const)
          : ('unknown' as const)
        : ctx.clock().getTime() - latest.finishedAt.getTime() < 12 * 60 * 60 * 1000
          ? ('fresh' as const)
          : ('stale' as const);
    return {
      coverage: input.coverage,
      sources,
      activeCount: active.length,
      missingCount: missing.length,
      freshness,
      lastSuccess:
        latest === null
          ? null
          : {
              source: latest.source,
              observedAt: latest.observedAt,
              finishedAt: latest.finishedAt,
              observedCount: latest.observedCount,
            },
    };
  },
});
