import {
  EventImportanceSchema,
  StockEventKindSchema,
  StockEventSchema,
  StockEventStatusSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListStockEventsInput = z.object({
  stockId: z.string().min(1).optional(),
  kinds: z.array(StockEventKindSchema).optional(),
  status: StockEventStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  importance: EventImportanceSchema.optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const ListStockEventsOutput = z.object({
  events: z.array(StockEventSchema),
});

/** list_stock_events（ruo 迁移 §7.2，read）。 */
export const listStockEventsTool = defineTool({
  name: 'list_stock_events',
  description: '查询公司事件（财报 / 解禁 / 分红 / 手工…，按 occursAt 升序）',
  sideEffect: 'read',
  input: ListStockEventsInput,
  output: ListStockEventsOutput,
  handler: async (input, ctx) => {
    const events = await ctx.repos.stockEvent.list({
      ...(input.stockId !== undefined ? { stockId: input.stockId } : {}),
      ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      limit: input.limit,
    });
    return { events: [...events] };
  },
});
