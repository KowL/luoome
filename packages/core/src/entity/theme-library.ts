import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { EvidenceDimensionStatusSchema } from './ashare-sentiment.js';
import type { LimitUpLadder } from './limit-up-ladder.js';
import { MAINSTREAM_THEMES, type MainstreamThemeDefinition } from './mainstream-themes.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  type SectorMemberStatus,
  SectorMemberStatusSchema,
  SectorStockIdSchema,
  SectorVendorCodeSchema,
  type StockSectorMembership,
} from './sector-catalog.js';
import {
  buildSectorDayMetric,
  buildSectorWindowMetric,
  resolveSectorWindow,
  SECTOR_EMPTY_REASON_TEXT,
  SECTOR_INTRADAY_WINDOWS,
  SectorDayMetricSchema,
  SectorRankingAnchorSchema,
  type SectorWindowKey,
  SectorWindowKeySchema,
  SectorWindowMetricSchema,
  type SectorWindowRef,
  SectorWindowRefSchema,
  sectorRankingAnchorSummary,
} from './sector-intraday-ranking.js';

/**
 * 系统题材库：由人维护的题材、固定顺序与成分生效区间。
 *
 * - 原始扶摇概念目录 / 成分仍留在 sector-catalog，本库只保存导入后的首版种子与人工改动；
 * - 题材 id 稳定：种子来自 core 标准题材定义的 id，人工新增使用本地生成的不透明 id；
 * - 成分是多对多历史：每次增删产生一条生效区间，回放只看当时有效的区间，
 *   不用今天的成分重算历史，也不伪造导入前的人工维护历史；
 * - 导入只补齐缺失的种子题材与它们首版成分，不覆盖已存在题材的改名 / 归档 / 顺序 / 成分增删。
 */

export const ThemeLibraryStateSchema = z.enum(['active', 'archived']);
export type ThemeLibraryState = z.infer<typeof ThemeLibraryStateSchema>;

export const ThemeLibraryMemberOriginSchema = z.enum(['seed', 'manual', 'auto']);
export type ThemeLibraryMemberOrigin = z.infer<typeof ThemeLibraryMemberOriginSchema>;

const ThemeLibraryIdSchema = z.string().trim().min(1).max(64);

export const ThemeLibraryThemeSchema = z
  .object({
    id: ThemeLibraryIdSchema,
    name: z.string().trim().min(1).max(40),
    state: ThemeLibraryStateSchema,
    sortOrder: z.number().int().nonnegative(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    archivedAt: z.coerce.date().nullable(),
  })
  .superRefine((theme, ctx) => {
    if (theme.state === 'active' && theme.archivedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['archivedAt'],
        message: 'active theme must not carry archivedAt',
      });
    }
    if (theme.createdAt.getTime() > theme.updatedAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt must not be earlier than createdAt',
      });
    }
  });
export type ThemeLibraryTheme = z.infer<typeof ThemeLibraryThemeSchema>;

export const ThemeLibraryThemeSourceSchema = z.object({
  themeId: ThemeLibraryIdSchema,
  vendorCode: SectorVendorCodeSchema,
  sectorId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  createdAt: z.coerce.date(),
});
export type ThemeLibraryThemeSource = z.infer<typeof ThemeLibraryThemeSourceSchema>;

export const ThemeLibraryMemberSchema = z
  .object({
    id: z.string().min(1),
    themeId: ThemeLibraryIdSchema,
    stockId: SectorStockIdSchema,
    origin: ThemeLibraryMemberOriginSchema,
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  })
  .superRefine((member, ctx) => {
    if (
      member.effectiveTo !== null &&
      member.effectiveTo.getTime() <= member.effectiveFrom.getTime()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effectiveTo must be later than effectiveFrom',
      });
    }
  });
export type ThemeLibraryMember = z.infer<typeof ThemeLibraryMemberSchema>;

/** 某时点生效：起点不晚于 at，终点为空或晚于 at（区间左闭右开）。 */
export const isThemeLibraryMemberEffectiveAt = (member: ThemeLibraryMember, at: Date): boolean =>
  member.effectiveFrom.getTime() <= at.getTime() &&
  (member.effectiveTo === null || member.effectiveTo.getTime() > at.getTime());

