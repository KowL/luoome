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
  SectorMemberStatusSchema,
  type StockSectorMembership,
} from './sector-catalog.js';
import {
  buildSectorDayMetric,
  buildSectorLimitUpBlock,
  buildSectorTurnoverMetric,
  buildSectorTurnoverWindow,
  buildSectorWindowMetric,
  resolveSectorWindow,
  SECTOR_INTRADAY_MIN_SAMPLE,
  SECTOR_RANKING_EMPTY_REASONS,
  type SectorDayMetric,
  SectorDayMetricSchema,
  SectorLimitUpBlockSchema,
  SectorLimitUpMetricSchema,
  SectorTurnoverMetricSchema,
  SectorTurnoverWindowSchema,
  type SectorWindowKey,
  SectorWindowMetricSchema,
  type SectorWindowRef,
  SectorWindowRefSchema,
} from './sector-intraday-ranking.js';

/**
 * 板块详情（ticket #39）：在盘中榜之上给出单板块的走势、成分明细与多板块对照。
 *
 * - 走势口径：本地事实只有个股批次，没有按供应商代码（如 881273.TI）保存的板块指数序列，
 *   `fetchIndexQuotes` 也只覆盖大盘指数；因此走势统一用「成分等权合成」并在 method /
 *   indexFallbackReason 中注明，绝不用大盘指数冒充板块走势；
 * - 合成方式：以窗口内首个有样本的批次为基准 100，按各成分收盘价比值等权平均；
 *   基准批次之后才出现的成分没有基准价，计入缺失而不是补 0；
 * - 成分上涨比例独立于走势展示：上涨数 ÷ 有效成分数，与板块指数无关；
 * - 对照板块各自归一化到 100，基准时点可能不同，差异在 series.coverage 与 notes 中写明；
 * - `leaderOrder` 只按各时点走势值排名，呈现顺序变化事实，不产出事件；
 * - 缺失样本、停牌退市、分母无效一律写缺失与原因，不补零。
 */

export const SECTOR_TREND_METHODS = ['sector_index', 'constituent_equal_weight'] as const;
export const SectorTrendMethodSchema = z.enum(SECTOR_TREND_METHODS);
export type SectorTrendMethod = z.infer<typeof SectorTrendMethodSchema>;

/** 指数口径不可用的原因：写入每条走势序列，供 UI 直接展示口径差异。 */
export const SECTOR_TREND_INDEX_FALLBACK_REASON =
  'sector_index_unavailable: 本地未保存按板块供应商代码（如 881273.TI）的指数行情序列，fetchIndexQuotes 只覆盖上证 / 深证等大盘指数；本走势改用成分等权合成，不用大盘指数冒充板块走势';

export const SECTOR_TREND_METHOD_NOTE =
  '成分等权合成：首个有样本批次 = 100，各成分按收盘价比值等权平均；停牌 / 退市与缺价成分剔除，不计作 0';

export const SECTOR_TREND_LEADER_NOTE =
  '领先顺序 = 同一时点各序列归一化走势值降序；只呈现顺序变化事实，不产出事件';

export const SECTOR_DETAIL_EMPTY_REASONS = [
  ...SECTOR_RANKING_EMPTY_REASONS,
  'sector_not_found',
] as const;
export const SectorDetailEmptyReasonSchema = z.enum(SECTOR_DETAIL_EMPTY_REASONS);
export type SectorDetailEmptyReason = z.infer<typeof SectorDetailEmptyReasonSchema>;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export interface SectorIdentity {
  readonly sectorId: string;
  readonly kind: SectorKind;
  readonly vendorCode: string;
  readonly name: string;
}

export const SectorIdentitySchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
});

export const SectorTrendPointSchema = z.object({
  sampledAt: z.coerce.date(),
  /** 归一化走势值（基准批次 = 100）；没有可用样本时为 null。 */
  value: z.number().finite().nullable(),
  sampleCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  nonTradableCount: z.number().int().nonnegative(),
  status: EvidenceDimensionStatusSchema,
  warnings: z.array(z.string()),
});
export type SectorTrendPoint = z.infer<typeof SectorTrendPointSchema>;

export const SectorTrendCoverageSchema = z.object({
  batchCount: z.number().int().nonnegative(),
  pointCount: z.number().int().nonnegative(),
  availablePointCount: z.number().int().nonnegative(),
  missingPointCount: z.number().int().nonnegative(),
  firstSampledAt: z.coerce.date().nullable(),
  /** 归一化基准批次（首个有样本批次）；全窗口无样本时为 null。 */
  baseSampledAt: z.coerce.date().nullable(),
  lastSampledAt: z.coerce.date().nullable(),
});
export type SectorTrendCoverage = z.infer<typeof SectorTrendCoverageSchema>;

