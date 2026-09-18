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

/**
 * 最新一条「合格」行情：`latestByStock` 只按时间取，盘前/收盘后的零星报价会把
 * 上一交易日的收盘价顶掉，于是明明有昨收也会被判为缺行情。这里按时间倒序取第一条
 * 通过决策资格校验的行情，保证盘前、收盘后、盘中都能得到稳定口径。
 */
const latestQualifiedQuote = async (
  ctx: ToolContext,
  stockId: string,
  now: Date,
): Promise<import('@luoome/core').Quote | null> => {
  const candidates = await ctx.repos.quote.listInRange(
    stockId,
    new Date(now.getTime() - 30 * 86_400_000),
    now,
  );
  const ordered = [...candidates].sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
  );
  for (const quote of ordered) {
    if (isAdviceQuoteCurrent(quote, now)) return quote;
  }
  return null;
};

const latestQuoteWithinDays = async (
  ctx: ToolContext,
  stockId: string,
  now: Date,
  days: number,
): Promise<import('@luoome/core').Quote | null> => {
  const candidates = await ctx.repos.quote.listInRange(
    stockId,
    new Date(now.getTime() - days * 86_400_000),
    now,
  );
  return (
    [...candidates].sort(
      (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
    )[0] ?? null
  );
};

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
  const fallbackReasons: string[] = [];
  const fallbackNotes: string[] = [];
  const stocks = new Map<string, { industry?: string }>();
  for (const stockId of stockIds) {
    const stock = await ctx.repos.stock.findById(stockId);
    if (stock !== null && stock.industry !== undefined) {
      stocks.set(stockId, { industry: stock.industry });
    } else if (stock !== null) {
      stocks.set(stockId, {});
    }
    const qualified = await latestQualifiedQuote(ctx, stockId, now);
    if (qualified !== null) {
      prices.set(stockId, { close: money(qualified.close), observedAt: qualified.observedAt });
      continue;
    }
    // 兜底：停牌 / 刚登记 / 数据源缺当日的标的，用最近 30 天内最后一条行情估值，
    // 并在 reasons 里明确标注（带限制展示，不冒充当日实时）。
    const fallback = await latestQuoteWithinDays(ctx, stockId, now, 30);
    if (fallback === null) {
      fallbackReasons.push(`持仓 ${stockId} 没有任何可用行情，无法计算市值`);
      continue;
    }
    fallbackNotes.push(
      `持仓 ${stockId} 使用 ${fallback.observedAt.toISOString().slice(0, 10)} 的收盘价估值（无当日合格行情）`,
    );
    prices.set(stockId, { close: money(fallback.close), observedAt: fallback.observedAt });
  }
  const [trades, cashFlows, holdingAdjustments] = await Promise.all([
    ctx.repos.trade.listByAccount(id),
    ctx.repos.portfolioCashFlow.listByAccount(id),
    ctx.repos.ledger.listHoldingAdjustments(id),
  ]);
  const reconciliation = reconcileCashBalance(account, {
    account,
    holdings,
    trades,
    cashFlows,
    holdingAdjustments,
  });
  const extraReasons: string[] = [...fallbackReasons];
  if (!reconciliation.reconciled)
    extraReasons.push('账户现金与账本重算不一致，请核对资金和持仓记录');
  if (reconciliation.gaps.length > 0)
    extraReasons.push('持仓与交易、调整记录存在数量缺口，请先核对账本');
  return buildAccountFacts({
    account,
    holdings,
    stocks,
    prices,
    asOf: now,
    extraReasons,
    notes: fallbackNotes,
  });
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
 * 账户现金对账：把账户上的现金余额与账本（初始资金 + 交易 + 资金流水 + 持仓调整）
 * 重算结果比一比，包含已持久化的手工持仓调整；差额和未覆盖的数量缺口逐股列出。
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
    const [holdings, trades, cashFlows, holdingAdjustments] = await Promise.all([
      ctx.repos.holding.listByAccount(accountId),
      ctx.repos.trade.listByAccount(accountId),
      ctx.repos.portfolioCashFlow.listByAccount(accountId),
      ctx.repos.ledger.listHoldingAdjustments(accountId),
    ]);
    const result = reconcileCashBalance(account, {
      account,
      holdings,
      trades,
      cashFlows,
      holdingAdjustments,
    });
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