export const selectThemeLibraryMembersAt = (
  members: readonly ThemeLibraryMember[],
  at: Date,
): readonly ThemeLibraryMember[] =>
  members.filter((member) => isThemeLibraryMemberEffectiveAt(member, at));

export interface ThemeLibrarySeedSource {
  readonly vendorCode: string;
  readonly sectorId: string;
  readonly name: string;
}

export interface ThemeLibrarySeedTheme {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly sources: readonly ThemeLibrarySeedSource[];
  readonly stockIds: readonly string[];
}

export const ThemeLibrarySeedSkipReasonSchema = z.enum([
  'no_source',
  'no_members',
  'name_conflict',
]);
export type ThemeLibrarySeedSkipReason = z.infer<typeof ThemeLibrarySeedSkipReasonSchema>;

export interface ThemeLibrarySeedPlan {
  readonly themes: readonly ThemeLibrarySeedTheme[];
  readonly skipped: readonly {
    readonly themeId: string;
    readonly name: string;
    readonly reason: ThemeLibrarySeedSkipReason;
  }[];
}

/**
 * 首版种子：core 标准题材定义 × 本地已同步扶摇概念目录的 active 成分并集。
 * 一个股票只进一次；定义里没有本地来源或没有有效成分的题材不伪装成已导入。
 */
export const buildThemeLibrarySeed = (input: {
  readonly catalog: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
  readonly definitions?: readonly MainstreamThemeDefinition[];
}): ThemeLibrarySeedPlan => {
  const definitions = input.definitions ?? MAINSTREAM_THEMES;
  const concepts = input.catalog.filter(
    (sector) => sector.kind === 'concept' && sector.state === 'active',
  );
  const conceptByVendorCode = new Map(concepts.map((sector) => [sector.vendorCode, sector]));
  const activeMemberIdsBySector = new Map<string, Set<string>>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const ids = activeMemberIdsBySector.get(membership.sectorId) ?? new Set<string>();
    ids.add(membership.stockId);
    activeMemberIdsBySector.set(membership.sectorId, ids);
  }

  const themes: ThemeLibrarySeedTheme[] = [];
  const skipped: ThemeLibrarySeedPlan['skipped'][number][] = [];
  for (const definition of definitions) {
    const sources: ThemeLibrarySeedSource[] = [];
    const stockIds = new Set<string>();
    for (const vendorCode of definition.vendorCodes) {
      const concept = conceptByVendorCode.get(vendorCode);
      if (concept === undefined) continue;
      sources.push({ vendorCode, sectorId: concept.id, name: concept.name });
      for (const stockId of activeMemberIdsBySector.get(concept.id) ?? []) stockIds.add(stockId);
    }
    if (sources.length === 0) {
      skipped.push({ themeId: definition.id, name: definition.name, reason: 'no_source' });
      continue;
    }
    if (stockIds.size === 0) {
      skipped.push({ themeId: definition.id, name: definition.name, reason: 'no_members' });
      continue;
    }
    themes.push({
      id: definition.id,
      name: definition.name,
      sortOrder: themes.length,
      sources,
      stockIds: [...stockIds].sort(),
    });
  }
  return { themes, skipped };
};

export const ThemeLibraryImportStatusSchema = z.enum([
  'imported',
  'unchanged',
  'already_initialized',
]);
export type ThemeLibraryImportStatus = z.infer<typeof ThemeLibraryImportStatusSchema>;

export const ThemeLibrarySeedSkipSchema = z.object({
  themeId: z.string().min(1),
  name: z.string().min(1),
  reason: z.enum(['no_source', 'no_members', 'name_conflict']),
});
export type ThemeLibrarySeedSkip = z.infer<typeof ThemeLibrarySeedSkipSchema>;

export const ThemeLibraryImportSummarySchema = z.object({
  importId: z.string().min(1),
  source: z.string().min(1),
  status: ThemeLibraryImportStatusSchema,
  appliedAt: z.coerce.date(),
  createdThemes: z.number().int().nonnegative(),
  createdMembers: z.number().int().nonnegative(),
  createdSources: z.number().int().nonnegative(),
  skippedThemes: z.array(ThemeLibrarySeedSkipSchema),
});
export type ThemeLibraryImportSummary = z.infer<typeof ThemeLibraryImportSummarySchema>;

