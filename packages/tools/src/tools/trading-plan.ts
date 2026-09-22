import {
  assertTradingPlanBudgetLimits,
  DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
  evaluateTradingPlanBudget,
  type Stock,
  TradingPlanBudgetLimitsSchema,
  TradingPlanBudgetResultSchema,
  type TradingPlanMonitoring,
  TradingPlanMonitoringSchema,
  TradingPlanQuerySchema,
  TradingPlanSchema,
  tradingPlanMonitoring,
  tradingPlanVersionId,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { deriveAccountFacts } from './account-facts.js';

export const SaveTradingPlanInput = z.object({
  plan: TradingPlanSchema,
  limits: TradingPlanBudgetLimitsSchema.default(DEFAULT_TRADING_PLAN_BUDGET_LIMITS),
});
export const SaveTradingPlanOutput = z.object({
  plan: TradingPlanSchema,
  versionId: z.string().min(1),
});

export const saveTradingPlanTool = defineTool({
  name: 'save_trading_plan',
  description: '保存不可变的逐股结构化交易计划版本；信号不会改变实际持仓',
  sideEffect: 'write',
  input: SaveTradingPlanInput,
  output: SaveTradingPlanOutput,
  handler: async (input, ctx) => {
    const account = await ctx.repos.account.findById(input.plan.accountId);
    if (account === null) return errNotFound('Account', input.plan.accountId);
    // 计划必须基于当前账户事实（现金字段 + 当前持仓 + 行情）：指纹不一致说明账本已变，
    // 旧前提不再成立，需要重新生成计划而不是沿用。
    const facts = await deriveAccountFacts(ctx, input.plan.accountId);
    if (facts === null) return errNotFound('Account', input.plan.accountId);
    if (input.plan.accountFactsDigest !== facts.digest) {
      return errInvalidInput('交易计划基于的账户事实已变化（持仓或现金已更新），请重新生成计划');
    }
    if (input.plan.status === 'active' && facts.status !== 'complete') {
      return errInvalidInput(
        `账户事实不可用时不能激活精确仓位计划：${facts.reasons.join('；') || '缺少现金或合格行情'}`,
      );
    }
    if (input.plan.status === 'active') {
      if (input.plan.position.constraintStatus !== 'passed') {
        return errInvalidInput('只有通过约束校验的计划才能激活');
      }
      assertTradingPlanBudgetLimits(input.limits);
      const active = await ctx.repos.tradingPlan.list({
        accountId: input.plan.accountId,
        activeOnly: true,
        asOf: ctx.clock(),
        limit: 500,
      });
      const otherPlans = active.filter((plan) => plan.id !== input.plan.id);
      const stocks = new Map<string, Stock>();
      const stockIds = new Set([
        ...facts.positions.map((position) => position.stockId),
        ...otherPlans.map((plan) => plan.stockId),
        input.plan.stockId,
      ]);
      for (const stockId of stockIds) {
        const stock = await ctx.repos.stock.findById(stockId);
        if (stock !== null) stocks.set(stock.id, stock);
      }
      const saved = await ctx.repos.tradingPlan.saveIfBudgetAvailable({
        plan: input.plan,
        facts,
        stocks,
        limits: input.limits,
        asOf: ctx.clock(),
      });
      if (!saved.saved) {
        const allocation = saved.budget.allocations.find(
          (item) => item.planId === tradingPlanVersionId(input.plan),
        );
        return errInvalidInput(
          `计划未通过组合预算：${allocation?.reasons.join(',') ?? saved.budget.reasons.join(',')}`,
        );
      }
      return { plan: input.plan, versionId: tradingPlanVersionId(input.plan) };
    }
    const versionId = tradingPlanVersionId(input.plan);
    await ctx.repos.tradingPlan.save(input.plan);
    return { plan: input.plan, versionId };
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

export const ListTradingPlansInput = TradingPlanQuerySchema.extend({
  includeMonitoring: z.boolean().optional(),
});
export const ListTradingPlansOutput = z.object({
  plans: z.array(TradingPlanSchema),
  monitoring: z.array(TradingPlanMonitoringSchema).optional(),
});

export const listTradingPlansTool = defineTool({
  name: 'list_trading_plans',
  description: '查询结构化交易计划及当前有效版本，可附带监控资格与阻塞原因',
  sideEffect: 'read',
  input: ListTradingPlansInput,
  output: ListTradingPlansOutput,
  handler: async (input, ctx) => {
    const { includeMonitoring, ...query } = input;
    const plans = [...(await ctx.repos.tradingPlan.list(query))];
    if (!includeMonitoring) return { plans };
    const monitoring: TradingPlanMonitoring[] = [];
    for (const accountId of new Set(plans.map((plan) => plan.accountId))) {
      const facts = await deriveAccountFacts(ctx, accountId);
      for (const plan of plans.filter((item) => item.accountId === accountId)) {
        monitoring.push(tradingPlanMonitoring(plan, facts, ctx.clock()));
      }
    }
    return { plans, monitoring };
  },
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
    const facts = await deriveAccountFacts(ctx, accountId);
    if (facts === null) return errNotFound('Account', accountId);
    assertTradingPlanBudgetLimits(input.limits);
    const plans = await ctx.repos.tradingPlan.list({
      accountId,
      activeOnly: true,
      asOf: ctx.clock(),
      limit: 500,
    });
    const stocks = new Map<string, Stock>();
    const stockIds = new Set([
      ...facts.positions.map((position) => position.stockId),
      ...plans.map((plan) => plan.stockId),
    ]);
    for (const stockId of stockIds) {
      const stock = await ctx.repos.stock.findById(stockId);
      if (stock !== null) stocks.set(stock.id, stock);
    }
    return TradingPlanBudgetResultSchema.parse(
      evaluateTradingPlanBudget({
        facts,
        // 只合并「基于同一份账户事实」的有效计划：账本变了，旧计划的额度不再占用。
        plans: plans.filter((plan) => plan.accountFactsDigest === facts.digest),
        stocks,
        limits: input.limits,
      }),
    );
  },
});