export const SectorTrendSeriesSchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
  method: SectorTrendMethodSchema,
  methodNote: z.string().min(1),
  /** method 不是 sector_index 时说明原因；是 sector_index 时为 null。 */
  indexFallbackReason: z.string().min(1).nullable(),
  coverage: SectorTrendCoverageSchema,
  points: z.array(SectorTrendPointSchema),
  warnings: z.array(z.string()),
});
export type SectorTrendSeries = z.infer<typeof SectorTrendSeriesSchema>;

export const SectorBreadthSchema = z.object({
  status: EvidenceDimensionStatusSchema,
  advancing: z.number().int().nonnegative(),
  declining: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  nonTradableCount: z.number().int().nonnegative(),
  /** 上涨成分数 ÷ 有效成分数 × 100；无有效样本时为 null。 */
  advanceRatio: z.number().finite().nullable(),
  thinSample: z.boolean(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorBreadth = z.infer<typeof SectorBreadthSchema>;

export const SectorMemberDetailSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  /** 批次内名称；成分不在锚点批次时为 null，不能用代码编造名称。 */
  name: z.string().min(1).nullable(),
  memberStatus: SectorMemberStatusSchema,
  inBatch: z.boolean(),
  dayChangePct: z.number().finite().nullable(),
  /** 请求窗口口径的两端价格涨幅；窗口不可比或两端缺价时为 null。 */
  windowChangePct: z.number().finite().nullable(),
  /** 请求窗口口径的累计成交额增量（元）。 */
  windowAmountDelta: z.number().finite().nullable(),
  /** 成分增量 ÷ 板块增量合计 × 100；板块增量为空或非正时为 null。 */
  windowAmountSharePct: z.number().finite().nullable(),
  /** 是否在当前涨跌停池中；无天梯快照时为 null。 */
  sealed: z.boolean().nullable(),
  ladderLevel: z.number().int().positive().nullable(),
  warnings: z.array(z.string()),
});
export type SectorMemberDetail = z.infer<typeof SectorMemberDetailSchema>;

export const SectorLeaderOrderEntrySchema = z.object({
  sectorId: z.string().min(1),
  name: z.string().min(1),
  value: z.number().finite(),
  rank: z.number().int().positive(),
});
export type SectorLeaderOrderEntry = z.infer<typeof SectorLeaderOrderEntrySchema>;

export const SectorLeaderOrderPointSchema = z.object({
  sampledAt: z.coerce.date(),
  entries: z.array(SectorLeaderOrderEntrySchema),
  missingSectorIds: z.array(z.string()),
  reordered: z.boolean(),
  /** 上一个有样本时点的顺序；首个时点或上一时点无样本时为 null。 */
  previousOrder: z.array(z.string()).nullable(),
});
export type SectorLeaderOrderPoint = z.infer<typeof SectorLeaderOrderPointSchema>;

export const SectorDetailCoverageSchema = z.object({
  batchCount: z.number().int().nonnegative(),
  trendPointCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  comparisonCount: z.number().int().nonnegative(),
  unresolvedComparisonCount: z.number().int().nonnegative(),
});
export type SectorDetailCoverage = z.infer<typeof SectorDetailCoverageSchema>;

const anchorShape = z
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
  .nullable();

export const SectorDetailSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorDetailEmptyReasonSchema.optional(),
  sector: SectorIdentitySchema.nullable(),
  tradingDate: dateString.nullable(),
  anchor: anchorShape,
  window: z.enum(['w5', 'w15']),
  windows: z.object({ w5: SectorWindowRefSchema, w15: SectorWindowRefSchema }),
  trend: SectorTrendSeriesSchema.nullable(),
  comparisons: z.array(SectorTrendSeriesSchema),
  unresolvedSectorIds: z.array(z.string()),
  breadth: SectorBreadthSchema.nullable(),
  day: SectorDayMetricSchema.nullable(),
  windowMetric: SectorWindowMetricSchema.nullable(),
  turnoverWindow: SectorTurnoverWindowSchema.nullable(),
  turnover: SectorTurnoverMetricSchema.nullable(),
  limitUpBlock: SectorLimitUpBlockSchema.nullable(),
  limitUp: SectorLimitUpMetricSchema.nullable(),
  members: z.array(SectorMemberDetailSchema),
  leaderOrder: z.array(SectorLeaderOrderPointSchema),
  coverage: SectorDetailCoverageSchema,
  notes: z.array(z.string()),
});
export type SectorDetail = z.infer<typeof SectorDetailSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const itemMap = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((entry) => [entry.id, entry]));

const codeOfStockId = (stockId: string): string => stockId.split('.')[0] ?? stockId;

const isNonTradable = (membership: StockSectorMembership): boolean =>
  membership.memberStatus === 'suspended' || membership.memberStatus === 'delisted';