export interface ThemeLibraryImportInput {
  readonly importId: string;
  readonly source: string;
  readonly appliedAt: Date;
  readonly seed: ThemeLibrarySeedPlan;
}

export const ThemeLibraryEmptyReasonSchema = z.enum([
  ...(['no_batch', 'pre_open', 'non_trading_day', 'no_today_batch'] as const),
  'no_theme_library',
  'no_active_theme',
  'no_members',
]);
export type ThemeLibraryEmptyReason = z.infer<typeof ThemeLibraryEmptyReasonSchema>;

export const THEME_LIBRARY_EMPTY_REASON_TEXT: Readonly<Record<ThemeLibraryEmptyReason, string>> = {
  no_batch: SECTOR_EMPTY_REASON_TEXT.no_batch,
  pre_open: SECTOR_EMPTY_REASON_TEXT.pre_open,
  non_trading_day: SECTOR_EMPTY_REASON_TEXT.non_trading_day,
  no_today_batch: SECTOR_EMPTY_REASON_TEXT.no_today_batch,
  no_theme_library: '系统题材库尚未导入或新建题材',
  no_active_theme: '系统题材库里没有已启用题材',
  no_members: '已启用题材当前没有生效成分',
};

export const ThemeLibraryTrendPointSchema = z.object({
  sampledAt: z.coerce.date(),
  /** 该批次当时有效成分的日涨幅等权均值（%）；无样本时为 null，不插值。 */
  value: z.number().finite().nullable(),
  sampleCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  nonTradableCount: z.number().int().nonnegative(),
  status: EvidenceDimensionStatusSchema,
  warnings: z.array(z.string()),
});
export type ThemeLibraryTrendPoint = z.infer<typeof ThemeLibraryTrendPointSchema>;

export const ThemeLibraryTrendSchema = z.object({
  method: z.literal('constituent_equal_weight_change_pct'),
  methodNote: z.string().min(1),
  coverage: z.object({
    batchCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    availablePointCount: z.number().int().nonnegative(),
    firstSampledAt: z.coerce.date().nullable(),
    lastSampledAt: z.coerce.date().nullable(),
  }),
  points: z.array(ThemeLibraryTrendPointSchema),
  warnings: z.array(z.string()),
});
export type ThemeLibraryTrend = z.infer<typeof ThemeLibraryTrendSchema>;

export const ThemeLibraryMemberPerformanceSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1).nullable(),
  memberStatus: SectorMemberStatusSchema,
  effectiveFrom: z.coerce.date(),
  dayChangePct: z.number().finite().nullable(),
  window5ChangePct: z.number().finite().nullable(),
  window15ChangePct: z.number().finite().nullable(),
  todayAmount: z.number().finite().nullable(),
  /** 是否在当日连板天梯中；无天梯快照时为 null。 */
  sealed: z.boolean().nullable(),
  ladderLevel: z.number().int().positive().nullable(),
});
export type ThemeLibraryMemberPerformance = z.infer<typeof ThemeLibraryMemberPerformanceSchema>;

/**
 * 轮动卡里的有限个股摘要：只给一个口径下的前五只，不铺开全部成分。
 * `value` 与该卡题材涨跌幅同口径（日涨幅或窗口涨幅），缺失成分不进入列表。
 */
export const ThemeLibraryMemberLeaderSchema = z.object({
  stockId: z.string().min(1),
  name: z.string().min(1).nullable(),
  value: z.number().finite(),
  sealed: z.boolean().nullable(),
  ladderLevel: z.number().int().positive().nullable(),
});
export type ThemeLibraryMemberLeader = z.infer<typeof ThemeLibraryMemberLeaderSchema>;

/** 轮动卡的两个可切换口径；`window` 跟随请求的 window（总览只请求 w15）。 */
export const ThemeLibraryThemeLeaderSetSchema = z.object({
  day: z.array(ThemeLibraryMemberLeaderSchema),
  window: z.array(ThemeLibraryMemberLeaderSchema),
});
export type ThemeLibraryThemeLeaderSet = z.infer<typeof ThemeLibraryThemeLeaderSetSchema>;

