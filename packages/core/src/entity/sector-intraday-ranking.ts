import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { EvidenceDimensionStatusSchema } from './ashare-sentiment.js';
import type { LimitUpLadder } from './limit-up-ladder.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  type SectorKind,
  SectorKindSchema,
  type StockSectorMembership,
} from './sector-catalog.js';

/**
 * 板块盘中榜（ticket #38）：把已发布批次、窗口起点批次、行业 / 概念成分与当日连板天梯
 * 组合成同一张可切换口径的榜单。
 *
 * - 日涨幅 = 板块成分 changePct 等权均值，相对前收；窗口涨幅比较窗口两端价格，不复用日涨幅；
 * - 窗口成交占比 = 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量；
 * - 概念间成分可重叠，各板块占比不可加总为市场总量；
 * - 每个数字都带样本数 / 分母 / 方法说明；缺样本、分母无效、跨午休不可比一律 null + 原因，
 *   绝不补零；无天梯快照时封板数为 null 而不是 0；
 * - 名次只影响排序，不产生事件。
 */

export const SECTOR_INTRADAY_WINDOWS = { w5: 5, w15: 15 } as const;
export type SectorWindowKey = keyof typeof SECTOR_INTRADAY_WINDOWS;

export const SectorWindowKeySchema = z.enum(['w5', 'w15']);
export const SectorIntradaySortSchema = z.enum(['day', 'window5', 'window15']);
export type SectorIntradaySort = z.infer<typeof SectorIntradaySortSchema>;

/** 样本不足下限：有效成分少于 3 只或不足板块成分半数时标注「样本不足」。 */
export const SECTOR_INTRADAY_MIN_SAMPLE = 3;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const SECTOR_RANKING_EMPTY_REASONS = [
  'no_batch',
  'pre_open',
  'non_trading_day',
  'no_today_batch',
  'no_sector_catalog',
  'no_members',
] as const;
export const SectorRankingEmptyReasonSchema = z.enum(SECTOR_RANKING_EMPTY_REASONS);
export type SectorRankingEmptyReason = z.infer<typeof SectorRankingEmptyReasonSchema>;

const DAY_METHOD =
  '日涨幅 = 板块 active 成分 changePct 等权均值（相对前收）；停牌 / 退市与缺涨幅成分剔除，不计作 0';
const WINDOW_METHOD = (minutes: number): string =>
  `窗口涨幅 = 各成分窗口两端价格比值 - 1（${minutes} 分钟窗口），逐成分计算后等权；两端缺一的成分剔除，不复用日涨幅`;
const TURNOVER_METHOD =
  '窗口成交占比 = 板块 active 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量（同一股票在两个批次都出现才计入分母）';
const LIMIT_UP_METHOD = '封板数 = 当日连板天梯中出现的板块 active 成分数；无天梯快照时缺失，不写 0';

/** 窗口起点批次的可比性结论；`unavailable` 时 value 一律 null，reason 说明原因。 */
export const SectorWindowRefSchema = z.object({
  key: SectorWindowKeySchema,
  minutes: z.number().int().positive(),
  status: EvidenceDimensionStatusSchema,
  /** 目标起点（锚点时点 - 窗口分钟）；空态没有锚点时为 null。 */
  targetSampledAt: z.coerce.date().nullable(),
  /** 实际使用的窗口起点批次；没有更早批次时为 null。 */
  startSampledAt: z.coerce.date().nullable(),
  spanMs: z.number().int().nonnegative().nullable(),
  reason: z.string().min(1).nullable(),
  warnings: z.array(z.string()),
});
export type SectorWindowRef = z.infer<typeof SectorWindowRefSchema>;

const countsShape = {
  /** 板块 active 成分总数（口径分母参照）。 */
  memberCount: z.number().int().nonnegative(),
  /** 参与该口径计算的成分数。 */
  sampleCount: z.number().int().nonnegative(),
  /** 缺样本成分数（不在批次或字段缺失）。 */
  missingCount: z.number().int().nonnegative(),
  /** 停牌 / 退市成分数：排除但不算缺失。 */
  nonTradableCount: z.number().int().nonnegative(),
};

