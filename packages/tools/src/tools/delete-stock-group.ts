import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const DeleteStockGroupInput = z.object({
  id: z.string().min(1),
});

export const DeleteStockGroupOutput = z.object({
  id: z.string().min(1),
  removed: z.boolean(),
});

/**
 * 删除股票分组（分组化起，write；docs/stock-group-design.md §6）。
 *
 * 有 pool 引用时拒绝（invariant_violation，提示先解绑）。
 * 历史成员快照不级联删除（groupId 字段保留作为审计线索，同 delete_stock_pool 口径）。
 */
export const deleteStockGroupTool = defineTool({
  name: 'delete_stock_group',
  description: '删除股票分组（write）；有 pool 引用时拒绝，需先解绑',
  sideEffect: 'write',
  input: DeleteStockGroupInput,
  output: DeleteStockGroupOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockGroup.findById(input.id);
    if (existing === null) return errNotFound('StockGroup', input.id);

    const pools = await ctx.repos.stockPool.list(false);
    const referencing = pools.filter((p) => p.groupId === input.id);
    if (referencing.length > 0) {
      return {
        ok: false,
        error: {
          kind: 'invariant_violation',
          message: `分组仍被 ${referencing.length} 个池引用（${referencing
            .map((p) => p.id)
            .join(', ')}），请先用 update_stock_pool 换绑或删除这些池`,
        },
      };
    }

    await ctx.repos.stockGroup.remove(input.id);
    return { id: input.id, removed: true };
  },
});