export const ThemeLibraryThemeRowSchema = z.object({
  themeId: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  day: SectorDayMetricSchema,
  window5: SectorWindowMetricSchema,
  window15: SectorWindowMetricSchema,
  trend: ThemeLibraryTrendSchema,
  /** 轮动卡前五只：上涨按涨幅降序、下跌按跌幅绝对值降序。 */
  leaders: ThemeLibraryThemeLeaderSetSchema,
  members: z.array(ThemeLibraryMemberPerformanceSchema),
});
export type ThemeLibraryThemeRow = z.infer<typeof ThemeLibraryThemeRowSchema>;

/** 时间轴可选批次：当交易日全部已发布批次，与当前选中卡 / 时点无关，回拖后仍能向前选。 */
export const ThemeLibraryRotationBatchSchema = z.object({
  sampledAt: z.coerce.date(),
  complete: z.boolean(),
});
export type ThemeLibraryRotationBatch = z.infer<typeof ThemeLibraryRotationBatchSchema>;

export const ThemeLibraryRotationSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: ThemeLibraryEmptyReasonSchema.optional(),
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  anchor: SectorRankingAnchorSchema.nullable(),
  window: SectorWindowKeySchema,
  windows: z.object({ w5: SectorWindowRefSchema, w15: SectorWindowRefSchema }),
  coverage: z.object({
    themeCount: z.number().int().nonnegative(),
    memberCount: z.number().int().nonnegative(),
  }),
  themes: z.array(ThemeLibraryThemeRowSchema),
  /** 时间轴可选批次，升序；不含午休与缺批。 */
  batches: z.array(ThemeLibraryRotationBatchSchema),
  notes: z.array(z.string()),
});
export type ThemeLibraryRotation = z.infer<typeof ThemeLibraryRotationSchema>;

const THEME_LIBRARY_NOTES: readonly string[] = [
  '题材与成分由系统题材库维护；作战室只展示已启用题材，库内固定顺序用于同值定序，榜单按当前口径涨跌排列。',
  '日涨幅和窗口涨幅取成分股等权均值。实时视图使用当前成分和最新批次报价，回放使用行情批次时生效的成分。',
  '轮动卡内个股与该卡同一时点、同一口径：上排取涨幅最高的五只，下排取跌幅最大的五只，缺数跳过，不足五只留白。',
  '日内走势 = 每个已发布批次当时有效成分的日涨幅等权均值，缺口不插值、不补零。',
  '时间轴只列当日已发布的行情批次，不含午休与缺批；回拖后仍可选当日更晚的已发布批次。',
  '原始扶摇概念目录与成分保留在来源 / 管理端，不在此展示。',
];

const THEME_TREND_METHOD_NOTE =
  '每个批次按当时生效成分的 changePct 等权平均；只使用该批次已有报价，缺失不插值、不沿用前值';

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const itemMap = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((item) => [item.id, item]));

const isNonTradableStatus = (status: SectorMemberStatus): boolean =>
  status === 'suspended' || status === 'delisted';

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

const isThin = (memberCount: number, sampleCount: number): boolean =>
  sampleCount < 3 || (memberCount > 0 && sampleCount * 2 < memberCount);

/** 成分区间 → 既有板块指标可复用的成分投影；状态只影响停牌 / 退市剔除。 */
const toStockSectorMembership = (input: {
  readonly themeId: string;
  readonly member: ThemeLibraryMember;
  readonly memberStatus: SectorMemberStatus;
}): StockSectorMembership => ({
  sectorId: input.themeId,
  stockId: input.member.stockId,
  source: 'theme-library',
  state: 'active',
  memberStatus: input.memberStatus,
  firstSeenAt: input.member.effectiveFrom,
  lastSeenAt: input.member.effectiveTo ?? input.member.effectiveFrom,
  missingSince: null,
});

const windowReturn = (current?: MarketSnapshotItem, start?: MarketSnapshotItem): number | null => {
  const endPrice = current?.close;
  const startPrice = start?.close;
  if (endPrice === undefined || startPrice === undefined || endPrice <= 0 || startPrice <= 0)
    return null;
  return round4((endPrice / startPrice - 1) * 100);
};

