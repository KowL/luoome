import {
  aggregateSignalObservationStats,
  classifyStrategyResult,
  diffStrategyRunViews,
  isPublishableOperationalRun,
  isUsableStrategyRun,
  type SignalObservation,
  type StrategyResultView,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

const DAY_MS = 86_400_000;
const HORIZONS = ['t1', 't3', 't5', 't20'] as const;
const OBSERVATION_QUERY_CHUNK = 400;
const OBSERVATION_LIMIT = 5000;
const FACT_EVIDENCE_LIMIT = 50;

const StrategyInsightFactSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).max(FACT_EVIDENCE_LIMIT),
});

const ObservationAggregateSchema = z.object({
  horizon: z.enum(HORIZONS),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)).max(5000),
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

const GroupedObservationAggregateSchema = z.object({
  dimension: z.enum(['industry', 'score-bucket', 'edge', 'market-state']),
  group: z.string().min(1),
  horizon: z.enum(HORIZONS),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)).max(5000),
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

export const StrategyInsightFactsSchema = z.object({
  scope: z.enum(['operational', 'evaluation']),
  evaluationSessionId: z.string().optional(),
  strategy: z.object({ id: z.string(), name: z.string() }),
  window: z.object({
    days: z.number().int().positive(),
    from: z.coerce.date(),
    to: z.coerce.date(),
  }),
  factsAsOf: z.coerce.date(),
  observationAsOf: z.coerce.date().optional(),
  runs: z.object({
    total: z.number().int().nonnegative(),
    usable: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    latestRunAt: z.coerce.date().optional(),
  }),
  currentSelection: z.object({
    runId: z.string().optional(),
    selectedCount: z.number().int().nonnegative(),
    averageScore: z.number().finite().optional(),
    industries: z.array(
      z.object({
        name: z.string(),
        count: z.number().int().positive(),
        share: z.number().min(0).max(1),
      }),
    ),
  }),
  changes: z.object({
    comparisons: z.number().int().nonnegative(),
    entered: z.number().int().nonnegative(),
    exited: z.number().int().nonnegative(),
    candidatePromoted: z.number().int().nonnegative(),
    selectedDemoted: z.number().int().nonnegative(),
    definitionChanges: z.number().int().nonnegative(),
  }),
  blockers: z.array(
    z.object({
      ruleId: z.string(),
      ruleName: z.string(),
      count: z.number().int().positive(),
      runIds: z.array(z.string()),
    }),
  ),
  observations: z.array(ObservationAggregateSchema),
  groupedObservations: z.array(GroupedObservationAggregateSchema),
  alertPlans: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      ruleCount: z.number().int().positive(),
    }),
  ),
  facts: z.array(StrategyInsightFactSchema),
  limitations: z.array(z.string()),
});
export type StrategyInsightFacts = z.infer<typeof StrategyInsightFactsSchema>;

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

