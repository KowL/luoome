import type { SignalObservation } from '../entity/signal-observation.js';

export interface SignalObservationStats {
  readonly group: string;
  readonly horizon: SignalObservation['horizon'];
  readonly total: number;
  readonly complete: number;
  readonly uniqueStocks: number;
  readonly missingRate: number;
  readonly observationIds: readonly string[];
  readonly averageReturnPct?: number;
  readonly medianReturnPct?: number;
  readonly p25ReturnPct?: number;
  readonly p75ReturnPct?: number;
  readonly averageBenchmarkReturnPct?: number;
  readonly averageExcessReturnPct?: number;
  readonly averageMaxFavorableExcursionPct?: number;
  readonly averageMaxAdverseExcursionPct?: number;
  readonly observedAsOf?: Date;
}

/**
 * R7 的描述性样本单位：同一股票、同一基准交易日和同一观察周期只保留一个事实。
 * baselineAt 缺失的 unavailable 记录无法可靠解析为 signal-day，因此不参与去重。
 */
export const SIGNAL_OBSERVATION_SAMPLE_UNIT = 'stock-day-horizon' as const;

export const signalObservationSampleKey = (observation: SignalObservation): string | undefined => {
  if (observation.baselineAt === undefined) return undefined;
  const baselineDay = observation.baselineAt.toISOString().slice(0, 10);
  return `${observation.stockId}\0${baselineDay}\0${observation.horizon}`;
};

const observationStatusRank: Record<SignalObservation['status'], number> = {
  unavailable: 0,
  pending: 1,
  complete: 2,
};

/** 按 sample key 选出可审计的代表行；同等级下用 id 保证结果稳定。 */
export const deduplicateSignalObservations = (
  observations: readonly SignalObservation[],
  groupOf: (observation: SignalObservation) => string = () => 'all',
): readonly SignalObservation[] => {
  const representatives = new Map<string, SignalObservation>();
  const unkeyed: SignalObservation[] = [];
  for (const observation of observations) {
    const sampleKey = signalObservationSampleKey(observation);
    if (sampleKey === undefined) {
      unkeyed.push(observation);
      continue;
    }
    const key = `${groupOf(observation)}\0${sampleKey}`;
    const previous = representatives.get(key);
    if (
      previous === undefined ||
      observationStatusRank[observation.status] > observationStatusRank[previous.status] ||
      (observationStatusRank[observation.status] === observationStatusRank[previous.status] &&
        observation.id.localeCompare(previous.id) < 0)
    ) {
      representatives.set(key, observation);
    }
  }
  return [...representatives.values(), ...unkeyed].sort(
    (left, right) =>
      left.horizon.localeCompare(right.horizon) ||
      left.stockId.localeCompare(right.stockId) ||
      (left.baselineAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.baselineAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
};

const average = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile = (values: readonly number[], quantile: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return undefined;
  return lower === upper ? lowerValue : lowerValue + (upperValue - lowerValue) * (position - lower);
};

/** 把事实观察按 horizon + 外部 group 聚合；不把 pending/unavailable 当作 0。 */
export const aggregateSignalObservationStats = (
  observations: readonly SignalObservation[],
  groupOf: (observation: SignalObservation) => string = () => 'all',
): readonly SignalObservationStats[] => {
  const sampledObservations = deduplicateSignalObservations(observations, groupOf);
  const groups = new Map<string, SignalObservation[]>();
  for (const observation of sampledObservations) {
    const key = `${groupOf(observation)}\0${observation.horizon}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const [group = 'all', horizon = 't1'] = key.split('\0');
      const complete = rows.filter((row) => row.status === 'complete');
      const returns = complete.flatMap((row) =>
        row.returnPct === undefined ? [] : [row.returnPct],
      );
      const benchmarks = complete.flatMap((row) =>
        row.benchmarkReturnPct === undefined ? [] : [row.benchmarkReturnPct],
      );
      const excess = complete.flatMap((row) =>
        row.returnPct === undefined || row.benchmarkReturnPct === undefined
          ? []
          : [row.returnPct - row.benchmarkReturnPct],
      );
      const mfe = complete.flatMap((row) =>
        row.maxFavorableExcursionPct === undefined ? [] : [row.maxFavorableExcursionPct],
      );
      const mae = complete.flatMap((row) =>
        row.maxAdverseExcursionPct === undefined ? [] : [row.maxAdverseExcursionPct],
      );
      const observedAsOf = complete.reduce<Date | undefined>(
        (latest, row) =>
          row.observedAt !== undefined && (latest === undefined || row.observedAt > latest)
            ? row.observedAt
            : latest,
        undefined,
      );
      const stats: SignalObservationStats = {
        group,
        horizon: horizon as SignalObservation['horizon'],
        total: rows.length,
        complete: complete.length,
        uniqueStocks: new Set(rows.map((row) => row.stockId)).size,
        missingRate: rows.length === 0 ? 0 : (rows.length - complete.length) / rows.length,
        observationIds: rows.map((row) => row.id).sort(),
      };
      const averageReturnPct = average(returns);
      const medianReturnPct = percentile(returns, 0.5);
      const p25ReturnPct = percentile(returns, 0.25);
      const p75ReturnPct = percentile(returns, 0.75);
      const averageBenchmarkReturnPct = average(benchmarks);
      const averageExcessReturnPct = average(excess);
      const averageMaxFavorableExcursionPct = average(mfe);
      const averageMaxAdverseExcursionPct = average(mae);
      return {
        ...stats,
        ...(averageReturnPct === undefined ? {} : { averageReturnPct }),
        ...(medianReturnPct === undefined ? {} : { medianReturnPct }),
        ...(p25ReturnPct === undefined ? {} : { p25ReturnPct }),
        ...(p75ReturnPct === undefined ? {} : { p75ReturnPct }),
        ...(averageBenchmarkReturnPct === undefined ? {} : { averageBenchmarkReturnPct }),
        ...(averageExcessReturnPct === undefined ? {} : { averageExcessReturnPct }),
        ...(averageMaxFavorableExcursionPct === undefined
          ? {}
          : { averageMaxFavorableExcursionPct }),
        ...(averageMaxAdverseExcursionPct === undefined ? {} : { averageMaxAdverseExcursionPct }),
        ...(observedAsOf === undefined ? {} : { observedAsOf }),
      };
    })
    .sort(
      (left, right) =>
        left.group.localeCompare(right.group) || left.horizon.localeCompare(right.horizon),
    );
};