const isThin = (memberCount: number, sampleCount: number): boolean =>
  sampleCount < SECTOR_INTRADAY_MIN_SAMPLE || (memberCount > 0 && sampleCount * 2 < memberCount);

const identityOf = (sector: SectorCatalogEntry): SectorIdentity => ({
  sectorId: sector.id,
  kind: sector.kind,
  vendorCode: sector.vendorCode,
  name: sector.name,
});

const activeMembersOf = (
  members: readonly StockSectorMembership[],
): readonly StockSectorMembership[] =>
  members.filter((membership) => membership.state === 'active');

const statusOf = (input: {
  readonly hasValue: boolean;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly thinSample: boolean;
  readonly batchComplete: boolean;
}): z.infer<typeof EvidenceDimensionStatusSchema> => {
  if (!input.hasValue) return 'unavailable';
  return input.missingCount > 0 ||
    input.nonTradableCount > 0 ||
    input.thinSample ||
    !input.batchComplete
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
    warnings.push(`${input.missingReason}: ${input.missingCount} 只成分，已从该时点剔除`);
  }
  if (input.nonTradableCount > 0) {
    warnings.push(
      `non_tradable: ${input.nonTradableCount} 只停牌 / 退市成分已排除，不计入该时点、也不算缺失`,
    );
  }
  if (input.thinSample) {
    warnings.push(
      `thin_sample: 有效成分 ${input.sampleCount} / ${input.memberCount} 只，样本不足（下限 ${SECTOR_INTRADAY_MIN_SAMPLE} 只且不少于成分半数）`,
    );
  }
  return warnings;
};

const trendWarnings = (input: {
  readonly batch: MarketSnapshotBatch;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly thinSample: boolean;
  readonly memberCount: number;
  readonly sampleCount: number;
  readonly hasBase: boolean;
  readonly hasValue: boolean;
}): string[] => {
  const warnings = sampleWarnings({
    missingCount: input.missingCount,
    nonTradableCount: input.nonTradableCount,
    thinSample: input.thinSample,
    memberCount: input.memberCount,
    sampleCount: input.sampleCount,
    missingReason: input.hasBase
      ? 'missing_trend_price: 缺当前收盘价'
      : 'missing_trend_base: 没有基准价（窗口内首个样本之后才出现或缺价）',
  });
  if (!input.batch.completeness.complete) {
    warnings.unshift(
      `batch_incomplete: 该批次期望 ${input.batch.completeness.expectedCount} 只，实收 ${input.batch.completeness.receivedCount} 只`,
    );
  }
  if (!input.hasValue) {
    warnings.unshift(
      input.hasBase
        ? 'missing_trend_sample: 该时点没有可比较的成分，走势缺失'
        : 'missing_trend_base: 窗口内没有可用基准样本，走势缺失',
    );
  }
  return warnings;
};

/**
 * 成分等权合成走势：首个有样本批次 = 100，之后按各成分收盘价比值等权平均。
 * 每次计算只用当时两端都有价的成分，缺样本计 missing，不补 0、不填充前值。
 */
