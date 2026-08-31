import {
  STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER,
  type StrategyRecommendationPreflightReasonCode,
  StrategyRecommendationPreflightReasonCodeSchema,
  StrategyRecommendationPreflightSummarySchema,
  type WorkflowRun,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetStrategyRecommendationPreflightHistoryInput = z.object({
  strategyId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const PreflightHistoryCandidateSchema = z.object({
  stockId: z.string().min(1),
  status: z.enum(['eligible', 'skipped', 'unavailable']),
  reasonCodes: z.array(StrategyRecommendationPreflightReasonCodeSchema),
  factCount: z.number().int().nonnegative(),
  evaluatedAt: z.coerce.date(),
});

const PreflightHistoryRunSchema = z.object({
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date(),
  workflowStatus: z.enum(['succeeded', 'partial', 'failed']),
  total: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  candidates: z.array(PreflightHistoryCandidateSchema),
});

export const GetStrategyRecommendationPreflightHistoryOutput = z.object({
  strategyId: z.string(),
  runs: z.array(PreflightHistoryRunSchema),
  reasonCounts: z.array(
    z.object({
      code: StrategyRecommendationPreflightReasonCodeSchema,
      count: z.number().int().positive(),
    }),
  ),
  limitations: z.array(z.string().min(1)),
});

type PreflightHistoryRun = z.output<typeof PreflightHistoryRunSchema>;
type TerminalWorkflowStatus = Exclude<WorkflowRun['status'], 'running'>;
type TerminalWorkflowRun = Omit<WorkflowRun, 'status' | 'finishedAt'> & {
  status: TerminalWorkflowStatus;
  finishedAt: Date;
};
type ParsedPreflightRun = {
  run: TerminalWorkflowRun;
  snapshot: z.output<typeof StrategyRecommendationPreflightSummarySchema>;
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const LIMITATION_MESSAGES = {
  missingAttribution: '旧运行缺少 Strategy 归属信息，已忽略。',
  missingPreflight: '旧运行没有 preflight 快照，已忽略。',
  corruptPreflight: '损坏的 preflight 快照未计入历史。',
  invalidTerminal: '终态运行缺少有效结束时间，已忽略。',
} as const;

type LimitationKey = keyof typeof LIMITATION_MESSAGES;

const addLimitation = (limitations: Set<LimitationKey>, key: LimitationKey): void => {
  limitations.add(key);
};

const isTerminalWorkflowStatus = (
  status: WorkflowRun['status'],
): status is TerminalWorkflowStatus =>
  status === 'succeeded' || status === 'partial' || status === 'failed';

const preflightSnapshotFor = (
  run: WorkflowRun,
  strategyId: string,
  limitations: Set<LimitationKey>,
): ParsedPreflightRun | undefined => {
  if (!isTerminalWorkflowStatus(run.status)) {
    return undefined;
  }
  if (run.finishedAt === undefined || !Number.isFinite(run.finishedAt.getTime())) {
    addLimitation(limitations, 'invalidTerminal');
    return undefined;
  }

  const inputSummary = asRecord(run.inputSummary);
  if (inputSummary?.strategyId === undefined) {
    addLimitation(limitations, 'missingAttribution');
    return undefined;
  }
  if (inputSummary.strategyId !== strategyId) {
    return undefined;
  }

  const outputSummary = asRecord(run.outputSummary);
  const rawPreflight = outputSummary?.preflight;
  if (rawPreflight === undefined) {
    addLimitation(limitations, 'missingPreflight');
    return undefined;
  }
  const parsed = StrategyRecommendationPreflightSummarySchema.safeParse(rawPreflight);
  if (!parsed.success) {
    addLimitation(limitations, 'corruptPreflight');
    return undefined;
  }

  const snapshot = parsed.data;
  const counts = {
    total: snapshot.details.length,
    eligible: snapshot.details.filter((detail) => detail.status === 'eligible').length,
    skipped: snapshot.details.filter((detail) => detail.status === 'skipped').length,
    unavailable: snapshot.details.filter((detail) => detail.status === 'unavailable').length,
  };
  // detail.runId is the persisted StrategyRun id, while this record's id is the
  // surrounding strategy-daily-cycle WorkflowRun id; only Strategy ownership is
  // comparable at this projection boundary.
  const detailsBelongToStrategy = snapshot.details.every(
    (detail) => detail.strategyId === strategyId,
  );
  const summaryCountsMatch =
    snapshot.total === counts.total &&
    snapshot.eligible === counts.eligible &&
    snapshot.skipped === counts.skipped &&
    snapshot.unavailable === counts.unavailable;
  if (!detailsBelongToStrategy || !summaryCountsMatch) {
    addLimitation(limitations, 'corruptPreflight');
    return undefined;
  }
  return {
    run: { ...run, status: run.status, finishedAt: run.finishedAt },
    snapshot,
  };
};

const toHistoryRun = (
  run: TerminalWorkflowRun,
  snapshot: z.output<typeof StrategyRecommendationPreflightSummarySchema>,
): PreflightHistoryRun => {
  const candidates = snapshot.details
    .map((detail, index) => ({ detail, index }))
    .sort((left, right) => {
      const byStock = compareCodeUnits(left.detail.stockId, right.detail.stockId);
      if (byStock !== 0) return byStock;
      const byEvaluatedAt = left.detail.evaluatedAt.getTime() - right.detail.evaluatedAt.getTime();
      return byEvaluatedAt !== 0 ? byEvaluatedAt : left.index - right.index;
    })
    .map(({ detail }) => ({
      stockId: detail.stockId,
      status: detail.status,
      reasonCodes: [...detail.reasons]
        .sort(
          (left, right) =>
            STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER.indexOf(left.code) -
            STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER.indexOf(right.code),
        )
        .map((reason) => reason.code),
      factCount: detail.factReferences.length,
      evaluatedAt: detail.evaluatedAt,
    }));
  return {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt as Date,
    workflowStatus: run.status,
    total: snapshot.total,
    eligible: snapshot.eligible,
    skipped: snapshot.skipped,
    unavailable: snapshot.unavailable,
    candidates,
  };
};

const limitationOutput = (limitations: ReadonlySet<LimitationKey>): string[] =>
  (Object.keys(LIMITATION_MESSAGES) as LimitationKey[])
    .filter((key) => limitations.has(key))
    .map((key) => LIMITATION_MESSAGES[key]);

export const getStrategyRecommendationPreflightHistoryTool = defineTool({
  name: 'get_strategy_recommendation_preflight_history',
  description: '读取 strategy-daily-cycle 已有预检快照并按 Strategy 聚合历史',
  sideEffect: 'read',
  input: GetStrategyRecommendationPreflightHistoryInput,
  output: GetStrategyRecommendationPreflightHistoryOutput,
  handler: async (input, ctx) => {
    // Over-fetch a bounded window so running/corrupt/other-Strategy records do not make a
    // requested recent history appear shorter than the caller's limit. Query each terminal
    // status explicitly so the repository boundary never asks for in-flight workflow runs.
    const recentLimit = Math.min(200, input.limit * 4);
    const runs = (
      await Promise.all(
        (['succeeded', 'partial', 'failed'] as const).map((status) =>
          ctx.repos.workflowRun.listRecent({
            workflowName: 'strategy-daily-cycle',
            status,
            limit: recentLimit,
          }),
        ),
      )
    ).flat();
    const limitations = new Set<LimitationKey>();
    const parsedRuns = runs.flatMap((run) => {
      return preflightSnapshotFor(run, input.strategyId, limitations) ?? [];
    });
    parsedRuns.sort((left, right) => {
      const byStartedAt = right.run.startedAt.getTime() - left.run.startedAt.getTime();
      if (byStartedAt !== 0) return byStartedAt;
      const byFinishedAt =
        (right.run.finishedAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
        (left.run.finishedAt?.getTime() ?? Number.NEGATIVE_INFINITY);
      if (byFinishedAt !== 0) return byFinishedAt;
      return compareCodeUnits(left.run.id, right.run.id);
    });
    const selected = parsedRuns
      .slice(0, input.limit)
      .map(({ run, snapshot }) => toHistoryRun(run, snapshot));
    const reasonCounts = new Map<StrategyRecommendationPreflightReasonCode, number>();
    for (const run of selected) {
      for (const candidate of run.candidates) {
        for (const code of candidate.reasonCodes) {
          reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
        }
      }
    }

    return {
      strategyId: input.strategyId,
      runs: selected,
      reasonCounts: STRATEGY_RECOMMENDATION_PREFLIGHT_REASON_ORDER.flatMap((code) => {
        const count = reasonCounts.get(code);
        return count === undefined ? [] : [{ code, count }];
      }),
      limitations: limitationOutput(limitations),
    };
  },
});
