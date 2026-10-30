import { z } from 'zod';
import { isHoliday, isWeekend } from '../trading-calendar.js';
import { DataProvenanceSchema } from './provenance.js';
import type { DailyBar } from './quote.js';

/** 信号发生后的事实观察；不是回测交易或投资建议。 */
// 'tactic-signal'：旧 Tactic 模型已下线，枚举值为存量 signal_observations 行的读兼容保留。
export const SignalObservationSourceKindSchema = z.enum([
  'watch-trigger',
  'strategy-signal',
  'tactic-signal',
]);
export type SignalObservationSourceKind = z.infer<typeof SignalObservationSourceKindSchema>;

/**
 * 历史兼容来源：写入方已下线，只剩存量行，因此这些观察不属于前瞻轨。
 * 启动迁移把它们显式降级为 vintage='legacy'，而不是留在 pit 池里冒充前瞻样本。
 */
export const LEGACY_SIGNAL_OBSERVATION_SOURCE_KINDS = ['tactic-signal'] as const;
/** 退役观察周期：t20 只用于读既有持久化观察，迁移时同样降级为 legacy。 */
export const RETIRED_SIGNAL_OBSERVATION_HORIZONS = ['t20'] as const;

export const ACTIVE_SIGNAL_OBSERVATION_HORIZONS = ['t1', 't3', 't5'] as const;
export const ActiveSignalObservationHorizonSchema = z.enum(ACTIVE_SIGNAL_OBSERVATION_HORIZONS);
export type ActiveSignalObservationHorizon = z.infer<typeof ActiveSignalObservationHorizonSchema>;

/** `t20` 仅用于读取既有持久化观察；新候选、补全与产品视图只使用 active horizons。 */
export const SignalObservationHorizonSchema = z.enum(['t1', 't3', 't5', 't20']);
export type SignalObservationHorizon = z.infer<typeof SignalObservationHorizonSchema>;

export const isActiveSignalObservationHorizon = (
  horizon: SignalObservationHorizon,
): horizon is ActiveSignalObservationHorizon =>
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS.includes(horizon as ActiveSignalObservationHorizon);

export const SignalObservationStatusSchema = z.enum(['pending', 'complete', 'unavailable']);
export type SignalObservationStatus = z.infer<typeof SignalObservationStatusSchema>;

/**
 * 观察的时点口径（vintage）：
 * - `pit`：信号发生时点前瞻写入，只用当时可得事实；
 * - `restated`：事后用修订/回溯数据补算，只能进统计层，不得冒充 pit 用于策略历史命中、Advice 证据链或复盘「当时依据」；
 * - `legacy`：存量兼容数据（退役的 t20 周期或已下线来源），历史产物，不具备前瞻可复现性。
 */
export const SIGNAL_OBSERVATION_VINTAGES = ['pit', 'restated', 'legacy'] as const;
export const SignalObservationVintageSchema = z.enum(SIGNAL_OBSERVATION_VINTAGES);
export type SignalObservationVintage = z.infer<typeof SignalObservationVintageSchema>;

/** 当前生产写入方只产生 pit；迁移把其余存量显式降级为 legacy。 */
export const DEFAULT_SIGNAL_OBSERVATION_VINTAGE: SignalObservationVintage = 'pit';

/** 统计默认口径：只算 pit，避免 restated/legacy 混进前瞻样本池。 */
export const DEFAULT_SIGNAL_OBSERVATION_STATS_VINTAGE: SignalObservationVintage = 'pit';

export const SignalObservationSchema = z.object({
  id: z.string().min(1),
  sourceKind: SignalObservationSourceKindSchema,
  sourceId: z.string().min(1),
  stockId: z.string().min(1),
  baselinePrice: z.number().positive().optional(),
  baselineAt: z.coerce.date().optional(),
  horizon: SignalObservationHorizonSchema,
  vintage: SignalObservationVintageSchema.default(DEFAULT_SIGNAL_OBSERVATION_VINTAGE),
  closePrice: z.number().positive().optional(),
  returnPct: z.number().finite().optional(),
  maxFavorableExcursionPct: z.number().finite().optional(),
  maxAdverseExcursionPct: z.number().finite().optional(),
  benchmarkReturnPct: z.number().finite().optional(),
  /** benchmark 使用版本化 qfq 日线；同步失败时必须显式标记而非默默省略。 */
  benchmarkStatus: z.enum(['complete', 'unavailable']).default('unavailable'),
  status: SignalObservationStatusSchema,
  provenance: DataProvenanceSchema,
  unavailableReason: z.string().min(1).max(300).optional(),
  observedAt: z.coerce.date().optional(),
  /** 交易 session 解析后的最早可完成时点；旧记录可缺省。 */
  dueAt: z.coerce.date().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  lastAttemptAt: z.coerce.date().optional(),
  nextAttemptAt: z.coerce.date().optional(),
  lastErrorKind: z.string().min(1).optional(),
});

export type SignalObservation = z.infer<typeof SignalObservationSchema>;