export const SectorDayMetricSchema = z.object({
  value: z.number().finite().nullable(),
  status: EvidenceDimensionStatusSchema,
  ...countsShape,
  advancing: z.number().int().nonnegative(),
  declining: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  thinSample: z.boolean(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorDayMetric = z.infer<typeof SectorDayMetricSchema>;

export const SectorWindowMetricSchema = z.object({
  value: z.number().finite().nullable(),
  status: EvidenceDimensionStatusSchema,
  ...countsShape,
  thinSample: z.boolean(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorWindowMetric = z.infer<typeof SectorWindowMetricSchema>;

export const SectorTurnoverMetricSchema = z.object({
  /** 占比百分比（0-100）；分母无效或窗口不可比时为 null。 */
  value: z.number().finite().nullable(),
  status: EvidenceDimensionStatusSchema,
  ...countsShape,
  /** 成分累计成交额增量之和（元）；无有效成分时为 null。 */
  numeratorAmount: z.number().nullable(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorTurnoverMetric = z.infer<typeof SectorTurnoverMetricSchema>;

export const SectorLimitUpMetricSchema = z.object({
  value: z.number().int().nonnegative().nullable(),
  status: EvidenceDimensionStatusSchema,
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorLimitUpMetric = z.infer<typeof SectorLimitUpMetricSchema>;

/** 全市场分母与窗口有效性：一行即可说明本榜所有占比为何可用 / 缺失。 */
export const SectorTurnoverWindowSchema = z.object({
  window: SectorWindowKeySchema,
  status: EvidenceDimensionStatusSchema,
  reason: z.string().min(1).nullable(),
  /** 同期全市场去重成交额增量（分母，元）；无效时为 null。 */
  marketAmountDelta: z.number().nullable(),
  marketSampleCount: z.number().int().nonnegative(),
  marketTotalCount: z.number().int().nonnegative(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorTurnoverWindow = z.infer<typeof SectorTurnoverWindowSchema>;

export const SectorLimitUpBlockSchema = z.object({
  status: EvidenceDimensionStatusSchema,
  reason: z.string().min(1).nullable(),
  tradingDate: dateString.nullable(),
  source: z.string().nullable(),
  total: z.number().int().nonnegative().nullable(),
  maxLevel: z.number().int().nonnegative().nullable(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorLimitUpBlock = z.infer<typeof SectorLimitUpBlockSchema>;

export const SectorIntradayRowSchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
  /** 当前排序口径下的名次（1 起）；该口径缺失时为 null。 */
  rank: z.number().int().positive().nullable(),
  day: SectorDayMetricSchema,
  window5: SectorWindowMetricSchema,
  window15: SectorWindowMetricSchema,
  /** 按请求 window 口径的窗口成交占比。 */
  turnover: SectorTurnoverMetricSchema,
  limitUp: SectorLimitUpMetricSchema,
});
export type SectorIntradayRow = z.infer<typeof SectorIntradayRowSchema>;

export const SectorIntradayRankingSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorRankingEmptyReasonSchema.optional(),
  kind: SectorKindSchema,
  sort: SectorIntradaySortSchema,
  window: SectorWindowKeySchema,
  tradingDate: dateString.nullable(),
  anchor: z
    .object({
      sampledAt: z.coerce.date(),
      source: z.string().min(1),
      tradingDate: dateString,
      complete: z.boolean(),
      expectedCount: z.number().int().nonnegative(),
      receivedCount: z.number().int().nonnegative(),
      missingCount: z.number().int().nonnegative(),
      duplicateCount: z.number().int().nonnegative(),
      gaps: z.array(z.string()),
    })
    .nullable(),
  windows: z.object({ w5: SectorWindowRefSchema, w15: SectorWindowRefSchema }),
  turnover: SectorTurnoverWindowSchema,
  limitUp: SectorLimitUpBlockSchema,
  coverage: z.object({
    sectorCount: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    /** 目录里有但没有任何 active 成分、因而未进入榜单的板块数。 */
    omittedSectorCount: z.number().int().nonnegative(),
  }),
  rows: z.array(SectorIntradayRowSchema),
  notes: z.array(z.string()),
});
export type SectorIntradayRanking = z.infer<typeof SectorIntradayRankingSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SESSION_START_MIN = 9 * 60 + 30;
const MORNING_END_MIN = 11 * 60 + 30;
const AFTERNOON_START_MIN = 13 * 60;
const SESSION_END_MIN = 15 * 60;

const shanghaiMinutes = (date: Date): number => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const clockLabel = (date: Date): string => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(
    shifted.getUTCMinutes(),
  ).padStart(2, '0')}`;
};

const minutesLabel = (spanMs: number): string => `${round2(spanMs / 60_000)} 分钟`;

/** 窗口起点目标：锚点采样时点 - 窗口分钟。 */
export const sectorWindowTarget = (anchorSampledAt: Date, key: SectorWindowKey): Date =>
  new Date(anchorSampledAt.getTime() - SECTOR_INTRADAY_WINDOWS[key] * 60_000);

export interface SectorWindowInput {
  readonly key: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  /** 目标起点及之前最近的已发布批次；null 表示当日没有更早批次。 */
  readonly start: MarketSnapshotBatch | null;
}

/**
 * 判断窗口两端是否可比。只有同一交易日、同一连续竞价时段内、跨度正好等于窗口分钟数
 * 的两个批次才可比；跨午休、跨日、盘前盘后、起点不是窗口目标一律不可比。
 */
export const resolveSectorWindow = (input: SectorWindowInput): SectorWindowRef => {
  const minutes = SECTOR_INTRADAY_WINDOWS[input.key];
  const nominalSpanMs = minutes * 60_000;
  const targetSampledAt = sectorWindowTarget(input.anchor.sampledAt, input.key);
  const start = input.start;
  const base = {
    key: input.key,
    minutes,
    targetSampledAt,
    startSampledAt: start === null ? null : start.sampledAt,
    spanMs:
      start === null
        ? null
        : Math.max(0, input.anchor.sampledAt.getTime() - start.sampledAt.getTime()),
  };
  const missing = (reason: string, warnings: readonly string[] = []): SectorWindowRef => ({
    ...base,
    status: 'unavailable',
    reason,
    warnings: [...warnings],
  });

  if (start === null) {
    return missing(
      `window_start_missing: ${clockLabel(targetSampledAt)} 及之前没有已发布批次，无法比较 ${minutes} 分钟窗口两端价格`,
    );
  }
  if (start.tradingDate !== input.anchor.tradingDate) {
    return missing(
      `window_cross_day: 窗口起点批次属于 ${start.tradingDate}，与锚点 ${input.anchor.tradingDate} 不同交易日`,
    );
  }
  const startMin = shanghaiMinutes(start.sampledAt);
  const endMin = shanghaiMinutes(input.anchor.sampledAt);
  if (startMin < MORNING_END_MIN && endMin > MORNING_END_MIN) {
    return missing(
      `window_crosses_lunch_break: ${clockLabel(start.sampledAt)}–${clockLabel(input.anchor.sampledAt)} 跨午休（11:30–13:00），窗口涨幅不可比`,
    );
  }
  if (
    startMin < SESSION_START_MIN ||
    endMin > SESSION_END_MIN ||
    (startMin > MORNING_END_MIN && startMin < AFTERNOON_START_MIN) ||
    (endMin > MORNING_END_MIN && endMin < AFTERNOON_START_MIN)
  ) {
    return missing(
      `window_outside_session: ${clockLabel(start.sampledAt)}–${clockLabel(input.anchor.sampledAt)} 不在 09:30–11:30 / 13:00–15:00 连续竞价内，窗口涨幅不可比`,
    );
  }
  const spanMs = base.spanMs ?? 0;
  if (spanMs !== nominalSpanMs) {
    return missing(
      `window_start_missing: 目标起点 ${clockLabel(targetSampledAt)}，当日最近的更早批次是 ${clockLabel(start.sampledAt)}（${minutesLabel(spanMs)}），不是 ${minutes} 分钟窗口`,
    );
  }

  const warnings: string[] = [];
  if (!input.anchor.completeness.complete) {
    warnings.push(
      `anchor_incomplete: 锚点批次期望 ${input.anchor.completeness.expectedCount} 只，实收 ${input.anchor.completeness.receivedCount} 只`,
    );
  }
  if (!start.completeness.complete) {
    warnings.push(
      `window_start_incomplete: 窗口起点批次期望 ${start.completeness.expectedCount} 只，实收 ${start.completeness.receivedCount} 只`,
    );
  }
  return {
    ...base,
    status: warnings.length === 0 ? 'complete' : 'partial',
    reason: null,
    warnings,
  };
};

const itemMap = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((entry) => [entry.id, entry]));

const codeOfStockId = (stockId: string): string => stockId.split('.')[0] ?? stockId;

const isNonTradable = (membership: StockSectorMembership): boolean =>
  membership.memberStatus === 'suspended' || membership.memberStatus === 'delisted';

const isThin = (memberCount: number, sampleCount: number): boolean =>
  sampleCount < SECTOR_INTRADAY_MIN_SAMPLE || (memberCount > 0 && sampleCount * 2 < memberCount);

const metricStatus = (input: {
  readonly hasValue: boolean;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly thinSample: boolean;
}): z.infer<typeof EvidenceDimensionStatusSchema> => {
  if (!input.hasValue) return 'unavailable';
  return input.missingCount > 0 || input.nonTradableCount > 0 || input.thinSample
    ? 'partial'
    : 'complete';
};

const sampleWarnings = (input: {
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly thinSample: boolean;
  readonly memberCount: number;
  readonly sampleCount: number;
  readonly missingReason: string;
}): string[] => {
  const warnings: string[] = [];
  if (input.missingCount > 0) {
    warnings.push(`${input.missingReason}: ${input.missingCount} 只成分，已从该口径剔除`);
  }
  if (input.nonTradableCount > 0) {
    warnings.push(
      `non_tradable: ${input.nonTradableCount} 只停牌 / 退市成分已排除，不计入该口径、也不算缺失`,
    );
  }
  if (input.thinSample) {
    warnings.push(
      `thin_sample: 有效成分 ${input.sampleCount} / ${input.memberCount} 只，样本不足（下限 ${SECTOR_INTRADAY_MIN_SAMPLE} 只且不少于成分半数）`,
    );
  }
  return warnings;
};

/** 日涨幅：成分 changePct 等权均值 + 涨跌平分类，旁证样本数与缺失数。 */
export const buildSectorDayMetric = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
}): SectorDayMetric => {
  const memberCount = input.members.length;
  const changePcts: number[] = [];
  let missingCount = 0;
  let nonTradableCount = 0;
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  for (const membership of input.members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const item = input.items.get(membership.stockId);
    if (item === undefined || item.changePct === undefined) {
      missingCount += 1;
      continue;
    }
    changePcts.push(item.changePct);
    if (item.changePct > 0) advancing += 1;
    else if (item.changePct < 0) declining += 1;
    else unchanged += 1;
  }

  const sampleCount = changePcts.length;
  const thinSample = isThin(memberCount, sampleCount);
  const value =
    sampleCount === 0
      ? null
      : round4(changePcts.reduce((sum, current) => sum + current, 0) / sampleCount);
  const warnings = sampleWarnings({
    missingCount,
    nonTradableCount,
    thinSample,
    memberCount,
    sampleCount,
    missingReason: 'missing_change_pct: 不在批次或缺涨幅',
  });
  if (value === null) {
    warnings.unshift('missing_change_pct: 板块没有可用涨幅样本，日涨幅与涨跌分类均为缺失');
  }
  return {
    value,
    status: metricStatus({
      hasValue: value !== null,
      missingCount,
      nonTradableCount,
      thinSample,
    }),
    memberCount,
    sampleCount,
    missingCount,
    nonTradableCount,
    advancing,
    declining,
    unchanged,
    thinSample,
    method: DAY_METHOD,
    warnings,
  };
};

/** 窗口涨幅：窗口两端价格比值，逐成分计算后等权；窗口不可比时 value 为 null。 */
export const buildSectorWindowMetric = (input: {
  readonly key: SectorWindowKey;
  readonly window: SectorWindowRef;
  readonly members: readonly StockSectorMembership[];
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
  readonly startItems: ReadonlyMap<string, MarketSnapshotItem>;
}): SectorWindowMetric => {
  const minutes = SECTOR_INTRADAY_WINDOWS[input.key];
  const memberCount = input.members.length;
  const returns: number[] = [];
  let missingCount = 0;
  let nonTradableCount = 0;
  for (const membership of input.members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const current = input.items.get(membership.stockId);
    const start = input.startItems.get(membership.stockId);
    const currentClose = current?.close;
    const startClose = start?.close;
    if (
      currentClose === undefined ||
      startClose === undefined ||
      startClose <= 0 ||
      currentClose <= 0
    ) {
      missingCount += 1;
      continue;
    }
    returns.push((currentClose / startClose - 1) * 100);
  }

  const sampleCount = returns.length;
  const thinSample = isThin(memberCount, sampleCount);
  const windowReady = input.window.status !== 'unavailable';
  const value =
    !windowReady || sampleCount === 0
      ? null
      : round4(returns.reduce((sum, current) => sum + current, 0) / sampleCount);
  const warnings = sampleWarnings({
    missingCount,
    nonTradableCount,
    thinSample,
    memberCount,
    sampleCount,
    missingReason: 'missing_window_price: 窗口两端缺价格',
  });
  if (input.window.status === 'unavailable') {
    warnings.unshift(input.window.reason ?? 'window_unavailable: 窗口不可比');
  } else if (value === null) {
    warnings.unshift('missing_window_price: 板块没有两端都有价格的成分，窗口涨幅缺失');
  }
  return {
    value,
    status: metricStatus({
      hasValue: value !== null,
      missingCount,
      nonTradableCount,
      thinSample,
    }),
    memberCount,
    sampleCount,
    missingCount,
    nonTradableCount,
    thinSample,
    method: WINDOW_METHOD(minutes),
    warnings,
  };
};

/** 全市场分母：同一股票在两个批次都出现且都有成交额才计入，去重后求和增量。 */
export const buildSectorTurnoverWindow = (input: {
  readonly window: SectorWindowKey;
  readonly windowRef: SectorWindowRef;
  readonly anchor: MarketSnapshotBatch;
  readonly start: MarketSnapshotBatch | null;
}): SectorTurnoverWindow => {
  const startItems = itemMap(input.start);
  let delta = 0;
  let sampleCount = 0;
  const totalCount = input.anchor.items.length;
  if (input.start !== null) {
    for (const item of input.anchor.items) {
      const previous = startItems.get(item.id);
      if (previous?.amount === undefined || item.amount === undefined) continue;
      delta += item.amount - previous.amount;
      sampleCount += 1;
    }
  }
  const base = {
    window: input.window,
    marketSampleCount: sampleCount,
    marketTotalCount: totalCount,
    method: TURNOVER_METHOD,
  };
  const invalid = (
    reason: string,
    marketAmountDelta: number | null,
    warnings: readonly string[] = [],
  ): SectorTurnoverWindow => ({
    ...base,
    status: 'unavailable',
    reason,
    marketAmountDelta,
    warnings: [...warnings],
  });

  if (input.windowRef.status === 'unavailable') {
    return invalid(input.windowRef.reason ?? 'window_unavailable: 窗口不可比', null);
  }
  if (!input.anchor.completeness.complete) {
    return invalid(
      `batch_incomplete: 锚点批次期望 ${input.anchor.completeness.expectedCount} 只，实收 ${input.anchor.completeness.receivedCount} 只，分母不完整`,
      null,
    );
  }
  if (sampleCount !== totalCount) {
    return invalid(
      `denominator_incomplete: 分母仅覆盖 ${sampleCount} / ${totalCount} 只（缺成交额或不在窗口起点批次），无法作为全市场分母`,
      round2(delta),
    );
  }
  if (delta <= 0) {
    return invalid(
      `denominator_invalid: 同期全市场去重成交额增量为 ${round2(delta)}，不为正，占比无意义`,
      round2(delta),
    );
  }
  const warnings = [...input.windowRef.warnings];
  return {
    ...base,
    status: warnings.length === 0 ? 'complete' : 'partial',
    reason: null,
    marketAmountDelta: round2(delta),
    warnings,
  };
};

/** 单板块占比：成分累计成交额增量之和 ÷ 全市场去重增量；分母无效时整列为 null。 */
export const buildSectorTurnoverMetric = (input: {
  readonly denominator: SectorTurnoverWindow;
  readonly members: readonly StockSectorMembership[];
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
  readonly startItems: ReadonlyMap<string, MarketSnapshotItem>;
}): SectorTurnoverMetric => {
  const memberCount = input.members.length;
  let numerator = 0;
  let sampleCount = 0;
  let missingCount = 0;
  let nonTradableCount = 0;
  for (const membership of input.members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const current = input.items.get(membership.stockId);
    const start = input.startItems.get(membership.stockId);
    if (current?.amount === undefined || start?.amount === undefined) {
      missingCount += 1;
      continue;
    }
    numerator += current.amount - start.amount;
    sampleCount += 1;
  }

  const denominatorAmount = input.denominator.marketAmountDelta;
  const denominatorValid = input.denominator.status !== 'unavailable' && denominatorAmount !== null;
  const thinSample = isThin(memberCount, sampleCount);
  const value =
    !denominatorValid || sampleCount === 0 || denominatorAmount === null
      ? null
      : round2((numerator / denominatorAmount) * 100);
  const warnings = sampleWarnings({
    missingCount,
    nonTradableCount,
    thinSample,
    memberCount,
    sampleCount,
    missingReason: 'missing_window_amount: 窗口两端缺成交额',
  });
  if (!denominatorValid) {
    warnings.unshift(input.denominator.reason ?? 'denominator_invalid: 全市场分母无效');
  } else if (value === null) {
    warnings.unshift('missing_window_amount: 板块没有两端都有成交额的成分，占比缺失');
  }
  return {
    value,
    status: metricStatus({
      hasValue: value !== null,
      missingCount,
      nonTradableCount,
      thinSample,
    }),
    memberCount,
    sampleCount,
    missingCount,
    nonTradableCount,
    numeratorAmount: sampleCount === 0 ? null : round2(numerator),
    method: TURNOVER_METHOD,
    warnings,
  };
};

const ladderUnavailable = (limitUp: LimitUpLadder | null, error: string | null): string | null => {
  if (limitUp === null) {
    return `limit_up_missing: ${error ?? '当日没有已保存的连板天梯快照'}，封板数缺失（不写 0）`;
  }
  if (limitUp.total === 0 && limitUp.warnings.length > 0) {
    // 空天梯带缺口说明（盘前 / 非交易日 / 上游未更新）：缺失，不写 0；
    // 空天梯且无缺口说明则是当日确实没有封板股，真 0 照常展示。
    return `limit_up_empty: ${limitUp.warnings[0] as string}，封板数缺失（不写 0）`;
  }
  return null;
};

export const buildSectorLimitUpBlock = (input: {
  readonly limitUp: LimitUpLadder | null;
  readonly limitUpError: string | null;
}): SectorLimitUpBlock => {
  const reason = ladderUnavailable(input.limitUp, input.limitUpError);
  const warnings = input.limitUp === null ? [] : [...input.limitUp.warnings];
  return {
    status: reason === null ? 'complete' : 'unavailable',
    reason,
    tradingDate: input.limitUp?.date ?? null,
    source: input.limitUp?.source ?? null,
    total: input.limitUp?.total ?? null,
    maxLevel: input.limitUp?.maxLevel ?? null,
    method: LIMIT_UP_METHOD,
    warnings,
  };
};

const ladderCodes = (limitUp: LimitUpLadder | null): ReadonlySet<string> => {
  const codes = new Set<string>();
  for (const level of limitUp?.levels ?? []) {
    for (const entry of level.stocks) codes.add(entry.code);
  }
  return codes;
};

const buildSectorLimitUpMetric = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly block: SectorLimitUpBlock;
  readonly codes: ReadonlySet<string>;
}): SectorLimitUpMetric => {
  if (input.block.status === 'unavailable') {
    return {
      value: null,
      status: 'unavailable',
      method: LIMIT_UP_METHOD,
      warnings: [input.block.reason ?? 'limit_up_missing: 无天梯快照'],
    };
  }
  const value = input.members.filter((membership) =>
    input.codes.has(codeOfStockId(membership.stockId)),
  ).length;
  return { value, status: 'complete', method: LIMIT_UP_METHOD, warnings: [] };
};

const anchorSummary = (batch: MarketSnapshotBatch): SectorIntradayRanking['anchor'] => ({
  sampledAt: batch.sampledAt,
  source: batch.source,
  tradingDate: batch.tradingDate,
  complete: batch.completeness.complete,
  expectedCount: batch.completeness.expectedCount,
  receivedCount: batch.completeness.receivedCount,
  missingCount: batch.completeness.missingCount,
  duplicateCount: batch.completeness.duplicateCount,
  gaps: [...batch.gaps],
});

const RANKING_NOTES: readonly string[] = [
  '日涨幅相对前收；近 5 / 15 分钟窗口涨幅比较窗口两端价格，不复用日涨幅。',
  '窗口成交占比 = 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量；概念间成分可重叠，各板块占比不可加总为市场总量。',
  '缺失样本、分母无效与跨午休不可比一律记为缺失，不补零；封板数无天梯快照时为缺失而不是 0。',
  '名次只影响排序，不产生事件。',
];

export interface SectorIntradayRankingInput {
  readonly kind: SectorKind;
  readonly sort: SectorIntradaySort;
  readonly window: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  readonly windowStarts: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
  readonly limitUp: LimitUpLadder | null;
  readonly limitUpError: string | null;
}

const EMPTY_REASON_TEXT: Readonly<Record<SectorRankingEmptyReason, string>> = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '目录里没有带 active 成分的板块',
};

/** 空态榜单：保留「最近批次是什么时候」，窗口、分母与行全部不可用。 */
export const buildSectorIntradayEmptyRanking = (input: {
  readonly kind: SectorKind;
  readonly sort: SectorIntradaySort;
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): SectorIntradayRanking => {
  if ((input.reason === 'no_batch') !== (input.latest === null)) {
    throw new InvariantError('板块榜空态原因与最近批次状态不一致');
  }
  const reasonText = `${input.reason}: ${EMPTY_REASON_TEXT[input.reason]}`;
  const windowRef = (key: SectorWindowKey): SectorWindowRef => ({
    key,
    minutes: SECTOR_INTRADAY_WINDOWS[key],
    status: 'unavailable',
    targetSampledAt: null,
    startSampledAt: null,
    spanMs: null,
    reason: reasonText,
    warnings: [],
  });
  const parsed = SectorIntradayRankingSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    kind: input.kind,
    sort: input.sort,
    window: input.window,
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : anchorSummary(input.latest),
    windows: { w5: windowRef('w5'), w15: windowRef('w15') },
    turnover: {
      window: input.window,
      status: 'unavailable',
      reason: reasonText,
      marketAmountDelta: null,
      marketSampleCount: 0,
      marketTotalCount: 0,
      method: TURNOVER_METHOD,
      warnings: [],
    },
    limitUp: {
      status: 'unavailable',
      reason: reasonText,
      tradingDate: null,
      source: null,
      total: null,
      maxLevel: null,
      method: LIMIT_UP_METHOD,
      warnings: [],
    },
    coverage: { sectorCount: 0, rowCount: 0, omittedSectorCount: 0 },
    rows: [],
    notes: [...RANKING_NOTES],
  });
  assertSectorIntradayRankingInvariants(parsed);
  return parsed;
};

const sortValueOf = (row: SectorIntradayRow, sort: SectorIntradaySort): number | null =>
  sort === 'day' ? row.day.value : sort === 'window5' ? row.window5.value : row.window15.value;

const compareRows =
  (sort: SectorIntradaySort) => (left: SectorIntradayRow, right: SectorIntradayRow) => {
    const leftValue = sortValueOf(left, sort);
    const rightValue = sortValueOf(right, sort);
    if (leftValue === null && rightValue === null)
      return left.vendorCode.localeCompare(right.vendorCode);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return left.vendorCode.localeCompare(right.vendorCode);
  };

export const buildSectorIntradayRanking = (
  input: SectorIntradayRankingInput,
): SectorIntradayRanking => {
  const windows = {
    w5: resolveSectorWindow({
      key: 'w5',
      anchor: input.anchor,
      start: input.windowStarts.w5,
    }),
    w15: resolveSectorWindow({
      key: 'w15',
      anchor: input.anchor,
      start: input.windowStarts.w15,
    }),
  };
  const anchorItems = itemMap(input.anchor);
  const startItems = { w5: itemMap(input.windowStarts.w5), w15: itemMap(input.windowStarts.w15) };
  const turnoverBlock = buildSectorTurnoverWindow({
    window: input.window,
    windowRef: windows[input.window],
    anchor: input.anchor,
    start: input.windowStarts[input.window],
  });
  const limitUpBlock = buildSectorLimitUpBlock({
    limitUp: input.limitUp,
    limitUpError: input.limitUpError,
  });
  const codes = ladderCodes(input.limitUp);

  const membersBySector = new Map<string, StockSectorMembership[]>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const list = membersBySector.get(membership.sectorId) ?? [];
    list.push(membership);
    membersBySector.set(membership.sectorId, list);
  }

  const catalog = input.sectors.filter(
    (sector) => sector.kind === input.kind && sector.state === 'active',
  );
  let omittedSectorCount = 0;
  const rows: SectorIntradayRow[] = [];
  for (const sector of catalog) {
    const members = membersBySector.get(sector.id) ?? [];
    if (members.length === 0) {
      omittedSectorCount += 1;
      continue;
    }
    rows.push({
      sectorId: sector.id,
      kind: sector.kind,
      vendorCode: sector.vendorCode,
      name: sector.name,
      rank: null,
      day: buildSectorDayMetric({ members, items: anchorItems }),
      window5: buildSectorWindowMetric({
        key: 'w5',
        window: windows.w5,
        members,
        items: anchorItems,
        startItems: startItems.w5,
      }),
      window15: buildSectorWindowMetric({
        key: 'w15',
        window: windows.w15,
        members,
        items: anchorItems,
        startItems: startItems.w15,
      }),
      turnover: buildSectorTurnoverMetric({
        denominator: turnoverBlock,
        members,
        items: anchorItems,
        startItems: startItems[input.window],
      }),
      limitUp: buildSectorLimitUpMetric({ members, block: limitUpBlock, codes }),
    });
  }

  rows.sort(compareRows(input.sort));
  let rank = 0;
  const ranked = rows.map((row) => {
    const value = sortValueOf(row, input.sort);
    if (value === null) return row;
    rank += 1;
    return { ...row, rank };
  });

  const parsed = SectorIntradayRankingSchema.parse({
    state: 'ready',
    kind: input.kind,
    sort: input.sort,
    window: input.window,
    tradingDate: input.anchor.tradingDate,
    anchor: anchorSummary(input.anchor),
    windows,
    turnover: turnoverBlock,
    limitUp: limitUpBlock,
    coverage: {
      sectorCount: catalog.length,
      rowCount: ranked.length,
      omittedSectorCount,
    },
    rows: ranked,
    notes: [...RANKING_NOTES],
  });
  assertSectorIntradayRankingInvariants(parsed);
  return parsed;
};

const assertCounted = (
  name: string,
  metric: {
    readonly memberCount: number;
    readonly sampleCount: number;
    readonly missingCount: number;
    readonly nonTradableCount: number;
  },
): void => {
  if (metric.sampleCount + metric.missingCount + metric.nonTradableCount !== metric.memberCount) {
    throw new InvariantError(
      `sector ranking ${name} 样本数必须等于有效 + 缺失 + 停牌退市（${metric.sampleCount} + ${metric.missingCount} + ${metric.nonTradableCount} ≠ ${metric.memberCount}）`,
    );
  }
};

const assertMetricStatus = (
  name: string,
  metric: {
    readonly status: string;
    readonly value: unknown;
    readonly warnings: readonly string[];
  },
): void => {
  if ((metric.value === null) !== (metric.status === 'unavailable')) {
    throw new InvariantError(`sector ranking ${name} 只有缺失值才允许 unavailable`);
  }
  if (metric.status !== 'complete' && metric.warnings.length === 0) {
    throw new InvariantError(`sector ranking ${name} 非 complete 时必须给出缺失原因`);
  }
};

export const assertSectorIntradayRankingInvariants = (ranking: SectorIntradayRanking): void => {
  if (ranking.state === 'empty') {
    if (ranking.emptyReason === undefined) {
      throw new InvariantError('sector ranking 空态必须给出原因');
    }
    if (ranking.rows.length > 0) {
      throw new InvariantError('sector ranking 空态不得有榜单行');
    }
  } else {
    if (ranking.emptyReason !== undefined) {
      throw new InvariantError('sector ranking ready 不得携带空态原因');
    }
    if (ranking.anchor === null || ranking.tradingDate === null) {
      throw new InvariantError('sector ranking ready 必须基于已发布批次');
    }
    if (ranking.rows.length !== ranking.coverage.rowCount) {
      throw new InvariantError('sector ranking 行数必须与覆盖统计一致');
    }
  }

  if (ranking.windows.w5.key !== 'w5' || ranking.windows.w15.key !== 'w15') {
    throw new InvariantError('sector ranking 窗口键必须与请求口径一致');
  }
  if (ranking.turnover.window !== ranking.window) {
    throw new InvariantError('sector ranking 占比窗口必须与请求口径一致');
  }
  if (ranking.turnover.status === 'unavailable') {
    if (ranking.turnover.reason === null) {
      throw new InvariantError('sector ranking 分母无效时必须给出原因');
    }
  } else if (
    ranking.turnover.marketAmountDelta === null ||
    ranking.turnover.marketAmountDelta <= 0
  ) {
    throw new InvariantError('sector ranking 分母可用时必须给出正的全市场成交额增量');
  }

  let expectedRank = 0;
  let previousSortValue: number | null = null;
  for (const row of ranking.rows) {
    assertCounted(`day(${row.name})`, row.day);
    assertCounted(`window5(${row.name})`, row.window5);
    assertCounted(`window15(${row.name})`, row.window15);
    assertCounted(`turnover(${row.name})`, row.turnover);
    assertMetricStatus(`day(${row.name})`, row.day);
    assertMetricStatus(`window5(${row.name})`, row.window5);
    assertMetricStatus(`window15(${row.name})`, row.window15);
    assertMetricStatus(`turnover(${row.name})`, row.turnover);
    assertMetricStatus(`limitUp(${row.name})`, row.limitUp);
    if (row.day.advancing + row.day.declining + row.day.unchanged !== row.day.sampleCount) {
      throw new InvariantError('sector ranking 涨跌平分类必须等于有效成分数');
    }
    if (row.day.sampleCount > 0 && row.day.value === null) {
      throw new InvariantError('sector ranking 有样本时必须给出日涨幅');
    }
    if ((row.limitUp.value === null) !== (ranking.limitUp.status === 'unavailable')) {
      throw new InvariantError('sector ranking 封板数缺失状态必须与天梯块一致');
    }
    const activeValue = sortValueOf(row, ranking.sort);
    if (activeValue === null) {
      if (row.rank !== null) throw new InvariantError('sector ranking 缺失口径不得有名次');
      continue;
    }
    if (previousSortValue !== null && activeValue > previousSortValue) {
      throw new InvariantError('sector ranking 行序必须按当前口径降序');
    }
    previousSortValue = activeValue;
    expectedRank += 1;
    if (row.rank !== expectedRank) {
      throw new InvariantError('sector ranking 名次必须按当前口径连续且从 1 开始');
    }
  }
};
