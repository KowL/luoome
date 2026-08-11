import type { StrategySignal, StrategySignalEmission } from '../entity/strategy.js';
import { isHoliday, isWeekend } from '../trading-calendar.js';

export interface StrategySignalEmissionDecision {
  readonly emit: boolean;
  readonly reason: 'level' | 'rising-edge' | 'cooldown' | 'not-matched';
}

const tradingDaysBetween = (from: Date, to: Date): number => {
  if (to.getTime() <= from.getTime()) return 0;
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1),
  );
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  let days = 0;
  while (cursor.getTime() <= end.getTime()) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

export const decideStrategySignalEmission = (input: {
  readonly emission?: StrategySignalEmission;
  readonly matched: boolean;
  /** 上一 eligible run 的 rule evaluation 是否 matched；edge 不依赖上一条 emitted signal。 */
  readonly previousMatched?: boolean;
  readonly previousSignal?: StrategySignal;
  readonly now: Date;
}): StrategySignalEmissionDecision => {
  if (!input.matched) return { emit: false, reason: 'not-matched' };
  const emission = input.emission ?? { mode: 'level' as const, cooldownTradingDays: 0 };
  if (
    emission.mode === 'edge' &&
    (input.previousMatched === true ||
      (input.previousMatched === undefined && input.previousSignal !== undefined))
  ) {
    return { emit: false, reason: 'rising-edge' };
  }
  if (input.previousSignal !== undefined && emission.cooldownTradingDays > 0) {
    const elapsed = tradingDaysBetween(input.previousSignal.ts, input.now);
    if (elapsed < emission.cooldownTradingDays) {
      return { emit: false, reason: 'cooldown' };
    }
  }
  return { emit: true, reason: emission.mode === 'edge' ? 'rising-edge' : 'level' };
};
