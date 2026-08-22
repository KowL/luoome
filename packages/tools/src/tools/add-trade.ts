import {
  type Holding,
  HoldingSchema,
  money,
  quantity,
  type Trade,
  TradeSchema,
  TradeSideSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { ensureStockStub, manualId, STOCK_ID_PATTERN } from '../internal/manual-entry.js';

export const AddTradeInput = z.object({
  /** 形如 002594.SZ（代码.交易所）。 */
  stockId: z.string().regex(STOCK_ID_PATTERN, 'stockId 必须形如 002594.SZ（代码.交易所）'),
  /** Web 搜索候选携带的名称，用于避免新股票只显示代码。 */
  stockName: z.string().trim().min(1).max(100).optional(),
  side: TradeSideSchema,
  quantity: z.number().int().positive(),
  price: z.number().positive(),
  fee: z.number().nonnegative().default(0),
  /** 缺省 = ctx.clock()（现在）。 */
  executedAt: z.coerce.date().optional(),
  /** 缺省 = 当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
  /** 可选 Advice 依据；必须与 stock/position 事实一致。 */
  adviceId: z.string().min(1).optional(),
  /** 可选研究假设版本依据；只接受 active 版本。 */
  researchHypothesisVersionId: z.string().min(1).optional(),
  /** 可选 Strategy 来源；只接受已发布版本。 */
  strategyVersionId: z.string().min(1).optional(),
});

export const AddTradeOutput = z.object({
  trade: TradeSchema,
  holding: HoldingSchema,
});

/**
 * 录入一笔交易（v0.5 起，write）。
 * 落 Trade（source='manual'）并联动 Holding：
 * - buy：无持仓 / 已平仓 → 新开仓（avgCost=price）；持仓中 → 加权平均成本
 * - sell：无持仓 → invalid_input；超卖（> availableQuantity）→ invalid_input；
 *   卖光 → closedAt=executedAt
 * stock 行缺失时自动补 stub（保证 analyze_position 可用）。
 * avgCost 口径与 fixtures 一致：数量加权价，不含 fee。
 */
export const addTradeTool = defineTool({
  name: 'add_trade',
  description: '录入一笔买入/卖出交易，自动联动持仓（加权成本 / 可卖数量 / 清仓）',
  sideEffect: 'write',
  input: AddTradeInput,
  output: AddTradeOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    if (input.adviceId !== undefined) {
      const advice = await ctx.repos.advice.findById(input.adviceId);
      if (advice === null) return errNotFound('Advice', input.adviceId);
      if (advice.subjectKind === 'stock') {
        if (advice.subjectId !== input.stockId) {
          return errInvalidInput('Advice.subjectId 与 Trade.stockId 不一致');
        }
      } else if (advice.subjectKind === 'position') {
        const position = await ctx.repos.holding.findById(advice.subjectId);
        if (
          position === null ||
          position.accountId !== accountId ||
          position.stockId !== input.stockId
        ) {
          return errInvalidInput('Advice.position 与 Trade.accountId/stockId 不一致');
        }
      } else {
        return errInvalidInput('Trade.adviceId 只能关联 stock 或 position Advice');
      }
    }

    if (input.researchHypothesisVersionId !== undefined) {
      const hypothesis = await ctx.repos.researchHypothesisVersion.findById(
        input.researchHypothesisVersionId,
      );
      if (hypothesis === null) {
        return errNotFound('ResearchHypothesisVersion', input.researchHypothesisVersionId);
      }
      if (hypothesis.status !== 'active') {
        return errInvalidInput('Trade.researchHypothesisVersionId 必须指向 active 版本');
      }
    }

    if (input.strategyVersionId !== undefined) {
      const strategyVersion = await ctx.repos.strategy.findVersionById(input.strategyVersionId);
      if (strategyVersion === null) {
        return errNotFound('StrategyVersion', input.strategyVersionId);
      }
      if (strategyVersion.publishedAt === undefined) {
        return errInvalidInput('Trade.strategyVersionId 必须指向已发布 StrategyVersion');
      }
    }

    const now = ctx.clock();
    const executedAt = input.executedAt ?? now;

    const trade: Trade = {
      id: manualId('trade'),
      accountId,
      stockId: input.stockId,
      side: input.side,
      quantity: quantity(input.quantity),
      price: money(input.price),
      fee: money(input.fee),
      executedAt,
      source: 'manual',
      ...(input.adviceId === undefined ? {} : { adviceId: input.adviceId }),
      ...(input.researchHypothesisVersionId === undefined
        ? {}
        : { researchHypothesisVersionId: input.researchHypothesisVersionId }),
      ...(input.strategyVersionId === undefined
        ? {}
        : { strategyVersionId: input.strategyVersionId }),
      createdAt: now,
    };
    const existing = await ctx.repos.holding.findByAccountAndStock(accountId, input.stockId);
    let holding: Holding;
    if (input.side === 'buy') {
      if (existing === null || existing.closedAt !== null) {
        // 新开仓 / 重新开仓（复用旧行 id，(accountId, stockId) 唯一约束）
        holding = {
          id: existing?.id ?? manualId('holding'),
          accountId,
          stockId: input.stockId,
          quantity: input.quantity,
          availableQuantity: input.quantity,
          avgCost: money(input.price),
          openedAt: executedAt,
          closedAt: null,
        };
      } else {
        const totalQuantity = existing.quantity + input.quantity;
        holding = {
          ...existing,
          quantity: totalQuantity,
          availableQuantity: existing.availableQuantity + input.quantity,
          avgCost: money(
            (existing.quantity * existing.avgCost + input.quantity * input.price) / totalQuantity,
          ),
        };
      }
    } else {
      if (existing === null || existing.closedAt !== null) {
        return errInvalidInput(`无持仓可卖: ${input.stockId}`);
      }
      if (input.quantity > existing.availableQuantity) {
        return errInvalidInput(
          `可卖数量不足: 可卖 ${existing.availableQuantity}，卖出 ${input.quantity}`,
        );
      }
      const remain = existing.quantity - input.quantity;
      holding = {
        ...existing,
        quantity: remain,
        availableQuantity: existing.availableQuantity - input.quantity,
        ...(remain === 0 ? { closedAt: executedAt } : {}),
      };
    }
    // 先完成持仓侧的所有业务校验，避免无持仓/超卖等 invalid_input 留下孤立 Trade。
    await ensureStockStub(input.stockId, ctx, input.stockName);
    await ctx.repos.trade.save(trade);
    await ctx.repos.holding.save(holding);
    return { trade, holding };
  },
});