const aggregateObservations = (
  observations: readonly SignalObservation[],
): z.infer<typeof ObservationAggregateSchema>[] =>
  HORIZONS.map((horizon) => {
    const rows = observations.filter((item) => item.horizon === horizon);
    const advanced = aggregateSignalObservationStats(observations).find(
      (item) => item.group === 'all' && item.horizon === horizon,
    );
    const complete = rows.filter((item) => item.status === 'complete');
    const observedAsOf = complete.reduce<Date | undefined>(
      (latest, item) =>
        item.observedAt !== undefined && (latest === undefined || item.observedAt > latest)
          ? item.observedAt
          : latest,
      undefined,
    );
    const averageReturnPct = mean(complete.flatMap((item) => item.returnPct ?? []));
    const averageBenchmarkReturnPct = mean(
      complete.flatMap((item) => item.benchmarkReturnPct ?? []),
    );
    const averageExcessReturnPct = mean(
      complete.flatMap((item) =>
        item.returnPct === undefined || item.benchmarkReturnPct === undefined
          ? []
          : [item.returnPct - item.benchmarkReturnPct],
      ),
    );
    const averageMaxFavorableExcursionPct = mean(
      complete.flatMap((item) => item.maxFavorableExcursionPct ?? []),
    );
    const averageMaxAdverseExcursionPct = mean(
      complete.flatMap((item) => item.maxAdverseExcursionPct ?? []),
    );
    const pending = rows.filter((item) => item.status === 'pending').length;
    const unavailable = rows.filter((item) => item.status === 'unavailable').length;
    return {
      horizon,
      total: rows.length,
      complete: complete.length,
      uniqueStocks: advanced?.uniqueStocks ?? new Set(rows.map((item) => item.stockId)).size,
      pending,
      unavailable,
      missingRate: rows.length === 0 ? 0 : (pending + unavailable) / rows.length,
      observationIds: [...(advanced?.observationIds ?? rows.map((item) => item.id).sort())],
      benchmarkStatus:
        complete.length > 0 && complete.every((item) => item.benchmarkStatus === 'complete')
          ? 'complete'
          : 'unavailable',
      ...(averageReturnPct === undefined ? {} : { averageReturnPct }),
      ...(advanced?.medianReturnPct === undefined
        ? {}
        : { medianReturnPct: advanced.medianReturnPct }),
      ...(advanced?.p25ReturnPct === undefined ? {} : { p25ReturnPct: advanced.p25ReturnPct }),
      ...(advanced?.p75ReturnPct === undefined ? {} : { p75ReturnPct: advanced.p75ReturnPct }),
      ...(averageBenchmarkReturnPct === undefined ? {} : { averageBenchmarkReturnPct }),
      ...(averageExcessReturnPct === undefined ? {} : { averageExcessReturnPct }),
      ...(averageMaxFavorableExcursionPct === undefined ? {} : { averageMaxFavorableExcursionPct }),
      ...(averageMaxAdverseExcursionPct === undefined ? {} : { averageMaxAdverseExcursionPct }),
      ...(observedAsOf === undefined ? {} : { observedAsOf }),
    };
  });

const scoreBucket = (score: number | undefined): string => {
  if (score === undefined || !Number.isFinite(score)) return 'unknown';
  const lower = Math.max(0, Math.floor(score / 20) * 20);
  return `${lower}-${Math.min(100, lower + 20)}`;
};

const marketState = (observation: SignalObservation): string => {
  if (observation.benchmarkStatus !== 'complete' || observation.benchmarkReturnPct === undefined) {
    return 'benchmark-unavailable';
  }
  if (observation.benchmarkReturnPct >= 0.01) return 'benchmark-up';
  if (observation.benchmarkReturnPct <= -0.01) return 'benchmark-down';
  return 'benchmark-flat';
};

