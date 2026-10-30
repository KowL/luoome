// H8（冻结口径，不可协商）：`restated` 三条路径全禁——
//   ① 「策略历史命中」陈述 ② Advice 证据链 ③ DecisionReview 的「当时依据」。
// 只允许统计层（IC / 分位 / 换手）。这里的守卫是**拒绝**而不是静默过滤：
// 静默过滤会让调用方以为拿到的是前瞻样本，那正是 H8 要防的伪证据。
import type { SignalObservation, ToolResult } from '@luoome/core';

export type ObservationStatementSurface =
  | '策略历史命中陈述'
  | 'Advice 证据链'
  | 'DecisionReview 的「当时依据」';

export const RESTATED_BANNED_MESSAGE = (surface: ObservationStatementSurface): string =>
  `restated 观察不得用于${surface}（H8 冻结口径）：回溯轨补算只能进统计层（IC / 分位 / 换手）。请改用 pit 观察，或改用 get_signal_observation_stats 查看统计口径。`;

export const nonPitObservations = (
  rows: readonly SignalObservation[],
): readonly SignalObservation[] => rows.filter((row) => row.vintage !== 'pit');

/** 有任何非 pit 观察进入陈述面就拒绝；返回 null 表示放行。 */
export const rejectNonPitObservations = (
  rows: readonly SignalObservation[],
  surface: ObservationStatementSurface,
): ToolResult<never> | null => {
  const offenders = nonPitObservations(rows);
  if (offenders.length === 0) return null;
  return {
    ok: false,
    error: {
      kind: 'invalid_input',
      message: `${RESTATED_BANNED_MESSAGE(surface)}（本次范围内有 ${String(offenders.length)} 条非 pit 观察）`,
      issues: [],
    },
  };
};
