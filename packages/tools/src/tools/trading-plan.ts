import {
  assertTradingPlanBudgetLimits,
  DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
  evaluateTradingPlanBudget,
  type Stock,
  TradingPlanBudgetLimitsSchema,
  TradingPlanBudgetResultSchema,
  TradingPlanQuerySchema,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const SaveTradingPlanInput = z.object({
  plan: TradingPlanSchema,
  limits: TradingPlanBudgetLimitsSchema.default(DEFAULT_TRADING_PLAN_BUDGET_LIMITS),
});
export const SaveTradingPlanOutput = z.object({
  plan: TradingPlanSchema,
  versionId: z.string().min(1),
});

const budgetLocks = new Map<string, Promise<void>>();

const withBudgetLock = async <T>(accountId: string, task: () => Promise<T>): Promise<T> => {
  const previous = budgetLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  budgetLocks.set(accountId, current);
  await previous;
  try {
    return await task();
  } finally {
    if (budgetLocks.get(accountId) === current) budgetLocks.delete(accountId);
    release();
  }
};

export const saveTradingPlanTool = defineTool({
  name: 'save_trading_plan',
  description: '保存不可变的逐股结构化交易计划版本；信号不会改变实际持仓',
  sideEffect: 'write',
  input: SaveTradingPlanInput,
  output: SaveTradingPlanOutput,
  handler: async (input, ctx) => {
    return withBudgetLock(input.plan.accountId, async () => {
      const account = await ctx.repos.account.findById(input.plan.accountId);
      if (account === null) return errNotFound('Account', input.plan.accountId);
      const snapshot = await ctx.repos.accountSnapshot.findById(input.plan.accountSnapshotId);
      if (snapshot === null) return errNotFound('AccountSnapshot', input.plan.accountSnapshotId);
      if (
        snapshot.accountId !== input.plan.accountId ||
        snapshot.version !== input.plan.accountSnapshotVersion
      ) {
        return errInvalidInput('交易计划引用的账户快照不是该账户的当前版本');
      }
      if (input.plan.status === 'active' && snapshot.status !== 'complete') {
        return errInvalidInput('账户快照待核对时不能激活精确仓位计划');
      }
      if (input.plan.status === 'active') {
        const latestSnapshot = await ctx.repos.accountSnapshot.latestByAccount(
          input.plan.accountId,
        );
        if (
          latestSnapshot === null ||
          latestSnapshot.id !== snapshot.id ||
          latestSnapshot.version !== snapshot.version
        ) {
          return errInvalidInput('只能基于账户当前快照激活交易计划');
        }
        if (input.plan.position.constraintStatus !== 'passed') {
          return errInvalidInput('只有通过约束校验的计划才能激活');
        }
        assertTradingPlanBudgetLimits(input.limits);
        const active = await ctx.repos.tradingPlan.list({
          accountId: input.plan.accountId,
          activeOnly: true,
          limit: 500,
        });
        const otherPlans = active.filter((plan) => plan.id !== input.plan.id);
        const stocks = new Map<string, Stock>();
        const stockIds = new Set([
          ...snapshot.positions.map((position) => position.stockId),
          ...otherPlans.map((plan) => plan.stockId),
          input.plan.stockId,
        ]);
        for (const stockId of stockIds) {
          const stock = await ctx.repos.stock.findById(stockId);
          if (stock !== null) stocks.set(stock.id, stock);
        }
        const budget = evaluateTradingPlanBudget({
          snapshot,
          plans: [...otherPlans, input.plan],
          stocks,
          limits: input.limits,
        });
        const allocation = budget.allocations.find(
          (item) => item.planId === tradingPlanVersionId(input.plan),
        );
        if (allocation?.status !== 'included') {
          return errInvalidInput(
            `计划未通过组合预算：${allocation?.reasons.join(',') ?? budget.reasons.join(',')}`,
          );
        }
      }
      const versionId = tradingPlanVersionId(input.plan);
      await ctx.repos.tradingPlan.save(input.plan);
      return { plan: input.plan, versionId };
    });
  },
});

export const GetTradingPlanInput = z.object({
  versionId: z.string().min(1),
});
export const GetTradingPlanOutput = z.object({ plan: TradingPlanSchema });

export const getTradingPlanTool = defineTool({
  name: 'get_trading_plan',
  description: '按确切版本读取结构化交易计划',
  sideEffect: 'read',
  input: GetTradingPlanInput,
  output: GetTradingPlanOutput,
  handler: async (input, ctx) => {
    const plan = await ctx.repos.tradingPlan.findByVersionId(input.versionId);
    return plan === null ? errNotFound('TradingPlan', input.versionId) : { plan };
  },
});

export const ListTradingPlansInput = TradingPlanQuerySchema;
export const ListTradingPlansOutput = z.object({ plans: z.array(TradingPlanSchema) });

export const listTradingPlansTool = defineTool({
  name: 'list_trading_plans',
  description: '查询结构化交易计划及当前有效版本',
  sideEffect: 'read',
  input: ListTradingPlansInput,
  output: ListTradingPlansOutput,
  handler: async (input, ctx) => ({ plans: [...(await ctx.repos.tradingPlan.list(input))] }),
});

const BudgetInput = z.object({
  accountId: z.string().min(1).optional(),
  limits: TradingPlanBudgetLimitsSchema.default(DEFAULT_TRADING_PLAN_BUDGET_LIMITS),
});
export const EvaluateTradingPlanBudgetInput = BudgetInput;
export const EvaluateTradingPlanBudgetOutput = TradingPlanBudgetResultSchema;

export const evaluateTradingPlanBudgetTool = defineTool({
  name: 'evaluate_trading_plan_budget',
  description: '按账户当前快照合并校验全部有效计划的总仓位、单股和行业上限',
  sideEffect: 'read',
  input: EvaluateTradingPlanBudgetInput,
  output: EvaluateTradingPlanBudgetOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const snapshot = await ctx.repos.accountSnapshot.latestByAccount(accountId);
    if (snapshot === null) return errNotFound('AccountSnapshot', accountId);
    assertTradingPlanBudgetLimits(input.limits);
    const plans = await ctx.repos.tradingPlan.list({ accountId, activeOnly: true, limit: 500 });
    const stocks = new Map<string, Stock>();
    const stockIds = new Set([
      ...snapshot.positions.map((position) => position.stockId),
      ...plans.map((plan) => plan.stockId),
    ]);
    for (const stockId of stockIds) {
      const stock = await ctx.repos.stock.findById(stockId);
      if (stock !== null) stocks.set(stock.id, stock);
    }
    return TradingPlanBudgetResultSchema.parse(
      evaluateTradingPlanBudget({
        snapshot,
        plans,
        stocks,
        limits: input.limits,
      }),
    );
  },
});
