import {
  type DataProvenance,
  SIGNAL_OBSERVATION_HORIZON_DAYS,
  type SignalObservation,
  type StrategySignal,
  signalObservationDueAt,
  signalObservationId,
  type WatchTrigger,
} from '@luoome/core';

const horizons = Object.keys(
  SIGNAL_OBSERVATION_HORIZON_DAYS,
) as (keyof typeof SIGNAL_OBSERVATION_HORIZON_DAYS)[];
const pending = (
  sourceKind: SignalObservation['sourceKind'],
  sourceId: string,
  stockId: string,
  baselinePrice: number,
  baselineAt: Date,
  provenance: DataProvenance,
): SignalObservation[] =>
  horizons.map((horizon) => ({
    id: signalObservationId(sourceKind, sourceId, horizon),
    sourceKind,
    sourceId,
    stockId,
    baselinePrice,
    baselineAt,
    horizon,
    status: 'pending',
    benchmarkStatus: 'unavailable',
    dueAt: signalObservationDueAt(baselineAt, horizon),
    attemptCount: 0,
    provenance,
  }));
export const observationsForWatchTrigger = (
  trigger: WatchTrigger,
  provenance: DataProvenance,
): SignalObservation[] =>
  trigger.quote === undefined
    ? horizons.map((horizon) => ({
        id: signalObservationId('watch-trigger', trigger.id, horizon),
        sourceKind: 'watch-trigger' as const,
        sourceId: trigger.id,
        stockId: trigger.stockId,
        horizon,
        status: 'unavailable' as const,
        benchmarkStatus: 'unavailable' as const,
        provenance: {
          ...provenance,
          freshness: 'unavailable' as const,
          errorKind: 'baseline_unavailable',
        },
        unavailableReason: '触发时没有可审计的价格快照',
      }))
    : pending(
        'watch-trigger',
        trigger.id,
        trigger.stockId,
        trigger.quote.close,
        trigger.quote.ts,
        provenance,
      );

export interface StrategySignalBaseline {
  readonly price: number;
  readonly at: Date;
  readonly provider: string;
}

export const observationsForStrategySignal = (
  signal: StrategySignal,
  baseline: StrategySignalBaseline | undefined,
  fetchedAt: Date,
): SignalObservation[] =>
  baseline === undefined
    ? horizons.map((horizon) => ({
        id: signalObservationId('strategy-signal', signal.id, horizon),
        sourceKind: 'strategy-signal' as const,
        sourceId: signal.id,
        stockId: signal.stockId,
        horizon,
        status: 'unavailable' as const,
        benchmarkStatus: 'unavailable' as const,
        provenance: {
          provider: 'strategy-signal',
          observedAt: signal.ts,
          fetchedAt,
          freshness: 'unavailable' as const,
          errorKind: 'baseline_unavailable',
        },
        unavailableReason: '策略信号发生时没有可审计的价格基准',
      }))
    : pending('strategy-signal', signal.id, signal.stockId, baseline.price, baseline.at, {
        provider: baseline.provider,
        observedAt: baseline.at,
        fetchedAt,
        freshness: 'unknown',
      });

export const saveObservationCandidates = async (
  items: readonly SignalObservation[],
  repo: {
    findById(id: string): Promise<SignalObservation | null>;
    save(item: SignalObservation): Promise<void>;
  },
): Promise<void> => {
  for (const item of items) if ((await repo.findById(item.id)) === null) await repo.save(item);
};