const buildThemeTrend = (input: {
  readonly themeId: string;
  readonly members: readonly ThemeLibraryMember[];
  readonly batches: ReadonlyArray<{
    sampledAt: Date;
    complete: boolean;
    items: ReadonlyMap<string, MarketSnapshotItem>;
  }>;
  readonly statusByStock: ReadonlyMap<string, SectorMemberStatus>;
}): ThemeLibraryTrend => {
  const points = input.batches.map((batch): ThemeLibraryTrendPoint => {
    const effective = selectThemeLibraryMembersAt(input.members, batch.sampledAt);
    const items = batch.items;
    const changePcts: number[] = [];
    let missingCount = 0;
    let nonTradableCount = 0;
    for (const member of effective) {
      const status = input.statusByStock.get(member.stockId) ?? 'unknown';
      if (isNonTradableStatus(status)) {
        nonTradableCount += 1;
        continue;
      }
      const changePct = items.get(member.stockId)?.changePct;
      if (changePct === undefined) {
        missingCount += 1;
        continue;
      }
      changePcts.push(changePct);
    }
    const memberCount = effective.length;
    const sampleCount = changePcts.length;
    const value =
      sampleCount === 0
        ? null
        : round4(changePcts.reduce((sum, current) => sum + current, 0) / sampleCount);
    const thinSample = isThin(memberCount, sampleCount);
    const warnings: string[] = [];
    if (memberCount === 0) warnings.push('no_effective_members: 该批次没有生效成分');
    if (missingCount > 0)
      warnings.push(`missing_change_pct: ${missingCount} 只成分不在该批次或缺涨幅`);
    if (nonTradableCount > 0) warnings.push(`non_tradable: ${nonTradableCount} 只成分已停牌/退市`);
    if (thinSample && memberCount > 0)
      warnings.push(`thin_sample: 有效样本 ${sampleCount} / ${memberCount} 只`);
    return {
      sampledAt: batch.sampledAt,
      value,
      sampleCount,
      memberCount,
      missingCount,
      nonTradableCount,
      status: statusOf({
        hasValue: value !== null,
        missingCount,
        nonTradableCount,
        thinSample,
        batchComplete: batch.complete,
      }),
      warnings,
    };
  });
  const availablePointCount = points.filter((point) => point.value !== null).length;
  const warnings: string[] =
    availablePointCount === points.length
      ? []
      : [
          `missing_trend_points: ${points.length - availablePointCount} / ${points.length} 个时点无可用样本`,
        ];
  return {
    method: 'constituent_equal_weight_change_pct',
    methodNote: THEME_TREND_METHOD_NOTE,
    coverage: {
      batchCount: input.batches.length,
      pointCount: points.length,
      availablePointCount,
      firstSampledAt: input.batches[0]?.sampledAt ?? null,
      lastSampledAt: input.batches.at(-1)?.sampledAt ?? null,
    },
    points,
    warnings,
  };
};

const emptyWindowRef = (key: SectorWindowKey, reason: string): SectorWindowRef => ({
  key,
  minutes: SECTOR_INTRADAY_WINDOWS[key],
  status: 'unavailable',
  targetSampledAt: null,
  startSampledAt: null,
  spanMs: null,
  reason,
  warnings: [],
});

const batchAxis = (batches: readonly MarketSnapshotBatch[]): ThemeLibraryRotationBatch[] =>
  batches
    .map((batch) => ({ sampledAt: batch.sampledAt, complete: batch.completeness.complete }))
    .sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime());

export const buildThemeLibraryRotationEmpty = (input: {
  readonly window: SectorWindowKey;
  readonly reason: ThemeLibraryEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
  /** 当日已发布批次：空态下仍可拖动时间轴与返回最新。 */
  readonly batches?: readonly MarketSnapshotBatch[];
}): ThemeLibraryRotation => {
  const reasonText = `${input.reason}: ${THEME_LIBRARY_EMPTY_REASON_TEXT[input.reason]}`;
  const rotation: ThemeLibraryRotation = {
    state: 'empty',
    emptyReason: input.reason,
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : sectorRankingAnchorSummary(input.latest),
    window: input.window,
    windows: {
      w5: emptyWindowRef('w5', reasonText),
      w15: emptyWindowRef('w15', reasonText),
    },
    coverage: { themeCount: 0, memberCount: 0 },
    themes: [],
    batches: batchAxis(input.batches ?? []),
    notes: [...THEME_LIBRARY_NOTES],
  };
  return rotation;
};

