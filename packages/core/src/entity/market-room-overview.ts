import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { dateInShanghai, isHoliday, isWeekend, previousTradingDate } from '../trading-calendar.js';
import { type AShareSentimentSnapshot, EvidenceDimensionStatusSchema } from './ashare-sentiment.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import { type IndexQuote, IndexQuoteSchema } from './quote.js';
import { MarketCoverageSchema } from './stock-universe.js';

/**
 * 市场作战室总览（ticket #36）：把最近一个已发布批次的覆盖、宽度、量能与既有情绪契约
 * 组合成一屏可核对的事实。
 *
 * - 全部数值由已发布批次 items、既有情绪维度与指数行情派生，不重新采集；
 * - 每个维度独立标注 complete / partial / unavailable，非 complete 必须给出缺失原因；
 * - 缺样本、缺字段只写缺失，不写 0；不可比时不做放量 / 缩量结论；
 * - 非交易日与盘前返回空态，不把上一交易日数据当作当日盘面。
 */

/** 昨日同时点对比容差：小于一个批次间隔，避免用相邻时点冒充同一时刻。 */
export const MARKET_ROOM_COMPARE_TOLERANCE_MS = 60_000;

/** 指数与个股宽度对照使用的基准指数（上证指数，与 index-defs.js 同码）。 */
export const MARKET_ROOM_BENCHMARK_INDEX_CODE = '000001';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const MarketRoomEmptyReasonSchema = z.enum([
  'no_batch',
  'pre_open',
  'non_trading_day',
  'no_today_batch',
]);
export type MarketRoomEmptyReason = z.infer<typeof MarketRoomEmptyReasonSchema>;

const dimensionBase = {
  status: EvidenceDimensionStatusSchema,
  warnings: z.array(z.string()),
};

export const MarketRoomCoverageSchema = z.object({
  ...dimensionBase,
  value: z
    .object({
      coverage: MarketCoverageSchema,
      source: z.string().min(1),
      tradingDate: dateString,
      sampledAt: z.coerce.date(),
      fetchedAt: z.coerce.date(),
      observedAt: z.coerce.date().optional(),
      dataAsOf: z.coerce.date().optional(),
      expectedCount: z.number().int().nonnegative(),
      receivedCount: z.number().int().nonnegative(),
      missingCount: z.number().int().nonnegative(),
      duplicateCount: z.number().int().nonnegative(),
      complete: z.boolean(),
      gaps: z.array(z.string()),
    })
    .optional(),
});
export type MarketRoomCoverage = z.infer<typeof MarketRoomCoverageSchema>;

export const MarketRoomDivergenceSchema = z.object({
  indexCode: z.string().min(1),
  indexName: z.string().min(1),
  indexChangePct: z.number().finite(),
  medianChangePct: z.number().finite(),
  /** 指数涨跌方向与个股涨幅中位数方向相反。 */
  divergent: z.boolean(),
});
export type MarketRoomDivergence = z.infer<typeof MarketRoomDivergenceSchema>;

export const MarketRoomBreadthSchema = z.object({
  ...dimensionBase,
  value: z
    .object({
      advancing: z.number().int().nonnegative(),
      declining: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      /** 参与涨跌平分类的样本数（有 changePct 的条目）。 */
      classifiedCount: z.number().int().nonnegative(),
      /** 缺 changePct、已从分类与中位数中排除的条目数。 */
      missingChangePctCount: z.number().int().nonnegative(),
      /** 批次实收条目数。 */
      sampleCount: z.number().int().nonnegative(),
      /** 批次期望条目数（覆盖口径分母）。 */
      expectedCount: z.number().int().nonnegative(),
      medianChangePct: z.number().finite().nullable(),
      divergence: MarketRoomDivergenceSchema.optional(),
    })
    .optional(),
});
export type MarketRoomBreadth = z.infer<typeof MarketRoomBreadthSchema>;

