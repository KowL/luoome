import {
  type AccountFacts,
  AccountFactsSchema,
  type AccountPriceFact,
  buildAccountFacts,
  isAdviceQuoteCurrent,
  MoneySchema,
  money,
  reconcileCashBalance,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const GetAccountFactsInput = z.object({
  accountId: z.string().min(1).optional(),
});
export const GetAccountFactsOutput = z.object({ facts: AccountFactsSchema });

/**
 * 由账户现金字段 + 当前持仓 + 本地行情构造「账户事实」。
 *
 * 现金来自 Account.cashBalance（交易/持仓/流水维护），市值只能来自行情：
 * 任何有数量的持仓缺少达到决策资格的行情时，整份事实标 unavailable 并给出原因，
 * 计划与预算据此拒绝给精确仓位（“不要快照，只拿当前持仓”之后的唯一账户输入）。
 */
export const deriveAccountFacts = async (
  ctx: ToolContext,
  accountId?: string,
): Promise<AccountFacts | null> => {
  const id = accountId ?? ctx.user.defaultAccountId;
  const account = await ctx.repos.account.findById(id);
  if (account === null) return null;
  const holdings = (await ctx.repos.holding.listByAccount(id)).filter(
    (holding) => holding.closedAt === null && holding.quantity > 0,
  );
  const stockIds = [...new Set(holdings.map((holding) => holding.stockId))];
  const now = ctx.clock();
  const prices = new Map<string, AccountPriceFact>();
  const stocks = new Map<string, { industry?: string }>();
  for (const stockId of stockIds) {
    const stock = await ctx.repos.stock.findById(stockId);
    if (stock !== null && stock.industry !== undefined) {
      stocks.set(stockId, { industry: stock.industry });
    } else if (stock !== null) {
      stocks.set(stockId, {});
    }
    const quote = await ctx.repos.quote.latestByStock(stockId);
    if (quote === null) continue;
    if (!isAdviceQuoteCurrent(quote, now)) continue;
    prices.set(stockId, { close: money(quote.close), observedAt: quote.observedAt });
  }
  return buildAccountFacts({ account, holdings, stocks, prices, asOf: now });
};

export const getAccountFactsTool = defineTool({
  name: 'get_account_facts',
  description: '按当前持仓与行情计算账户事实（现金字段 + 持仓市值 + 指纹）',
  sideEffect: 'read',
  input: GetAccountFactsInput,
  output: GetAccountFactsOutput,
  handler: async (input, ctx) => {
    const facts = await deriveAccountFacts(ctx, input.accountId);
    if (facts === null) {
      return errNotFound('Account', input.accountId ?? ctx.user.defaultAccountId);
    }
    return { facts };
  },
});

export const ReconcileAccountCashInput = z.object({
  accountId: z.string().min(1).optional(),
});

export const ReconcileAccountCashOutput = z.object({
  accountId: z.string().min(1),
  stored: MoneySchema,
  recomputed: MoneySchema,
  difference: MoneySchema,
  reconciled: z.boolean(),
  gaps: z.array(
    z.object({
      stockId: z.string().min(1),
      holdingQuantity: z.number().int().nonnegative(),
      tradedQuantity: z.number().int(),
      uncoveredQuantity: z.number().int().nonnegative(),
      unmatchedTradeQuantity: z.number().int().nonnegative(),
      oversoldQuantity: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * 账户现金对账：把账户上的现金余额与账本（初始资金 + 交易 + 资金流水 + 直接登记持仓）
 * 重算结果比一比。差额就是漏记的成交/入金/出金，缺口逐股列出，不用人工找。
 */
export const reconcileAccountCashTool = defineTool({
  name: 'reconcile_account_cash',
  description: '对账账户现金余额与账本口径，输出差额与账本缺口',
  sideEffect: 'read',
  input: ReconcileAccountCashInput,
  output: ReconcileAccountCashOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    const [holdings, trades, cashFlows] = await Promise.all([
      ctx.repos.holding.listByAccount(accountId),
      ctx.repos.trade.listByAccount(accountId),
      ctx.repos.portfolioCashFlow.listByAccount(accountId),
    ]);
    const result = reconcileCashBalance(account, { account, holdings, trades, cashFlows });
    return {
      accountId: result.accountId,
      stored: result.stored,
      recomputed: result.recomputed,
      difference: result.difference,
      reconciled: result.reconciled,
      gaps: result.gaps.map((gap) => ({ ...gap })),
    };
  },
});
