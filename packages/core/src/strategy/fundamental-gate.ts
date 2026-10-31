import type { FundamentalDataGateStatus } from '../context.js';

/**
 * 基本面评分闸的**唯一判定实现**（REQ-M3-09 §4）。
 *
 * 判定维度（全部来自本次运行实际拿到的输入，不看字面常量）：
 * - `providerKind !== 'mock'`：mock/合成事实不构成 evaluation-ready；
 * - `gateStatus === 'operational'` 或 `'evaluation-ready'`：数据源自身声明的闸位；
 * - `status === 'complete'`：引擎本次没有缺样本 / 排除样本；
 * - `resultCount > 0`：真的产出了可消费结果。
 *
 * 返回 `'not-ready'` 时，调用方**不得输出任何评分数字**——数字与闸位必须同时成立，
 * 「算出来再标 not-ready」等于让读者看到假结论（PRD §4 明确禁止）。
 */
export interface FundamentalGateInput {
  readonly providerKind: 'mock' | 'real';
  readonly gateStatus?: FundamentalDataGateStatus;
  readonly status: 'complete' | 'partial' | 'unavailable' | 'committed' | 'started' | 'failed';
  readonly resultCount: number;
}

export type FundamentalGate = 'not-ready' | 'evaluation-ready';

export const fundamentalGate = (input: FundamentalGateInput): FundamentalGate => {
  if (input.providerKind !== 'real') return 'not-ready';
  if (input.gateStatus !== 'operational' && input.gateStatus !== 'evaluation-ready')
    return 'not-ready';
  if (input.status !== 'complete') return 'not-ready';
  return input.resultCount > 0 ? 'evaluation-ready' : 'not-ready';
};

/** gate 为 `not-ready` 时，任何评分数字都不得出现——调用方用它做一次性兜底检查。 */
export const assertGateHidesScores = (
  gate: FundamentalGate,
  scores: readonly (number | undefined)[],
): void => {
  if (gate !== 'not-ready') return;
  const leaked = scores.filter((value) => value !== undefined);
  if (leaked.length > 0) {
    throw new Error(`gate=not-ready 时不得输出评分数字，实际泄漏 ${leaked.length} 个`);
  }
};