export const MarketRoomAmountSchema = z.object({
  ...dimensionBase,
  value: z
    .object({
      /** 当日累计成交额（元，样本内合计）；样本缺失时不是全市场口径。 */
      currentAmount: z.number().nonnegative(),
      currentSampleCount: z.number().int().nonnegative(),
      currentMissingAmountCount: z.number().int().nonnegative(),
      currentTotalCount: z.number().int().nonnegative(),
      comparison: z
        .object({
          previousTradingDate: dateString,
          previousSampledAt: z.coerce.date(),
          previousAmount: z.number().nonnegative(),
          previousSampleCount: z.number().int().nonnegative(),
          deltaAmount: z.number(),
          deltaPct: z.number(),
          verdict: z.enum(['expanded', 'contracted', 'flat']),
        })
        .optional(),
    })
    .optional(),
});
export type MarketRoomAmount = z.infer<typeof MarketRoomAmountSchema>;

export const MarketRoomLimitUpSchema = z.object({
  ...dimensionBase,
  value: z
    .object({
      sealedCount: z.number().int().nonnegative(),
      brokenCount: z.number().int().nonnegative(),
      maxLadderLevel: z.number().int().nonnegative(),
    })
    .optional(),
});
export type MarketRoomLimitUp = z.infer<typeof MarketRoomLimitUpSchema>;

export const MarketRoomIndexesSchema = z.object({
  ...dimensionBase,
  value: z
    .object({
      values: z.array(IndexQuoteSchema).min(1),
      /** 因行情日期不是目标交易日而被排除的条数。 */
      excludedCount: z.number().int().nonnegative(),
    })
    .optional(),
});
export type MarketRoomIndexes = z.infer<typeof MarketRoomIndexesSchema>;

