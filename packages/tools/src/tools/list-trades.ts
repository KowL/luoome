import { TradeSchema, TradeSideSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const ListTradesInput = z.object({
  /** 账户 id；缺省为当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  side: TradeSideSchema.optional(),
  /** 按 executedAt 过滤（闭区间）。 */
  since: z.coerce.date().optional(),
  /** 按 executedAt 过滤（闭区间）。 */
  until: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const ListTradesOutput = z.object({
  accountId: z.string().min(1),
  trades: z.array(TradeSchema),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
});

export const listTradesTool = defineTool({
  name: 'list_trades',
  description: '查询账户交易记录（可按股票/方向/成交时间过滤，按成交时间倒序）',
  sideEffect: 'read',
  input: ListTradesInput,
  output: ListTradesOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const filtered = (await ctx.repos.trade.listByAccount(accountId))
      .filter((trade) => input.stockId === undefined || trade.stockId === input.stockId)
      .filter((trade) => input.side === undefined || trade.side === input.side)
      .filter(
        (trade) => input.since === undefined || trade.executedAt.getTime() >= input.since.getTime(),
      )
      .filter(
        (trade) => input.until === undefined || trade.executedAt.getTime() <= input.until.getTime(),
      )
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime() || b.id.localeCompare(a.id));

    return {
      accountId,
      trades: z.array(TradeSchema).parse(filtered.slice(0, input.limit)),
      total: filtered.length,
    };
  },
});
