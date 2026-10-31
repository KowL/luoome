// T18 / REQ-M3-01：回溯轨观察流水线。
//
// 结构：历史区间 → evaluation session 逐日 replay（复用 replay-strategy-range 的 PIT 断点
// 序列）→ 每日 evaluation run → vintage=restated 的观察候选。
//
// 边界（H8 冻结口径）：
//   - 不写 operational 前态：replay 只落 evaluation scope 的 run/day/session；
//   - 不改 publication：本 workflow 不触碰 Strategy 版本状态；
//   - 不生成 Advice：restated 观察只进统计层，三条陈述路径由 tools 侧守卫拒绝。
import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { replayStrategyRangeWorkflow } from './replay-strategy-range.js';

export const BackfillStrategyObservationsInput = z.object({
  strategyId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  owner: z.string().min(1).optional(),
  /** 单次最多推进的交易日数；续跑靠 resumeSessionId。 */
  maxDays: z.number().int().min(1).max(20).optional(),
  resumeSessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).max(100).optional(),
});
export type BackfillStrategyObservationsInputT = z.infer<typeof BackfillStrategyObservationsInput>;

/** 缺失原因分布：键是原因，值是受影响的天数。 */
export const BackfillMissingReasonSchema = z.record(z.string(), z.number().int().nonnegative());

export const BackfillStrategyObservationsOutput = z.object({
  sessionId: z.string().min(1),
  strategyId: z.string().min(1),
  versionId: z.string().min(1),
  status: z.enum(['complete', 'partial', 'failed']),
  vintage: z.literal('restated'),
  summary: z.object({
    tradingDays: z.number().int().nonnegative(),
    coveredDays: z.number().int().nonnegative(),
    failedDays: z.number().int().nonnegative(),
    pendingDays: z.number().int().nonnegative(),
    /** 本次写入的 restated 观察条数（含 skipped 时只算 created）。 */
    observationSamples: z.number().int().nonnegative(),
    skippedSamples: z.number().int().nonnegative(),
    baselinesAvailable: z.number().int().nonnegative(),
    baselinesUnavailable: z.number().int().nonnegative(),
    byHorizon: z.record(
      ActiveSignalObservationHorizonSchema,
      z.object({
        created: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      }),
    ),
    missingReasons: BackfillMissingReasonSchema,
  }),
  days: z.array(
    z.object({
      dataAsOf: z.coerce.date(),
      status: z.enum(['complete', 'failed', 'pending']),
      vintage: z.literal('restated'),
      runId: z.string().min(1).optional(),
      observationSamples: z.number().int().nonnegative(),
      missingReason: z.string().min(1).optional(),
    }),
  ),
  limitations: z.array(z.string()),
});
export type BackfillStrategyObservationsOutputT = z.infer<
  typeof BackfillStrategyObservationsOutput
>;

/** 边界三分法（PRD v3.1 修正）：三类各一句面向用户的说法，(b) 必须点明"看似可补"。 */
export const BACKFILL_BOUNDARY_STATEMENTS = Object.freeze({
  a: '可补：IC / RankIC、分位收益、gross 毛收益、break-even cost、规则换手、参数邻域方差——这些只依赖历史行情与规则本身，回溯轨能给。',
  b: '看似可补实不可补：可实现换手受容量约束；信号胜率不等于建议命中率（同名不同物）；IC 有幸存偏差（幸存者股票池前视）；超额收益需要同 cutoff 基准；成本后净收益需要真实成交假设——这些回溯轨给不了，别当 (a) 用。',
  c: '能补但被排除：任何需要「当时可见性」的结论（信号历史性、建议兑现）即使算得出来也不补，因为它会变成前视证据。',
});

const VINTAGE_LIMITATIONS = [
  BACKFILL_BOUNDARY_STATEMENTS.a,
  BACKFILL_BOUNDARY_STATEMENTS.b,
  BACKFILL_BOUNDARY_STATEMENTS.c,
  '本 workflow 只写 vintage=restated 的观察：它由历史 replay 补算，只能进统计层（IC / 分位 / 换手）。',
  'restated 不得用于「策略历史命中」陈述、Advice 证据链或 DecisionReview 的「当时依据」（H8 冻结口径）。',
  '未写 operational 前态、未改 Strategy publication、未生成任何 Advice。',
];