export const MarketRoomOverviewSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: MarketRoomEmptyReasonSchema.optional(),
  /** 今日（Asia/Shanghai）。 */
  tradingDate: dateString,
  /** 最近已发布批次的时间锚点；没有任何批次时为 null。 */
  latestBatch: z.object({ tradingDate: dateString, sampledAt: z.coerce.date() }).nullable(),
  coverage: MarketRoomCoverageSchema,
  breadth: MarketRoomBreadthSchema,
  amount: MarketRoomAmountSchema,
  limitUp: MarketRoomLimitUpSchema,
  indexes: MarketRoomIndexesSchema,
});
export type MarketRoomOverview = z.infer<typeof MarketRoomOverviewSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const shanghaiMinutes = (date: Date): number => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/** 把采样时刻搬到目标交易日的同一上海时刻（A 股无夏令时，墙上时间可直接复用）。 */
export const sameTimeOfDayOn = (tradingDate: string, sampledAt: Date): Date => {
  const shifted = new Date(sampledAt.getTime() + 8 * 60 * 60 * 1000);
  const time = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(
    shifted.getUTCMinutes(),
  ).padStart(2, '0')}:${String(shifted.getUTCSeconds()).padStart(2, '0')}.${String(
    shifted.getUTCMilliseconds(),
  ).padStart(3, '0')}`;
  return new Date(`${tradingDate}T${time}+08:00`);
};

/** 昨日同时点对比基准：上一交易日 + 同一上海时刻（repo 按容差查这一时点的批次）。 */
export const marketRoomCompareTarget = (
  sampledAt: Date,
): { readonly tradingDate: string; readonly sampledAt: Date } => {
  const tradingDate = previousTradingDate(sampledAt);
  return { tradingDate, sampledAt: sameTimeOfDayOn(tradingDate, sampledAt) };
};

/**
 * 空态判定：只有当日已发布批次才能代表当前盘面。
 * 无批次 / 非交易日 / 盘前 / 交易日但当日尚无批次，分别给出明确原因。
 */
export const marketRoomEmptyReason = (
  now: Date,
  latest: MarketSnapshotBatch | null,
): MarketRoomEmptyReason | null => {
  if (latest === null) return 'no_batch';
  if (latest.tradingDate === dateInShanghai(now)) return null;
  if (isWeekend(now) || isHoliday(now)) return 'non_trading_day';
  return shanghaiMinutes(now) < 9 * 60 + 30 ? 'pre_open' : 'no_today_batch';
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  if (sorted.length % 2 === 1) return round4(upper);
  const lower = sorted[middle - 1] as number;
  return round4((lower + upper) / 2);
};

export const buildMarketRoomCoverage = (batch: MarketSnapshotBatch): MarketRoomCoverage => {
  const { completeness } = batch;
  const warnings = [...batch.gaps];
  if (!completeness.complete && warnings.length === 0) {
    warnings.push(
      `incomplete_batch: 期望 ${completeness.expectedCount} 只，实收 ${completeness.receivedCount} 只`,
    );
  }
  return {
    status: completeness.complete ? 'complete' : 'partial',
    warnings,
    value: {
      coverage: batch.coverage,
      source: batch.source,
      tradingDate: batch.tradingDate,
      sampledAt: batch.sampledAt,
      fetchedAt: batch.fetchedAt,
      ...(batch.observedAt === undefined ? {} : { observedAt: batch.observedAt }),
      ...(batch.dataAsOf === undefined ? {} : { dataAsOf: batch.dataAsOf }),
      expectedCount: completeness.expectedCount,
      receivedCount: completeness.receivedCount,
      missingCount: completeness.missingCount,
      duplicateCount: completeness.duplicateCount,
      complete: completeness.complete,
      gaps: [...batch.gaps],
    },
  };
};

export const buildMarketRoomBreadth = (input: {
  readonly batch: MarketSnapshotBatch;
  readonly benchmark?: {
    readonly code: string;
    readonly name: string;
    readonly changePct: number;
  } | null;
}): MarketRoomBreadth => {
  const { batch } = input;
  const changePcts = batch.items.flatMap((entry) =>
    entry.changePct === undefined ? [] : [entry.changePct],
  );
  const missingChangePctCount = batch.items.length - changePcts.length;
  const warnings: string[] = [];
  if (missingChangePctCount > 0) {
    warnings.push(
      `missing_change_pct: ${missingChangePctCount} 只缺涨幅，已从涨跌平与中位数中排除`,
    );
  }
  if (!batch.completeness.complete) {
    warnings.push(
      `incomplete_batch: 期望 ${batch.completeness.expectedCount} 只，实收 ${batch.completeness.receivedCount} 只`,
    );
  }
  if (changePcts.length === 0) {
    return {
      status: 'unavailable',
      warnings: warnings.length === 0 ? ['missing_change_pct: 批次没有可用涨幅样本'] : warnings,
    };
  }

  const advancing = changePcts.filter((value) => value > 0).length;
  const declining = changePcts.filter((value) => value < 0).length;
  const unchanged = changePcts.filter((value) => value === 0).length;
  const medianChangePct = median(changePcts);
  const benchmark = input.benchmark ?? null;
  const divergence: MarketRoomDivergence | undefined =
    benchmark === null || medianChangePct === null
      ? undefined
      : {
          indexCode: benchmark.code,
          indexName: benchmark.name,
          indexChangePct: benchmark.changePct,
          medianChangePct,
          divergent:
            (benchmark.changePct > 0 && medianChangePct < 0) ||
            (benchmark.changePct < 0 && medianChangePct > 0),
        };

  return {
    status: warnings.length === 0 ? 'complete' : 'partial',
    warnings,
    value: {
      advancing,
      declining,
      unchanged,
      classifiedCount: changePcts.length,
      missingChangePctCount,
      sampleCount: batch.items.length,
      expectedCount: batch.completeness.expectedCount,
      medianChangePct,
      ...(divergence === undefined ? {} : { divergence }),
    },
  };
};

const sumAmounts = (batch: MarketSnapshotBatch): { total: number; sampleCount: number } => {
  const amounts = batch.items.flatMap((entry) =>
    entry.amount === undefined ? [] : [entry.amount],
  );
  return { total: amounts.reduce((sum, value) => sum + value, 0), sampleCount: amounts.length };
};

const sameTimeOfDayLabel = (date: Date): string => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(
    shifted.getUTCMinutes(),
  ).padStart(2, '0')}`;
};