export interface ThemeLibraryRotationInput {
  readonly window: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  readonly windowStarts: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  /** 当日全部已发布批次（升序）：走势只用锚点及之前的，时间轴列全部。 */
  readonly batches: readonly MarketSnapshotBatch[];
  readonly themes: readonly ThemeLibraryTheme[];
  readonly sources: readonly ThemeLibraryThemeSource[];
  readonly members: readonly ThemeLibraryMember[];
  readonly statusByStock: ReadonlyMap<string, SectorMemberStatus>;
  readonly namesByStock: ReadonlyMap<string, string>;
  readonly limitUp: LimitUpLadder | null;
  readonly limitUpError: string | null;
  /** 只返回该题材的成分明细；其他题材只给指标与走势，避免一次响应铺开全部成分。 */
  readonly detailThemeId?: string | null;
  readonly membershipAt?: Date;
}

const anchorItems = (anchor: MarketSnapshotBatch): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map(anchor.items.map((item) => [item.id, item]));

const emptyReasonForTheme = (input: {
  readonly catalog: readonly ThemeLibraryTheme[];
  readonly active: readonly ThemeLibraryTheme[];
  readonly members: readonly ThemeLibraryMember[];
  readonly at: Date;
}): ThemeLibraryEmptyReason | null => {
  if (input.catalog.length === 0) return 'no_theme_library';
  if (input.active.length === 0) return 'no_active_theme';
  if (
    input.members.filter((member) => isThemeLibraryMemberEffectiveAt(member, input.at)).length === 0
  ) {
    return 'no_members';
  }
  return null;
};

/**
 * 轮动卡前五只：方向跟随该题材自身涨跌幅符号，按当前方向从强到弱，缺数跳过不补位。
 * 题材涨跌幅为正按涨幅降序取五只，为负按跌幅绝对值降序取五只；持平 / 缺失不给列表。
 */
const themeLeaderRows = (input: {
  readonly effective: readonly ThemeLibraryMember[];
  readonly sign: number;
  readonly valueAt: (member: ThemeLibraryMember) => number | null;
  readonly statusByStock: ReadonlyMap<string, SectorMemberStatus>;
  readonly namesByStock: ReadonlyMap<string, string>;
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
  readonly limitUp: LimitUpLadder | null;
  readonly ladderCodes: ReadonlySet<string>;
  readonly ladderLevels: ReadonlyMap<string, number>;
}): ThemeLibraryMemberLeader[] => {
  if (input.sign === 0) return [];
  const ranked: { member: ThemeLibraryMember; value: number }[] = [];
  for (const member of input.effective) {
    if (isNonTradableStatus(input.statusByStock.get(member.stockId) ?? 'unknown')) continue;
    const value = input.valueAt(member);
    if (value === null || !Number.isFinite(value)) continue;
    ranked.push({ member, value });
  }
  ranked.sort((left, right) =>
    input.sign > 0
      ? right.value - left.value || left.member.stockId.localeCompare(right.member.stockId)
      : left.value - right.value || left.member.stockId.localeCompare(right.member.stockId),
  );
  return ranked.slice(0, 5).map(({ member, value }): ThemeLibraryMemberLeader => {
    const code = member.stockId.split('.')[0] ?? member.stockId;
    return {
      stockId: member.stockId,
      name: input.namesByStock.get(member.stockId) ?? input.items.get(member.stockId)?.name ?? null,
      value,
      sealed:
        input.limitUp === null
          ? null
          : input.ladderCodes.has(code) || input.ladderCodes.has(member.stockId),
      ladderLevel: input.ladderLevels.get(code) ?? input.ladderLevels.get(member.stockId) ?? null,
    };
  });
};

/**
 * 作战室题材区：按固定顺序返回全部已启用题材，day / w5 / w15、日内走势与轮动卡前五只
 * 都按当时有效成分计算；时间轴批次取自传入的当日已发布批次。
 * 走势只用锚点及之前的批次，不查询未来批次。
 */
