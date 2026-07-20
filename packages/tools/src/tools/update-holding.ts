import { type Holding, HoldingSchema, money } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const UpdateHoldingInput = z
  .object({
    holdingId: z.string().min(1),
    quantity: z.number().int().nonnegative().optional(),
    availableQuantity: z.number().int().nonnegative().optional(),
    avgCost: z.number().positive().optional(),
  })
  .refine(
    (v) => v.quantity !== undefined || v.availableQuantity !== undefined || v.avgCost !== undefined,
    { message: '至少提供一个待更新字段（quantity / availableQuantity / avgCost）' },
  );

export const UpdateHoldingOutput = z.object({
  holding: HoldingSchema,
});

/**
 * 纠错持仓字段（v0.5 起，write）。
 * 只改显式传入的字段；合并后 availableQuantity > quantity → invalid_input；
 * repo 层不变量（非负整数 / available ≤ total）兜底。
 */
export const updateHoldingTool = defineTool({
  name: 'update_holding',
  description: '修正持仓的数量 / 可卖数量 / 成本价（录入错误纠错用）',
  sideEffect: 'write',
  input: UpdateHoldingInput,
  output: UpdateHoldingOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.holding.findById(input.holdingId);
    if (existing === null) return errNotFound('Holding', input.holdingId);

    const quantity = input.quantity ?? existing.quantity;
    const availableQuantity = input.availableQuantity ?? existing.availableQuantity;
    if (availableQuantity > quantity) {
      return errInvalidInput(
        `availableQuantity(${availableQuantity}) 不能大于 quantity(${quantity})`,
      );
    }

    const holding: Holding = {
      ...existing,
      quantity,
      availableQuantity,
      ...(input.avgCost !== undefined ? { avgCost: money(input.avgCost) } : {}),
    };
    await ctx.repos.holding.save(holding);
    return { holding };
  },
});