const incompleteReason = (label: string, batch: MarketSnapshotBatch): string =>
  `${label}_incomplete: 期望 ${batch.completeness.expectedCount} 只，实收 ${batch.completeness.receivedCount} 只`;

export const buildMarketRoomAmount = (input: {
  readonly current: MarketSnapshotBatch;
  readonly previous: MarketSnapshotBatch | null;
}): MarketRoomAmount => {
  const { current, previous } = input;
  const currentSum = sumAmounts(current);
  const currentMissingAmountCount = current.items.length - currentSum.sampleCount;
  const warnings: string[] = [];
  if (currentMissingAmountCount > 0) {
    warnings.push(
      `missing_amount: ${currentMissingAmountCount} 只缺成交额，累计成交额偏低，不是全市场口径`,
    );
  }
  if (currentSum.sampleCount === 0) {
    return {
      status: 'unavailable',
      warnings: warnings.length === 0 ? ['missing_amount: 批次没有可用成交额样本'] : warnings,
    };
  }
  const value = {
    currentAmount: round2(currentSum.total),
    currentSampleCount: currentSum.sampleCount,
    currentMissingAmountCount,
    currentTotalCount: current.items.length,
  };

  if (previous === null) {
    const target = marketRoomCompareTarget(current.sampledAt);
    return {
      status: 'partial',
      warnings: [
        ...warnings,
        `missing_previous_batch: 缺少 ${target.tradingDate} ${sameTimeOfDayLabel(target.sampledAt)} 的已发布批次，不做昨日同时点对比`,
      ],
      value,
    };
  }

  const previousSum = sumAmounts(previous);
  const previousMissingAmountCount = previous.items.length - previousSum.sampleCount;
  const reasons: string[] = [];
  if (current.coverage !== previous.coverage) {
    reasons.push(`coverage_mismatch: ${current.coverage} vs ${previous.coverage}`);
  }
  if (!current.completeness.complete) reasons.push(incompleteReason('current', current));
  if (!previous.completeness.complete) reasons.push(incompleteReason('previous', previous));
  if (currentMissingAmountCount > 0) {
    reasons.push(`current_missing_amount: ${currentMissingAmountCount} 只缺成交额`);
  }
  if (previousMissingAmountCount > 0) {
    reasons.push(`previous_missing_amount: ${previousMissingAmountCount} 只缺成交额`);
  }
  if (previousSum.total <= 0) {
    reasons.push('previous_amount_zero: 上一时点累计成交额为 0，无法计算变化');
  }
  if (reasons.length > 0) {
    return { status: 'partial', warnings: [...warnings, ...reasons], value };
  }

  const deltaAmount = round2(currentSum.total - previousSum.total);
  return {
    status: 'complete',
    warnings,
    value: {
      ...value,
      comparison: {
        previousTradingDate: previous.tradingDate,
        previousSampledAt: previous.sampledAt,
        previousAmount: round2(previousSum.total),
        previousSampleCount: previousSum.sampleCount,
        deltaAmount,
        deltaPct: round2((deltaAmount / previousSum.total) * 100),
        verdict: deltaAmount > 0 ? 'expanded' : deltaAmount < 0 ? 'contracted' : 'flat',
      },
    },
  };
};

export const buildMarketRoomLimitUp = (input: {
  readonly dimension: AShareSentimentSnapshot['limitUp'] | null;
  readonly error: string | null;
}): MarketRoomLimitUp => {
  const { dimension } = input;
  if (dimension === null) {
    return { status: 'unavailable', warnings: [`limit_up_failed: ${input.error ?? 'unknown'}`] };
  }
  const value =
    dimension.value === undefined
      ? undefined
      : {
          sealedCount: dimension.value.sealedCount,
          brokenCount: dimension.value.brokenCount,
          maxLadderLevel: dimension.value.maxLadderLevel,
        };
  const status =
    dimension.status === 'complete' && value === undefined ? 'unavailable' : dimension.status;
  const warnings =
    dimension.warnings.length > 0
      ? [...dimension.warnings]
      : status === 'complete'
        ? []
        : [`${status}: 情绪维度未给出原因`];
  return {
    status,
    warnings,
    ...(value === undefined ? {} : { value }),
  };
};