export const buildThemeLibraryRotation = (
  input: ThemeLibraryRotationInput,
): ThemeLibraryRotation => {
  const membershipAt = input.membershipAt ?? input.anchor.sampledAt;
  const catalog = [...input.themes];
  const active = catalog
    .filter((theme) => theme.state === 'active')
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  const effectiveMemberCount = active.reduce(
    (sum, theme) =>
      sum +
      selectThemeLibraryMembersAt(
        input.members.filter((member) => member.themeId === theme.id),
        membershipAt,
      ).length,
    0,
  );
  const activeThemeIds = new Set(active.map((theme) => theme.id));
  const emptyReason = emptyReasonForTheme({
    catalog,
    active,
    members: input.members.filter((member) => activeThemeIds.has(member.themeId)),
    at: membershipAt,
  });
  if (emptyReason !== null) {
    return buildThemeLibraryRotationEmpty({
      window: input.window,
      reason: emptyReason,
      latest: input.anchor,
      batches: input.batches,
    });
  }

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
  const items = anchorItems(input.anchor);
  const startItems = {
    w5: itemMap(input.windowStarts.w5),
    w15: itemMap(input.windowStarts.w15),
  };
  const ladderCodes = new Set<string>();
  const ladderLevels = new Map<string, number>();
  for (const level of input.limitUp?.levels ?? []) {
    for (const entry of level.stocks) {
      ladderCodes.add(entry.code);
      ladderLevels.set(entry.code, Math.max(ladderLevels.get(entry.code) ?? 0, level.level));
    }
  }
  const sourcesByTheme = new Map<string, number>();
  for (const source of input.sources) {
    sourcesByTheme.set(source.themeId, (sourcesByTheme.get(source.themeId) ?? 0) + 1);
  }
  const stockIds = new Set(input.members.map((member) => member.stockId));
  const dayBatches = input.batches.filter(
    (batch) => batch.sampledAt.getTime() <= input.anchor.sampledAt.getTime(),
  );
  const batches = dayBatches.map((batch) => ({
    sampledAt: batch.sampledAt,
    complete: batch.completeness.complete,
    items: new Map(
      batch.items.filter((item) => stockIds.has(item.id)).map((item) => [item.id, item]),
    ),
  }));

  const rows = active.map((theme): ThemeLibraryThemeRow => {
    const allMembers = input.members.filter((member) => member.themeId === theme.id);
    const effective = selectThemeLibraryMembersAt(allMembers, membershipAt);
    const memberships = effective.map((member) =>
      toStockSectorMembership({
        themeId: theme.id,
        member,
        memberStatus: input.statusByStock.get(member.stockId) ?? 'unknown',
      }),
    );
    const day = buildSectorDayMetric({ members: memberships, items });
    const window5 = buildSectorWindowMetric({
      key: 'w5',
      window: windows.w5,
      members: memberships,
      items,
      startItems: startItems.w5,
    });
    const window15 = buildSectorWindowMetric({
      key: 'w15',
      window: windows.w15,
      members: memberships,
      items,
      startItems: startItems.w15,
    });
    const trend = buildThemeTrend({
      themeId: theme.id,
      members: allMembers,
      batches,
      statusByStock: input.statusByStock,
    });
    const window = input.window === 'w5' ? window5 : window15;
    const startForWindow = startItems[input.window];
    const leaders: ThemeLibraryThemeLeaderSet = {
      day: themeLeaderRows({
        effective,
        sign: Math.sign(day.value ?? 0),
        valueAt: (member) => items.get(member.stockId)?.changePct ?? null,
        statusByStock: input.statusByStock,
        namesByStock: input.namesByStock,
        items,
        limitUp: input.limitUp,
        ladderCodes,
        ladderLevels,
      }),
      window: themeLeaderRows({
        effective,
        sign: Math.sign(window.value ?? 0),
        valueAt: (member) =>
          windowReturn(items.get(member.stockId), startForWindow.get(member.stockId)),
        statusByStock: input.statusByStock,
        namesByStock: input.namesByStock,
        items,
        limitUp: input.limitUp,
        ladderCodes,
        ladderLevels,
      }),
    };
    const memberRows =
      input.detailThemeId === theme.id
        ? effective
            .map((member): ThemeLibraryMemberPerformance => {
              const item = items.get(member.stockId);
              const code = member.stockId.split('.')[0] ?? member.stockId;
              const status = input.statusByStock.get(member.stockId) ?? 'unknown';
              return {
                stockId: member.stockId,
                code,
                name: input.namesByStock.get(member.stockId) ?? item?.name ?? null,
                memberStatus: status,
                effectiveFrom: member.effectiveFrom,
                dayChangePct: item?.changePct ?? null,
                window5ChangePct: windowReturn(item, startItems.w5.get(member.stockId)),
                window15ChangePct: windowReturn(item, startItems.w15.get(member.stockId)),
                todayAmount: item?.amount ?? null,
                sealed:
                  input.limitUp === null
                    ? null
                    : ladderCodes.has(code) || ladderCodes.has(member.stockId),
                ladderLevel: ladderLevels.get(code) ?? ladderLevels.get(member.stockId) ?? null,
              };
            })
            .sort((left, right) => {
              const leftValue = left.dayChangePct ?? Number.NEGATIVE_INFINITY;
              const rightValue = right.dayChangePct ?? Number.NEGATIVE_INFINITY;
              return rightValue - leftValue || left.stockId.localeCompare(right.stockId);
            })
        : [];
    return {
      themeId: theme.id,
      name: theme.name,
      order: theme.sortOrder,
      sourceCount: sourcesByTheme.get(theme.id) ?? 0,
      memberCount: effective.length,
      day,
      window5,
      window15,
      trend,
      leaders,
      members: memberRows,
    };
  });

  return {
    state: 'ready',
    tradingDate: input.anchor.tradingDate,
    anchor: sectorRankingAnchorSummary(input.anchor),
    window: input.window,
    windows,
    coverage: {
      themeCount: rows.length,
      memberCount: effectiveMemberCount,
    },
    themes: rows,
    batches: batchAxis(input.batches),
    notes: [...THEME_LIBRARY_NOTES],
  };
};

