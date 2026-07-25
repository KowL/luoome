import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const DeleteStockEventInput = z.object({
  eventId: z.string().min(1),
});

export const DeleteStockEventOutput = z.object({
  ok: z.literal(true),
});

/**
 * delete_stock_event（ruo 迁移 §7.2，write）。
 * 仅 manual 事件可删；external → invalid_input（提示用 cancelled 状态语义）。
 */
export const deleteStockEventTool = defineTool({
  name: 'delete_stock_event',
  description: '删除手工公司事件（external 事件请改 status=cancelled，不可删）',
  sideEffect: 'write',
  input: DeleteStockEventInput,
  output: DeleteStockEventOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockEvent.findById(input.eventId);
    if (existing === null) return errNotFound('StockEvent', input.eventId);
    if (existing.source === 'external') {
      return errInvalidInput('external 事件不可删除；如需失效请把 status 改为 cancelled');
    }
    await ctx.repos.stockEvent.remove(input.eventId);
    return { ok: true as const };
  },
});