export const buildMarketRoomIndexes = (input: {
  readonly tradingDate: string;
  readonly quotes: readonly IndexQuote[] | null;
  readonly error: string | null;
}): MarketRoomIndexes => {
  if (input.quotes === null) {
    return {
      status: 'unavailable',
      warnings: [`index_quotes_failed: ${input.error ?? 'unknown'}`],
    };
  }
  const values = input.quotes.filter((entry) => dateInShanghai(entry.ts) === input.tradingDate);
  if (values.length === 0) {
    return {
      status: 'unavailable',
      warnings: [
        input.quotes.length === 0
          ? 'index_quotes_empty: 指数行情为空'
          : `index_quotes_stale: 指数行情日期不是 ${input.tradingDate}`,
      ],
    };
  }
  const excludedCount = input.quotes.length - values.length;
  return {
    status: excludedCount === 0 ? 'complete' : 'partial',
    warnings:
      excludedCount === 0
        ? []
        : [`index_quotes_filtered: 已排除 ${excludedCount} 条非 ${input.tradingDate} 指数行情`],
    value: { values: [...values], excludedCount },
  };
};

const EMPTY_REASON_TEXT: Readonly<Record<MarketRoomEmptyReason, string>> = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
};

const emptyDimension = (reason: MarketRoomEmptyReason) => ({
  status: 'unavailable' as const,
  warnings: [`${reason}: ${EMPTY_REASON_TEXT[reason]}`],
});

/** 空态概览：只保留「最近批次是什么时候」，五个维度全部 unavailable 并带同一原因。 */
export const buildMarketRoomEmptyOverview = (input: {
  readonly now: Date;
  readonly latest: MarketSnapshotBatch | null;
  readonly reason: MarketRoomEmptyReason;
}): MarketRoomOverview => {
  if (marketRoomEmptyReason(input.now, input.latest) !== input.reason) {
    throw new InvariantError('market room 空态原因与批次状态不一致');
  }
  const parsed = MarketRoomOverviewSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    tradingDate: dateInShanghai(input.now),
    latestBatch:
      input.latest === null
        ? null
        : { tradingDate: input.latest.tradingDate, sampledAt: input.latest.sampledAt },
    coverage: emptyDimension(input.reason),
    breadth: emptyDimension(input.reason),
    amount: emptyDimension(input.reason),
    limitUp: emptyDimension(input.reason),
    indexes: emptyDimension(input.reason),
  });
  assertMarketRoomOverviewInvariants(parsed);
  return parsed;
};

/** ready 概览：组合覆盖、宽度、量能、情绪与指数；各维度独立降级。 */
export const buildMarketRoomOverview = (input: {
  readonly now: Date;
  readonly latest: MarketSnapshotBatch;
  readonly previous: MarketSnapshotBatch | null;
  readonly indexQuotes: readonly IndexQuote[] | null;
  readonly indexError: string | null;
  readonly limitUp: AShareSentimentSnapshot['limitUp'] | null;
  readonly limitUpError: string | null;
}): MarketRoomOverview => {
  const indexes = buildMarketRoomIndexes({
    tradingDate: dateInShanghai(input.now),
    quotes: input.indexQuotes,
    error: input.indexError,
  });
  const benchmark =
    indexes.value?.values.find((entry) => entry.code === MARKET_ROOM_BENCHMARK_INDEX_CODE) ?? null;
  const parsed = MarketRoomOverviewSchema.parse({
    state: 'ready',
    tradingDate: dateInShanghai(input.now),
    latestBatch: {
      tradingDate: input.latest.tradingDate,
      sampledAt: input.latest.sampledAt,
    },
    coverage: buildMarketRoomCoverage(input.latest),
    breadth: buildMarketRoomBreadth({ batch: input.latest, benchmark }),
    amount: buildMarketRoomAmount({ current: input.latest, previous: input.previous }),
    limitUp: buildMarketRoomLimitUp({ dimension: input.limitUp, error: input.limitUpError }),
    indexes,
  });
  assertMarketRoomOverviewInvariants(parsed);
  return parsed;
};