export const SIGNAL_OBSERVATION_HORIZON_DAYS: Record<SignalObservationHorizon, number> = {
  t1: 1,
  t3: 3,
  t5: 5,
  t20: 20,
};

/** R7 默认基准；同步任务可把它作为 explicit stockId 纳入同一份日线数据源。 */
export const STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID = '000300.SH';
/** R7 benchmark 的可审计数据集版本：沪深 300、前复权、日线。 */
export const STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION = '000300.SH:qfq:daily:v1';

export const signalObservationId = (
  sourceKind: SignalObservationSourceKind,
  sourceId: string,
  horizon: SignalObservationHorizon,
): string => `signal-observation:${sourceKind}:${sourceId}:${horizon}`;

/** 按可用交易日 session 估计 due；holiday calendar 之外的交易所临时安排仍由补偿任务兜底。 */
export const signalObservationDueAt = (
  baselineAt: Date,
  horizon: SignalObservationHorizon,
): Date => {
  const target = new Date(baselineAt);
  let sessions = 0;
  while (sessions < SIGNAL_OBSERVATION_HORIZON_DAYS[horizon]) {
    target.setUTCDate(target.getUTCDate() + 1);
    if (!isWeekend(target) && !isHoliday(target)) sessions += 1;
  }
  return target;
};

export const assertSignalObservationInvariants = (observation: SignalObservation): void => {
  if (observation.status === 'unavailable') {
    if (observation.unavailableReason === undefined) {
      throw new Error('unavailable SignalObservation 必须说明 unavailableReason');
    }
    return;
  }
  if (observation.baselinePrice === undefined || observation.baselineAt === undefined) {
    throw new Error('pending/complete SignalObservation 必须有基准价格与时间');
  }
  if (
    observation.attemptCount !== undefined &&
    (!Number.isInteger(observation.attemptCount) || observation.attemptCount < 0)
  ) {
    throw new Error('SignalObservation.attemptCount 必须是非负整数');
  }
  if (observation.status === 'complete') {
    if (
      observation.closePrice === undefined ||
      observation.returnPct === undefined ||
      observation.maxFavorableExcursionPct === undefined ||
      observation.maxAdverseExcursionPct === undefined ||
      observation.observedAt === undefined
    ) {
      throw new Error('complete SignalObservation 必须有完整的后续表现');
    }
  }
};

/** 用 baseline 后第 N 根可用 qfq 日线完成事实观察；样本不足时保持 pending。 */
export const completeSignalObservationFromDailyBars = (
  observation: SignalObservation,
  bars: readonly DailyBar[],
  fetchedAt: Date,
  options: {
    readonly benchmarkBars?: readonly DailyBar[];
  } = {},
): SignalObservation => {
  if (
    observation.status !== 'pending' ||
    observation.baselineAt === undefined ||
    observation.baselinePrice === undefined
  ) {
    return observation;
  }
  if (observation.dueAt !== undefined && fetchedAt < observation.dueAt) return observation;
  const baselineAt = observation.baselineAt;
  const required = SIGNAL_OBSERVATION_HORIZON_DAYS[observation.horizon];
  const window = bars
    .filter((bar) => bar.stockId === observation.stockId && bar.date > baselineAt)
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .slice(0, required);
  if (window.length < required) return observation;
  const target = window.at(-1);
  if (target === undefined) return observation;
  const baseline = observation.baselinePrice;
  const providers = [...new Set(window.map((bar) => bar.source))];
  const benchmarkBars = (options.benchmarkBars ?? [])
    .filter((bar) => bar.stockId === STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID)
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const benchmarkBaseline = benchmarkBars.filter((bar) => bar.date <= baselineAt).at(-1);
  const benchmarkWindow = benchmarkBars.filter((bar) => bar.date > baselineAt).slice(0, required);
  const benchmarkTarget = benchmarkWindow.at(-1);
  const benchmarkReturnPct =
    benchmarkBaseline !== undefined &&
    benchmarkTarget !== undefined &&
    benchmarkWindow.length >= required &&
    benchmarkBaseline.close > 0
      ? (benchmarkTarget.close - benchmarkBaseline.close) / benchmarkBaseline.close
      : undefined;
  const completed: SignalObservation = {
    ...observation,
    closePrice: target.close,
    returnPct: (target.close - baseline) / baseline,
    maxFavorableExcursionPct: (Math.max(...window.map((bar) => bar.high)) - baseline) / baseline,
    maxAdverseExcursionPct: (Math.min(...window.map((bar) => bar.low)) - baseline) / baseline,
    ...(benchmarkReturnPct === undefined
      ? { benchmarkStatus: 'unavailable' as const }
      : { benchmarkReturnPct, benchmarkStatus: 'complete' as const }),
    status: 'complete',
    provenance: {
      provider:
        providers.length === 1 ? (providers[0] ?? 'daily-bar') : `mixed:${providers.join(',')}`,
      observedAt: target.date,
      fetchedAt,
      freshness: 'unknown',
    },
    observedAt: target.date,
    ...(observation.attemptCount === undefined ? {} : { attemptCount: observation.attemptCount }),
  };
  assertSignalObservationInvariants(completed);
  return completed;
};
