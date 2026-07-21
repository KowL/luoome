import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const DeleteStockPoolInput = z.object({
  id: z.string().min(1),
});

export const DeleteStockPoolOutput = z.object({
  id: z.string().min(1),
  removed: z.boolean(),
});

/**
 * 删除股票池（v0.6 起，write）。
 *
 * 设计：池删后历史 watchTriggers 不级联删除（poolId 字段保留作为审计线索）；
 * listByPool 查询依然能拿到，但 pool 已 findById=null（前端展示为「池已删除」）。
 */
export const deleteStockPoolTool = defineTool({
  name: 'delete_stock_pool',
  description: '删除股票池（write）；历史 watchTriggers 不级联删除',
  sideEffect: 'write',
  input: DeleteStockPoolInput,
  output: DeleteStockPoolOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockPool.findById(input.id);
    if (existing === null) return errNotFound('StockPool', input.id);
    await ctx.repos.stockPool.remove(input.id);
    return { id: input.id, removed: true };
  },
});
