import {
  type AccountFacts,
  applyTradingPlanBudgetConstraint,
  assertTradingPlanBudgetLimits,
  DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
  evaluateTradingPlanBudget,
  type Stock,
  type ToolContext,
  type TradingPlan,
  type TradingPlanBudgetLimits,
  TradingPlanBudgetLimitsSchema,
  TradingPlanBudgetResultSchema,
  type TradingPlanMonitoring,
  TradingPlanMonitoringSchema,
  TradingPlanQuerySchema,
  TradingPlanReadSchema,
  type TradingPlanReview,
  TradingPlanReviewSchema,
  TradingPlanSchema,
  TradingPlanV2Schema,
  TradingPlanViewSchema,
  toTradingPlanRead,
  tradingPlanMonitoring,
  tradingPlanVersionId,
  tradingPlanView,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { deriveAccountFacts } from './account-facts.js';

const latestReviews = async (ctx: ToolContext, accountId: string) => {
  const runs = await ctx.repos.workflowRun.listRecent({
    workflowName: 'trading-plan-daily-cycle',
    limit: 200,
  });
  const reviews = new Map<string, TradingPlanReview>();
  for (const run of runs) {
    if (run.inputSummary?.accountId !== accountId || !Array.isArray(run.outputSummary?.reviews))
      continue;
    for (const value of run.outputSummary.reviews) {
      const parsed = TradingPlanReviewSchema.safeParse(value);
      if (!parsed.success) continue;
      const review = parsed.data;
      const previous = reviews.get(review.versionId);
      if (previous === undefined || review.reviewedAt > previous.reviewedAt)
        reviews.set(review.versionId, review);
    }
  }
  return reviews;
};

const budgetFor = async (
  ctx: ToolContext,
  facts: AccountFacts,
  plans: readonly TradingPlan[],
  limits: TradingPlanBudgetLimits,
  candidate?: TradingPlan,
): Promise<z.infer<typeof TradingPlanBudgetResultSchema>> => {
  const stocks = new Map<string, Stock>();
  const stockIds = new Set([
    ...facts.positions.map((position) => position.stockId),
    ...plans.map((plan) => plan.stockId),
    ...(candidate === undefined ? [] : [candidate.stockId]),
  ]);
  for (const stockId of stockIds) {
    const stock = await ctx.repos.stock.findById(stockId);
    if (stock !== null) stocks.set(stock.id, stock);
  }
  return TradingPlanBudgetResultSchema.parse(
    evaluateTradingPlanBudget({
      facts,
      plans: candidate === undefined ? [...plans] : [...plans, candidate],
      stocks,
      limits,
    }),
  );
};

export const SaveTradingPlanInput = z.object({
  /** 写路径只接受 v2（区间 + 选点 + 结构化失效条件）；旧形状必须由调用方先迁移。 */
  plan: TradingPlanV2Schema,
  limits: TradingPlanBudgetLimitsSchema.default(DEFAULT_TRADING_PLAN_BUDGET_LIMITS),
});
export const SaveTradingPlanOutput = z.object({
  plan: TradingPlanSchema,
  versionId: z.string().min(1),
  /** 本次保存的预算结论（含 min/max 合计）；facts 不可用时缺省。 */
  budget: TradingPlanBudgetResultSchema.optional(),
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
        if (saved.reason === 'account-facts-changed') {
          return errInvalidInput(
            '交易计划基于的账户事实已变化（持仓或现金已更新），请重新生成计划',
          );
        }
        const allocation = saved.budget.allocations.find(
          (item) => item.planId === tradingPlanVersionId(input.plan),
        );
        return errInvalidInput(
          `计划未通过组合预算：${allocation?.reasons.join(',') ?? saved.budget.reasons.join(',')}`,
        );
      }
      return {
        plan: input.plan,
        versionId: tradingPlanVersionId(input.plan),
        budget: TradingPlanBudgetResultSchema.parse(saved.budget),
      };
    }
    const versionId = tradingPlanVersionId(input.plan);
    // draft：预算冲突不阻止保存，但必须记录 constraintStatus/constraintReasons。
    const active = await ctx.repos.tradingPlan.list({
      accountId: input.plan.accountId,
      activeOnly: true,
      asOf: ctx.clock(),
      limit: 500,
    });
    const others = active.filter(
      (plan) => plan.id !== input.plan.id && plan.accountFactsDigest === facts.digest,
    );
    const budget =
      facts.status === 'complete'
        ? await budgetFor(ctx, facts, others, input.limits, input.plan)
        : undefined;
    const stored =
      budget === undefined ? input.plan : applyTradingPlanBudgetConstraint(input.plan, budget);
    await ctx.repos.tradingPlan.save(stored);
    return { plan: stored, versionId, ...(budget === undefined ? {} : { budget }) };
  },
});

export const GetTradingPlanInput = z.object({
  versionId: z.string().min(1),
});
export const GetTradingPlanOutput = z.object({
  plan: TradingPlanReadSchema,
  monitoring: TradingPlanMonitoringSchema,
});

