import {
  type AdviceDecision,
  dateInShanghai,
  STANDARD_DISCLAIMERS,
  type StockBriefMissingDimension,
  type WatchlistMember,
} from '@luoome/core';

import type { StockFactPack } from './stock-facts.js';

/**
 * 每日个股观察的规则预筛（design.md §6.2）。
 *
 * 纯函数：不调 LLM、不落库、不访问网络。只决定「是否进入 LLM 阶段」以及
 * 规则兜底时的确定性观察草稿；预算截断留给后续 workflow。
 */

export type BriefPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type BriefPreScreenAction = 'include' | 'rule-only' | 'unavailable' | 'skip';
export type RuleOnlyDecision = Extract<AdviceDecision, 'hold' | 'watch' | 'avoid'>;

export const DEFAULT_STALE_FACT_DAYS = 3;
export const RULE_ONLY_MAX_CONFIDENCE = 30;
/** 当日策略信号进入 P2 的最低分。 */
export const RULE_INCLUDE_SIGNAL_SCORE = 60;

export interface BriefStrategySignal {
  readonly score: number;
  readonly direction: 'bullish' | 'bearish' | 'neutral';
  /** 缺省视为调用方已筛选为当日信号。 */
  readonly ts?: Date;
}

/** 事实包投影：只保留预筛需要的事实指纹与关键降级。 */
export interface BriefRuleFacts {
  readonly factDigest: string;
  readonly quoteAvailable: boolean;
  readonly barsAvailable: boolean;
  readonly missingDimensions?: readonly StockBriefMissingDimension[];
}

export const briefRuleFactsFromFactPack = (pack: StockFactPack): BriefRuleFacts => ({
  factDigest: pack.factDigest,
  quoteAvailable: pack.quote?.status === 'ok',
  barsAvailable: pack.bars?.status === 'ok',
  missingDimensions: [
    ...(pack.quote?.status === 'unavailable' ? (['quote'] as const) : []),
    ...(pack.bars?.status === 'unavailable' ? (['daily-bars'] as const) : []),
  ],
});

export interface BriefExistingBrief {
  readonly digest: string;
  readonly decision: AdviceDecision;
}

export interface RuleOnlyDraft {
  readonly decision: RuleOnlyDecision;
  readonly confidence: number;
  readonly premise: string;
  readonly evidence: readonly string[];
  readonly disclaimers: readonly string[];
}

export interface BriefPreScreenInput {
  readonly tradingDate: string;
  readonly stockId: string;
  readonly stockName?: string;
  readonly held: boolean;
  readonly watchlistStage?: WatchlistMember['stage'] | null;
  readonly strategySignals?: readonly BriefStrategySignal[];
  readonly facts: BriefRuleFacts;
  readonly existingBrief?: BriefExistingBrief;
  readonly consecutiveNoNewFactDays?: number;
  readonly listingStatus?: 'listed' | 'suspended' | 'delisted';
  /** 连续 N 日无新事实的阈值；默认 3。 */
  readonly staleAfterDays?: number;
}

export interface BriefPreScreenResult {
  readonly stockId: string;
  readonly priority: BriefPriority;
  readonly action: BriefPreScreenAction;
  readonly reason: string;
  readonly factDigest: string;
  readonly ruleOnly?: RuleOnlyDraft;
}

const decisionLabel: Record<RuleOnlyDecision, string> = {
  hold: '中性观察',
  watch: '待确认观察',
  avoid: '回避观察',
};

const isTodaySignal = (signal: BriefStrategySignal, tradingDate: string): boolean =>
  signal.ts === undefined || dateInShanghai(signal.ts) === tradingDate;

const todaySignificantSignals = (input: BriefPreScreenInput): readonly BriefStrategySignal[] =>
  (input.strategySignals ?? []).filter(
    (signal) =>
      Number.isFinite(signal.score) &&
      signal.score >= RULE_INCLUDE_SIGNAL_SCORE &&
      isTodaySignal(signal, input.tradingDate),
  );

const classifyPriority = (
  input: BriefPreScreenInput,
  signals: readonly BriefStrategySignal[],
): BriefPriority => {
  if (input.held) return 'P0';
  if (input.watchlistStage === 'confirmed' || input.watchlistStage === 'researching') return 'P1';
  if (signals.length > 0) return 'P2';
  if (input.watchlistStage === 'watching') return 'P3';
  return 'P4';
};

const decideRuleOnlyDecision = (
  input: BriefPreScreenInput,
  signals: readonly BriefStrategySignal[],
): RuleOnlyDecision => {
  if (input.held) return 'hold';
  if (signals.some((signal) => signal.direction === 'bearish')) return 'avoid';
  if (signals.some((signal) => signal.direction === 'bullish')) return 'watch';
  if (input.watchlistStage === 'watching') return 'watch';
  return 'watch';
};

/**
 * 规则兜底完全确定性：
 * - decision 只用 hold / watch / avoid；confidence ≤ 30；
 * - premise / evidence 带 `isRuleFallbackAdvice` 可识别的规则标记；
 * - disclaimers 包含全部 STANDARD_DISCLAIMERS，措辞只出现「观察」。
 */