export const assertThemeLibraryRotationInvariants = (rotation: ThemeLibraryRotation): void => {
  if (rotation.state === 'empty') {
    if (rotation.emptyReason === undefined) {
      throw new InvariantError('题材库空态必须给出原因');
    }
    if (rotation.themes.length > 0) {
      throw new InvariantError('题材库空态不得返回题材行');
    }
    return;
  }
  if (rotation.emptyReason !== undefined) {
    throw new InvariantError('题材库 ready 不得携带空态原因');
  }
  let previousOrder = -1;
  for (const theme of rotation.themes) {
    if (theme.order < previousOrder) {
      throw new InvariantError('题材库必须按固定顺序返回题材');
    }
    previousOrder = theme.order;
    if (theme.members.length > theme.day.memberCount) {
      throw new InvariantError(`题材 ${theme.themeId} 成分明细多于日指标成分数`);
    }
    assertLeaders(theme, 'day', theme.day.value);
    assertLeaders(
      theme,
      'window',
      (rotation.window === 'w5' ? theme.window5 : theme.window15).value,
    );
  }
  if (rotation.coverage.themeCount !== rotation.themes.length) {
    throw new InvariantError('题材库覆盖统计与题材行不一致');
  }
  let previousSampledAt = Number.NEGATIVE_INFINITY;
  for (const batch of rotation.batches) {
    if (batch.sampledAt.getTime() < previousSampledAt) {
      throw new InvariantError('时间轴批次必须按采样时点升序');
    }
    previousSampledAt = batch.sampledAt.getTime();
  }
};

/** 卡内前五只：至多 5 只、方向与题材符号一致、按当前方向从强到弱（同幅度按代码定序）。 */
const assertLeaders = (
  theme: ThemeLibraryThemeRow,
  key: 'day' | 'window',
  themeValue: number | null,
): void => {
  const leaders = theme.leaders[key];
  if (leaders.length > 5) {
    throw new InvariantError(`题材 ${theme.themeId} 的 ${key} 卡内个股多于 5 只`);
  }
  const sign = Math.sign(themeValue ?? 0);
  if (sign === 0 ? leaders.length > 0 : leaders.length === 0) {
    throw new InvariantError(`题材 ${theme.themeId} 的 ${key} 卡内个股方向与题材涨跌幅不一致`);
  }
  for (let index = 0; index < leaders.length; index += 1) {
    const current = leaders[index]!;
    const previous = leaders[index - 1];
    if (previous === undefined) continue;
    const ordered = sign > 0 ? current.value <= previous.value : current.value >= previous.value;
    if (!ordered) {
      throw new InvariantError(`题材 ${theme.themeId} 的 ${key} 卡内个股未按幅度排序`);
    }
  }
};
