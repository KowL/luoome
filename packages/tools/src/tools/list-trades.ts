import { createHash } from 'node:crypto';
import { TradeSchema, TradeSideSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const ListTradesInput = z.object({
  /** 账户 id；缺省为当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  side: TradeSideSchema.optional(),
  adviceId: z.string().min(1).optional(),
  researchHypothesisVersionId: z.string().min(1).optional(),
  strategyVersionId: z.string().min(1).optional(),
  /** 按 executedAt 过滤（闭区间）。 */
  since: z.coerce.date().optional(),
  /** 按 executedAt 过滤（闭区间）。 */
  until: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(100),
  cursor: z.string().min(1).optional(),
  asOf: z.coerce.date().optional(),
});

export const ListTradesOutput = z.object({
  accountId: z.string().min(1),
  trades: z.array(TradeSchema),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
  asOf: z.coerce.date(),
  snapshotHash: z.string().length(64),
  nextCursor: z.string().nullable(),
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

    const filterHash = createHash('sha256')
      .update(
        JSON.stringify({
          accountId,
          stockId: input.stockId,
          side: input.side,
          adviceId: input.adviceId,
          researchHypothesisVersionId: input.researchHypothesisVersionId,
          strategyVersionId: input.strategyVersionId,
          since: input.since?.toISOString(),
          until: input.until?.toISOString(),
        }),
      )
      .digest('hex');
    let cursor: {
      accountId: string;
      filterHash: string;
      snapshotHash: string;
      asOf: string;
      executedAt: string;
      id: string;
    } | null = null;
    if (input.cursor !== undefined) {
      try {
        cursor = z
          .object({
            accountId: z.string(),
            filterHash: z.string(),
            snapshotHash: z.string(),
            asOf: z.iso.datetime(),
            executedAt: z.iso.datetime(),
            id: z.string(),
          })
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
      } catch {
        return errInvalidInput('成交游标无效，请重新开始查询');
      }
      if (
        cursor.accountId !== accountId ||
        cursor.filterHash !== filterHash ||
        (input.asOf !== undefined && input.asOf.toISOString() !== cursor.asOf)
      )
        return errInvalidInput('成交游标与账户或筛选条件不匹配');
    }
    const asOf = cursor === null ? (input.asOf ?? ctx.clock()) : new Date(cursor.asOf);
    const filtered = (await ctx.repos.trade.listByAccount(accountId))
      .filter((trade) => trade.createdAt <= asOf)
      .filter((trade) => input.stockId === undefined || trade.stockId === input.stockId)
      .filter((trade) => input.side === undefined || trade.side === input.side)
      .filter((trade) => input.adviceId === undefined || trade.adviceId === input.adviceId)
      .filter(
        (trade) =>
          input.researchHypothesisVersionId === undefined ||
          trade.researchHypothesisVersionId === input.researchHypothesisVersionId,
      )
      .filter(
        (trade) =>
          input.strategyVersionId === undefined ||
          trade.strategyVersionId === input.strategyVersionId,
      )
      .filter(
        (trade) => input.since === undefined || trade.executedAt.getTime() >= input.since.getTime(),
      )
      .filter(
        (trade) => input.until === undefined || trade.executedAt.getTime() <= input.until.getTime(),
      )
      .sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime() || b.id.localeCompare(a.id));

    const snapshotHash = createHash('sha256').update(JSON.stringify(filtered)).digest('hex');
    if (cursor !== null && snapshotHash !== cursor.snapshotHash)
      return errInvalidInput('成交事实已变化，请刷新选择器');
    const visible =
      cursor === null
        ? filtered
        : filtered.filter(
            (trade) =>
              trade.executedAt.toISOString() < cursor!.executedAt ||
              (trade.executedAt.toISOString() === cursor!.executedAt && trade.id < cursor!.id),
          );
    const trades = visible.slice(0, input.limit);
    const last = trades.at(-1);
    const nextCursor =
      visible.length > input.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              accountId,
              filterHash,
              snapshotHash,
              asOf: asOf.toISOString(),
              executedAt: last.executedAt.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null;
    return {
      accountId,
      trades: z.array(TradeSchema).parse(trades),
      total: filtered.length,
      asOf,
      snapshotHash,
      nextCursor,
    };
  },
});
