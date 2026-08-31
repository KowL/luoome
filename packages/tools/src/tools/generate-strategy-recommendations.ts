import {
  type Account,
  ActiveStrategyRecommendationTriggerSchema,
  type Advice,
  AdviceSchema,
  evaluateStrategyRecommendationPreflight,
  isPublishableOperationalRun,
  isStrategyRecommendationPolicyV2,
  type Quote,
  type Stock,
  type StrategyRecommendationCooldownFact,
  type StrategyRecommendationHoldingFact,
  StrategyRecommendationPolicySchema,
  type StrategyRecommendationPolicyV2,
  type StrategyRecommendationPreflight,
  StrategyRecommendationPreflightSummarySchema,
  type StrategyRecommendationSignalFact,
  type StrategyRecommendationStrategyExposureFact,
  type StrategySignal,
  type StrategyVersion,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';
import { analyzeStrategyCandidateTool } from './analyze-strategy-candidate.js';
import { getAccountTool } from './get-account.js';
import { getAdviceTool } from './get-advice.js';
import { listTradesTool } from './list-trades.js';
import { sendNotificationTool } from './send-notification.js';
import {
  type ListStrategyResultViewsOutput,
  listStrategyResultViewsTool,
} from './strategy-query.js';

export const GenerateStrategyRecommendationsInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  policy: StrategyRecommendationPolicySchema,
  trigger: ActiveStrategyRecommendationTriggerSchema.default('run'),
  stockIds: z.array(z.string().min(1)).max(200).optional(),
});
export const GenerateStrategyRecommendationsOutput = z.object({
  strategyId: z.string(),
  runId: z.string(),
  advices: z.array(AdviceSchema),
  skippedCooldown: z.number().int().nonnegative(),
  notificationFailed: z.number().int().nonnegative(),
  preflight: StrategyRecommendationPreflightSummarySchema.optional(),
});

type PreflightSummary = z.output<typeof StrategyRecommendationPreflightSummarySchema>;

const signalScopesByRuleId = (
  version: StrategyVersion,
): Map<string, Set<'entry' | 'exit' | 'risk'>> => {
  const scopes = new Map<string, Set<'entry' | 'exit' | 'risk'>>();
  for (const [scope, rules] of [
    ['entry', version.definition.signals.entry],
    ['exit', version.definition.signals.exit],
    ['risk', version.definition.signals.risk],
  ] as const) {
    for (const rule of rules) {
      const current = scopes.get(rule.id) ?? new Set<'entry' | 'exit' | 'risk'>();
      current.add(scope);
      scopes.set(rule.id, current);
    }
  }
  return scopes;
};

const assembleSignalFacts = (
  signals: readonly StrategySignal[],
  version: StrategyVersion,
  runId: string,
  strategyId: string,
  stockId: string,
): {
  readonly facts: readonly StrategyRecommendationSignalFact[];
  readonly unavailable: boolean;
} => {
  const scopesByRuleId = signalScopesByRuleId(version);
  let unavailable = false;
  const facts: StrategyRecommendationSignalFact[] = [];
  for (const signal of signals) {
    if (
      signal.strategyId !== strategyId ||
      signal.strategyVersionId !== version.id ||
      signal.runId !== runId ||
      signal.stockId !== stockId
    ) {
      continue;
    }
    const scopes = [...(scopesByRuleId.get(signal.ruleId) ?? [])].sort();
    const scope = scopes[0];
    if (scope === undefined || scopes.length !== 1) {
      unavailable = true;
      continue;
    }
    facts.push({ signal, scope });
  }
  return { facts, unavailable };
};

interface AssembledV2Facts {
  readonly account: Account | null;
  readonly stockById: ReadonlyMap<string, Stock | null>;
  readonly holdings: readonly StrategyRecommendationHoldingFact[];
  readonly holdingFactsUnavailable: boolean;
  readonly quoteByStock: ReadonlyMap<string, Quote>;
  readonly signals: readonly StrategySignal[];
  readonly signalsUnavailable: boolean;
  readonly strategyExposureFacts: readonly StrategyRecommendationStrategyExposureFact[];
  readonly strategyExposureFactsUnavailable: boolean;
  readonly strategyVersionIds: readonly string[] | undefined;
}