const aggregateObservationGroups = (
  observations: readonly SignalObservation[],
  signals: readonly { id: string; stockId: string; score: number; ruleId: string; ts: Date }[],
  stocks: ReadonlyMap<string, { industry?: string }>,
  versionRules: ReadonlyMap<string, { emission?: { mode?: 'level' | 'edge' } | undefined }>,
): z.infer<typeof GroupedObservationAggregateSchema>[] => {
  const orderedSignals = [...signals].sort(
    (left, right) => left.ts.getTime() - right.ts.getTime() || left.id.localeCompare(right.id),
  );
  const signalById = new Map(orderedSignals.map((signal) => [signal.id, signal]));
  const firstEdgeSignalIds = new Set<string>();
  const seenEdgeKeys = new Set<string>();
  for (const signal of orderedSignals) {
    const rule = versionRules.get(signal.ruleId);
    if (rule?.emission?.mode !== 'edge') continue;
    const key = `${signal.stockId}\0${signal.ruleId}`;
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    firstEdgeSignalIds.add(signal.id);
  }
  const dimensions = [
    {
      dimension: 'industry' as const,
      groupOf: (observation: SignalObservation): string => {
        const signal = signalById.get(observation.sourceId);
        return stocks.get(signal?.stockId ?? observation.stockId)?.industry ?? '未分类';
      },
    },
    {
      dimension: 'score-bucket' as const,
      groupOf: (observation: SignalObservation): string =>
        scoreBucket(signalById.get(observation.sourceId)?.score),
    },
    {
      dimension: 'edge' as const,
      groupOf: (observation: SignalObservation): string =>
        firstEdgeSignalIds.has(observation.sourceId) ? 'first-edge' : 'repeat-or-level',
    },
    {
      dimension: 'market-state' as const,
      groupOf: marketState,
    },
  ];
  return dimensions.flatMap(({ dimension, groupOf }) =>
    aggregateSignalObservationStats(observations, groupOf).map((stats) => {
      const rows = observations.filter(
        (observation) =>
          observation.horizon === stats.horizon && groupOf(observation) === stats.group,
      );
      const complete = rows.filter((observation) => observation.status === 'complete');
      const observedAsOf = complete.reduce<Date | undefined>(
        (latest, observation) =>
          observation.observedAt !== undefined &&
          (latest === undefined || observation.observedAt > latest)
            ? observation.observedAt
            : latest,
        undefined,
      );
      return {
        dimension,
        group: stats.group,
        horizon: stats.horizon,
        total: stats.total,
        complete: stats.complete,
        uniqueStocks: stats.uniqueStocks,
        missingRate: stats.missingRate,
        observationIds: [...stats.observationIds],
        benchmarkStatus:
          complete.length > 0 && complete.every((item) => item.benchmarkStatus === 'complete')
            ? ('complete' as const)
            : ('unavailable' as const),
        ...(stats.averageReturnPct === undefined
          ? {}
          : { averageReturnPct: stats.averageReturnPct }),
        ...(stats.medianReturnPct === undefined ? {} : { medianReturnPct: stats.medianReturnPct }),
        ...(stats.p25ReturnPct === undefined ? {} : { p25ReturnPct: stats.p25ReturnPct }),
        ...(stats.p75ReturnPct === undefined ? {} : { p75ReturnPct: stats.p75ReturnPct }),
        ...(stats.averageBenchmarkReturnPct === undefined
          ? {}
          : { averageBenchmarkReturnPct: stats.averageBenchmarkReturnPct }),
        ...(stats.averageExcessReturnPct === undefined
          ? {}
          : { averageExcessReturnPct: stats.averageExcessReturnPct }),
        ...(stats.averageMaxFavorableExcursionPct === undefined
          ? {}
          : { averageMaxFavorableExcursionPct: stats.averageMaxFavorableExcursionPct }),
        ...(stats.averageMaxAdverseExcursionPct === undefined
          ? {}
          : { averageMaxAdverseExcursionPct: stats.averageMaxAdverseExcursionPct }),
        ...(observedAsOf === undefined ? {} : { observedAsOf }),
      };
    }),
  );
};

const evidenceIds = (ids: readonly string[]): string[] => ids.slice(0, FACT_EVIDENCE_LIMIT);