const replay: WorkflowStep = async (previous, ctx) => {
  const input = previous as BackfillStrategyObservationsInputT;
  // provenance=backfill：这条轨的观察恒为 restated，所以 session 记下来源轨，
  // 让零信号日（有评分横截面、无观察可贴标签）也能按 restated 参与统计层计算。
  const replayed = await replayStrategyRangeWorkflow.run({ ...input, origin: 'backfill' }, ctx);
  if (!replayed.ok) return replayed;
  const output: BackfillStrategyObservationsOutputT = {
    sessionId: replayed.data.sessionId,
    strategyId: input.strategyId,
    versionId: input.versionId ?? '',
    status: replayed.data.status,
    vintage: 'restated',
    summary: {
      tradingDays: replayed.data.summary.tradingDays,
      coveredDays: replayed.data.summary.completedDays,
      failedDays: replayed.data.summary.failedDays,
      pendingDays: 0,
      observationSamples: 0,
      skippedSamples: 0,
      baselinesAvailable: 0,
      baselinesUnavailable: 0,
      byHorizon: Object.fromEntries(
        ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [horizon, { created: 0, skipped: 0 }]),
      ) as BackfillStrategyObservationsOutputT['summary']['byHorizon'],
      missingReasons: {},
    },
    days: replayed.data.days.map((day) => ({
      dataAsOf: day.dataAsOf,
      status: day.status,
      vintage: 'restated' as const,
      ...(day.runId === undefined ? {} : { runId: day.runId }),
      observationSamples: 0,
      ...(day.error === undefined
        ? { missingReason: 'replay-failed' }
        : { missingReason: day.error }),
    })),
    limitations: [...VINTAGE_LIMITATIONS],
  };
  return output;
};

/** 逐日把 evaluation run 转成 restated 观察；缺 runId 或 tool 拒绝都记进缺失原因分布。 */
const collect: WorkflowStep = async (previous, ctx) => {
  const output = previous as BackfillStrategyObservationsOutputT;
  const summary = {
    ...output.summary,
    byHorizon: Object.fromEntries(
      ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [
        horizon,
        { ...(output.summary.byHorizon[horizon] ?? { created: 0, skipped: 0 }) },
      ]),
    ) as BackfillStrategyObservationsOutputT['summary']['byHorizon'],
    missingReasons: { ...output.summary.missingReasons },
  };
  const bump = (reason: string): void => {
    summary.missingReasons[reason] = (summary.missingReasons[reason] ?? 0) + 1;
  };
  const days: BackfillStrategyObservationsOutputT['days'] = [];
  for (const day of output.days) {
    if (day.status !== 'complete' || day.runId === undefined) {
      if (day.status !== 'complete') bump(day.missingReason ?? 'replay-failed');
      else bump('run-missing');
      days.push({ ...day, status: day.status === 'complete' ? 'pending' : day.status });
      continue;
    }
    const created = await ctx.tools.create_restated_strategy_observation_candidates.execute({
      runId: day.runId,
      evaluationSessionId: output.sessionId,
    });
    if (!created.ok) {
      bump(`observation-rejected:${created.error.kind}`);
      days.push({ ...day, status: 'pending', missingReason: created.error.kind });
      continue;
    }
    summary.observationSamples += created.data.created;
    summary.skippedSamples += created.data.skipped;
    summary.baselinesAvailable += created.data.baselines.available;
    summary.baselinesUnavailable += created.data.baselines.unavailable;
    for (const horizon of ACTIVE_SIGNAL_OBSERVATION_HORIZONS) {
      const bucket = created.data.horizons[horizon] ?? { created: 0, skipped: 0 };
      summary.byHorizon[horizon] = {
        created: summary.byHorizon[horizon].created + bucket.created,
        skipped: summary.byHorizon[horizon].skipped + bucket.skipped,
      };
    }
    days.push({ ...day, observationSamples: created.data.created });
  }
  const failedDays = days.filter((day) => day.status === 'failed').length;
  const pendingDays = days.filter((day) => day.status === 'pending').length;
  return {
    ...output,
    status: failedDays > 0 || pendingDays > 0 ? ('partial' as const) : ('complete' as const),
    summary: { ...summary, failedDays, pendingDays },
    days,
  };
};

export const backfillStrategyObservationsWorkflow = defineWorkflow<
  BackfillStrategyObservationsInputT,
  BackfillStrategyObservationsOutputT
>({
  name: 'backfill-strategy-observations',
  description:
    '回溯轨：历史区间逐日 replay 并写入 vintage=restated 观察（只进统计层，不写 operational 前态、不改 publication、不生成 Advice）',
  input: BackfillStrategyObservationsInput,
  steps: [replay, collect],
});