const assembleV2Facts = async (
  rows: readonly {
    readonly stock: { readonly stockId: string; readonly nameStatus: 'resolved' | 'unavailable' };
  }[],
  runId: string,
  strategyId: string,
  ctx: ToolContext,
): Promise<AssembledV2Facts> => {
  const accountId = ctx.user.defaultAccountId;
  const accountResult = await getAccountTool.execute({ accountId }, ctx);
  const account = accountResult.ok ? accountResult.data.account : null;

  let rawHoldings: Awaited<ReturnType<ToolContext['repos']['holding']['listByAccount']>> = [];
  let holdingsUnavailable = false;
  try {
    rawHoldings = await ctx.repos.holding.listByAccount(accountId);
  } catch (error) {
    holdingsUnavailable = true;
    ctx.logger.warn('generate_strategy_recommendations: holdings facts unavailable', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const stockIds = [
    ...rows.map((row) => row.stock.stockId),
    ...rawHoldings
      .filter(
        (holding) =>
          holding.accountId === accountId && holding.quantity > 0 && holding.closedAt === null,
      )
      .map((holding) => holding.stockId),
  ];
  let resolvedQuotes: readonly {
    stockId: string;
    status: 'ok' | 'unresolved' | 'unavailable';
    quote?: Quote;
  }[] = [];
  try {
    resolvedQuotes = await resolveQuotes(ctx, [...new Set(stockIds)], { context: 'display' });
  } catch (error) {
    ctx.logger.warn('generate_strategy_recommendations: quote facts unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const quoteByStock = new Map(
    resolvedQuotes.flatMap((item) =>
      item.status === 'ok' && item.quote !== undefined ? [[item.stockId, item.quote] as const] : [],
    ),
  );
  const stockById = new Map<
    string,
    Awaited<ReturnType<ToolContext['repos']['stock']['findById']>>
  >();
  await Promise.all(
    [...new Set(stockIds)].map(async (stockId) => {
      try {
        stockById.set(stockId, await ctx.repos.stock.findById(stockId));
      } catch {
        stockById.set(stockId, null);
      }
    }),
  );
  const holdings: StrategyRecommendationHoldingFact[] = rawHoldings.map((holding) => {
    const stock = stockById.get(holding.stockId);
    return {
      holding,
      ...(stock?.industry === undefined ? {} : { industry: stock.industry }),
      ...(quoteByStock.get(holding.stockId) === undefined
        ? {}
        : { quote: quoteByStock.get(holding.stockId) as Quote }),
    };
  });

  let signals: readonly StrategySignal[] = [];
  let signalsUnavailable = false;
  try {
    signals = await ctx.repos.strategyRun.signalsByRun(runId);
  } catch (error) {
    signalsUnavailable = true;
    ctx.logger.warn('generate_strategy_recommendations: signal facts unavailable', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let strategyVersionIds: readonly string[] | undefined;
  let strategyExposureFacts: StrategyRecommendationStrategyExposureFact[] = [];
  let strategyExposureFactsUnavailable = false;
  try {
    const [versions, trades] = await Promise.all([
      ctx.repos.strategy.listVersions(strategyId),
      listTradesTool.execute({ accountId, limit: 500 }, ctx),
    ]);
    strategyVersionIds = versions.map((version) => version.id).sort();
    if (!trades.ok) {
      strategyExposureFactsUnavailable = true;
    } else if (trades.data.trades.length < trades.data.total) {
      strategyExposureFactsUnavailable = true;
    } else {
      const versionSet = new Set(strategyVersionIds);
      strategyExposureFacts = trades.data.trades
        .filter(
          (trade) =>
            trade.accountId === accountId &&
            trade.side === 'buy' &&
            trade.strategyVersionId !== undefined &&
            versionSet.has(trade.strategyVersionId),
        )
        .map((trade) => ({
          accountId,
          strategyId,
          strategyVersionId: trade.strategyVersionId as string,
          stockId: trade.stockId,
          factReferences: [`trade:${trade.id}`],
        }));
    }
  } catch (error) {
    strategyExposureFactsUnavailable = true;
    ctx.logger.warn('generate_strategy_recommendations: strategy exposure facts unavailable', {
      strategyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    account,
    stockById,
    holdings,
    holdingFactsUnavailable: holdingsUnavailable,
    quoteByStock,
    signals,
    signalsUnavailable,
    strategyExposureFacts,
    strategyExposureFactsUnavailable,
    strategyVersionIds,
  };
};

const cooldownFactsForAdvices = async (
  advices: readonly Advice[],
  strategyId: string,
  stockId: string,
  ctx: ToolContext,
): Promise<readonly StrategyRecommendationCooldownFact[]> => {
  const facts: StrategyRecommendationCooldownFact[] = [];
  for (const advice of advices) {
    const strategy = advice.basedOn.strategy;
    if (
      strategy === undefined ||
      strategy.strategyId !== strategyId ||
      strategy.stockId !== stockId ||
      advice.subjectId !== stockId
    ) {
      continue;
    }
    const previousRun = await ctx.repos.strategyRun.findRunById(strategy.runId);
    if (
      previousRun === null ||
      previousRun.strategyId !== strategyId ||
      previousRun.strategyVersionId !== strategy.strategyVersionId ||
      !isPublishableOperationalRun(previousRun)
    ) {
      continue;
    }
    facts.push({
      adviceId: advice.id,
      ...(strategy.accountId === undefined ? {} : { accountId: strategy.accountId }),
      strategyId,
      runId: previousRun.id,
      runScope: 'operational',
      runPublication: 'published',
      stockId,
      trigger: strategy.recommendationTrigger,
      createdAt: advice.createdAt,
      factReferences: [`advice:${advice.id}`, `strategy-run:${previousRun.id}`],
    });
  }
  return facts;
};

const summarizePreflight = (
  details: readonly StrategyRecommendationPreflight[],
): PreflightSummary => ({
  total: details.length,
  eligible: details.filter((item) => item.status === 'eligible').length,
  skipped: details.filter((item) => item.status === 'skipped').length,
  unavailable: details.filter((item) => item.status === 'unavailable').length,
  details: [...details],
});

const notifyAdvice = async (
  advice: z.output<typeof AdviceSchema>,
  channel: 'log' | 'feishu',
  ctx: ToolContext,
): Promise<boolean> => {
  const payload = {
    title: `策略推荐 · ${advice.stockName ?? advice.subjectId}`,
    content: [
      `${advice.subjectId} · ${advice.decision} · 信心度 ${advice.confidence}`,
      advice.reasoning.premise,
      `证据：${advice.reasoning.evidence.join('；') || '暂无'}`,
      `反证：${advice.reasoning.counterEvidence.join('；') || '暂无'}`,
      `风险：${advice.risks.join('；') || '暂无'}`,
      `有效期至 ${advice.validUntil.toISOString()}`,
      advice.disclaimers.join('\n'),
    ].join('\n'),
    level: advice.decision === 'avoid' || advice.decision === 'sell' ? 'warn' : 'info',
  } as const;
  const notification = await sendNotificationTool.execute(
    {
      channel,
      ...(channel === 'feishu' ? { feishu: payload } : { log: payload }),
      adviceId: advice.id,
    },
    ctx,
  );
  return notification.ok;
};

type GenerateStrategyRecommendationsInputT = z.output<typeof GenerateStrategyRecommendationsInput>;
type GenerateStrategyRecommendationsV2Input = Omit<
  GenerateStrategyRecommendationsInputT,
  'policy'
> & {
  readonly policy: StrategyRecommendationPolicyV2;
};
type ListedStrategyResultViews = z.output<typeof ListStrategyResultViewsOutput>;

const generateV2Recommendations = async (
  input: GenerateStrategyRecommendationsV2Input,
  listed: ListedStrategyResultViews,
  ctx: ToolContext,
): Promise<z.output<typeof GenerateStrategyRecommendationsOutput>> => {
  const eligible = listed.rows
    .filter(({ stock }) => input.stockIds === undefined || input.stockIds.includes(stock.stockId))
    .filter(({ view }) => (view.result.rank ?? Number.MAX_SAFE_INTEGER) <= input.policy.maxRank)
    .filter(({ view }) => (view.result.score ?? -1) >= input.policy.minScore)
    .slice(0, input.policy.maxPerRun);
  const evaluatedAt = ctx.clock();
  const facts = await assembleV2Facts(eligible, input.runId, input.strategyId, ctx);
  const advices: z.output<typeof AdviceSchema>[] = [];
  const details: StrategyRecommendationPreflight[] = [];
  let skippedCooldown = 0;
  let notificationFailed = 0;

  for (const row of eligible) {
    const stockId = row.stock.stockId;
    const stock = facts.stockById.get(stockId);
    const quote = facts.quoteByStock.get(stockId);
    const signalFacts = assembleSignalFacts(
      facts.signals,
      listed.version,
      input.runId,
      input.strategyId,
      stockId,
    );
    let cooldownFacts: readonly StrategyRecommendationCooldownFact[] = [];
    let cooldownFactsUnavailable = false;
    try {
      const previous = await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: stockId,
        sourceTool: 'analyze_strategy_candidate',
        since: new Date(evaluatedAt.getTime() - input.policy.cooldownHours * 60 * 60_000),
        includeExpired: true,
      });
      cooldownFacts = await cooldownFactsForAdvices(previous, input.strategyId, stockId, ctx);
    } catch (error) {
      cooldownFactsUnavailable = true;
      ctx.logger.warn('generate_strategy_recommendations: cooldown facts unavailable', {
        strategyId: input.strategyId,
        stockId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const preflight = evaluateStrategyRecommendationPreflight({
      policy: input.policy,
      accountId: ctx.user.defaultAccountId,
      strategyId: input.strategyId,
      run: listed.run,
      candidate: {
        stockId,
        stockResolved: row.stock.nameStatus === 'resolved' && stock !== null && stock !== undefined,
        ...(stock?.industry === undefined ? {} : { industry: stock.industry }),
        ...(quote === undefined ? {} : { quote }),
        factReferences: [
          `strategy-result:${input.runId}:${stockId}`,
          ...(quote === undefined ? [] : [`quote:${stockId}:${quote.observedAt.toISOString()}`]),
        ],
      },
      account: facts.account,
      holdings: facts.holdings,
      holdingFactsUnavailable: facts.holdingFactsUnavailable,
      signals: signalFacts.facts,
      signalsUnavailable: facts.signalsUnavailable || signalFacts.unavailable,
      strategyExposureFacts: facts.strategyExposureFacts,
      strategyExposureFactsUnavailable: facts.strategyExposureFactsUnavailable,
      ...(facts.strategyVersionIds === undefined
        ? {}
        : { strategyVersionIds: facts.strategyVersionIds }),
      trigger: input.trigger,
      cooldownFacts,
      cooldownFactsUnavailable,
      evaluatedAt,
    });
    details.push(preflight);
    if (preflight.status !== 'eligible') {
      if (preflight.reasons.some((reason) => reason.code === 'cooldown')) {
        skippedCooldown += 1;
      }
      continue;
    }

    const generated = await analyzeStrategyCandidateTool.execute(
      {
        strategyId: input.strategyId,
        runId: input.runId,
        stockId,
        recommendationTrigger: input.trigger,
      },
      ctx,
    );
    if (!generated.ok) continue;
    advices.push(generated.data.advice);
    if (
      input.policy.notify &&
      !(await notifyAdvice(generated.data.advice, input.policy.channel, ctx))
    ) {
      notificationFailed += 1;
    }
  }

  return {
    strategyId: input.strategyId,
    runId: input.runId,
    advices,
    skippedCooldown,
    notificationFailed,
    preflight: summarizePreflight(details),
  };
};

export const generateStrategyRecommendationsTool = defineTool({
  name: 'generate_strategy_recommendations',
  description: '按 StrategyRecommendationPolicy 从已发布运行生成可追溯 Advice 并可选通知',
  sideEffect: 'advice',
  requiredCapabilities: ['advice', 'external'],
  input: GenerateStrategyRecommendationsInput,
  output: GenerateStrategyRecommendationsOutput,
  handler: async (input, ctx: ToolContext) => {
    if (!input.policy.enabled) {
      return {
        strategyId: input.strategyId,
        runId: input.runId,
        advices: [],
        skippedCooldown: 0,
        notificationFailed: 0,
      };
    }
    const listed = await listStrategyResultViewsTool.execute(
      {
        strategyId: input.strategyId,
        runId: input.runId,
        view: 'selected',
        sort: 'rank',
        order: 'asc',
        offset: 0,
        limit: input.policy.maxRank,
      },
      ctx,
    );
    if (!listed.ok) return listed;
    const policy = input.policy;
    if (isStrategyRecommendationPolicyV2(policy)) {
      return generateV2Recommendations({ ...input, policy }, listed.data, ctx);
    }
    if (!isPublishableOperationalRun(listed.data.run)) {
      return errInvalidInput('只有已发布且通过完整性门禁的 operational StrategyRun 才能生成推荐');
    }
    const eligible = listed.data.rows
      .filter(({ stock }) => input.stockIds === undefined || input.stockIds.includes(stock.stockId))
      .filter(({ view }) => (view.result.rank ?? Number.MAX_SAFE_INTEGER) <= input.policy.maxRank)
      .filter(({ view }) => (view.result.score ?? -1) >= input.policy.minScore)
      .slice(0, input.policy.maxPerRun);
    const advices: z.output<typeof AdviceSchema>[] = [];
    let skippedCooldown = 0;
    let notificationFailed = 0;
    const since = new Date(ctx.clock().getTime() - input.policy.cooldownHours * 60 * 60 * 1000);
    for (const row of eligible) {
      const previous = await getAdviceTool.execute(
        {
          subjectKind: 'stock',
          subjectId: row.stock.stockId,
          sourceTool: 'analyze_strategy_candidate',
          since,
          includeExpired: true,
          limit: 50,
        },
        ctx,
      );
      if (!previous.ok) continue;
      if (
        previous.data.advices.some(
          (advice) =>
            advice.basedOn.strategy?.strategyId === input.strategyId &&
            advice.basedOn.strategy.recommendationTrigger === input.trigger,
        )
      ) {
        skippedCooldown += 1;
        continue;
      }
      const generated = await analyzeStrategyCandidateTool.execute(
        {
          strategyId: input.strategyId,
          runId: input.runId,
          stockId: row.stock.stockId,
          recommendationTrigger: input.trigger,
        },
        ctx,
      );
      if (!generated.ok) continue;
      advices.push(generated.data.advice);
      if (!input.policy.notify) continue;
      const advice = generated.data.advice;
      const payload = {
        title: `策略推荐 · ${advice.stockName ?? advice.subjectId}`,
        content: [
          `${advice.subjectId} · ${advice.decision} · 信心度 ${advice.confidence}`,
          advice.reasoning.premise,
          `证据：${advice.reasoning.evidence.join('；') || '暂无'}`,
          `反证：${advice.reasoning.counterEvidence.join('；') || '暂无'}`,
          `风险：${advice.risks.join('；') || '暂无'}`,
          `有效期至 ${advice.validUntil.toISOString()}`,
          advice.disclaimers.join('\n'),
        ].join('\n'),
        level: advice.decision === 'avoid' || advice.decision === 'sell' ? 'warn' : 'info',
      } as const;
      const notification = await sendNotificationTool.execute(
        {
          channel: input.policy.channel,
          ...(input.policy.channel === 'feishu' ? { feishu: payload } : { log: payload }),
          adviceId: advice.id,
        },
        ctx,
      );
      if (!notification.ok) notificationFailed += 1;
    }
    return {
      strategyId: input.strategyId,
      runId: input.runId,
      advices,
      skippedCooldown,
      notificationFailed,
    };
  },
});
