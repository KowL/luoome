import {
  ActiveStrategyRecommendationTriggerSchema,
  type Advice,
  evaluateStrategyRecommendationPreflight,
  isPublishableOperationalRun,
  isStrategyRecommendationPolicyV2,
  type Quote,
  type StrategyRecommendationCandidateFact,
  type StrategyRecommendationCooldownFact,
  type StrategyRecommendationHoldingFact,
  StrategyRecommendationPolicyV2Schema,
  type StrategyRecommendationPreflight,
  StrategyRecommendationPreflightSchema,
  type StrategyRecommendationSignalFact,
  type StrategyRun,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { deriveAccountFacts } from './account-facts.js';

const DEFAULT_COOLDOWN_HOURS = 48;

export const EvaluateStrategyCandidatePreflightInput = z.object({
  strategyId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  /** 缺省取该策略最新已发布运行。 */
  runId: z.string().min(1).optional(),
  /** 缺省取该运行的全部入选结果。 */
  stockIds: z.array(z.string().min(1)).min(1).max(200).optional(),
  /** 缺省读 StrategySchedule.recommendationPolicy（必须是 V2）。 */
  policy: StrategyRecommendationPolicyV2Schema.optional(),
  trigger: ActiveStrategyRecommendationTriggerSchema.default('run'),
  cooldownHours: z.number().int().min(0).max(720).optional(),
});

export const EvaluateStrategyCandidatePreflightOutput = z.object({
  strategyId: z.string(),
  accountId: z.string(),
  runId: z.string(),
  policySource: z.enum(['input', 'schedule']),
  evaluatedAt: z.coerce.date(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  details: z.array(StrategyRecommendationPreflightSchema),
  limitations: z.array(z.string().min(1)),
});

type SignalScope = 'entry' | 'exit' | 'risk';

const signalScopes = (definition: {
  readonly signals: {
    readonly entry: readonly { readonly id: string }[];
    readonly exit: readonly { readonly id: string }[];
    readonly risk: readonly { readonly id: string }[];
  };
}): Map<string, SignalScope> => {
  const scopes = new Map<string, SignalScope>();
  for (const rule of definition.signals.entry) scopes.set(rule.id, 'entry');
  for (const rule of definition.signals.exit) scopes.set(rule.id, 'exit');
  for (const rule of definition.signals.risk) scopes.set(rule.id, 'risk');
  return scopes;
};

const portfolioValueOf = async (
  accountId: string,
  ctx: ToolContext,
): Promise<{ value?: number; limitation?: string }> => {
  // 组合估值只走账户事实这一条口径（含现金对账与缺行情降级），不在这里另算一份。
  const facts = await deriveAccountFacts(ctx, accountId);
  if (facts === null) return { limitation: '账户不存在，无法估值组合' };
  if (facts.totalAssets === null) {
    return { limitation: `组合估值不可用：${facts.reasons.join('；') || '缺少持仓行情'}` };
  }
  return { value: facts.totalAssets };
};

const cooldownFactsFor = async (
  input: {
    readonly strategyId: string;
    readonly cooldownHours: number;
    readonly now: Date;
  },
  ctx: ToolContext,
): Promise<{ facts: StrategyRecommendationCooldownFact[]; limitation?: string }> => {
  const since = new Date(input.now.getTime() - input.cooldownHours * 3_600_000);
  const advices = await ctx.repos.advice.query({
    since,
    until: input.now,
    includeExpired: true,
    limit: 500,
  });
  const facts: StrategyRecommendationCooldownFact[] = [];
  for (const advice of advices as readonly Advice[]) {
    const strategy = advice.basedOn.strategy;
    if (strategy === undefined || strategy.strategyId !== input.strategyId) continue;
    const run = await ctx.repos.strategyRun.findRunById(strategy.runId);
    if (run === null) {
      return {
        facts,
        limitation: `冷却事实缺失：建议 ${advice.id} 引用的运行 ${strategy.runId} 已不存在`,
      };
    }
    facts.push({
      adviceId: advice.id,
      ...(strategy.accountId === undefined ? {} : { accountId: strategy.accountId }),
      strategyId: strategy.strategyId,
      runId: strategy.runId,
      runScope: run.scope === 'evaluation' ? 'evaluation' : 'operational',
      runPublication: run.publication?.status ?? 'withheld',
      stockId: strategy.stockId,
      trigger: strategy.recommendationTrigger,
      createdAt: advice.createdAt,
      factReferences: [`advice:${advice.id}`],
    });
  }
  return { facts };
};

export const evaluateStrategyCandidatePreflightTool = defineTool({
  name: 'evaluate_strategy_candidate_preflight',
  description:
    '按已发布策略运行的入选结果逐股评估账户级预检（仓位、行业、冷却、信号冲突）；只读，不产生建议或计划。',
  sideEffect: 'read',
  input: EvaluateStrategyCandidatePreflightInput,
  output: EvaluateStrategyCandidatePreflightOutput,
  handler: async (input, ctx: ToolContext) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);

    let policySource: 'input' | 'schedule' = 'input';
    let policy = input.policy;
    if (policy === undefined) {
      const schedule = await ctx.repos.strategySchedule.findByStrategyId(input.strategyId);
      const scheduled = schedule?.recommendationPolicy;
      if (scheduled === undefined || !isStrategyRecommendationPolicyV2(scheduled)) {
        return errInvalidInput(
          '该策略没有 V2 推荐策略：请先在 StrategySchedule.recommendationPolicy 配置 schemaVersion=2，或在入参显式传 policy。',
        );
      }
      policy = scheduled;
      policySource = 'schedule';
    }

    const run: StrategyRun | null =
      input.runId === undefined
        ? await ctx.repos.strategyRun.findLatestPublishedRun(input.strategyId)
        : await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId ?? input.strategyId);
    if (run.strategyId !== input.strategyId)
      return errInvalidInput('runId 不属于该策略，不能混用事实');
    if (!isPublishableOperationalRun(run))
      return errInvalidInput('只能对已发布（published operational）运行做候选预检');

    const version = await ctx.repos.strategy.findVersionById(run.strategyVersionId);
    const scopes =
      version === null ? new Map<string, SignalScope>() : signalScopes(version.definition);

    const results = (await ctx.repos.strategyRun.listResults(run.id)).filter(
      (result) =>
        result.selected &&
        (input.stockIds === undefined || input.stockIds.includes(result.stockId)),
    );
    const now = ctx.clock();
    const evaluatedAt = now;
    const limitations: string[] = [];
    if (results.length === 0) limitations.push('该运行没有入选结果，无需预检');

    const portfolio = await portfolioValueOf(accountId, ctx);
    if (portfolio.limitation !== undefined) limitations.push(portfolio.limitation);

    const holdings = await ctx.repos.holding.listByAccount(accountId);
    const holdingFacts: StrategyRecommendationHoldingFact[] = [];
    for (const holding of holdings) {
      if (holding.closedAt !== null) continue;
      const quote = await ctx.repos.quote.latestByStock(holding.stockId);
      const stock = await ctx.repos.stock.findById(holding.stockId);
      holdingFacts.push({
        holding,
        ...(stock?.industry === undefined ? {} : { industry: stock.industry }),
        ...(quote === null ? {} : { quote }),
        factReferences: [`holding:${holding.id}`],
      });
    }

    const cooldownHours = input.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
    const cooldown = await cooldownFactsFor(
      { strategyId: input.strategyId, cooldownHours, now },
      ctx,
    );
    if (cooldown.limitation !== undefined) limitations.push(cooldown.limitation);

    const signals = await ctx.repos.strategyRun.signalsByRun(run.id);
    const details: StrategyRecommendationPreflight[] = [];
    for (const result of results) {
      const stock = await ctx.repos.stock.findById(result.stockId);
      const quote: Quote | null = await ctx.repos.quote.latestByStock(result.stockId);
      if (quote === null) {
        limitations.push(`候选 ${result.stockId} 缺少行情，预检将标为 candidate-data-unavailable`);
      }
      const candidate: StrategyRecommendationCandidateFact = {
        stockId: result.stockId,
        stockResolved: stock !== null,
        ...(stock?.industry === undefined ? {} : { industry: stock.industry }),
        ...(quote === null ? {} : { quote }),
        factReferences: [`run:${run.id}`, `result:${result.stockId}`],
      };
      const signalFacts: StrategyRecommendationSignalFact[] = signals
        .filter((signal) => signal.stockId === result.stockId)
        .flatMap((signal) => {
          const scope = scopes.get(signal.ruleId);
          return scope === undefined
            ? []
            : [{ signal, scope, factReferences: [`signal:${signal.id}`] }];
        });
      details.push(
        evaluateStrategyRecommendationPreflight({
          policy,
          accountId,
          strategyId: input.strategyId,
          run,
          candidate,
          account,
          holdings: holdingFacts,
          ...(portfolio.value === undefined ? {} : { portfolioValue: portfolio.value }),
          signals: signalFacts,
          strategyExposureFacts: [],
          strategyVersionIds: [run.strategyVersionId],
          trigger: input.trigger,
          cooldownFacts: cooldown.facts,
          ...(cooldown.limitation === undefined ? {} : { cooldownFactsUnavailable: true }),
          evaluatedAt,
        }),
      );
    }

    return {
      strategyId: input.strategyId,
      accountId,
      runId: run.id,
      policySource,
      evaluatedAt,
      summary: {
        total: details.length,
        eligible: details.filter((detail) => detail.status === 'eligible').length,
        skipped: details.filter((detail) => detail.status === 'skipped').length,
        unavailable: details.filter((detail) => detail.status === 'unavailable').length,
      },
      details,
      limitations,
    };
  },
});
