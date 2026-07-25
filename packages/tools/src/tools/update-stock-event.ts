import {
  EventImportanceSchema,
  type StockEvent,
  StockEventSchema,
  StockEventStatusSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const shanghaiMidnight = (date: Date): Date => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - SHANGHAI_OFFSET_MS);
};

export const UpdateStockEventInput = z.object({
  eventId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  occursAt: z.coerce.date().optional(),
  importance: EventImportanceSchema.optional(),
  remindBeforeDays: z.array(z.number().int().min(0).max(90)).max(8).optional(),
  status: StockEventStatusSchema.optional(),
});

export const UpdateStockEventOutput = z.object({
  event: StockEventSchema,
});

/**
 * update_stock_event（ruo 迁移 §7.2，write）。
 * source='external' 的事件禁止改 occursAt（以 provider 为准），只能改提醒设置 / status。
 */
export const updateStockEventTool = defineTool({
  name: 'update_stock_event',
  description: '更新公司事件（external 事件不可改 occursAt，只能改提醒设置）',
  sideEffect: 'write',
  input: UpdateStockEventInput,
  output: UpdateStockEventOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.stockEvent.findById(input.eventId);
    if (existing === null) return errNotFound('StockEvent', input.eventId);
    if (input.occursAt !== undefined && existing.source === 'external') {
      return errInvalidInput('external 事件的 occursAt 以 provider 为准，不可手工修改');
    }
    const now = ctx.clock();
    const occursAt =
      input.occursAt !== undefined
        ? existing.allDay
          ? shanghaiMidnight(input.occursAt)
          : input.occursAt
        : existing.occursAt;
    const updated: StockEvent = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      occursAt,
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.remindBeforeDays !== undefined ? { remindBeforeDays: input.remindBeforeDays } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: now,
    };
    await ctx.repos.stockEvent.save(updated);
    return { event: updated };
  },
});