export const buildSectorTrendSeries = (input: {
  readonly sector: SectorCatalogEntry;
  readonly members: readonly StockSectorMembership[];
  readonly batches: readonly MarketSnapshotBatch[];
}): SectorTrendSeries => {
  const activeMembers = activeMembersOf(input.members);
  const itemsByBatch = input.batches.map((batch) => itemMap(batch));
  const baseIndex = itemsByBatch.findIndex((items) =>
    activeMembers.some((membership) => {
      if (isNonTradable(membership)) return false;
      const close = items.get(membership.stockId)?.close;
      return close !== undefined && close > 0;
    }),
  );
  const baseItems = baseIndex === -1 ? null : (itemsByBatch[baseIndex] ?? null);
  const baseCloses = new Map<string, number>();
  for (const membership of activeMembers) {
    const close = baseItems?.get(membership.stockId)?.close;
    if (close !== undefined && close > 0) baseCloses.set(membership.stockId, close);
  }

  const points = input.batches.map((batch, index): SectorTrendPoint => {
    const items = itemsByBatch[index] ?? new Map<string, MarketSnapshotItem>();
    let valueSum = 0;
    let sampleCount = 0;
    let missingCount = 0;
    let nonTradableCount = 0;
    for (const membership of activeMembers) {
      if (isNonTradable(membership)) {
        nonTradableCount += 1;
        continue;
      }
      const baseClose = baseCloses.get(membership.stockId);
      const close = items.get(membership.stockId)?.close;
      if (baseClose === undefined || close === undefined || close <= 0) {
        missingCount += 1;
        continue;
      }
      valueSum += close / baseClose;
      sampleCount += 1;
    }
    const memberCount = activeMembers.length;
    const thinSample = isThin(memberCount, sampleCount);
    const hasValue = sampleCount > 0;
    const value = hasValue ? round4((valueSum / sampleCount) * 100) : null;
    return {
      sampledAt: batch.sampledAt,
      value,
      sampleCount,
      memberCount,
      missingCount,
      nonTradableCount,
      status: statusOf({
        hasValue,
        missingCount,
        nonTradableCount,
        thinSample,
        batchComplete: batch.completeness.complete,
      }),
      warnings: trendWarnings({
        batch,
        missingCount,
        nonTradableCount,
        thinSample,
        memberCount,
        sampleCount,
        hasBase: baseIndex !== -1 && index >= baseIndex,
        hasValue,
      }),
    };
  });

  const availablePointCount = points.filter((point) => point.value !== null).length;
  const warnings: string[] = [];
  if (baseIndex === -1) {
    warnings.push('missing_trend_base: 窗口内没有任何成分同时具备收盘价，走势全部缺失');
  }
  if (availablePointCount < points.length) {
    warnings.push(
      `missing_trend_points: ${points.length - availablePointCount} / ${points.length} 个时点没有可用样本`,
    );
  }

  return SectorTrendSeriesSchema.parse({
    ...identityOf(input.sector),
    method: 'constituent_equal_weight',
    methodNote: SECTOR_TREND_METHOD_NOTE,
    indexFallbackReason: SECTOR_TREND_INDEX_FALLBACK_REASON,
    coverage: {
      batchCount: input.batches.length,
      pointCount: points.length,
      availablePointCount,
      missingPointCount: points.length - availablePointCount,
      firstSampledAt: input.batches[0]?.sampledAt ?? null,
      baseSampledAt: baseIndex === -1 ? null : (input.batches[baseIndex]?.sampledAt ?? null),
      lastSampledAt: input.batches.at(-1)?.sampledAt ?? null,
    },
    points,
    warnings,
  });
};

/** 成分上涨比例：与板块指数、走势无关的独立口径。 */
export const buildSectorBreadth = (day: SectorDayMetric): SectorBreadth => {
  const advanceRatio =
    day.sampleCount === 0 ? null : round2((day.advancing / day.sampleCount) * 100);
  const warnings = [...day.warnings];
  if (advanceRatio === null) {
    warnings.unshift('missing_breadth_sample: 没有有效成分，上涨比例缺失');
  }
  return {
    status: day.status,
    advancing: day.advancing,
    declining: day.declining,
    unchanged: day.unchanged,
    sampleCount: day.sampleCount,
    memberCount: day.memberCount,
    missingCount: day.missingCount,
    nonTradableCount: day.nonTradableCount,
    advanceRatio,
    thinSample: day.thinSample,
    method:
      '成分上涨比例 = 上涨成分数 ÷ 有效成分数 × 100（有效成分 = 锚点批次内有涨幅的 active 成分）；停牌 / 缺失不计入分母；与板块指数无关',
    warnings,
  };
};

const ladderLevels = (limitUp: LimitUpLadder | null): ReadonlyMap<string, number> | null => {
  if (limitUp === null) return null;
  if (limitUp.total === 0 && limitUp.warnings.length > 0) return null;
  const levels = new Map<string, number>();
  for (const level of limitUp.levels) {
    for (const entry of level.stocks) levels.set(entry.code, entry.ladderLevel);
  }
  return levels;
};

const sortMembers = (members: readonly SectorMemberDetail[]): SectorMemberDetail[] =>
  [...members].sort((left, right) => {
    if (left.dayChangePct === null && right.dayChangePct !== null) return 1;
    if (left.dayChangePct !== null && right.dayChangePct === null) return -1;
    if (left.dayChangePct !== null && right.dayChangePct !== null) {
      if (right.dayChangePct !== left.dayChangePct) return right.dayChangePct - left.dayChangePct;
    }
    return left.code.localeCompare(right.code);
  });

