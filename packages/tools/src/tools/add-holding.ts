import { type Holding, HoldingSchema, money } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { ensureStockStub, manualId, STOCK_ID_PATTERN } from '../internal/manual-entry.js';

export const AddHoldingInput = z.object({
  /** 形如 002594.SZ（代码.交易所）。 */
  stockId: z.string().regex(STOCK_ID_PATTERN, 'stockId 必须形如 002594.SZ（代码.交易所）'),
  quantity: z.number().int().positive(),
  avgCost: z.number().positive(),
  /** 缺省 = quantity（全量可卖）。 */
  availableQuantity: z.number().int().nonnegative().optional(),
  /** 缺省 = ctx.clock()（现在）。 */
  openedAt: z.coerce.date().optional(),
  /** 缺省 = 当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
});

export const AddHoldingOutput = z.object({
  holding: HoldingSchema,
});

/**
 * 直接录入持仓（v0.5 起，write）。
 * 用于没有交易记录的历史持仓；有成交明细请用 add_trade。
 * 同 (accountId, stockId) 已存在持仓（含已平仓）→ invalid_input（唯一约束）。
 */
export const addHoldingTool = defineTool({
  name: 'add_holding',
  description: '直接录入一笔持仓（无交易记录场景）；同账户同股票不可重复',
  sideEffect: 'write',
  input: AddHoldingInput,
  output: AddHoldingOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const existing = await ctx.repos.holding.findByAccountAndStock(accountId, input.stockId);
    if (existing !== null) {
      return errInvalidInput(
        `同 (accountId, stockId) 已存在持仓（id=${existing.id}，closedAt=${existing.closedAt?.toISOString() ?? 'null'}）；加仓/减仓请用 add_trade，纠错请用 update_holding`,
      );
    }

    const availableQuantity = input.availableQuantity ?? input.quantity;
    if (availableQuantity > input.quantity) {
      return errInvalidInput(
        `availableQuantity(${availableQuantity}) 不能大于 quantity(${input.quantity})`,
      );
    }

    await ensureStockStub(input.stockId, ctx);
    const now = ctx.clock();
    const holding: Holding = {
      id: manualId('holding'),
      accountId,
      stockId: input.stockId,
      quantity: input.quantity,
      availableQuantity,
      avgCost: money(input.avgCost),
      openedAt: input.openedAt ?? now,
      closedAt: null,
    };
    await ctx.repos.holding.save(holding);
    return { holding };
  },
});
