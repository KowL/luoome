import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  type ActiveSignalObservationHorizon,
  deduplicateSignalObservations,
  type SignalObservation,
  type StrategyRun,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';

const SOURCE_ID_CHUNK_SIZE = 400;
const DEFAULT_MAX_OBSERVATIONS = 5_000;

export interface StrategyObservationEvidenceLink {
  readonly observationId: string;
  readonly signalId: string;
  readonly runId: string;
  readonly stockId: string;
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly horizon: ActiveSignalObservationHorizon;
}

export interface StrategyObservationMissing {
  readonly sampleKey: string;
  readonly signalId: string;
  readonly runId: string;
  readonly stockId: string;
  readonly horizon: ActiveSignalObservationHorizon;
}

export type StrategyObservationEvidenceHorizonCounts = Record<
  ActiveSignalObservationHorizon,
  number
>;

export interface StrategyObservationEvidence {
  /** 通过 run/signal 关联校验后的全部 StrategySignal。 */
  readonly signals: readonly StrategySignal[];
  /** 通过 source/stock/horizon 校验并按 stock-day-horizon 去重后的样本，可能受 maxObservations 截断。 */
  readonly observations: readonly SignalObservation[];
  /** observations 的显式别名，便于调用方表达“统计样本”语义。 */
  readonly sampledObservations: readonly SignalObservation[];
  /** 通过关联校验的原始行；调用方按单个 run/cycle 展开关系时使用。 */
  readonly rawObservations: readonly SignalObservation[];
  /** 每条代表样本对应的 run→signal→observation 关系。 */
  readonly observationLinks: readonly StrategyObservationEvidenceLink[];
  /** 预期的 signal-day-horizon 样本数。 */
  readonly expectedByHorizon: StrategyObservationEvidenceHorizonCounts;
  /** 没有对应 observation 的预期样本数。 */
  readonly missingByHorizon: StrategyObservationEvidenceHorizonCounts;
  readonly missing: readonly StrategyObservationMissing[];
  readonly requestedSignalCount: number;
  readonly matchedSignalCount: number;
  /** 通过关系校验的原始 observation 行数（去重前、截断前）。 */
  readonly rawObservationCount: number;
  /** 去重后的样本数（截断前）。 */
  readonly sampledObservationCount: number;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface CollectStrategyObservationEvidenceInput {
  readonly ctx: ToolContext;
  /** 提供 runs 时由仓储批量读取其 signals，并再次校验 signal 的 run/strategy/version 归属。 */
  readonly runs?: readonly StrategyRun[];
  /** 已由调用方取得的 signals；适合 StrategyInsight 已按 strategy 读取的信号。 */
  readonly signals?: readonly StrategySignal[];
  /** 提供 source id 时由仓储一次批量读取 signals，避免按股票查询和 500 条静默截断。 */
  readonly signalIds?: readonly string[];
  readonly strategyId?: string;
  readonly strategyVersionId?: string;
  readonly horizons?: readonly ActiveSignalObservationHorizon[];
  readonly maxObservations?: number;
  readonly sourceLabel?: string;
}

const emptyHorizonCounts = (): StrategyObservationEvidenceHorizonCounts => ({
  t1: 0,
  t3: 0,
  t5: 0,
});

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const dayKey = (value: Date): string => value.toISOString().slice(0, 10);

const signalSampleKey = (signal: StrategySignal, horizon: ActiveSignalObservationHorizon): string =>
  `${signal.stockId}\0${dayKey(signal.ts)}\0${horizon}`;

const observationSampleKey = (observation: SignalObservation): string | undefined =>
  observation.baselineAt === undefined
    ? undefined
    : `${observation.stockId}\0${dayKey(observation.baselineAt)}\0${observation.horizon}`;

const sortSignals = (signals: readonly StrategySignal[]): StrategySignal[] =>
  [...signals].sort(
    (left, right) =>
      right.ts.getTime() - left.ts.getTime() ||
      right.runId.localeCompare(left.runId) ||
      right.id.localeCompare(left.id),
  );

const sortMissing = (
  missing: readonly StrategyObservationMissing[],
): StrategyObservationMissing[] =>
  [...missing].sort(
    (left, right) =>
      left.horizon.localeCompare(right.horizon) ||
      left.sampleKey.localeCompare(right.sampleKey) ||
      left.signalId.localeCompare(right.signalId),
  );

const addLimitation = (limitations: string[], seen: Set<string>, message: string): void => {
  if (seen.has(message)) return;
  seen.add(message);
  limitations.push(message);
};

const resolveSignals = async (
  input: CollectStrategyObservationEvidenceInput,
): Promise<{
  readonly signals: readonly StrategySignal[];
  readonly requestedSignalCount: number;
}> => {
  if (input.runs !== undefined) {
    const runIds = unique(input.runs.map((run) => run.id));
    const signals = await input.ctx.repos.strategyRun.signalsByRuns(runIds);
    return {
      signals,
      requestedSignalCount: signals.length,
    };
  }
  if (input.signalIds !== undefined) {
    const signalIds = unique(input.signalIds);
    return {
      signals: await input.ctx.repos.strategyRun.signalsByIds(signalIds),
      requestedSignalCount: signalIds.length,
    };
  }
  return {
    signals: input.signals ?? [],
    requestedSignalCount: input.signals?.length ?? 0,
  };
};

/**
 * Strategy 事实链的唯一读取 seam：统一取得 signals、分块读取 observations、校验归属、
 * 按 stock-day-horizon 选代表样本，并显式给出预期缺失和截断状态。
 *
 * 统计数值仍由 core 的纯函数负责；本 Module 只隐藏跨仓储关联和读取完整性。
 */
export const collectStrategyObservationEvidence = async (
  input: CollectStrategyObservationEvidenceInput,
): Promise<StrategyObservationEvidence> => {
  const horizons = ACTIVE_SIGNAL_OBSERVATION_HORIZONS.filter((horizon) =>
    (input.horizons ?? ACTIVE_SIGNAL_OBSERVATION_HORIZONS).includes(horizon),
  );
  const limitations: string[] = [];
  const limitationSet = new Set<string>();
  const sourceLabel = input.sourceLabel ?? 'Strategy';
  const { signals: loadedSignals, requestedSignalCount } = await resolveSignals(input);
  const runById = new Map((input.runs ?? []).map((run) => [run.id, run] as const));
  const requestedIds = input.signalIds === undefined ? undefined : new Set(input.signalIds);
  const seenSignalIds = new Set<string>();
  const signals: StrategySignal[] = [];

  for (const signal of loadedSignals) {
    if (seenSignalIds.has(signal.id)) continue;
    seenSignalIds.add(signal.id);
    if (requestedIds !== undefined && !requestedIds.has(signal.id)) continue;
    const run = runById.get(signal.runId);
    if (input.runs !== undefined && run === undefined) {
      addLimitation(
        limitations,
        limitationSet,
        `${sourceLabel} signal ${signal.id} 的 runId=${signal.runId} 不在请求的 runs 中，已跳过。`,
      );
      continue;
    }
    if (
      run !== undefined &&
      (signal.strategyId !== run.strategyId || signal.strategyVersionId !== run.strategyVersionId)
    ) {
      addLimitation(
        limitations,
        limitationSet,
        `${sourceLabel} signal ${signal.id} 与 StrategyRun ${run.id} 的 strategy/version 不一致，已跳过。`,
      );
      continue;
    }
    if (input.strategyId !== undefined && signal.strategyId !== input.strategyId) {
      addLimitation(
        limitations,
        limitationSet,
        `${sourceLabel} signal ${signal.id} 不属于 strategyId=${input.strategyId}，已跳过。`,
      );
      continue;
    }
    if (
      input.strategyVersionId !== undefined &&
      signal.strategyVersionId !== input.strategyVersionId
    ) {
      addLimitation(
        limitations,
        limitationSet,
        `${sourceLabel} signal ${signal.id} 不属于 strategyVersionId=${input.strategyVersionId}，已跳过。`,
      );
      continue;
    }
    signals.push(signal);
  }
  const sortedSignals = sortSignals(signals);
  if (requestedIds !== undefined) {
    const matchedIds = new Set(signals.map((signal) => signal.id));
    const missingSignalIds = [...requestedIds].filter((id) => !matchedIds.has(id));
    if (missingSignalIds.length > 0) {
      addLimitation(
        limitations,
        limitationSet,
        `${sourceLabel} 有 ${missingSignalIds.length} 个 signal id 无法解析，关联结果可能不完整。`,
      );
    }
  }
  if (horizons.length === 0) {
    return {
      signals: sortedSignals,
      observations: [],
      sampledObservations: [],
      rawObservations: [],
      observationLinks: [],
      expectedByHorizon: emptyHorizonCounts(),
      missingByHorizon: emptyHorizonCounts(),
      missing: [],
      requestedSignalCount,
      matchedSignalCount: sortedSignals.length,
      rawObservationCount: 0,
      sampledObservationCount: 0,
      truncated: false,
      limitations,
    };
  }

  addLimitation(
    limitations,
    limitationSet,
    'StrategyObservationEvidence 仅读取 ACTIVE T+1/T+3/T+5；存量 T+20 不进入当前关联或统计。',
  );

  const signalById = new Map(sortedSignals.map((signal) => [signal.id, signal] as const));
  const sourceIds = unique(sortedSignals.map((signal) => signal.id)).sort();
  const validRowsById = new Map<string, SignalObservation>();
  for (let offset = 0; offset < sourceIds.length; offset += SOURCE_ID_CHUNK_SIZE) {
    const sourceIdChunk = sourceIds.slice(offset, offset + SOURCE_ID_CHUNK_SIZE);
    const rows = await input.ctx.repos.signalObservation.listBySources({
      sourceKind: 'strategy-signal',
      sourceIds: sourceIdChunk,
      horizons,
    });
    const sourceIdSet = new Set(sourceIdChunk);
    for (const row of rows) {
      if (
        row.sourceKind !== 'strategy-signal' ||
        !sourceIdSet.has(row.sourceId) ||
        !horizons.includes(row.horizon as ActiveSignalObservationHorizon)
      ) {
        addLimitation(
          limitations,
          limitationSet,
          `${sourceLabel} observation ${row.id} 不属于当前 ACTIVE signal 来源或周期，已跳过。`,
        );
        continue;
      }
      const signal = signalById.get(row.sourceId);
      if (signal === undefined) continue;
      if (row.stockId !== signal.stockId) {
        addLimitation(
          limitations,
          limitationSet,
          `SignalObservation ${row.id} 的 stockId=${row.stockId} 与 StrategySignal ${row.sourceId} 的 stockId=${signal.stockId} 不一致，已跳过。`,
        );
        continue;
      }
      validRowsById.set(row.id, row);
    }
  }

  const rawRows = [...validRowsById.values()];
  const allSampled = deduplicateSignalObservations(rawRows);
  const maxObservations = Math.max(1, input.maxObservations ?? DEFAULT_MAX_OBSERVATIONS);
  const truncated = allSampled.length > maxObservations;
  const sampledObservations = allSampled.slice(0, maxObservations);
  if (truncated) {
    addLimitation(
      limitations,
      limitationSet,
      `SignalObservation 去重后有 ${allSampled.length} 个样本，仅返回前 ${maxObservations} 个；结果已截断，需分段查询。`,
    );
  }
  if (sourceIds.length > 0 && rawRows.length === 0) {
    addLimitation(
      limitations,
      limitationSet,
      `${sourceLabel} runs 有 StrategySignal，但当前 ACTIVE T+1/T+3/T+5 没有 observation 事实；这不是 0 收益。`,
    );
  }

  const observedSampleKeys = new Set<string>();
  for (const row of rawRows) {
    const key = observationSampleKey(row);
    if (key !== undefined) observedSampleKeys.add(key);
  }
  const expectedByHorizon = emptyHorizonCounts();
  const missingByHorizon = emptyHorizonCounts();
  const missing: StrategyObservationMissing[] = [];
  const representativeSignalByKey = new Map<string, StrategySignal>();
  for (const signal of sortedSignals) {
    for (const horizon of horizons) {
      const key = signalSampleKey(signal, horizon);
      if (representativeSignalByKey.has(key)) continue;
      representativeSignalByKey.set(key, signal);
      expectedByHorizon[horizon] += 1;
      if (observedSampleKeys.has(key)) continue;
      missingByHorizon[horizon] += 1;
      missing.push({
        sampleKey: key,
        signalId: signal.id,
        runId: signal.runId,
        stockId: signal.stockId,
        horizon,
      });
    }
  }
  if (missing.length > 0) {
    addLimitation(
      limitations,
      limitationSet,
      `${sourceLabel} 预期的 ${missing.length} 个 signal-day-horizon 没有可关联 observation；计入 missing，不按 0 收益。`,
    );
  }

  const observationLinks = sampledObservations
    .flatMap((observation): StrategyObservationEvidenceLink[] => {
      const signal = signalById.get(observation.sourceId);
      if (signal === undefined) return [];
      return [
        {
          observationId: observation.id,
          signalId: signal.id,
          runId: signal.runId,
          stockId: signal.stockId,
          strategyId: signal.strategyId,
          strategyVersionId: signal.strategyVersionId,
          horizon: observation.horizon as ActiveSignalObservationHorizon,
        },
      ];
    })
    .sort((left, right) => left.observationId.localeCompare(right.observationId));

  return {
    signals: sortedSignals,
    observations: sampledObservations,
    sampledObservations,
    rawObservations: rawRows,
    observationLinks,
    expectedByHorizon,
    missingByHorizon,
    missing: sortMissing(missing),
    requestedSignalCount,
    matchedSignalCount: sortedSignals.length,
    rawObservationCount: rawRows.length,
    sampledObservationCount: allSampled.length,
    truncated,
    limitations,
  };
};