/** 成分明细：日涨幅、窗口涨幅、窗口成交额增量与占板块增量比、封板与停牌状态。 */
export const buildSectorMemberDetails = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly anchor: MarketSnapshotBatch;
  readonly windowRef: SectorWindowRef;
  readonly windowStart: MarketSnapshotBatch | null;
  readonly sectorAmountDelta: number | null;
  readonly limitUp: LimitUpLadder | null;
}): SectorMemberDetail[] => {
  const members = activeMembersOf(input.members);
  const anchorItems = itemMap(input.anchor);
  const startItems = itemMap(input.windowStart);
  const levels = ladderLevels(input.limitUp);
  const shareBase =
    input.sectorAmountDelta !== null && input.sectorAmountDelta > 0
      ? input.sectorAmountDelta
      : null;

  const details = members.map((membership): SectorMemberDetail => {
    const item = anchorItems.get(membership.stockId);
    const warnings: string[] = [];
    const nonTradable = isNonTradable(membership);
    if (nonTradable) {
      warnings.push(
        `non_tradable: 成分状态为 ${membership.memberStatus}，不计入涨幅 / 成交占比口径`,
      );
    }
    if (item === undefined) {
      warnings.push('missing_batch_item: 锚点批次没有该成分，涨幅与成交额缺失');
    }

    const dayChangePct = nonTradable ? null : (item?.changePct ?? null);
    if (!nonTradable && item !== undefined && item.changePct === undefined) {
      warnings.push('missing_change_pct: 批次条目缺涨幅');
    }

    let windowChangePct: number | null = null;
    if (!nonTradable && input.windowRef.status !== 'unavailable') {
      const startClose = startItems.get(membership.stockId)?.close;
      const currentClose = item?.close;
      if (
        startClose !== undefined &&
        currentClose !== undefined &&
        startClose > 0 &&
        currentClose > 0
      ) {
        windowChangePct = round4((currentClose / startClose - 1) * 100);
      } else {
        warnings.push('missing_window_price: 窗口两端缺价格，窗口涨幅缺失');
      }
    }

    let windowAmountDelta: number | null = null;
    if (!nonTradable) {
      const startAmount = startItems.get(membership.stockId)?.amount;
      const currentAmount = item?.amount;
      if (startAmount !== undefined && currentAmount !== undefined) {
        windowAmountDelta = round2(currentAmount - startAmount);
      } else {
        warnings.push('missing_window_amount: 窗口两端缺成交额，增量缺失');
      }
    }

    const windowAmountSharePct =
      windowAmountDelta === null || shareBase === null
        ? null
        : round2((windowAmountDelta / shareBase) * 100);
    if (windowAmountDelta !== null && shareBase === null) {
      warnings.push('amount_share_unavailable: 板块窗口增量合计为空或非正，占比无意义');
    }

    const sealed = levels === null ? null : levels.has(codeOfStockId(membership.stockId));
    const ladderLevel = levels?.get(codeOfStockId(membership.stockId)) ?? null;

    return {
      stockId: membership.stockId,
      code: codeOfStockId(membership.stockId),
      name: item?.name ?? null,
      memberStatus: membership.memberStatus,
      inBatch: item !== undefined,
      dayChangePct,
      windowChangePct,
      windowAmountDelta,
      windowAmountSharePct,
      sealed,
      ladderLevel,
      warnings,
    };
  });

  return sortMembers(details);
};

/** 领先顺序：逐时点排序，标出与上一有样本时点相比是否变化；不生成事件。 */
export const buildSectorLeaderOrder = (
  series: readonly SectorTrendSeries[],
): SectorLeaderOrderPoint[] => {
  const pointCount = series[0]?.points.length ?? 0;
  let previousOrder: readonly string[] | null = null;
  const points: SectorLeaderOrderPoint[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    const sampledAt = series[0]?.points[index]?.sampledAt;
    if (sampledAt === undefined) continue;
    const entries = series
      .flatMap((entry) => {
        const value = entry.points[index]?.value ?? null;
        return value === null ? [] : [{ sectorId: entry.sectorId, name: entry.name, value }];
      })
      .sort((left, right) => {
        if (right.value !== left.value) return right.value - left.value;
        const byName = left.name.localeCompare(right.name);
        return byName !== 0 ? byName : left.sectorId.localeCompare(right.sectorId);
      })
      .map((entry, position) => ({ ...entry, rank: position + 1 }));
    const missingSectorIds = series
      .filter((entry) => (entry.points[index]?.value ?? null) === null)
      .map((entry) => entry.sectorId);
    const order = entries.map((entry) => entry.sectorId);
    const reordered =
      previousOrder !== null &&
      order.length > 0 &&
      (previousOrder.length !== order.length ||
        order.some((sectorId, position) => previousOrder?.[position] !== sectorId));
    points.push({
      sampledAt,
      entries,
      missingSectorIds,
      reordered,
      previousOrder: previousOrder === null ? null : [...previousOrder],
    });
    if (order.length > 0) previousOrder = order;
  }
  return points;
};

const DETAIL_NOTES: readonly string[] = [
  '板块走势为成分等权合成（首个有样本批次 = 100）；本地没有按板块供应商代码保存的指数序列，不用大盘指数冒充。',
  '成分上涨比例独立于板块走势与板块日涨幅：上涨数 ÷ 有效成分数，停牌与缺失不计入分母。',
  '对照板块各自归一化，基准时点可能不同；跨序列比较先看基准时点与缺失时点。',
  '概念成分可重叠，成交占比不可加总为市场总量；缺失样本一律不补零。',
  SECTOR_TREND_LEADER_NOTE,
];

