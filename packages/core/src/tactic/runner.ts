import type { TechnicalIndicators } from '../entity/indicator-set.js';
import type { Quote } from '../entity/quote.js';
import { assertTacticInvariants, type Tactic, type TacticSignal } from '../entity/tactic.js';
import { evaluateExpression, interpolate } from './dsl.js';

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
  const dslContext: Record<string, unknown> = {
    quote: context.quote,
    indicators: context.indicators,
    meta: context.meta ?? {},
  };

  // 1) trigger：先 interpolate 把 ${expr} 替换为字面量，再 evaluate 求值
  let triggered: boolean;
  try {
    const triggerSrc = interpolate(tactic.triggerWhen, dslContext);
    triggered = Boolean(evaluateExpression(triggerSrc, dslContext));
  } catch (e) {
    return {
      triggered: false,
      reason: 'dsl_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!triggered) {
    return { triggered: false, reason: 'trigger_false' };
  }

  // 2) score：同理先 interpolate
  let score: number;
  try {
    const scoreSrc = interpolate(tactic.scoreExpression, dslContext);
    const raw = evaluateExpression(scoreSrc, dslContext);
    score = Number(raw);
  } catch (e) {
    return {
      triggered: false,
      reason: 'dsl_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!Number.isFinite(score)) {
    return { triggered: false, reason: 'score_invalid', message: `score=${score}` };
  }
  // 限制 0-100
  score = Math.max(0, Math.min(100, score));

  // 3) evidence：用 interpolate 把 ${} 替换为字符串
  let evidence: string[];
  try {
    evidence = tactic.evidenceTemplate.map((tpl) => interpolate(tpl, dslContext));
  } catch (e) {
    return {
      triggered: false,
      reason: 'dsl_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const signal: TacticSignal = {
    tacticId: tactic.id,
    tacticName: tactic.name,
    tacticTag: tactic.tag,
    stockId,
    ts,
    score,
    direction: tactic.direction,
    evidence,
    triggerSnapshot: {
      expression: tactic.triggerWhen,
      result: triggered,
    },
  };

  return { triggered: true, signal };
};

/**
 * 5 个内置战法的 metadata（用户复盘 / list_tactics 用）。
 */
export const BUILTIN_TACTIC_IDS = [
  'breakout-volume',
  'ma-bullish-alignment',
  'pullback-after-limit-up',
  'volume-price-divergence',
  'sector-resonance',
] as const;

export type BuiltinTacticId = (typeof BUILTIN_TACTIC_IDS)[number];