export const getTradingPlanTool = defineTool({
  name: 'get_trading_plan',
  description: '按确切版本读取结构化交易计划',
  sideEffect: 'read',
  input: GetTradingPlanInput,
  output: GetTradingPlanOutput,
  handler: async (input, ctx) => {
    const plan = await ctx.repos.tradingPlan.findByVersionId(input.versionId);
    if (plan === null) return errNotFound('TradingPlan', input.versionId);
    const facts = await deriveAccountFacts(ctx, plan.accountId);
    const reviews = await latestReviews(ctx, plan.accountId);
    const versions = await ctx.repos.tradingPlan.list({
      accountId: plan.accountId,
      stockId: plan.stockId,
      currentOnly: true,
      limit: 1,
    });
    return {
      plan: toTradingPlanRead(plan),
      monitoring: tradingPlanMonitoring(
        plan,
        facts,
        ctx.clock(),
        reviews.get(input.versionId),
        versions,
      ),
    };
  },
});

export const ListTradingPlansInput = TradingPlanQuerySchema.extend({
  includeMonitoring: z.boolean().optional(),
});
export const ListTradingPlansOutput = z.object({
  plans: z.array(TradingPlanReadSchema),
  monitoring: z.array(TradingPlanMonitoringSchema).optional(),
  views: z.array(TradingPlanViewSchema).optional(),
});

export const listTradingPlansTool = defineTool({
  name: 'list_trading_plans',
  description: '查询结构化交易计划及当前有效版本，可附带监控资格与阻塞原因',
  sideEffect: 'read',
  input: ListTradingPlansInput,
  output: ListTradingPlansOutput,
  handler: async (input, ctx) => {
    const { includeMonitoring, ...query } = input;
    const now = ctx.clock();
    const plans = [
      ...(await ctx.repos.tradingPlan.list({
        ...query,
        ...(query.currentOnly === true && query.asOf === undefined ? { asOf: now } : {}),
      })),
    ];
    if (!includeMonitoring) return { plans: plans.map(toTradingPlanRead) };
    const monitoring: TradingPlanMonitoring[] = [];
    const views: z.infer<typeof TradingPlanViewSchema>[] = [];
    for (const accountId of new Set(plans.map((plan) => plan.accountId))) {
      const facts = await deriveAccountFacts(ctx, accountId);
      const reviews = await latestReviews(ctx, accountId);
      const accountPlans = plans.filter((item) => item.accountId === accountId);
      const versions =
        query.currentOnly === true
          ? accountPlans
          : await ctx.repos.tradingPlan.list({
              accountId,
              stockId: query.stockId,
              currentOnly: true,
              createdUntil: query.createdUntil,
              limit: 500,
            });
      for (const plan of accountPlans) {
        monitoring.push(
          tradingPlanMonitoring(
            plan,
            facts,
            now,
            reviews.get(tradingPlanVersionId(plan)),
            versions.filter((version) => version.id === plan.id),
          ),
        );
      }
      for (const planId of new Set(accountPlans.map((plan) => plan.id))) {
        const view = tradingPlanView(
          accountPlans.filter((plan) => plan.id === planId),
          now,
          facts,
        );
        if (view !== null) views.push(view);
      }
    }
    return { plans: plans.map(toTradingPlanRead), monitoring, views };
  },
});

const BudgetInput = z.object({
  accountId: z.string().min(1).optional(),
  limits: TradingPlanBudgetLimitsSchema.default(DEFAULT_TRADING_PLAN_BUDGET_LIMITS),
  /** 可选：把尚未落库的候选版本一起评估（生成器在 reuse 前用它避免版本抖动）。 */
  candidate: TradingPlanV2Schema.optional(),
});
export const EvaluateTradingPlanBudgetInput = BudgetInput;
export const EvaluateTradingPlanBudgetOutput = TradingPlanBudgetResultSchema;

export const evaluateTradingPlanBudgetTool = defineTool({
  name: 'evaluate_trading_plan_budget',
  description: '按账户当前事实合并校验全部有效计划的总仓位与单股上限',
  sideEffect: 'read',
  input: EvaluateTradingPlanBudgetInput,
  output: EvaluateTradingPlanBudgetOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const facts = await deriveAccountFacts(ctx, accountId);
    if (facts === null) return errNotFound('Account', accountId);
    assertTradingPlanBudgetLimits(input.limits);
    const plans = (
      await ctx.repos.tradingPlan.list({
        accountId,
        activeOnly: true,
        asOf: ctx.clock(),
        limit: 500,
      })
    ).filter((plan) => plan.accountFactsDigest === facts.digest);
    const candidates =
      input.candidate === undefined
        ? plans
        : [...plans, input.candidate].filter(
            (plan, index, all) =>
              all.findIndex((item) => tradingPlanVersionId(item) === tradingPlanVersionId(plan)) ===
              index,
          );
    return TradingPlanBudgetResultSchema.parse(
      await budgetFor(ctx, facts, candidates, input.limits),
    );
  },
});