const anchorSummary = (batch: MarketSnapshotBatch): NonNullable<SectorDetail['anchor']> => ({
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

const EMPTY_REASON_TEXT: Readonly<Record<SectorDetailEmptyReason, string>> = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '该板块没有 active 成分',
  sector_not_found: '指定的板块不在当前目录中',
};

/** 空态详情：保留最近批次与板块身份（如有），所有数据维度缺失并带同一原因。 */
export const buildSectorDetailEmpty = (input: {
  readonly reason: SectorDetailEmptyReason;
  readonly sector: SectorCatalogEntry | null;
  readonly latest: MarketSnapshotBatch | null;
  readonly window: SectorWindowKey;
}): SectorDetail => {
  if (input.sector !== null && input.reason === 'sector_not_found') {
    throw new InvariantError('板块详情的 sector_not_found 空态不得携带板块身份');
  }
  const reasonText = `${input.reason}: ${EMPTY_REASON_TEXT[input.reason]}`;
  const windowRef = (key: SectorWindowKey): SectorWindowRef => ({
    key,
    minutes: key === 'w5' ? 5 : 15,
    status: 'unavailable',
    targetSampledAt: null,
    startSampledAt: null,
    spanMs: null,
    reason: reasonText,
    warnings: [],
  });
  const parsed = SectorDetailSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    sector: input.sector === null ? null : identityOf(input.sector),
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : anchorSummary(input.latest),
    window: input.window,
    windows: { w5: windowRef('w5'), w15: windowRef('w15') },
    trend: null,
    comparisons: [],
    unresolvedSectorIds: [],
    breadth: null,
    day: null,
    windowMetric: null,
    turnoverWindow: null,
    turnover: null,
    limitUpBlock: null,
    limitUp: null,
    members: [],
    leaderOrder: [],
    coverage: {
      batchCount: 0,
      trendPointCount: 0,
      memberCount: 0,
      comparisonCount: 0,
      unresolvedComparisonCount: 0,
    },
    notes: [...DETAIL_NOTES],
  });
  assertSectorDetailInvariants(parsed);
  return parsed;
};

export interface SectorDetailInput {
  readonly sector: SectorCatalogEntry;
  readonly comparisons: readonly SectorCatalogEntry[];
  readonly unresolvedSectorIds: readonly string[];
  /** 目标板块与对照板块的 active 成分（按 sectorId 分组）。 */
  readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
  /** 当日已发布批次，按采样时点升序，最后一个是锚点。 */
  readonly batches: readonly MarketSnapshotBatch[];
  readonly window: SectorWindowKey;
  readonly windowStarts: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  readonly limitUp: LimitUpLadder | null;
  readonly limitUpError: string | null;
}

