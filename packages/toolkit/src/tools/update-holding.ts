import { type Holding, HoldingSchema, money } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { addHoldingTool } from './add-holding.js';
import { closeHoldingTool } from './close-holding.js';

export const UpdateHoldingInput = z
  .object({
    /** update/close 必填；open 不需要。 */
    holdingId: z.string().min(1).optional(),
    quantity: z.number().int().nonnegative().optional(),
    availableQuantity: z.number().int().nonnegative().optional(),
    avgCost: z.number().positive().optional(),
    /** update=纠错；open=建仓（合并 add_holding）；close=平仓（合并 close_holding）。 */
    mode: z.enum(['update', 'open', 'close']).default('update'),
    stockId: z.string().min(1).optional(),
    stockName: z.string().trim().min(1).max(100).optional(),
    accountId: z.string().min(1).optional(),
    openedAt: z.coerce.date().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === 'close') {
      if (input.holdingId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['holdingId'], message: 'close 需要 holdingId' });
      }
      return;
    }
    if (input.mode === 'open') {
      if (input.stockId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['stockId'], message: 'open 需要 stockId' });
      }
      if (input.quantity === undefined || input.quantity === 0) {
        ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'open 需要正数量 quantity' });
      }
      if (input.avgCost === undefined) {
        ctx.addIssue({ code: 'custom', path: ['avgCost'], message: 'open 需要 avgCost' });
      }
      return;
    }
    if (input.holdingId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['holdingId'], message: 'update 需要 holdingId' });
    }
    if (
      input.quantity === undefined &&
      input.availableQuantity === undefined &&
      input.avgCost === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: '至少提供一个待更新字段（quantity / availableQuantity / avgCost）',
      });
    }
  });

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
  description:
    '手动录入/校准持仓：update 纠错数量与成本、open 建仓（合并 add_holding）、close 平仓（合并 close_holding）',
  sideEffect: 'write',
  input: UpdateHoldingInput,
  output: UpdateHoldingOutput,
  handler: async (input, ctx) => {
    if (input.mode === 'open') {
      const result = await addHoldingTool.execute(
        {
          stockId: input.stockId as string,
          quantity: input.quantity as number,
          avgCost: input.avgCost as number,
          ...(input.stockName === undefined ? {} : { stockName: input.stockName }),
          ...(input.availableQuantity === undefined
            ? {}
            : { availableQuantity: input.availableQuantity }),
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.openedAt === undefined ? {} : { openedAt: input.openedAt }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return result.data;
    }
    if (input.mode === 'close') {
      const result = await closeHoldingTool.execute({ holdingId: input.holdingId as string }, ctx);
      if (!result.ok) return result;
      return result.data;
    }
    const existing = await ctx.repos.holding.findById(input.holdingId as string);
    if (existing === null) return errNotFound('Holding', input.holdingId as string);

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
    const account = await ctx.repos.account.findById(holding.accountId);
    if (account === null) return errNotFound('Account', holding.accountId);
    await ctx.repos.ledger.applyHolding({
      previousHolding: existing,
      holding,
      occurredAt: ctx.clock(),
    });
    return { holding };
  },
});
