import {
  SectorKindSchema,
  SectorStockIdSchema,
  StockSectorMembershipViewSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 按股票反查当前所属行业与概念（读本地同步事实，不联网）。
 * 返回来源与首次/最近观测时点；空结果只表示当前没有匹配关系。
 */
export const GetStockSectorMembershipsInput = z.object({
  stockIds: z.array(SectorStockIdSchema).min(1).max(100),
  kinds: z.array(SectorKindSchema).min(1).optional(),
  includeMissing: z.boolean().default(false),
});

export const GetStockSectorMembershipsOutput = z.object({
  memberships: z.array(StockSectorMembershipViewSchema),
  warnings: z.array(z.string()),
});

export const getStockSectorMembershipsTool = defineTool({
  name: 'get_stock_sector_memberships',
  description:
    '按股票反查当前所属行业与概念（保留内部标识、供应商代码、来源与观测时点）；' +
    'stockIds 单次最多 100 只，默认只返回当前有效成分。结果来自最近一次同步，不联网。',
  sideEffect: 'read',
  input: GetStockSectorMembershipsInput,
  output: GetStockSectorMembershipsOutput,
  handler: async (input, ctx) => {
    const memberships = await ctx.repos.sectorCatalog.listByStock({
      stockIds: input.stockIds,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      includeMissing: input.includeMissing,
    });
    return {
      memberships,
      warnings: memberships.length === 0 ? ['empty-list'] : [],
    };
  },
});
