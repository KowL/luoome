import {
  type Advice,
  aggregateSignalObservationStats,
  deduplicateSignalObservations,
  type ResearchHypothesisVersion,
  ResearchHypothesisVersionStatusSchema,
  SIGNAL_OBSERVATION_SAMPLE_UNIT,
  type SignalObservation,
  SignalObservationHorizonSchema,
  type Trade,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

const REVIEW_LIMIT = 1000;

export const GetDecisionLoopReviewInput = z
  .object({
    /** 账户 id；缺省为当前用户默认账户。 */
    accountId: z.string().min(1).optional(),
    /** 可选股票范围；Advice/Trade/SignalObservation 均按该股票过滤。 */
    stockId: z.string().min(1).optional(),
    /** Advice 按 createdAt、Trade/SignalObservation 按各自事实时间过滤。 */
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    /** 每类事实最多读取的条数；统计不会把未读到的行伪装成零。 */
    limit: z.number().int().min(1).max(REVIEW_LIMIT).default(100),
  })
  .superRefine((input, context) => {
    if (input.since !== undefined && input.until !== undefined && input.since > input.until) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['until'],
        message: 'until 必须不早于 since',
      });
    }
  });

const OutcomeDistributionSchema = z.object({
  followed: z.number().int().nonnegative(),
  partiallyFollowed: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
});

const AdviceReviewSchema = z.object({
  total: z.number().int().nonnegative(),
  backfilled: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  outcomeDistribution: OutcomeDistributionSchema,
});

const TradeAttributionSchema = z.object({
  total: z.number().int().nonnegative(),
  attributionCounts: z.object({
    advice: z.number().int().nonnegative(),
    researchHypothesisVersion: z.number().int().nonnegative(),
    strategyVersion: z.number().int().nonnegative(),
  }),
  /** 没有任何一类显式依据的交易；缺一类依据但有其它依据不计入此数。 */
  unattributed: z.number().int().nonnegative(),
});

const SignalStatsSchema = z.object({
  group: z.string().min(1),
  horizon: SignalObservationHorizonSchema,
  sampleUnit: z.literal(SIGNAL_OBSERVATION_SAMPLE_UNIT),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)),
  benchmarkStatus: z.enum(['complete', 'unavailable']),
  averageReturnPct: z.number().finite().optional(),
  medianReturnPct: z.number().finite().optional(),
  p25ReturnPct: z.number().finite().optional(),
  p75ReturnPct: z.number().finite().optional(),
  averageBenchmarkReturnPct: z.number().finite().optional(),
  averageExcessReturnPct: z.number().finite().optional(),
  averageMaxFavorableExcursionPct: z.number().finite().optional(),
  averageMaxAdverseExcursionPct: z.number().finite().optional(),
  observedAsOf: z.coerce.date().optional(),
});

const SignalReviewSchema = z.object({
  sampleUnit: z.literal(SIGNAL_OBSERVATION_SAMPLE_UNIT),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  stats: z.array(SignalStatsSchema),
});

const ResearchHypothesisSummarySchema = z.object({
  id: z.string().min(1),
  topicId: z.string().min(1),
  documentId: z.string().min(1),
  documentContentHash: z.string().min(1),
  version: z.number().int().positive(),
  status: ResearchHypothesisVersionStatusSchema,
  supersedesId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  createdAt: z.coerce.date(),
});

export const GetDecisionLoopReviewOutput = z.object({
  accountId: z.string().min(1),
  stockId: z.string().min(1).optional(),
  scope: z.object({
    accountId: z.string().min(1),
    stockId: z.string().min(1).optional(),
  }),
  window: z.object({
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
  }),
  advice: AdviceReviewSchema,
  trades: TradeAttributionSchema,
  signalObservations: SignalReviewSchema,
  researchHypothesisVersions: z.array(ResearchHypothesisSummarySchema),
  evidenceIds: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  dataAsOf: z.coerce.date(),
});

type DecisionLoopReviewInput = z.infer<typeof GetDecisionLoopReviewInput>;

const inDateRange = (date: Date, input: DecisionLoopReviewInput): boolean =>
  (input.since === undefined || date.getTime() >= input.since.getTime()) &&
  (input.until === undefined || date.getTime() <= input.until.getTime());

const stockIdsForAccount = (
  trades: readonly Trade[],
  holdings: readonly { readonly stockId: string }[],
): ReadonlySet<string> =>
  new Set([...trades.map((trade) => trade.stockId), ...holdings.map((holding) => holding.stockId)]);