export const buildSectorDetail = (input: SectorDetailInput): SectorDetail => {
  const anchor = input.batches.at(-1);
  if (anchor === undefined) {
    throw new InvariantError('板块详情需要至少一个已发布批次');
  }
  const members = input.membersBySector.get(input.sector.id) ?? [];
  if (activeMembersOf(members).length === 0) {
    throw new InvariantError('板块详情需要目标板块的 active 成分');
  }

  const trend = buildSectorTrendSeries({ sector: input.sector, members, batches: input.batches });
  const comparisons = input.comparisons.map((sector) =>
    buildSectorTrendSeries({
      sector,
      members: input.membersBySector.get(sector.id) ?? [],
      batches: input.batches,
    }),
  );
  const anchorItems = itemMap(anchor);
  const windowRefs: Record<SectorWindowKey, SectorWindowRef> = {
    w5: resolveSectorWindow({ key: 'w5', anchor, start: input.windowStarts.w5 }),
    w15: resolveSectorWindow({ key: 'w15', anchor, start: input.windowStarts.w15 }),
  };
  // 窗口不可比时不拿「最近的更早批次」冒充窗口起点：窗口涨幅 / 增量一律缺失。
  const start =
    windowRefs[input.window].status === 'unavailable' ? null : input.windowStarts[input.window];
  const startItems = itemMap(start);
  const day = buildSectorDayMetric({ members, items: anchorItems });
  const windowMetric = buildSectorWindowMetric({
    key: input.window,
    window: windowRefs[input.window],
    members,
    items: anchorItems,
    startItems,
  });
  const turnoverWindow = buildSectorTurnoverWindow({
    window: input.window,
    windowRef: windowRefs[input.window],
    anchor,
    start,
  });
  const turnover = buildSectorTurnoverMetric({
    denominator: turnoverWindow,
    members,
    items: anchorItems,
    startItems,
  });
  const limitUpBlock = buildSectorLimitUpBlock({
    limitUp: input.limitUp,
    limitUpError: input.limitUpError,
  });
  const ladderCodes = new Set(
    (input.limitUp?.levels ?? []).flatMap((level) => level.stocks.map((entry) => entry.code)),
  );
  const limitUp = {
    value:
      limitUpBlock.status === 'unavailable'
        ? null
        : members.filter((membership) => ladderCodes.has(codeOfStockId(membership.stockId))).length,
    status: limitUpBlock.status === 'unavailable' ? 'unavailable' : ('complete' as const),
    method: '封板数 = 当日连板天梯中出现的板块 active 成分数；无天梯快照时缺失，不写 0',
    warnings:
      limitUpBlock.status === 'unavailable'
        ? [limitUpBlock.reason ?? 'limit_up_missing: 无天梯快照']
        : [],
  };
  const memberDetails = buildSectorMemberDetails({
    members,
    anchor,
    windowRef: windowRefs[input.window],
    windowStart: start,
    sectorAmountDelta: turnover.numeratorAmount,
    limitUp: input.limitUp,
  });
  const leaderOrder = buildSectorLeaderOrder([trend, ...comparisons]);

  const notes = [...DETAIL_NOTES];
  const baseTimes = new Set(
    [trend, ...comparisons].map((series) =>
      series.coverage.baseSampledAt === null
        ? 'missing'
        : series.coverage.baseSampledAt.toISOString(),
    ),
  );
  if (baseTimes.size > 1) {
    notes.push(
      'base_time_mismatch: 各序列的 100 基准时点不同，跨序列比较领先顺序时只比较同一时点的相对位置，不比较累计涨幅。',
    );
  }
  if (input.unresolvedSectorIds.length > 0) {
    notes.push(
      `comparison_unresolved: 对照板块 ${input.unresolvedSectorIds.join(' / ')} 不在当前目录中，已从对照与领先顺序中排除。`,
    );
  }

  const parsed = SectorDetailSchema.parse({
    state: 'ready',
    sector: identityOf(input.sector),
    tradingDate: anchor.tradingDate,
    anchor: anchorSummary(anchor),
    window: input.window,
    windows: windowRefs,
    trend,
    comparisons,
    unresolvedSectorIds: [...input.unresolvedSectorIds],
    breadth: buildSectorBreadth(day),
    day,
    windowMetric,
    turnoverWindow,
    turnover,
    limitUpBlock,
    limitUp,
    members: memberDetails,
    leaderOrder,
    coverage: {
      batchCount: input.batches.length,
      trendPointCount: trend.points.length,
      memberCount: activeMembersOf(members).length,
      comparisonCount: comparisons.length,
      unresolvedComparisonCount: input.unresolvedSectorIds.length,
    },
    notes,
  });
  assertSectorDetailInvariants(parsed);
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
      `sector detail ${name} 样本数必须等于有效 + 缺失 + 停牌退市（${metric.sampleCount} + ${metric.missingCount} + ${metric.nonTradableCount} ≠ ${metric.memberCount}）`,
    );
  }
};

const assertMetricStatus = (
  name: string,
  metric: {
    readonly status: string;
    readonly value?: unknown;
    readonly warnings: readonly string[];
  },
): void => {
  if ((metric.value === null || metric.value === undefined) !== (metric.status === 'unavailable')) {
    throw new InvariantError(`sector detail ${name} 只有缺失值才允许 unavailable`);
  }
  if (metric.status !== 'complete' && metric.warnings.length === 0) {
    throw new InvariantError(`sector detail ${name} 非 complete 时必须给出缺失原因`);
  }
};

const assertTrendSeries = (name: string, series: SectorTrendSeries): void => {
  if (series.points.length !== series.coverage.pointCount) {
    throw new InvariantError(`sector detail ${name} 走势点数必须与覆盖统计一致`);
  }
  const available = series.points.filter((point) => point.value !== null).length;
  if (available !== series.coverage.availablePointCount) {
    throw new InvariantError(`sector detail ${name} 可用走势点数必须与覆盖统计一致`);
  }
  if (series.coverage.missingPointCount !== series.points.length - available) {
    throw new InvariantError(`sector detail ${name} 缺失走势点数必须与覆盖统计一致`);
  }
  for (const point of series.points) {
    assertCounted(`${name}@${point.sampledAt.toISOString()}`, point);
    assertMetricStatus(`${name}@${point.sampledAt.toISOString()}`, point);
  }
  if (series.method !== 'sector_index' && series.indexFallbackReason === null) {
    throw new InvariantError(`sector detail ${name} 非指数口径必须说明指数不可用的原因`);
  }
};