const assertDimension = (
  name: string,
  dimension: {
    readonly status: string;
    readonly warnings: readonly string[];
    readonly value?: unknown;
  },
): void => {
  if (dimension.status === 'complete' && dimension.value === undefined) {
    throw new InvariantError(`market room ${name} 维度为 complete 时必须带 value`);
  }
  if (dimension.status === 'unavailable' && dimension.value !== undefined) {
    throw new InvariantError(`market room ${name} 维度为 unavailable 时不得带 value`);
  }
  if (dimension.status !== 'complete' && dimension.warnings.length === 0) {
    throw new InvariantError(`market room ${name} 维度非 complete 时必须给出缺失原因`);
  }
};

export const assertMarketRoomOverviewInvariants = (overview: MarketRoomOverview): void => {
  for (const [name, dimension] of [
    ['coverage', overview.coverage],
    ['breadth', overview.breadth],
    ['amount', overview.amount],
    ['limitUp', overview.limitUp],
    ['indexes', overview.indexes],
  ] as const) {
    assertDimension(name, dimension);
  }

  if (overview.state === 'ready') {
    if (overview.emptyReason !== undefined) {
      throw new InvariantError('market room ready 概览不得携带空态原因');
    }
    if (overview.latestBatch === null) {
      throw new InvariantError('market room ready 概览必须有最近批次');
    }
    if (overview.latestBatch.tradingDate !== overview.tradingDate) {
      throw new InvariantError('market room ready 概览必须基于当日已发布批次');
    }
    if (overview.coverage.value === undefined) {
      throw new InvariantError('market room ready 概览必须带覆盖信息');
    }
  } else {
    if (overview.emptyReason === undefined) {
      throw new InvariantError('market room 空态必须给出原因');
    }
    for (const dimension of [
      overview.coverage,
      overview.breadth,
      overview.amount,
      overview.limitUp,
      overview.indexes,
    ]) {
      if (dimension.status !== 'unavailable' || dimension.value !== undefined) {
        throw new InvariantError('market room 空态不得展示当日维度数据');
      }
    }
  }

  const breadth = overview.breadth.value;
  if (breadth !== undefined) {
    if (breadth.advancing + breadth.declining + breadth.unchanged !== breadth.classifiedCount) {
      throw new InvariantError('market room breadth 分类数必须等于上涨 + 下跌 + 平');
    }
    if (breadth.classifiedCount + breadth.missingChangePctCount !== breadth.sampleCount) {
      throw new InvariantError('market room breadth 样本数必须等于分类数 + 缺涨幅数');
    }
    if ((breadth.medianChangePct === null) !== (breadth.classifiedCount === 0)) {
      throw new InvariantError('market room breadth 中位数只在无样本时为空');
    }
    if (
      breadth.divergence !== undefined &&
      breadth.divergence.medianChangePct !== breadth.medianChangePct
    ) {
      throw new InvariantError('market room breadth 背离结论必须引用同一中位数');
    }
  }

  const amount = overview.amount.value;
  if (amount !== undefined) {
    if (amount.currentSampleCount + amount.currentMissingAmountCount !== amount.currentTotalCount) {
      throw new InvariantError('market room amount 样本数必须等于有成交额 + 缺成交额');
    }
    const comparison = amount.comparison;
    if (comparison !== undefined) {
      if (round2(amount.currentAmount - comparison.previousAmount) !== comparison.deltaAmount) {
        throw new InvariantError('market room amount 变化额必须等于两时点累计成交额之差');
      }
      const verdict =
        comparison.deltaAmount > 0
          ? 'expanded'
          : comparison.deltaAmount < 0
            ? 'contracted'
            : 'flat';
      if (comparison.verdict !== verdict) {
        throw new InvariantError('market room amount 放量 / 缩量结论必须与变化额方向一致');
      }
    }
  }
};