const adviceBelongsToScope = (
  advice: Advice,
  input: DecisionLoopReviewInput,
  accountId: string,
  accountStockIds: ReadonlySet<string>,
  positionIdsByStock: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  if (advice.subjectKind === 'stock') {
    return input.stockId === undefined
      ? accountStockIds.has(advice.subjectId)
      : advice.subjectId === input.stockId;
  }
  if (advice.subjectKind === 'position') {
    if (input.stockId !== undefined) {
      return positionIdsByStock.get(input.stockId)?.has(advice.subjectId) ?? false;
    }
    return [...positionIdsByStock.values()].some((ids) => ids.has(advice.subjectId));
  }
  return (
    input.stockId === undefined &&
    advice.subjectKind === 'portfolio' &&
    advice.subjectId === accountId
  );
};

const summaryOf = (version: ResearchHypothesisVersion) => ({
  id: version.id,
  topicId: version.topicId,
  documentId: version.documentId,
  documentContentHash: version.documentContentHash,
  version: version.version,
  status: version.status,
  ...(version.supersedesId === undefined ? {} : { supersedesId: version.supersedesId }),
  ...(version.summary === undefined ? {} : { summary: version.summary }),
  createdAt: version.createdAt,
});

const buildSignalReview = (observations: readonly SignalObservation[]) => {
  const sampled = deduplicateSignalObservations(observations);
  const aggregates = aggregateSignalObservationStats(observations);
  const stats = aggregates.map((aggregate) => {
    const rows = sampled.filter((observation) => observation.horizon === aggregate.horizon);
    const completeRows = rows.filter((observation) => observation.status === 'complete');
    return {
      ...aggregate,
      observationIds: [...aggregate.observationIds],
      sampleUnit: SIGNAL_OBSERVATION_SAMPLE_UNIT,
      pending: rows.filter((observation) => observation.status === 'pending').length,
      unavailable: rows.filter((observation) => observation.status === 'unavailable').length,
      benchmarkStatus:
        completeRows.length > 0 &&
        completeRows.every((observation) => observation.benchmarkStatus === 'complete')
          ? ('complete' as const)
          : ('unavailable' as const),
    };
  });
  const complete = sampled.filter((observation) => observation.status === 'complete').length;
  return {
    sampleUnit: SIGNAL_OBSERVATION_SAMPLE_UNIT,
    total: sampled.length,
    complete,
    pending: sampled.filter((observation) => observation.status === 'pending').length,
    unavailable: sampled.filter((observation) => observation.status === 'unavailable').length,
    missingRate: sampled.length === 0 ? 0 : (sampled.length - complete) / sampled.length,
    stats,
  };
};

