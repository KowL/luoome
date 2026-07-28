import {
  EventImportanceSchema,
  type StockEvent,
  StockEventKindSchema,
  StockEventSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const shanghaiMidnight = (date: Date): Date => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - SHANGHAI_OFFSET_MS);
};
const shanghaiDay = (date: Date): string =>
  new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);

export const AddStockEventInput = z.object({
  stockId: z.string().min(1),
  kind: StockEventKindSchema,
  title: z.string().min(1).max(200),
  occursAt: z.coerce.date(),
  allDay: z.boolean().optional(),
  importance: EventImportanceSchema.optional(),
  remindBeforeDays: z.array(z.number().int().min(0).max(90)).max(8).optional(),
  description: z.string().max(2000).optional(),
  sourceUrl: z.string().url().optional(),
});

export const AddStockEventOutput = z.object({
  event: StockEventSchema,
  /** (stockId, kind, occursAt) 疑似重复时返回既有事件 id，由调用方决定是否继续。 */
  duplicateWarning: z.string().optional(),
});

/**
 * add_stock_event（ruo 迁移 §7.2，write）。手工事件（source='manual'）。
 * (stockId, kind, occursAt) 已存在时返回 duplicateWarning，不阻断创建。
 */
export const addStockEventTool = defineTool({
  name: 'add_stock_event',
  description: '新增手工公司事件（返回疑似重复告警，由调用方决定是否继续）',
  sideEffect: 'write',
  input: AddStockEventInput,
  output: AddStockEventOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const allDay = input.allDay ?? true;
    const occursAt = allDay ? shanghaiMidnight(input.occursAt) : input.occursAt;

    const existing = await ctx.repos.stockEvent.list({
      stockId: input.stockId,
      kinds: [input.kind],
    });
    const dup = existing.find((e) =>
      allDay
        ? shanghaiDay(e.occursAt) === shanghaiDay(occursAt)
        : e.occursAt.getTime() === occursAt.getTime(),
    );

    const event: StockEvent = {
      id: `evt_${globalThis.crypto.randomUUID().slice(0, 8)}`,
      stockId: input.stockId,
      kind: input.kind,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      occursAt,
      allDay,
      importance: input.importance ?? 'normal',
      status: 'scheduled',
      source: 'manual',
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      stale: false,
      remindBeforeDays: input.remindBeforeDays ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await ctx.repos.stockEvent.save(event);
    return { event, ...(dup !== undefined ? { duplicateWarning: dup.id } : {}) };
  },
});
