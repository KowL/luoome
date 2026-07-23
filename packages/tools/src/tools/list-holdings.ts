import { MoneySchema, PercentageSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { enrichHolding, HoldingPnlSchema, summarizePnl } from '../internal/holding-pnl.js';

const HoldingStatusSchema = z.enum(['active', 'closed', 'all']);

export const ListHoldingsInput = z.object({
  /** 账户 id；缺省为当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
  /** active=仅未平仓（默认） / closed=仅已平仓 / all=全部。 */
  status: HoldingStatusSchema.default('active'),
});

export const ListHoldingsOutput = z.object({
  accountId: z.string().min(1),
  status: HoldingStatusSchema,
  holdings: z.array(HoldingPnlSchema),
  totalValue: MoneySchema,
  totalCost: MoneySchema,
  totalPnL: MoneySchema,
  totalPnLPct: PercentageSchema,
});

export const listHoldingsTool = defineTool({
  name: 'list_holdings',
  description: '列出指定账户下的当前持仓（含现价与 PnL 汇总）',
  sideEffect: 'read',
  input: ListHoldingsInput,
  output: ListHoldingsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const all = await ctx.repos.holding.listByAccount(accountId);
    const holdings = all.filter((h) => {
      if (input.status === 'all') return true;
      return input.status === 'active' ? h.closedAt === null : h.closedAt !== null;
    });

    const stockIds = holdings.map((h) => h.stockId);
    const [storedQuotes, liveQuotes] = await Promise.all([
      ctx.repos.quote.latestByStocks(stockIds),
      ctx.adapters.market.batchQuote(stockIds).catch((error: unknown) => {
        ctx.logger.warn('list_holdings live quotes unavailable, using stored snapshots', {
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map();
      }),
    ]);
    // 最新实时价优先；实时源缺失或整体失败时保留本地最后快照。
    const quotes = new Map(storedQuotes);
    for (const [stockId, quote] of liveQuotes) quotes.set(stockId, quote);
    const items = await Promise.all(
      holdings.map(async (holding) => {
        const stock = await ctx.repos.stock.findById(holding.stockId);
        return enrichHolding(holding, quotes.get(holding.stockId), stock?.name ?? holding.stockId);
      }),
    );

    return { accountId, status: input.status, holdings: items, ...summarizePnl(items) };
  },
});
