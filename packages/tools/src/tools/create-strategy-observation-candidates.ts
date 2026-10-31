import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
  isObservableStrategySignal,
  isPublishableOperationalRun,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  observationsForStrategySignal,
  type StrategySignalBaseline,
  saveObservationCandidates,
} from '../internal/signal-observation.js';

export const CreateStrategyObservationCandidatesInput = z.object({
  runId: z.string().min(1),
  evaluationSessionId: z.string().min(1).optional(),
});

export const CreateStrategyObservationCandidatesOutput = z.object({
  runId: z.string().min(1),
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
});

const baselineFromSignal = (signal: StrategySignal): StrategySignalBaseline | undefined => {
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
  ) {
    return undefined;
  }
  return { price: value.price, at, provider: value.provider };
};

export const createStrategyObservationCandidatesTool = defineTool({
  name: 'create_strategy_observation_candidates',
  description: '为已发布正式运行或显式关联的验证运行创建事实观察；不创建建议或交易',
  sideEffect: 'write',
  input: CreateStrategyObservationCandidatesInput,
  output: CreateStrategyObservationCandidatesOutput,
  handler: async (input, ctx: ToolContext) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    if (input.evaluationSessionId !== undefined) {
      const session = await ctx.repos.strategyEvaluation.findSessionById(input.evaluationSessionId);
      const days = await ctx.repos.strategyEvaluation.listDays(input.evaluationSessionId);
      if (
        session === null ||
        run.scope !== 'evaluation' ||
        run.status !== 'complete' ||
        session.strategyId !== run.strategyId ||
        session.strategyVersionId !== run.strategyVersionId ||
        !days.some((day) => day.status === 'complete' && day.runId === run.id)
      ) {
        return errInvalidInput('验证观察必须关联同一 session 的已完成 evaluation 运行');
      }
      // 反向守卫，与 `create_restated_strategy_observation_candidates` 的 prospective 守卫对称：
      // 回溯轨 session 的观察恒为 restated，这里写 pit 会让同一天既称「事后补算」又称「前瞻写入」，
      // `get_strategy_ic` 只能判 vintage-conflict 并跳过——fail-closed 成立，但那是可避免的样本损失。
      // provenance 未知的存量 session 不拦：没有可对照的创建期事实，拦了等于把存量数据判死。
      if (session.origin === 'backfill') {
        return errInvalidInput(
          '该 evaluation session 的 provenance 是 backfill（回溯轨），观察必须是 restated；请用 create_restated_strategy_observation_candidates',
        );
      }
    } else if (!isPublishableOperationalRun(run)) {
      return errInvalidInput(
        '只有 published operational StrategyRun 或显式验证 session 才能创建观察候选',
      );
    }
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
    };
  },
});
