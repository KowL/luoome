// T18 / REQ-M3-01：回溯轨观察写入。
//
// 与 `create_strategy_observation_candidates`（前瞻 pit）分开成两个工具，而不是给后者加
// vintage 参数：pit 与 restated 的**写入前提**不同（restated 必须挂在已完成 evaluation
// session 的逐日 replay 上），混在一个工具里会让"默认写 pit"变成可被调用方改写的行为。
//
// H8：restated 只能进统计层；三条陈述路径（策略历史命中 / Advice 证据链 / DecisionReview
// 当时依据）由 internal/observation-vintage.ts 的守卫拒绝。
import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
  isObservableStrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  observationsForStrategySignal,
  type StrategySignalBaseline,
  saveObservationCandidates,
} from '../internal/signal-observation.js';

export const CreateRestatedStrategyObservationCandidatesInput = z.object({
  runId: z.string().min(1),
  /** 回溯轨必须显式挂在 evaluation session 上；不提供 operational 回填入口。 */
  evaluationSessionId: z.string().min(1),
});

export const CreateRestatedStrategyObservationCandidatesOutput = z.object({
  runId: z.string().min(1),
  evaluationSessionId: z.string().min(1),
  vintage: z.literal('restated'),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  baselines: z.object({
    available: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.number().int().nonnegative()),
  }),
  horizons: z.record(
    ActiveSignalObservationHorizonSchema,
    z.object({
      created: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  ),
  limitations: z.array(z.string()),
});

const baselineFromSignal = (signal: {
  evaluationSnapshot: { baseline?: unknown };
}): StrategySignalBaseline | undefined => {
  const raw = signal.evaluationSnapshot.baseline;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const at =
    value.at instanceof Date
      ? value.at
      : typeof value.at === 'string' || typeof value.at === 'number'
        ? new Date(value.at)
        : undefined;
  if (
    typeof value.price !== 'number' ||
    !Number.isFinite(value.price) ||
    value.price <= 0 ||
    at === undefined ||
    !Number.isFinite(at.getTime()) ||
    typeof value.provider !== 'string'
  )
    return undefined;
  return { price: value.price, at, provider: value.provider };
};

export const createRestatedStrategyObservationCandidatesTool = defineTool({
  name: 'create_restated_strategy_observation_candidates',
  description:
    '回溯轨：为已完成的 evaluation 运行写入 vintage=restated 的事实观察（只进统计层，不得用于历史命中/Advice 证据/复盘当时依据）',
  sideEffect: 'write',
  input: CreateRestatedStrategyObservationCandidatesInput,
  output: CreateRestatedStrategyObservationCandidatesOutput,
  handler: async (input, ctx: ToolContext) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    const session = await ctx.repos.strategyEvaluation.findSessionById(input.evaluationSessionId);
    const days = await ctx.repos.strategyEvaluation.listDays(input.evaluationSessionId);
    if (
      session === null ||
      run.scope !== 'evaluation' ||
      run.status !== 'complete' ||
      session.strategyId !== run.strategyId ||
      session.strategyVersionId !== run.strategyVersionId ||
      !days.some((day) => day.status === 'complete' && day.runId === run.id)
    )
      return errInvalidInput(
        'restated 观察必须关联同一 session 的已完成 evaluation 运行（不接受 operational 运行）',
      );
    const signals = (await ctx.repos.strategyRun.signalsByRun(input.runId)).filter(
      isObservableStrategySignal,
    );
    const baselineBySignal = new Map(
      signals.map((signal) => [signal.id, baselineFromSignal(signal)] as const),
    );
    const candidates = signals.flatMap((signal) =>
      observationsForStrategySignal(
        signal,
        baselineBySignal.get(signal.id),
        run.finishedAt ?? run.dataAsOf,
        'restated',
      ),
    );
    const existing = new Set(
      (
        await ctx.repos.signalObservation.list({
          sourceKind: 'strategy-signal',
          sourceIds: signals.map((signal) => signal.id),
          limit: candidates.length,
        })
      ).map((observation) => observation.id),
    );
    await saveObservationCandidates(candidates, ctx.repos.signalObservation);
    const providers = new Map<string, number>();
    for (const baseline of baselineBySignal.values()) {
      if (baseline === undefined) continue;
      providers.set(baseline.provider, (providers.get(baseline.provider) ?? 0) + 1);
    }
    const horizons = Object.fromEntries(
      ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => {
        const rows = candidates.filter((candidate) => candidate.horizon === horizon);
        return [
          horizon,
          {
            created: rows.filter((candidate) => !existing.has(candidate.id)).length,
            skipped: rows.filter((candidate) => existing.has(candidate.id)).length,
          },
        ];
      }),
    );
    return {
      runId: input.runId,
      evaluationSessionId: input.evaluationSessionId,
      vintage: 'restated' as const,
      created: candidates.filter((candidate) => !existing.has(candidate.id)).length,
      skipped: candidates.filter((candidate) => existing.has(candidate.id)).length,
      baselines: {
        available: [...baselineBySignal.values()].filter((baseline) => baseline !== undefined)
          .length,
        unavailable: [...baselineBySignal.values()].filter((baseline) => baseline === undefined)
          .length,
        providers: Object.fromEntries(
          [...providers].sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
      horizons,
      limitations: [
        'restated 观察由回溯轨 replay 补算，只能进统计层（IC / 分位 / 换手）。',
        '不得用于策略历史命中陈述、Advice 证据链或 DecisionReview 的「当时依据」（H8）。',
      ],
    };
  },
});
