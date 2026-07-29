import type { TechnicalIndicators } from '../entity/indicator-set.js';
import type { Quote } from '../entity/quote.js';
import { assertTacticInvariants, type Tactic, type TacticSignal } from '../entity/tactic.js';
import { evaluateStrategyStock } from '../strategy/evaluator.js';
import { mapLegacyTacticToStrategy } from '../strategy/legacy-mapper.js';

/**
 * 战法运行结果（run_tactic 工具的核心返回）。
 * - `triggered=true`：hit 了 trigger，附带 signal。
 * - `triggered=false`：未命中；可选附 `reason`（"指标缺失" / "trigger false"）。
 *
 * 设计原则：
 *   - 一次 run_tactic 对 (tacticId, stockId) 出一个 signal；hit 才落库。
 *   - DSL 异常不阻塞其它股票；runner 内部 try/catch 转成 triggered=false + reason。
 */

export interface TacticContext {
  /** 行情快照（close / volume / changePct 等）。 */
  readonly quote?: Quote | undefined;
  /** 技术指标快照（来自 compute_indicators 或内部 fetchDailyBars）。 */
  readonly indicators: TechnicalIndicators;
  /** 战法自定义 meta（如 sectorAvgChange3d / recentLimitUp / daysSinceLimitUp）。 */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type TacticRunOutcome =
  | {
      readonly triggered: true;
      readonly signal: TacticSignal;
    }
  | {
      readonly triggered: false;
      readonly reason: 'indicator_missing' | 'trigger_false' | 'dsl_error' | 'score_invalid';
      readonly message?: string;
    };

/**
 * 单只股票 × 单个战法 的运行。
 * 纯函数：context 已经在外面准备好，这里只负责 DSL 解释。
 * 任何 DSL 异常被吞掉并转成 `triggered=false`（让 run_tactic 整体不挂）。
 */
export const runTacticForStock = (
  tactic: Tactic,
  stockId: string,
  ts: Date,
  context: TacticContext,
): TacticRunOutcome => {
  assertTacticInvariants(tactic);
  const mapped = mapLegacyTacticToStrategy(tactic);
  const evaluated = evaluateStrategyStock({
    strategyId: mapped.strategy.id,
    version: mapped.version,
    runId: `legacy-runtime:${tactic.id}`,
    stockId,
    ts,
    dataAsOf: ts,
    context,
  });
  const evaluation = evaluated.result.ruleEvaluations[0];
  const strategySignal = evaluated.signals[0];
  if (strategySignal === undefined) {
    if (evaluation?.status === 'unknown') {
      return {
        triggered: false,
        reason: 'indicator_missing',
        ...(evaluation.error === undefined ? {} : { message: evaluation.error }),
      };
    }
    if (evaluation?.status === 'not-matched') {
      return { triggered: false, reason: 'trigger_false' };
    }
    const message = evaluated.errors.join('; ') || evaluation?.error;
    return {
      triggered: false,
      reason: message?.includes('score') ? 'score_invalid' : 'dsl_error',
      ...(message === undefined ? {} : { message }),
    };
  }

  const signal: TacticSignal = {
    tacticId: tactic.id,
    tacticName: tactic.name,
    tacticTag: tactic.tag,
    stockId,
    ts,
    score: strategySignal.score,
    direction: strategySignal.direction,
    evidence: [...strategySignal.evidence],
    triggerSnapshot: {
      expression: tactic.triggerWhen,
      result: true,
    },
  };

  return { triggered: true, signal };
};

/**
 * 内置战法的 metadata（用户复盘 / list_tactics 用）。
 */
export const BUILTIN_TACTIC_IDS = [
  'breakout-volume',
  'ma-bullish-alignment',
  'pullback-after-limit-up',
  'volume-price-divergence',
  'sector-resonance',
  'early-breakout',
  'bollinger-band',
] as const;

export type BuiltinTacticId = (typeof BUILTIN_TACTIC_IDS)[number];
