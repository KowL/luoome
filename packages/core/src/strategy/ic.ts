// T19 / REQ-M3-13：IC / RankIC 计算层。
//
// 口径（必须与验收复算一致，改动即破坏 1e-6 断言）：
//   - IC   = 当日横截面 score 与**次日**收益的 Pearson 相关；
//   - RankIC = 两者的 Spearman 相关（先取平均秩处理并列，再算 Pearson）；
//   - IR   = mean(RankIC) / std(RankIC)，**样本标准差（n−1）**，**非年化**——
//            25 日样本年化要乘 √252≈15.87，会把 25 天的噪声放大成看起来很确定的数字，
//            这正是本项目一直在防的假精度。口径由 M3a 裁定，不得改为年化或总体标准差；
//   - 正 IC 占比 = RankIC > 0 的天数 / 有效天数。
//
// 三条硬约束（H8 + REQ-M3-13）：
//   1. **按 vintage 分组**：不同 vintage 绝不合并成一个数字；每组各自给样本数。
//      restated 属统计层可用，但必须带口径标注。
//   2. 有效交易日 < 20 → `unavailable`（19 日必须 unavailable）。
//   3. **缺失日不填 0**：只统计真实算得出的日子，缺失日单列 `missingDays` 并给原因。
//      填 0 会让 IC 序列看起来完整而实际是伪造观测。
import type { SignalObservationVintage } from '../entity/signal-observation.js';

/** 有效交易日下限；低于它一律 unavailable。 */
export const STRATEGY_IC_MIN_SAMPLE_DAYS = 20;
/** 单日横截面最少配对数；低于它该日不计入（并列/缺失都会让相关性失真）。 */
export const STRATEGY_IC_MIN_CROSS_SECTION = 3;

export interface StrategyIcDayInput {
  /** 该日横截面（StrategyResult.score）。 */
  readonly dataAsOf: Date;
  /** 该日样本的 vintage；由调用方按观察事实判定，不在此推断。 */
  readonly vintage: SignalObservationVintage;
  readonly scores: readonly { readonly stockId: string; readonly score: number }[];
  /** stockId → **次日**收益（小数，如 0.012 表示 +1.2%）。 */
  readonly nextDayReturns: ReadonlyMap<string, number>;
}

export interface StrategyIcDay {
  readonly dataAsOf: Date;
  readonly sampleSize: number;
  readonly ic: number;
  readonly rankIc: number;
}

export type StrategyIcMissingReason =
  | 'insufficient-cross-section'
  | 'constant-scores'
  | 'missing-next-day-return';

export interface StrategyIcMissingDay {
  readonly dataAsOf: Date;
  readonly reason: StrategyIcMissingReason;
  readonly pairedStocks: number;
}