export const buildRuleOnlyDraft = (
  input: BriefPreScreenInput,
  signals: readonly BriefStrategySignal[],
): RuleOnlyDraft => {
  const decision = decideRuleOnlyDecision(input, signals);
  const label = decisionLabel[decision];
  const confidence = input.held ? 30 : 20;
  const evidence: string[] = [
    `规则 fallback：LLM 推理不可用，按确定性规则生成${label}`,
    `规则 fallback：事实指纹 ${input.facts.factDigest.slice(0, 12)}`,
  ];
  if (input.held) {
    evidence.push('规则 fallback：账户存在该股票持仓，按中性观察处理');
  }
  if (input.watchlistStage !== undefined && input.watchlistStage !== null) {
    evidence.push(`规则 fallback：关注阶段为 ${input.watchlistStage}，按${label}处理`);
  }
  for (const signal of signals) {
    evidence.push(
      `规则 fallback：当日策略信号 ${signal.direction}，置信分 ${signal.score}，按${label}处理`,
    );
  }
  if (!input.facts.quoteAvailable) {
    evidence.push('规则 fallback：报价事实不可用，未引用价格推断');
  }
  if (!input.facts.barsAvailable) {
    evidence.push('规则 fallback：日线样本不可用，未引用均线或 MACD 推断');
  }
  for (const dimension of input.facts.missingDimensions ?? []) {
    evidence.push(`规则 fallback：${dimension} 数据不可用，未纳入判断`);
  }
  return {
    decision,
    confidence: Math.min(confidence, RULE_ONLY_MAX_CONFIDENCE),
    premise: `${label}：LLM 推理不可用，仅展示确定性规则结果。仅技术研究，不构成投资建议。`,
    evidence,
    disclaimers: [...STANDARD_DISCLAIMERS],
  };
};

const result = (
  input: BriefPreScreenInput,
  priority: BriefPriority,
  action: BriefPreScreenAction,
  reason: string,
  ruleOnly?: RuleOnlyDraft,
): BriefPreScreenResult => ({
  stockId: input.stockId,
  priority,
  action,
  reason,
  factDigest: input.facts.factDigest,
  ...(ruleOnly === undefined ? {} : { ruleOnly }),
});

/**
 * 预筛优先级：
 * P0 持仓 → include；P1 confirmed/researching → include；P2 当日 score≥60 信号 → include；
 * P3 watching → rule-only；P4 其余 → rule-only（报价不可用则 unavailable）。
 * 排除：停牌/退市、同日 digest 未变、连续 N 日无新事实且结论未变。
 */
export const preScreenStockBrief = (input: BriefPreScreenInput): BriefPreScreenResult => {
  const signals = todaySignificantSignals(input);
  const allTodaySignals = (input.strategySignals ?? []).filter((signal) =>
    isTodaySignal(signal, input.tradingDate),
  );
  const priority = classifyPriority(input, signals);

  if (input.listingStatus === 'delisted') {
    return result(input, priority, 'skip', '已退市，排除当日观察');
  }
  if (input.listingStatus === 'suspended') {
    return result(input, priority, 'unavailable', '停牌中，不生成观察');
  }
  if (input.watchlistStage === 'archived') {
    return result(input, priority, 'skip', '关注列表成员已归档，排除当日观察');
  }
  if (input.existingBrief !== undefined && input.existingBrief.digest === input.facts.factDigest) {
    return result(input, priority, 'skip', '同日 factDigest 未变，跳过（0 次 LLM）');
  }
  const staleAfterDays = input.staleAfterDays ?? DEFAULT_STALE_FACT_DAYS;
  if (
    input.existingBrief !== undefined &&
    input.consecutiveNoNewFactDays !== undefined &&
    input.consecutiveNoNewFactDays >= staleAfterDays
  ) {
    return result(
      input,
      priority,
      'skip',
      `连续 ${input.consecutiveNoNewFactDays} 日无新事实且观察结论未变，跳过（0 次 LLM）`,
    );
  }

  if (priority === 'P0') {
    return result(input, priority, 'include', '持仓股票必须覆盖，进入 LLM 阶段');
  }
  if (priority === 'P1') {
    return result(
      input,
      priority,
      'include',
      `关注阶段 ${input.watchlistStage} 在预算内进入 LLM 阶段`,
    );
  }
  if (priority === 'P2') {
    return result(
      input,
      priority,
      'include',
      `当日策略信号达到 ${RULE_INCLUDE_SIGNAL_SCORE} 分，进入 LLM 阶段`,
    );
  }
  if (priority === 'P3') {
    return result(
      input,
      priority,
      'rule-only',
      '关注阶段 watching 一律使用确定性规则观察',
      buildRuleOnlyDraft(input, allTodaySignals),
    );
  }
  if (!input.facts.quoteAvailable) {
    return result(input, priority, 'unavailable', '报价事实不可用，无法形成观察');
  }
  return result(
    input,
    priority,
    'rule-only',
    '其余候选使用确定性规则观察',
    buildRuleOnlyDraft(input, allTodaySignals),
  );
};