export const collectStrategyInsightFacts = async (
  strategyId: string,
  windowDays: number,
  ctx: ToolContext,
  options: {
    readonly scope?: 'operational' | 'evaluation';
    readonly evaluationSessionId?: string;
  } = {},
): Promise<StrategyInsightFacts | null> => {
  const strategy = await ctx.repos.strategy.findById(strategyId);
  if (strategy === null) return null;
  const now = ctx.clock();
  const from = new Date(now.getTime() - windowDays * DAY_MS);
  const scope = options.scope ?? 'operational';
  const allRuns = await ctx.repos.strategyRun.listRuns({
    strategyId,
    scope,
    ...(scope === 'operational' ? { publication: 'published' as const } : {}),
    since: from,
    limit: 100,
  });
  const usableRuns = allRuns.filter((run) =>
    scope === 'operational'
      ? isPublishableOperationalRun(run)
      : isUsableStrategyRun(run) &&
        (options.evaluationSessionId === undefined ||
          (typeof run.inputSnapshot === 'object' &&
            run.inputSnapshot !== null &&
            'evaluationSessionId' in run.inputSnapshot &&
            (run.inputSnapshot as { readonly evaluationSessionId?: unknown })
              .evaluationSessionId === options.evaluationSessionId)),
  );
  const viewsByRun = new Map<string, StrategyResultView[]>();
  const ruleNames = new Map<string, string>();
  const signalRuleEmissions = new Map<
    string,
    { emission?: { mode?: 'level' | 'edge' } | undefined }
  >();
  for (const run of usableRuns) {
    const version = await ctx.repos.strategy.findVersionById(run.strategyVersionId);
    if (version === null) continue;
    for (const rule of version.definition.selection.rules) ruleNames.set(rule.id, rule.name);
    for (const rule of [
      ...version.definition.signals.entry,
      ...version.definition.signals.exit,
      ...version.definition.signals.risk,
    ]) {
      signalRuleEmissions.set(rule.id, rule);
    }
    const results = await ctx.repos.strategyRun.listResults(run.id);
    viewsByRun.set(
      run.id,
      results.map((result) => classifyStrategyResult(version.definition, result)),
    );
  }

  const currentRun = usableRuns.find((run) => viewsByRun.has(run.id));
  const currentViews = currentRun === undefined ? [] : (viewsByRun.get(currentRun.id) ?? []);
  const selected = currentViews.filter((view) => view.kind === 'selected');
  const selectedScores = selected.flatMap((view) => view.result.score ?? []);
  const stockUniverse = await ctx.repos.stockUniverse.listCurrent({
    coverage: 'CN_A_SHARES_SH_SZ',
    status: 'all',
  });
  const stocks = new Map(stockUniverse.map((stock) => [stock.id, stock]));
  const industryCounts = new Map<string, number>();
  for (const view of selected) {
    const industry = stocks.get(view.result.stockId)?.industry ?? '未分类';
    industryCounts.set(industry, (industryCounts.get(industry) ?? 0) + 1);
  }
  const industries = [...industryCounts]
    .map(([name, count]) => ({
      name,
      count,
      share: selected.length === 0 ? 0 : count / selected.length,
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  const changes = {
    comparisons: 0,
    entered: 0,
    exited: 0,
    candidatePromoted: 0,
    selectedDemoted: 0,
    definitionChanges: 0,
  };
  const comparableRuns = usableRuns.filter((run) => viewsByRun.has(run.id));
  for (let index = 0; index < comparableRuns.length - 1; index += 1) {
    const toRun = comparableRuns[index];
    const fromRun = comparableRuns[index + 1];
    if (toRun === undefined || fromRun === undefined) continue;
    const diff = diffStrategyRunViews({
      fromRun,
      toRun,
      fromViews: viewsByRun.get(fromRun.id) ?? [],
      toViews: viewsByRun.get(toRun.id) ?? [],
    });
    changes.comparisons += 1;
    changes.entered += diff.summary.entered;
    changes.exited += diff.summary.exited;
    changes.candidatePromoted += diff.summary.candidatePromoted;
    changes.selectedDemoted += diff.summary.selectedDemoted;
    if (diff.definitionChanged) changes.definitionChanges += 1;
  }

  const blockerCounts = new Map<string, { count: number; runIds: Set<string> }>();
  const allViews = [...viewsByRun.values()].flat();
  for (const view of allViews) {
    for (const ruleId of view.blockingRuleIds) {
      const row = blockerCounts.get(ruleId) ?? { count: 0, runIds: new Set<string>() };
      row.count += 1;
      row.runIds.add(view.result.runId);
      blockerCounts.set(ruleId, row);
    }
  }
  const blockers = [...blockerCounts]
    .map(([ruleId, row]) => ({
      ruleId,
      ruleName: ruleNames.get(ruleId) ?? ruleId,
      count: row.count,
      runIds: [...row.runIds].sort(),
    }))
    .sort((left, right) => right.count - left.count || left.ruleId.localeCompare(right.ruleId))
    .slice(0, 10);

  const publishedRunIds = new Set(usableRuns.map((run) => run.id));
  const signals = (await ctx.repos.strategyRun.signalsByStrategy(strategyId, from)).filter(
    (signal) => publishedRunIds.has(signal.runId),
  );
  const signalIds = signals.map((signal) => signal.id);
  const observationRows: SignalObservation[] = [];
  let observationsTruncated = false;
  for (let index = 0; index < signalIds.length; index += OBSERVATION_QUERY_CHUNK) {
    const sourceIds = signalIds.slice(index, index + OBSERVATION_QUERY_CHUNK);
    observationRows.push(
      ...(await ctx.repos.signalObservation.list({
        sourceKind: 'strategy-signal',
        sourceIds,
        limit: OBSERVATION_LIMIT,
      })),
    );
    if (observationRows.length >= OBSERVATION_LIMIT) {
      observationsTruncated =
        observationRows.length > OBSERVATION_LIMIT ||
        index + OBSERVATION_QUERY_CHUNK < signalIds.length;
      break;
    }
  }
  const observations = observationRows.slice(0, OBSERVATION_LIMIT);
  const observationAggregates = aggregateObservations(observations);
  const groupedObservations = aggregateObservationGroups(
    observations,
    signals,
    stocks,
    signalRuleEmissions,
  );
  const observationAsOf = observationAggregates.reduce<Date | undefined>(
    (latest, item) =>
      item.observedAsOf !== undefined && (latest === undefined || item.observedAsOf > latest)
        ? item.observedAsOf
        : latest,
    undefined,
  );
  const alertPlans = (await ctx.repos.alertPlan.list())
    .flatMap((plan) => {
      const ruleCount = plan.rules.filter(
        (rule) => rule.kind === 'strategy-signal' && rule.strategyId === strategyId,
      ).length;
      return ruleCount === 0
        ? []
        : [{ id: plan.id, name: plan.name, enabled: plan.enabled, ruleCount }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const facts: z.infer<typeof StrategyInsightFactSchema>[] = [
    {
      id: 'runs:window',
      label: `${windowDays} 天 ${scope} 运行`,
      value: `${allRuns.length} 次运行，${usableRuns.length} 次可用，${allRuns.filter((run) => run.status === 'failed').length} 次失败`,
      evidenceIds: evidenceIds(allRuns.map((run) => run.id)),
    },
    {
      id: 'selection:current',
      label: '当前明确命中',
      value: `${selected.length} 只，${industries.length} 个行业`,
      evidenceIds: currentRun === undefined ? [] : [currentRun.id],
    },
    {
      id: 'changes:window',
      label: '股票池变化',
      value: `进入 ${changes.entered}、退出 ${changes.exited}、候选晋级 ${changes.candidatePromoted}`,
      evidenceIds: evidenceIds(comparableRuns.map((run) => run.id)),
    },
    ...blockers.map((item) => ({
      id: `blocker:${item.ruleId}`,
      label: `高频阻断：${item.ruleName}`,
      value: `${item.count} 次`,
      evidenceIds: evidenceIds(item.runIds),
    })),
    ...observationAggregates.map((item) => ({
      id: `observation:${item.horizon}`,
      label: `${item.horizon.toUpperCase()} 真实表现`,
      value:
        item.complete === 0
          ? `暂无完整样本；待补 ${item.pending}，不可用 ${item.unavailable}，基准 ${item.benchmarkStatus}`
          : `${item.complete}/${item.total} 个完整样本，平均收益 ${((item.averageReturnPct ?? 0) * 100).toFixed(2)}%，${item.averageExcessReturnPct === undefined ? '超额收益暂不可用' : `平均超额 ${((item.averageExcessReturnPct ?? 0) * 100).toFixed(2)}%`}，基准 ${item.benchmarkStatus}`,
      evidenceIds: evidenceIds(
        observations
          .filter((observation) => observation.horizon === item.horizon)
          .map((observation) => observation.id),
      ),
    })),
    {
      id: 'alerts:associations',
      label: '关联预警',
      value: `${alertPlans.length} 个 AlertPlan`,
      evidenceIds: evidenceIds(alertPlans.map((plan) => plan.id)),
    },
    {
      id: 'observations:groups',
      label: '观察分组去相关',
      value: `${groupedObservations.length} 个行业、分数、市场状态和 edge 分组，${new Set(observations.map((item) => item.stockId)).size} 只唯一股票`,
      evidenceIds: evidenceIds(groupedObservations.flatMap((item) => item.observationIds)),
    },
  ];
  const limitations: string[] = [];
  if (allRuns.length === 0) limitations.push('观察窗口内没有策略运行，无法判断股票池变化。');
  if (signals.length === 0) limitations.push('观察窗口内没有策略信号，暂无事后表现样本。');
  if (signals.length > 0 && observations.length === 0) {
    limitations.push('窗口内信号尚无观察候选；Phase B 启用前的历史运行不会反向伪造观察基准。');
  }
  if (observationsTruncated)
    limitations.push(`观察明细超过 ${OBSERVATION_LIMIT} 条，仅统计最近样本。`);
  if (observationAggregates.some((item) => item.complete > 0 && item.complete < 10)) {
    limitations.push('部分观察周期的完整样本少于 10 个，只能作为描述性事实。');
  }
  if (observationAggregates.some((item) => item.missingRate > 0)) {
    limitations.push('部分信号尚未到观察期或数据不可用，统计存在缺失。');
  }
  limitations.push('事实观察不是回测，不包含成交、费用、滑点或可交易性假设。');

  return StrategyInsightFactsSchema.parse({
    scope,
    ...(options.evaluationSessionId === undefined
      ? {}
      : { evaluationSessionId: options.evaluationSessionId }),
    strategy: { id: strategy.id, name: strategy.name },
    window: { days: windowDays, from, to: now },
    factsAsOf: now,
    ...(observationAsOf === undefined ? {} : { observationAsOf }),
    runs: {
      total: allRuns.length,
      usable: usableRuns.length,
      failed: allRuns.filter((run) => run.status === 'failed').length,
      ...(allRuns[0] === undefined ? {} : { latestRunAt: allRuns[0].startedAt }),
    },
    currentSelection: {
      ...(currentRun === undefined ? {} : { runId: currentRun.id }),
      selectedCount: selected.length,
      ...(mean(selectedScores) === undefined ? {} : { averageScore: mean(selectedScores) }),
      industries,
    },
    changes,
    blockers,
    observations: observationAggregates,
    groupedObservations,
    alertPlans,
    facts,
    limitations,
  });
};

export const GetStrategyInsightFactsInput = z.object({
  strategyId: z.string().min(1),
  windowDays: z.number().int().min(7).max(180).default(30),
  scope: z.enum(['operational', 'evaluation']).default('operational'),
  evaluationSessionId: z.string().min(1).optional(),
});
export const GetStrategyInsightFactsOutput = StrategyInsightFactsSchema;

export const getStrategyInsightFactsTool = defineTool({
  name: 'get_strategy_insight_facts',
  description: '汇总 Strategy 运行变化、规则阻断、真实表现与关联预警的确定性事实',
  sideEffect: 'read',
  input: GetStrategyInsightFactsInput,
  output: GetStrategyInsightFactsOutput,
  handler: async (input, ctx) => {
    const facts = await collectStrategyInsightFacts(input.strategyId, input.windowDays, ctx, {
      scope: input.scope,
      ...(input.evaluationSessionId === undefined
        ? {}
        : { evaluationSessionId: input.evaluationSessionId }),
    });
    return facts ?? errNotFound('Strategy', input.strategyId);
  },
});

export const StrategyInsightNarrativeSchema = z.object({
  headline: z.string().min(1).max(120),
  summary: z.string().min(1).max(1000),
  findings: z
    .array(
      z.object({
        kind: z.enum(['trend', 'risk', 'limitation']),
        title: z.string().min(1).max(120),
        detail: z.string().min(1).max(600),
        factRefs: z.array(z.string().min(1)).min(1).max(8),
      }),
    )
    .max(8),
  risks: z.array(z.string().min(1).max(300)).max(8),
  limitations: z.array(z.string().min(1).max(300)).max(8),
  disclaimer: z.string().min(1).max(300),
});

export const GenerateStrategyInsightInput = GetStrategyInsightFactsInput;
export const GenerateStrategyInsightOutput = z.object({
  facts: StrategyInsightFactsSchema,
  insight: StrategyInsightNarrativeSchema,
  provider: z.string().min(1),
});

const factsOnlyNarrative = (
  facts: StrategyInsightFacts,
): z.infer<typeof StrategyInsightNarrativeSchema> => {
  const primary = facts.facts[0] ?? {
    id: 'runs:window',
    label: '运行事实',
    value: `${facts.runs.total} 次运行`,
    evidenceIds: [],
  };
  return {
    headline: `${facts.strategy.name} 事实摘要`,
    summary: `${facts.window.from.toISOString()} 至 ${facts.window.to.toISOString()} 共 ${facts.runs.total} 次 ${facts.scope} 运行，当前选择 ${facts.currentSelection.selectedCount} 只。`,
    findings: [
      {
        kind: 'trend',
        title: primary.label,
        detail: primary.value,
        factRefs: [primary.id],
      },
    ],
    risks: facts.limitations.slice(0, 8),
    limitations: facts.limitations.slice(0, 8),
    disclaimer: '这是基于已记录事实的降级摘要，不构成投资建议，也不替代人工复核。',
  };
};

export const generateStrategyInsightTool = defineTool({
  name: 'generate_strategy_insight',
  description: '仅基于确定性事实生成 Strategy 解释性洞察；不得生成交易建议或虚构引用',
  sideEffect: 'external',
  input: GenerateStrategyInsightInput,
  output: GenerateStrategyInsightOutput,
  handler: async (input, ctx) => {
    const facts = await collectStrategyInsightFacts(input.strategyId, input.windowDays, ctx, {
      scope: input.scope,
      ...(input.evaluationSessionId === undefined
        ? {}
        : { evaluationSessionId: input.evaluationSessionId }),
    });
    if (facts === null) return errNotFound('Strategy', input.strategyId);
    const allowed = new Set(facts.facts.map((fact) => fact.id));
    let lastError = 'AI 洞察生成失败';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await ctx.adapters.llm.generate<
          z.infer<typeof StrategyInsightNarrativeSchema>
        >({
          system:
            attempt === 0
              ? 'strategy_insight。只能解释 data.facts 中的事实；每条 finding 必须引用存在的 fact id。不得给出买卖建议、收益承诺、概率预测或把事实观察称为回测。必须保留缺失数据与小样本限制。'
              : 'strategy_insight 修复重试。严格输出 schema，所有 factRefs 必须来自 data.facts 的 id；不得补写事实、建议、概率或收益承诺。',
          schema: StrategyInsightNarrativeSchema,
          data: {
            strategy: facts.strategy,
            window: facts.window,
            facts: facts.facts,
            limitations: facts.limitations,
            ...(attempt === 0 ? {} : { repair: lastError }),
          },
        });
        const parsed = StrategyInsightNarrativeSchema.safeParse(generated);
        if (
          parsed.success &&
          parsed.data.findings.every((finding) => finding.factRefs.every((ref) => allowed.has(ref)))
        ) {
          return { facts, insight: parsed.data, provider: ctx.adapters.llm.name };
        }
        lastError = 'AI 洞察结构无效或引用了不存在的事实';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    ctx.logger.warn('generate_strategy_insight: LLM 两次尝试均失败，降级 facts-only', {
      strategyId: input.strategyId,
      error: lastError,
    });
    return { facts, insight: factsOnlyNarrative(facts), provider: 'facts-only' };
  },
});