export const getDecisionLoopReviewTool = defineTool({
  name: 'get_decision_loop_review',
  description:
    '读取 Advice、Trade、SignalObservation 与研究假设版本的决策闭环复盘摘要；仅做账户隔离的描述性聚合，明确展示未知项与数据截止时间，不推断因果或自动交易',
  sideEffect: 'read',
  input: GetDecisionLoopReviewInput,
  output: GetDecisionLoopReviewOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const [allAccountTrades, holdings, allAdvices, allObservations] = await Promise.all([
      ctx.repos.trade.listByAccount(accountId),
      ctx.repos.holding.listByAccount(accountId),
      ctx.repos.advice.query({
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
        includeExpired: true,
        limit: input.limit,
      }),
      ctx.repos.signalObservation.list({
        ...(input.since === undefined ? {} : { from: input.since }),
        ...(input.until === undefined ? {} : { to: input.until }),
        limit: input.limit,
      }),
    ]);

    const accountStockIds = stockIdsForAccount(allAccountTrades, holdings);
    const positionIdsByStock = new Map<string, ReadonlySet<string>>();
    for (const holding of holdings) {
      const current = positionIdsByStock.get(holding.stockId) ?? new Set<string>();
      positionIdsByStock.set(holding.stockId, new Set([...current, holding.id]));
    }

    const advices = allAdvices.filter((advice) =>
      adviceBelongsToScope(advice, input, accountId, accountStockIds, positionIdsByStock),
    );
    const trades = allAccountTrades.filter(
      (trade) =>
        (input.stockId === undefined || trade.stockId === input.stockId) &&
        inDateRange(trade.executedAt, input),
    );
    const observations = allObservations.filter((observation) =>
      input.stockId === undefined
        ? accountStockIds.has(observation.stockId)
        : observation.stockId === input.stockId,
    );

    const backfilled = advices.filter((advice) => advice.outcome !== undefined).length;
    const outcomeDistribution = { followed: 0, partiallyFollowed: 0, ignored: 0 };
    for (const advice of advices) {
      if (advice.outcome?.outcome === 'followed') outcomeDistribution.followed += 1;
      else if (advice.outcome?.outcome === 'partially_followed') {
        outcomeDistribution.partiallyFollowed += 1;
      } else if (advice.outcome?.outcome === 'ignored') outcomeDistribution.ignored += 1;
    }

    const attributionCounts = {
      advice: trades.filter((trade) => trade.adviceId !== undefined).length,
      researchHypothesisVersion: trades.filter(
        (trade) => trade.researchHypothesisVersionId !== undefined,
      ).length,
      strategyVersion: trades.filter((trade) => trade.strategyVersionId !== undefined).length,
    };
    const unattributed = trades.filter(
      (trade) =>
        trade.adviceId === undefined &&
        trade.researchHypothesisVersionId === undefined &&
        trade.strategyVersionId === undefined,
    ).length;

    const hypothesisIds = [
      ...new Set(
        trades.flatMap((trade) =>
          trade.researchHypothesisVersionId === undefined
            ? []
            : [trade.researchHypothesisVersionId],
        ),
      ),
    ];
    const hypothesisResults = await Promise.all(
      hypothesisIds.map(async (id) => ({
        id,
        version: await ctx.repos.researchHypothesisVersion.findById(id),
      })),
    );
    const researchHypothesisVersions = hypothesisResults
      .flatMap(({ version }) => (version === null ? [] : [summaryOf(version)]))
      .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));

    const referencedAdviceIds = [
      ...new Set(trades.flatMap((trade) => (trade.adviceId === undefined ? [] : [trade.adviceId]))),
    ];
    const referencedStrategyVersionIds = [
      ...new Set(
        trades.flatMap((trade) =>
          trade.strategyVersionId === undefined ? [] : [trade.strategyVersionId],
        ),
      ),
    ];
    const [referencedAdvices, referencedStrategies] = await Promise.all([
      Promise.all(
        referencedAdviceIds.map(async (id) => ({ id, value: await ctx.repos.advice.findById(id) })),
      ),
      Promise.all(
        referencedStrategyVersionIds.map(async (id) => ({
          id,
          value: await ctx.repos.strategy.findVersionById(id),
        })),
      ),
    ]);

    const unknowns: string[] = [];
    if (advices.length === 0) unknowns.push('当前账户/股票范围没有可见 Advice，无法判断建议结果。');
    if (backfilled < advices.length) {
      unknowns.push(`${advices.length - backfilled} 条 Advice 尚未回填 AdviceOutcome。`);
    }
    if (trades.length === 0) unknowns.push('当前账户/股票范围没有交易事实，无法判断实际行动。');
    if (observations.length === 0) {
      unknowns.push('当前账户/股票范围没有 SignalObservation，无法判断信号后续表现。');
    }
    for (const { id, version } of hypothesisResults) {
      if (version === null) unknowns.push(`Trade 引用的 ResearchHypothesisVersion 不可用：${id}。`);
    }
    for (const { id, value } of referencedAdvices) {
      if (value === null) unknowns.push(`Trade 引用的 Advice 不可用：${id}。`);
    }
    for (const { id, value } of referencedStrategies) {
      if (value === null) unknowns.push(`Trade 引用的 StrategyVersion 不可用：${id}。`);
    }
    if (input.stockId === undefined && accountStockIds.size === 0) {
      unknowns.push('账户没有交易或持仓股票，未能为账户范围投影股票级 Advice/SignalObservation。');
    }
    if (allObservations.length >= input.limit) {
      unknowns.push(`SignalObservation 读取达到 limit=${input.limit}，统计可能未覆盖更早样本。`);
    }
    if (allAdvices.length >= input.limit) {
      unknowns.push(`Advice 读取达到 limit=${input.limit}，统计可能未覆盖更早建议。`);
    }

    const limitations = [
      '这是 Advice、交易与信号事实的描述性聚合，不是回测、因果结论或未来收益预测。',
      'Trade 依据字段是用户显式 provenance；缺失关联不代表 Advice 未采纳，也不会自动补链。',
      'SignalObservation 没有 accountId 维度；账户范围按该账户交易/持仓股票投影，不能证明观察只属于该账户。',
      'AdviceOutcome 的 pnl/benchmarkPnl 缺省时保持未知，不折算为 0；本摘要也不从 Trade 或行情反推 outcome。',
    ];
    const evidenceIds = [
      ...new Set([
        ...advices.map((advice) => advice.id),
        ...trades.map((trade) => trade.id),
        ...observations.map((observation) => observation.id),
        ...hypothesisIds,
        ...referencedAdviceIds,
        ...referencedStrategyVersionIds,
      ]),
    ];
    const dataAsOf = ctx.clock();
    const signalReview = buildSignalReview(observations);
    return {
      accountId,
      ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      scope: {
        accountId,
        ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      },
      window: {
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
      },
      advice: {
        total: advices.length,
        backfilled,
        pending: advices.length - backfilled,
        outcomeDistribution,
      },
      trades: {
        total: trades.length,
        attributionCounts,
        unattributed,
      },
      signalObservations: signalReview,
      researchHypothesisVersions,
      evidenceIds,
      unknowns,
      limitations,
      dataAsOf,
    };
  },
});
