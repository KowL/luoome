import { z } from 'zod';

import { DataProvenanceSchema } from './provenance.js';

/** 信号发生后的事实观察；不是回测交易或投资建议。 */
// 'tactic-signal'：旧 Tactic 模型已下线，枚举值为存量 signal_observations 行的读兼容保留。
export const SignalObservationSourceKindSchema = z.enum(['watch-trigger', 'tactic-signal']);
export type SignalObservationSourceKind = z.infer<typeof SignalObservationSourceKindSchema>;

export const SignalObservationHorizonSchema = z.enum(['t1', 't3', 't5', 't20']);
export type SignalObservationHorizon = z.infer<typeof SignalObservationHorizonSchema>;

export const SignalObservationStatusSchema = z.enum(['pending', 'complete', 'unavailable']);
export type SignalObservationStatus = z.infer<typeof SignalObservationStatusSchema>;

export const SignalObservationSchema = z.object({
  id: z.string().min(1),
  sourceKind: SignalObservationSourceKindSchema,
  sourceId: z.string().min(1),
  stockId: z.string().min(1),
  baselinePrice: z.number().positive().optional(),
  baselineAt: z.coerce.date().optional(),
  horizon: SignalObservationHorizonSchema,
  closePrice: z.number().positive().optional(),
  returnPct: z.number().finite().optional(),
  maxFavorableExcursionPct: z.number().finite().optional(),
  maxAdverseExcursionPct: z.number().finite().optional(),
  benchmarkReturnPct: z.number().finite().optional(),
  /** 当前未接入指数日线，必须显式标记而非默默省略。 */
  benchmarkStatus: z.enum(['complete', 'unavailable']).default('unavailable'),
  status: SignalObservationStatusSchema,
  provenance: DataProvenanceSchema,
  unavailableReason: z.string().min(1).max(300).optional(),
  observedAt: z.coerce.date().optional(),
});

export type SignalObservation = z.infer<typeof SignalObservationSchema>;

export const SIGNAL_OBSERVATION_HORIZON_DAYS: Record<SignalObservationHorizon, number> = {
  t1: 1,
  t3: 3,
  t5: 5,
  t20: 20,
};

export const signalObservationId = (
  sourceKind: SignalObservationSourceKind,
  sourceId: string,
  horizon: SignalObservationHorizon,
): string => `signal-observation:${sourceKind}:${sourceId}:${horizon}`;

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
