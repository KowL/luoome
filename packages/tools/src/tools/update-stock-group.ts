import {
  assertStockGroupInvariants,
  GroupRefreshPolicySchema,
  GroupResolverSchema,
  StockGroupSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { validateGroupResolverRefs } from '../internal/stock-group.js';

export const UpdateStockGroupInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  resolver: GroupResolverSchema.optional(),
  refreshPolicy: GroupRefreshPolicySchema.optional(),
  enabled: z.boolean().optional(),
});

export const UpdateStockGroupOutput = z.object({
  group: StockGroupSchema,
});

/**
 * 更新股票分组（分组化起，write；docs/stock-group-design.md §6）。
 *
 * 语义：未提供的字段保持原值；description=null 表示清空。
 * 改 resolver 时做同样的跨实体引用校验（formula/holdings/manual）。
 * 注：改 resolver 不清历史快照——当前成员在下一次成功刷新前仍是旧批（快照只增不改）。
 */
export const updateStockGroupTool = defineTool({
  name: 'update_stock_group',
  description: '更新股票分组（write）；只改传入字段，未传保持原值',
  sideEffect: 'write',
  input: UpdateStockGroupInput,
  output: UpdateStockGroupOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockGroup.findById(input.id);
    if (existing === null) return errNotFound('StockGroup', input.id);

    if (input.resolver !== undefined) {
      const refError = await validateGroupResolverRefs(input.resolver, ctx);
      if (refError !== null) return refError;
    }

    const merged = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? input.description === null
          ? { description: undefined }
          : { description: input.description }
        : {}),
      ...(input.resolver !== undefined ? { resolver: input.resolver } : {}),
      ...(input.refreshPolicy !== undefined ? { refreshPolicy: input.refreshPolicy } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: ctx.clock(),
    };

    const group = StockGroupSchema.parse(merged);
    try {
      assertStockGroupInvariants(group);
    } catch (e) {
      return errInvalidInput((e as Error).message);
    }
    await ctx.repos.stockGroup.save(group);
    return { group };
  },
});