export const assertSectorDetailInvariants = (detail: SectorDetail): void => {
  if (detail.state === 'empty') {
    if (detail.emptyReason === undefined) {
      throw new InvariantError('sector detail 空态必须给出原因');
    }
    if (detail.trend !== null || detail.members.length > 0 || detail.leaderOrder.length > 0) {
      throw new InvariantError('sector detail 空态不得携带趋势、成分或领先顺序');
    }
    if (detail.emptyReason === 'sector_not_found' && detail.sector !== null) {
      throw new InvariantError('sector detail sector_not_found 不得携带板块身份');
    }
  } else {
    if (detail.emptyReason !== undefined) {
      throw new InvariantError('sector detail ready 不得携带空态原因');
    }
    if (detail.sector === null || detail.anchor === null || detail.trend === null) {
      throw new InvariantError('sector detail ready 必须带板块身份、锚点与走势');
    }
    if (detail.trend.sectorId !== detail.sector.sectorId) {
      throw new InvariantError('sector detail 走势必须属于目标板块');
    }
    if (detail.breadth === null || detail.day === null || detail.windowMetric === null) {
      throw new InvariantError('sector detail ready 必须给出宽度与板块涨幅口径');
    }
    if (detail.turnoverWindow === null || detail.turnover === null) {
      throw new InvariantError('sector detail ready 必须给出成交占比与分母');
    }
    if (detail.limitUpBlock === null || detail.limitUp === null) {
      throw new InvariantError('sector detail ready 必须给出封板口径');
    }
    if (detail.coverage.trendPointCount !== detail.trend.points.length) {
      throw new InvariantError('sector detail 趋势点数必须与覆盖统计一致');
    }
    if (detail.coverage.memberCount !== detail.trend.points.at(-1)?.memberCount) {
      throw new InvariantError('sector detail 成分数必须与走势时点一致');
    }
    if (detail.comparisons.length !== detail.coverage.comparisonCount) {
      throw new InvariantError('sector detail 对照序列数必须与覆盖统计一致');
    }
    if (detail.unresolvedSectorIds.length !== detail.coverage.unresolvedComparisonCount) {
      throw new InvariantError('sector detail 未解析对照数必须与覆盖统计一致');
    }
    if (detail.comparisons.some((series) => series.sectorId === detail.sector?.sectorId)) {
      throw new InvariantError('sector detail 对照序列不得重复目标板块');
    }
    assertTrendSeries('trend', detail.trend);
    for (const series of detail.comparisons)
      assertTrendSeries(`comparison(${series.name})`, series);

    if (
      detail.breadth.advancing + detail.breadth.declining + detail.breadth.unchanged !==
      detail.breadth.sampleCount
    ) {
      throw new InvariantError('sector detail 涨跌平分类必须等于有效成分数');
    }
    if ((detail.breadth.advanceRatio === null) !== (detail.breadth.sampleCount === 0)) {
      throw new InvariantError('sector detail 上涨比例只在无有效成分时缺失');
    }
    assertCounted('day', detail.day);
    assertCounted('window', detail.windowMetric);
    assertCounted('turnover', detail.turnover);
    assertMetricStatus('day', detail.day);
    assertMetricStatus('window', detail.windowMetric);
    assertMetricStatus('turnover', detail.turnover);
    assertMetricStatus('limitUp', detail.limitUp);
    if ((detail.limitUp.value === null) !== (detail.limitUpBlock.status === 'unavailable')) {
      throw new InvariantError('sector detail 封板数缺失状态必须与天梯块一致');
    }
    if (detail.members.length !== detail.day.memberCount) {
      throw new InvariantError('sector detail 成分明细必须覆盖全部 active 成分');
    }
    for (const member of detail.members) {
      if ((member.sealed === null) !== (detail.limitUpBlock.status === 'unavailable')) {
        throw new InvariantError('sector detail 成分封板状态必须与天梯块一致');
      }
      if (member.windowAmountSharePct !== null && detail.turnover.numeratorAmount === null) {
        throw new InvariantError('sector detail 成分成交占比不得脱离板块增量');
      }
    }
    let previousOrder: readonly string[] | null = null;
    for (const point of detail.leaderOrder) {
      const order = point.entries.map((entry) => entry.sectorId);
      if (point.missingSectorIds.some((sectorId) => order.includes(sectorId))) {
        throw new InvariantError('sector detail 领先顺序缺失板块不得同时有名次');
      }
      point.entries.forEach((entry, index) => {
        if (entry.rank !== index + 1) {
          throw new InvariantError('sector detail 领先顺序名次必须连续且从 1 开始');
        }
        if (index > 0) {
          const previous = point.entries[index - 1];
          if (previous !== undefined && entry.value > previous.value) {
            throw new InvariantError('sector detail 领先顺序必须按走势值降序');
          }
        }
      });
      if (point.previousOrder !== null) {
        if (previousOrder === null) {
          throw new InvariantError('sector detail 首个有样本时点不得有上一顺序');
        }
        if (point.previousOrder.join('|') !== previousOrder.join('|')) {
          throw new InvariantError('sector detail 上一顺序必须与上一个有样本时点一致');
        }
      }
      if (order.length > 0) previousOrder = order;
    }
  }
};