export interface StrategyIcVintageSummary {
  readonly vintage: SignalObservationVintage;
  readonly status: 'ok' | 'unavailable';
  /** unavailable 的原因；ok 时为 null。 */
  readonly unavailableReason: 'insufficient-sample' | 'no-samples' | null;
  /** 有效交易日下限（便于调用方复算，不在 UI 侧重复常量）。 */
  readonly minSampleDays: number;
  /** 有效天数（真实算得出 IC 的天数）。 */
  readonly sampleDays: number;
  readonly days: readonly StrategyIcDay[];
  /** 缺失日：**不填 0**，逐日给原因。 */
  readonly missingDays: readonly StrategyIcMissingDay[];
  readonly meanIc: number | null;
  readonly meanRankIc: number | null;
  /** 样本标准差（n−1）。 */
  readonly stdRankIc: number | null;
  readonly ir: number | null;
  readonly positiveRatio: number | null;
  readonly limitations: readonly string[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const sampleStd = (values: readonly number[]): number | null => {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const std = Math.sqrt(variance);
  return std === 0 ? null : std;
};

const pearson = (left: readonly number[], right: readonly number[]): number | null => {
  const n = left.length;
  if (n < 2 || n !== right.length) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = (left[index] ?? 0) - leftMean;
    const dy = (right[index] ?? 0) - rightMean;
    covariance += dx * dy;
    leftVariance += dx * dx;
    rightVariance += dy * dy;
  }
  if (leftVariance === 0 || rightVariance === 0) return null;
  return covariance / Math.sqrt(leftVariance * rightVariance);
};

/** 平均秩（并列取平均），升序。 */
export const averageRanks = (values: readonly number[]): number[] => {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array<number>(values.length).fill(0);
  let cursor = 0;
  while (cursor < order.length) {
    let end = cursor;
    while (end + 1 < order.length && order[end + 1]?.value === order[cursor]?.value) end += 1;
    const rank = (cursor + end) / 2 + 1;
    for (let index = cursor; index <= end; index += 1) {
      const target = order[index]?.index;
      if (target !== undefined) ranks[target] = rank;
    }
    cursor = end + 1;
  }
  return ranks;
};

const limitationsFor = (vintage: SignalObservationVintage): readonly string[] => {
  const base = [
    'IC / RankIC 只衡量「评分与次日收益的横截面相关性」，不构成策略历史命中陈述。',
    '收益口径为次日收盘对当日收盘的简单收益；未做复权差异校正、未扣成本。',
    'IR = mean(RankIC) / std(RankIC)，样本标准差（n−1）、**非年化**。',
  ];
  if (vintage === 'restated')
    return [
      ...base,
      '本组 vintage=restated：由回溯轨补算，只能进统计层（IC / 分位 / 换手），不得用于策略历史命中、Advice 证据链或复盘「当时依据」。',
    ];
  if (vintage === 'legacy')
    return [...base, '本组 vintage=legacy：存量兼容数据，不具备前瞻可复现性，仅作历史对照。'];
  return base;
};

/** 单日横截面 → IC / RankIC；数据不足返回缺失原因，不返回 0。 */
export const computeStrategyIcDay = (
  input: StrategyIcDayInput,
): { readonly day: StrategyIcDay } | { readonly missing: StrategyIcMissingDay } => {
  const pairs = input.scores
    .map((item) => ({ score: item.score, ret: input.nextDayReturns.get(item.stockId) }))
    .filter((item): item is { score: number; ret: number } => item.ret !== undefined);
  if (pairs.length < STRATEGY_IC_MIN_CROSS_SECTION)
    return {
      missing: {
        dataAsOf: input.dataAsOf,
        reason: 'insufficient-cross-section',
        pairedStocks: pairs.length,
      },
    };
  const scores = pairs.map((item) => item.score);
  const returns = pairs.map((item) => item.ret);
  const ic = pearson(scores, returns);
  const rankIc = pearson(averageRanks(scores), averageRanks(returns));
  if (ic === null || rankIc === null)
    return {
      missing: {
        dataAsOf: input.dataAsOf,
        reason: 'constant-scores',
        pairedStocks: pairs.length,
      },
    };
  return { day: { dataAsOf: input.dataAsOf, sampleSize: pairs.length, ic, rankIc } };
};

/**
 * 按 vintage 分组计算。**同一 vintage 内才聚合**；不同 vintage 各自一组，
 * 绝不合并成单一数字（H8）。输入里缺某天不补 0——那天直接进 missingDays。
 */
export const computeStrategyIc = (
  inputs: readonly StrategyIcDayInput[],
): readonly StrategyIcVintageSummary[] => {
  const byVintage = new Map<SignalObservationVintage, StrategyIcDayInput[]>();
  for (const input of inputs) {
    const bucket = byVintage.get(input.vintage) ?? [];
    bucket.push(input);
    byVintage.set(input.vintage, bucket);
  }
  const order: readonly SignalObservationVintage[] = ['pit', 'restated', 'legacy'];
  return [...byVintage.entries()]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([vintage, bucket]) => {
      const days: StrategyIcDay[] = [];
      const missingDays: StrategyIcMissingDay[] = [];
      for (const input of [...bucket].sort(
        (left, right) => left.dataAsOf.getTime() - right.dataAsOf.getTime(),
      )) {
        const outcome = computeStrategyIcDay(input);
        if ('day' in outcome) days.push(outcome.day);
        else missingDays.push(outcome.missing);
      }
      const rankIcs = days.map((day) => day.rankIc);
      const sampleDays = days.length;
      const status =
        sampleDays >= STRATEGY_IC_MIN_SAMPLE_DAYS ? ('ok' as const) : ('unavailable' as const);
      const unavailableReason =
        status === 'ok'
          ? null
          : sampleDays === 0
            ? ('no-samples' as const)
            : ('insufficient-sample' as const);
      // 样本不足时**不给汇总数字**：只有逐日原始事实保留（可审计），均值/IR/占比一律 null，
      // 避免调用方把"19 天算出来的均值"当成可用结论。
      const enough = status === 'ok';
      const std = enough ? sampleStd(rankIcs) : null;
      const meanRankIc = enough ? mean(rankIcs) : null;
      const positiveRatio = enough
        ? rankIcs.filter((value) => value > 0).length / sampleDays
        : null;
      return {
        vintage,
        status,
        unavailableReason,
        minSampleDays: STRATEGY_IC_MIN_SAMPLE_DAYS,
        sampleDays,
        days,
        missingDays,
        meanIc: enough ? mean(days.map((day) => day.ic)) : null,
        meanRankIc,
        stdRankIc: std,
        ir: meanRankIc === null || std === null ? null : meanRankIc / std,
        positiveRatio,
        limitations: [
          ...limitationsFor(vintage),
          ...(status === 'unavailable'
            ? [
                `有效交易日 ${sampleDays} < ${STRATEGY_IC_MIN_SAMPLE_DAYS}：样本不足，返回 unavailable，不给数字。`,
              ]
            : []),
          ...(missingDays.length === 0
            ? []
            : [
                `有 ${missingDays.length} 个交易日无法计算（样本不足/评分无方差/缺次日收益），未用 0 填充。`,
              ]),
        ],
      };
    });
};
