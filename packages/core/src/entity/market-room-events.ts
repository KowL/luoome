import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import { type EvidenceDimensionStatus, EvidenceDimensionStatusSchema } from './ashare-sentiment.js';
import type { LimitUpLadderEntry } from './limit-up-ladder.js';
import type { LimitUpLadderSample } from './limit-up-ladder-sample.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  type SectorKind,
  SectorKindSchema,
  type StockSectorMembership,
} from './sector-catalog.js';

/**
 * 盘中事件流（ticket #42）：把扩散、分化、换位三类轮动事实按检测时点落成可回看的事件。
 *
 * - 规则只使用本地已发布批次、板块目录 / 成分与按采样时点对齐的天梯样本，零 IO；
 * - 每个阈值都是具名常量，并随事件写入 `thresholds`；同一批数据换阈值会得到不同结果，
 *   事件记录里的阈值才是当时的判定依据；
 * - 事件身份由 (交易日, 种类, 板块, 检测时点) 稳定派生，重复扫描 / 重启都只落一条；
 * - 单次排名抖动不产生换位事件：新领先者必须在 `consecutiveSamples` 个连续样本上
 *   窗口表现持续优于旧领先者（滞回）；
 * - 缺样本、缺成交额、分母无效只影响证据完整性，不补零、不产生新事件；
 * - 未收录方向的「待核实」为二期，本票只产出 `verification.status = verified`。
 */

export const MARKET_ROOM_EVENT_KINDS = ['diffusion', 'divergence', 'rotation'] as const;
export const MarketRoomEventKindSchema = z.enum(MARKET_ROOM_EVENT_KINDS);
export type MarketRoomEventKind = z.infer<typeof MarketRoomEventKindSchema>;

/** 扫描最近样本数上限：只回看当日最近 N 个已发布批次，避免全交易日重算。 */
export const MARKET_ROOM_EVENT_SCAN_SAMPLES = 24;
/** 事件证据里列出的已知成分上限（按日涨幅降序）。 */
export const MARKET_ROOM_EVENT_PEER_LIMIT = 10;
/** 事件关联的当日异动关键词上限。 */
export const MARKET_ROOM_EVENT_KEYWORD_LIMIT = 10;
/** 上涨面 / 窗口 / 占比口径的样本下限（有效成分少于该值时该口径标 partial）。 */
export const MARKET_ROOM_EVENT_MIN_SAMPLE = 3;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

const WINDOW_METHOD = (lookback: number): string =>
  `窗口涨幅 = 板块 active 成分窗口两端价格比值 - 1 后等权（回看 ${lookback} 个样本）；两端缺一的成分剔除，不复用日涨幅`;
const BREADTH_METHOD =
  '上涨面 = 日涨幅 > 0 的 active 成分数 ÷ 有涨幅的 active 成分数；停牌 / 退市剔除，不计作 0';
const TURNOVER_METHOD =
  '窗口成交占比 = 板块 active 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量（同一股票在两个样本都出现才计入分母）';
const RANK_METHOD =
  '日涨幅名次 = 同分类（行业 / 概念）active 板块按成分等权日涨幅降序；并列同名次，缺涨幅的板块不参与排名';
const LADDER_METHOD =
  '封板数 = 与检测样本采样时点对齐的连板天梯样本中的板块 active 成分数；无对齐样本时缺失，不写 0';
const MEMBERS_METHOD = `已知成分 = 检测时点的板块 active 成分，按日涨幅降序取前 ${MARKET_ROOM_EVENT_PEER_LIMIT} 只`;

// ---------- 阈值（显式、可追溯） ----------

const thresholdBaseShape = {
  /** 窗口回看样本数 N：比较检测样本与 N 个样本之前的事实。 */
  lookbackSamples: z.number().int().positive(),
  /** 参与判定的有效成分下限。 */
  minSampleCount: z.number().int().positive(),
};

export const MarketRoomDiffusionThresholdsSchema = z.object({
  kind: z.literal('diffusion'),
  ...thresholdBaseShape,
  /** 上涨面在 N 个样本内至少提升的百分点。 */
  advanceRatioGainPp: z.number().positive(),
  /** 窗口涨幅必须严格高于该值（默认 0：为正）。 */
  windowChangePctAbove: z.number(),
  /** 窗口成交占比较上一窗口至少提高的百分点（默认 0：不降）。 */
  turnoverShareDeltaPpAtLeast: z.number(),
});
export type MarketRoomDiffusionThresholds = z.infer<typeof MarketRoomDiffusionThresholdsSchema>;

export const MarketRoomDivergenceThresholdsSchema = z.object({
  kind: z.literal('divergence'),
  ...thresholdBaseShape,
  /** 日涨幅名次不差于该值才叫「仍靠前」。 */
  dayRankMax: z.number().int().positive(),
  /** 上涨面在 N 个样本内至少回落的百分点。 */
  advanceRatioDropPp: z.number().positive(),
  /** 窗口涨幅必须严格低于该值（默认 0：转负）。 */
  windowChangePctBelow: z.number(),
});
export type MarketRoomDivergenceThresholds = z.infer<typeof MarketRoomDivergenceThresholdsSchema>;

export const MarketRoomRotationThresholdsSchema = z.object({
  kind: z.literal('rotation'),
  ...thresholdBaseShape,
  /** 新领先者持续优于旧领先者的连续样本数（滞回，避免单次抖动）。 */
  consecutiveSamples: z.number().int().min(2),
  /** 每个样本上新领先者窗口涨幅至少领先旧领先者的百分点。 */
  windowLeadPpAtLeast: z.number().nonnegative(),
});
export type MarketRoomRotationThresholds = z.infer<typeof MarketRoomRotationThresholdsSchema>;

export const MarketRoomEventThresholdsSchema = z.discriminatedUnion('kind', [
  MarketRoomDiffusionThresholdsSchema,
  MarketRoomDivergenceThresholdsSchema,
  MarketRoomRotationThresholdsSchema,
]);
export type MarketRoomEventThresholds = z.infer<typeof MarketRoomEventThresholdsSchema>;

/**
 * 默认阈值（用盘中样本校准前的起点）。事件里保存的是扫描时的实际阈值，
 * 调整这里不会回改历史事件，也不会让历史事件「看起来」用了新阈值。
 */
export const MARKET_ROOM_EVENT_DEFAULT_RULES: {
  readonly diffusion: MarketRoomDiffusionThresholds;
  readonly divergence: MarketRoomDivergenceThresholds;
  readonly rotation: MarketRoomRotationThresholds;
} = {
  diffusion: {
    kind: 'diffusion',
    lookbackSamples: 1,
    minSampleCount: MARKET_ROOM_EVENT_MIN_SAMPLE,
    advanceRatioGainPp: 8,
    windowChangePctAbove: 0,
    turnoverShareDeltaPpAtLeast: 0,
  },
  divergence: {
    kind: 'divergence',
    lookbackSamples: 1,
    minSampleCount: MARKET_ROOM_EVENT_MIN_SAMPLE,
    dayRankMax: 5,
    advanceRatioDropPp: 8,
    windowChangePctBelow: 0,
  },
  rotation: {
    kind: 'rotation',
    lookbackSamples: 1,
    minSampleCount: MARKET_ROOM_EVENT_MIN_SAMPLE,
    consecutiveSamples: 2,
    windowLeadPpAtLeast: 1,
  },
};

export interface MarketRoomEventRuleOverrides {
  readonly diffusion?: Partial<Omit<MarketRoomDiffusionThresholds, 'kind'>>;
  readonly divergence?: Partial<Omit<MarketRoomDivergenceThresholds, 'kind'>>;
  readonly rotation?: Partial<Omit<MarketRoomRotationThresholds, 'kind'>>;
}

export interface MarketRoomEventRules {
  readonly diffusion: MarketRoomDiffusionThresholds;
  readonly divergence: MarketRoomDivergenceThresholds;
  readonly rotation: MarketRoomRotationThresholds;
}

export const resolveMarketRoomEventRules = (
  overrides: MarketRoomEventRuleOverrides = {},
): MarketRoomEventRules => ({
  diffusion: MarketRoomDiffusionThresholdsSchema.parse({
    ...MARKET_ROOM_EVENT_DEFAULT_RULES.diffusion,
    ...overrides.diffusion,
  }),
  divergence: MarketRoomDivergenceThresholdsSchema.parse({
    ...MARKET_ROOM_EVENT_DEFAULT_RULES.divergence,
    ...overrides.divergence,
  }),
  rotation: MarketRoomRotationThresholdsSchema.parse({
    ...MARKET_ROOM_EVENT_DEFAULT_RULES.rotation,
    ...overrides.rotation,
  }),
});

// ---------- 事件模型 ----------

export const MarketRoomEventSectorSchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
});
export type MarketRoomEventSector = z.infer<typeof MarketRoomEventSectorSchema>;

export const MarketRoomEventStatusSchema = z.enum(['complete', 'partial']);
export type MarketRoomEventStatus = z.infer<typeof MarketRoomEventStatusSchema>;

/**
 * 事件核实状态。当前只产出 `verified`：事件方向已收录在行业 / 概念目录。
 * 未收录方向（`pending`）属二期，本票不伪造「待核实」条目。
 */
export const MarketRoomEventVerificationSchema = z.object({
  status: z.literal('verified'),
  basis: z.string().min(1),
});
export type MarketRoomEventVerification = z.infer<typeof MarketRoomEventVerificationSchema>;

export const MarketRoomEventLadderStockSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  ladderLevel: z.number().int().positive(),
  /** 供应商封板时间；缺失为 null，不用采样时点反推。 */
  firstTime: z.string().nullable(),
  /** 供应商涨停原因；缺失（'--' / 空）为 null。 */
  reason: z.string().nullable(),
});
export type MarketRoomEventLadderStock = z.infer<typeof MarketRoomEventLadderStockSchema>;

export const MarketRoomEventMemberSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  /** 批次与天梯都无名称时为 null，不用代码编造名称。 */
  name: z.string().min(1).nullable(),
  dayChangePct: z.number().finite().nullable(),
  /** 与事件同一窗口口径的涨幅；窗口两端缺价格时为 null。 */
  windowChangePct: z.number().finite().nullable(),
  sealed: z.boolean(),
  ladderLevel: z.number().int().positive().nullable(),
  firstTime: z.string().nullable(),
  reason: z.string().nullable(),
});
export type MarketRoomEventMember = z.infer<typeof MarketRoomEventMemberSchema>;

export const MarketRoomEventKeywordSchema = z.object({
  text: z.string().min(1),
  /** 关键词来源，如 `limit_up_ladder_reason`。 */
  source: z.string().min(1),
});

export const MarketRoomEventRotationSideSchema = z.object({
  sector: MarketRoomEventSectorSchema,
  dayRank: z.number().int().positive().nullable(),
  dayChangePct: z.number().finite().nullable(),
  windowChangePct: z.number().finite().nullable(),
});

export const MarketRoomEventRotationSchema = z.object({
  from: MarketRoomEventRotationSideSchema,
  to: MarketRoomEventRotationSideSchema,
  leadSamples: z
    .array(
      z.object({
        sampledAt: z.coerce.date(),
        fromWindowChangePct: z.number().finite(),
        toWindowChangePct: z.number().finite(),
        deltaPp: z.number().finite(),
      }),
    )
    .min(1),
});
export type MarketRoomEventRotation = z.infer<typeof MarketRoomEventRotationSchema>;

export const MarketRoomEventEvidenceSchema = z.object({
  window: z.object({
    lookbackSamples: z.number().int().positive(),
    baseSampledAt: z.coerce.date(),
    sampledAt: z.coerce.date(),
    spanMs: z.number().int().nonnegative(),
    status: EvidenceDimensionStatusSchema,
    changePct: z.number().finite().nullable(),
    sampleCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    nonTradableCount: z.number().int().nonnegative(),
    method: z.string().min(1),
    reason: z.string().min(1).nullable(),
    warnings: z.array(z.string()),
  }),
  ranking: z.object({
    sort: z.literal('day'),
    dayRank: z.number().int().positive().nullable(),
    sectorCount: z.number().int().nonnegative(),
    dayChangePct: z.number().finite().nullable(),
    method: z.string().min(1),
  }),
  breadth: z.object({
    status: EvidenceDimensionStatusSchema,
    advancing: z.number().int().nonnegative(),
    declining: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    memberCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    nonTradableCount: z.number().int().nonnegative(),
    advanceRatio: z.number().finite().nullable(),
    baseAdvanceRatio: z.number().finite().nullable(),
    deltaPp: z.number().finite().nullable(),
    baseSampledAt: z.coerce.date(),
    method: z.string().min(1),
    warnings: z.array(z.string()),
  }),
  turnover: z.object({
    status: EvidenceDimensionStatusSchema,
    sharePct: z.number().finite().nullable(),
    baseSharePct: z.number().finite().nullable(),
    deltaPp: z.number().finite().nullable(),
    numeratorAmount: z.number().nullable(),
    marketAmountDelta: z.number().nullable(),
    sampleCount: z.number().int().nonnegative(),
    memberCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    baseSampledAt: z.coerce.date(),
    method: z.string().min(1),
    reason: z.string().min(1).nullable(),
    warnings: z.array(z.string()),
  }),
  ladder: z.object({
    status: EvidenceDimensionStatusSchema,
    sampledAt: z.coerce.date().nullable(),
    source: z.string().nullable(),
    sealedCount: z.number().int().nonnegative().nullable(),
    stocks: z.array(MarketRoomEventLadderStockSchema),
    method: z.string().min(1),
    reason: z.string().min(1).nullable(),
  }),
  members: z.object({
    memberCount: z.number().int().nonnegative(),
    shownCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    peers: z.array(MarketRoomEventMemberSchema),
    method: z.string().min(1),
  }),
  keywords: z.array(MarketRoomEventKeywordSchema),
  rotation: MarketRoomEventRotationSchema.optional(),
});
export type MarketRoomEventEvidence = z.infer<typeof MarketRoomEventEvidenceSchema>;

export const MarketRoomEventSchema = z.object({
  /** `${tradingDate}|${kind}|${sectorId}|${sampledAt ISO}`；重复扫描稳定派生同一 id。 */
  id: z.string().min(1),
  tradingDate: dateString,
  kind: MarketRoomEventKindSchema,
  sector: MarketRoomEventSectorSchema,
  /** 检测时点（产生事件的样本）。 */
  sampledAt: z.coerce.date(),
  /** 检测样本的上一个样本；首个样本为 null。 */
  previousSampledAt: z.coerce.date().nullable(),
  /** 事件证据完整度；partial 表示有维度缺失，事件本身仍成立。 */
  status: MarketRoomEventStatusSchema,
  thresholds: MarketRoomEventThresholdsSchema,
  evidence: MarketRoomEventEvidenceSchema,
  verification: MarketRoomEventVerificationSchema,
  /** 写入时点；重复扫描只保留首次写入。 */
  recordedAt: z.coerce.date(),
});
export type MarketRoomEvent = z.infer<typeof MarketRoomEventSchema>;

export interface MarketRoomEventSaveResult {
  readonly created: boolean;
  readonly event: MarketRoomEvent;
}

// ---------- 纯计算 ----------

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const codeOfStockId = (stockId: string): string => stockId.split('.')[0] ?? stockId;

const isNonTradable = (membership: StockSectorMembership): boolean =>
  membership.memberStatus === 'suspended' || membership.memberStatus === 'delisted';

const itemMapOf = (batch: MarketSnapshotBatch): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map(batch.items.map((item) => [item.id, item]));

interface BreadthFacts {
  readonly advancing: number;
  readonly declining: number;
  readonly unchanged: number;
  readonly sampleCount: number;
  readonly memberCount: number;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  /** 上涨比例（0-100）；没有有效成分时为 null。 */
  readonly advanceRatio: number | null;
  /** 成分等权日涨幅；没有有效成分时为 null。 */
  readonly dayChangePct: number | null;
}

const breadthAt = (
  members: readonly StockSectorMembership[],
  items: ReadonlyMap<string, MarketSnapshotItem>,
): BreadthFacts => {
  let advancing = 0;
  let declining = 0;
  let unchanged = 0;
  let sampleCount = 0;
  let missingCount = 0;
  let nonTradableCount = 0;
  let sum = 0;
  for (const membership of members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const changePct = items.get(membership.stockId)?.changePct;
    if (changePct === undefined) {
      missingCount += 1;
      continue;
    }
    sampleCount += 1;
    sum += changePct;
    if (changePct > 0) advancing += 1;
    else if (changePct < 0) declining += 1;
    else unchanged += 1;
  }
  return {
    advancing,
    declining,
    unchanged,
    sampleCount,
    memberCount: members.length,
    missingCount,
    nonTradableCount,
    advanceRatio: sampleCount === 0 ? null : round2((advancing / sampleCount) * 100),
    dayChangePct: sampleCount === 0 ? null : round4(sum / sampleCount),
  };
};

interface WindowFacts {
  readonly baseSampledAt: Date;
  readonly sampledAt: Date;
  readonly spanMs: number;
  readonly changePct: number | null;
  readonly sampleCount: number;
  readonly missingCount: number;
  readonly nonTradableCount: number;
}

const windowAt = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly fromItems: ReadonlyMap<string, MarketSnapshotItem>;
  readonly toItems: ReadonlyMap<string, MarketSnapshotItem>;
  readonly from: Date;
  readonly to: Date;
}): WindowFacts => {
  let sum = 0;
  let sampleCount = 0;
  let missingCount = 0;
  let nonTradableCount = 0;
  for (const membership of input.members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const fromClose = input.fromItems.get(membership.stockId)?.close;
    const toClose = input.toItems.get(membership.stockId)?.close;
    if (fromClose === undefined || toClose === undefined || fromClose <= 0 || toClose <= 0) {
      missingCount += 1;
      continue;
    }
    sum += (toClose / fromClose - 1) * 100;
    sampleCount += 1;
  }
  return {
    baseSampledAt: input.from,
    sampledAt: input.to,
    spanMs: Math.max(0, input.to.getTime() - input.from.getTime()),
    changePct: sampleCount === 0 ? null : round4(sum / sampleCount),
    sampleCount,
    missingCount,
    nonTradableCount,
  };
};

interface MarketDelta {
  readonly delta: number;
  readonly sampleCount: number;
  readonly totalCount: number;
  readonly valid: boolean;
  readonly reason: string | null;
}

const marketDeltaBetween = (
  fromItems: ReadonlyMap<string, MarketSnapshotItem>,
  toItems: ReadonlyMap<string, MarketSnapshotItem>,
): MarketDelta => {
  let delta = 0;
  let sampleCount = 0;
  for (const item of toItems.values()) {
    const previous = fromItems.get(item.id);
    if (previous?.amount === undefined || item.amount === undefined) continue;
    delta += item.amount - previous.amount;
    sampleCount += 1;
  }
  const totalCount = toItems.size;
  const base = { delta: round2(delta), sampleCount, totalCount };
  if (sampleCount !== totalCount) {
    return {
      ...base,
      valid: false,
      reason: `denominator_incomplete: 分母仅覆盖 ${sampleCount} / ${totalCount} 只（缺成交额或不在窗口起点样本），占比无意义`,
    };
  }
  if (delta <= 0) {
    return {
      ...base,
      valid: false,
      reason: `denominator_invalid: 同期全市场去重成交额增量为 ${round2(delta)}，不为正，占比无意义`,
    };
  }
  return { ...base, valid: true, reason: null };
};

interface TurnoverFacts {
  readonly sharePct: number | null;
  readonly numeratorAmount: number | null;
  readonly marketAmountDelta: number | null;
  readonly sampleCount: number;
  readonly memberCount: number;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly reason: string | null;
}

const turnoverAt = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly fromItems: ReadonlyMap<string, MarketSnapshotItem>;
  readonly toItems: ReadonlyMap<string, MarketSnapshotItem>;
  readonly market: MarketDelta;
}): TurnoverFacts => {
  let numerator = 0;
  let sampleCount = 0;
  let missingCount = 0;
  let nonTradableCount = 0;
  for (const membership of input.members) {
    if (isNonTradable(membership)) {
      nonTradableCount += 1;
      continue;
    }
    const fromAmount = input.fromItems.get(membership.stockId)?.amount;
    const toAmount = input.toItems.get(membership.stockId)?.amount;
    if (fromAmount === undefined || toAmount === undefined) {
      missingCount += 1;
      continue;
    }
    numerator += toAmount - fromAmount;
    sampleCount += 1;
  }
  const usable = input.market.valid && input.market.delta > 0 && sampleCount > 0;
  const reason = !input.market.valid
    ? input.market.reason
    : sampleCount === 0
      ? 'missing_window_amount: 板块没有两端都有成交额的成分，占比缺失'
      : null;
  return {
    sharePct: usable ? round2((numerator / input.market.delta) * 100) : null,
    numeratorAmount: sampleCount === 0 ? null : round2(numerator),
    marketAmountDelta: input.market.valid ? input.market.delta : null,
    sampleCount,
    memberCount: input.members.length,
    missingCount,
    nonTradableCount,
    reason,
  };
};

interface SampleView {
  readonly batch: MarketSnapshotBatch;
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
  readonly ladderSample: LimitUpLadderSample | null;
  readonly ladderByCode: ReadonlyMap<string, LimitUpLadderEntry>;
}

interface Ranking {
  readonly dayRank: ReadonlyMap<string, number>;
  /** 唯一的日涨幅第一名；并列或无有效板块时为 null。 */
  readonly leaderId: string | null;
  readonly sectorCount: number;
}

interface ScanContext {
  readonly tradingDate: string;
  readonly samples: readonly SampleView[];
  readonly sectors: readonly SectorCatalogEntry[];
  readonly sectorsById: ReadonlyMap<string, SectorCatalogEntry>;
  readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
  readonly recordedAt: Date;
  readonly rules: MarketRoomEventRules;
  readonly breadthBySample: readonly ReadonlyMap<string, BreadthFacts>[];
  readonly rankings: Map<string, Ranking>;
  readonly marketDeltas: Map<string, MarketDelta>;
  readonly windows: Map<string, WindowFacts>;
  readonly turnovers: Map<string, TurnoverFacts>;
}

const sectorRef = (sector: SectorCatalogEntry): MarketRoomEventSector => ({
  sectorId: sector.id,
  kind: sector.kind,
  vendorCode: sector.vendorCode,
  name: sector.name,
});

const sampleViewOf = (input: {
  readonly batch: MarketSnapshotBatch;
  readonly ladderByTime: ReadonlyMap<number, LimitUpLadderSample>;
}): SampleView => {
  const ladderSample = input.ladderByTime.get(input.batch.sampledAt.getTime()) ?? null;
  const ladderByCode = new Map<string, LimitUpLadderEntry>();
  for (const level of ladderSample?.levels ?? []) {
    for (const entry of level.stocks) ladderByCode.set(entry.code, entry);
  }
  return {
    batch: input.batch,
    items: itemMapOf(input.batch),
    ladderSample,
    ladderByCode,
  };
};

const buildContext = (input: MarketRoomEventScanInput): ScanContext => {
  const ladderByTime = new Map<number, LimitUpLadderSample>();
  for (const sample of input.ladderSamples) {
    if (sample.tradingDate !== input.tradingDate) continue;
    ladderByTime.set(sample.sampledAt.getTime(), sample);
  }
  const byTime = new Map<number, MarketSnapshotBatch>();
  for (const batch of input.batches) {
    if (batch.tradingDate !== input.tradingDate) continue;
    if (!byTime.has(batch.sampledAt.getTime())) byTime.set(batch.sampledAt.getTime(), batch);
  }
  const batches = [...byTime.values()]
    .sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime())
    .slice(-MARKET_ROOM_EVENT_SCAN_SAMPLES);
  const samples = batches.map((batch) => sampleViewOf({ batch, ladderByTime }));

  const membersBySector = new Map<string, StockSectorMembership[]>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const list = membersBySector.get(membership.sectorId) ?? [];
    list.push(membership);
    membersBySector.set(membership.sectorId, list);
  }
  const activeSectors = input.sectors.filter(
    (sector) => sector.state === 'active' && (membersBySector.get(sector.id)?.length ?? 0) > 0,
  );
  const breadthBySample = samples.map((sample) => {
    const facts = new Map<string, BreadthFacts>();
    for (const sector of activeSectors) {
      const members = membersBySector.get(sector.id) ?? [];
      facts.set(sector.id, breadthAt(members, sample.items));
    }
    return facts;
  });

  return {
    tradingDate: input.tradingDate,
    samples,
    sectors: activeSectors,
    sectorsById: new Map(activeSectors.map((sector) => [sector.id, sector])),
    membersBySector,
    recordedAt: input.recordedAt,
    rules: resolveMarketRoomEventRules(input.ruleOverrides),
    breadthBySample,
    rankings: new Map(),
    marketDeltas: new Map(),
    windows: new Map(),
    turnovers: new Map(),
  };
};

const rankingAt = (ctx: ScanContext, kind: SectorKind, index: number): Ranking => {
  const key = `${kind}|${index}`;
  const cached = ctx.rankings.get(key);
  if (cached !== undefined) return cached;
  const breadth = ctx.breadthBySample[index];
  const entries: { id: string; value: number }[] = [];
  if (breadth !== undefined) {
    for (const sector of ctx.sectors) {
      if (sector.kind !== kind) continue;
      const dayChangePct = breadth.get(sector.id)?.dayChangePct;
      if (dayChangePct === undefined || dayChangePct === null) continue;
      entries.push({ id: sector.id, value: dayChangePct });
    }
  }
  entries.sort((left, right) => right.value - left.value || left.id.localeCompare(right.id));
  const dayRank = new Map<string, number>();
  let previousValue: number | null = null;
  let previousRank = 0;
  entries.forEach((entry, position) => {
    const rank =
      previousValue !== null && entry.value === previousValue ? previousRank : position + 1;
    dayRank.set(entry.id, rank);
    previousValue = entry.value;
    previousRank = rank;
  });
  const leaders = entries.filter((entry) => dayRank.get(entry.id) === 1);
  const ranking: Ranking = {
    dayRank,
    leaderId: leaders.length === 1 ? (leaders[0]?.id ?? null) : null,
    sectorCount: entries.length,
  };
  ctx.rankings.set(key, ranking);
  return ranking;
};

const marketDeltaAt = (ctx: ScanContext, from: number, to: number): MarketDelta => {
  const key = `${from}->${to}`;
  const cached = ctx.marketDeltas.get(key);
  if (cached !== undefined) return cached;
  const fromSample = ctx.samples[from];
  const toSample = ctx.samples[to];
  if (fromSample === undefined || toSample === undefined) {
    throw new InvariantError(`盘中事件扫描样本越界: ${from} -> ${to}`);
  }
  const delta = marketDeltaBetween(fromSample.items, toSample.items);
  ctx.marketDeltas.set(key, delta);
  return delta;
};

const windowFactsAt = (
  ctx: ScanContext,
  sectorId: string,
  index: number,
  lookback: number,
): WindowFacts => {
  const key = `${sectorId}|${index}|${lookback}`;
  const cached = ctx.windows.get(key);
  if (cached !== undefined) return cached;
  const from = ctx.samples[index - lookback];
  const to = ctx.samples[index];
  if (from === undefined || to === undefined) {
    throw new InvariantError(`盘中事件窗口样本越界: ${sectorId} @ ${index}`);
  }
  const facts = windowAt({
    members: ctx.membersBySector.get(sectorId) ?? [],
    fromItems: from.items,
    toItems: to.items,
    from: from.batch.sampledAt,
    to: to.batch.sampledAt,
  });
  ctx.windows.set(key, facts);
  return facts;
};

const turnoverFactsAt = (
  ctx: ScanContext,
  sectorId: string,
  index: number,
  lookback: number,
): TurnoverFacts => {
  const key = `${sectorId}|${index}|${lookback}`;
  const cached = ctx.turnovers.get(key);
  if (cached !== undefined) return cached;
  const from = ctx.samples[index - lookback];
  const to = ctx.samples[index];
  if (from === undefined || to === undefined) {
    throw new InvariantError(`盘中事件占比窗口样本越界: ${sectorId} @ ${index}`);
  }
  const facts = turnoverAt({
    members: ctx.membersBySector.get(sectorId) ?? [],
    fromItems: from.items,
    toItems: to.items,
    market: marketDeltaAt(ctx, index - lookback, index),
  });
  ctx.turnovers.set(key, facts);
  return facts;
};

const dimensionStatus = (input: {
  readonly hasValue: boolean;
  readonly missingCount: number;
  readonly nonTradableCount: number;
  readonly sampleCount: number;
  readonly minSampleCount: number;
  readonly reason: string | null;
}): z.infer<typeof EvidenceDimensionStatusSchema> => {
  if (!input.hasValue) return 'unavailable';
  if (
    input.reason !== null ||
    input.missingCount > 0 ||
    input.nonTradableCount > 0 ||
    input.sampleCount < input.minSampleCount
  ) {
    return 'partial';
  }
  return 'complete';
};

const missingReason = (
  label: string,
  missingCount: number,
  sampleCount: number,
  minSampleCount: number,
): string | null => {
  if (missingCount > 0) {
    return `missing_${label}: ${missingCount} 只成分缺该口径样本，已剔除`;
  }
  if (sampleCount < minSampleCount) {
    return `thin_sample: 有效成分 ${sampleCount} 只，低于判定下限 ${minSampleCount} 只`;
  }
  return null;
};

const ladderOfSampleAt = (
  sample: SampleView,
): {
  readonly status: EvidenceDimensionStatus;
  readonly sampledAt: Date | null;
  readonly source: string | null;
  readonly reason: string | null;
} => {
  if (sample.ladderSample === null) {
    return {
      status: 'unavailable',
      sampledAt: null,
      source: null,
      reason: 'limit_up_missing: 检测样本没有对齐的连板天梯样本，封板数与涨停原因缺失（不写 0）',
    };
  }
  return {
    status: 'complete',
    sampledAt: sample.ladderSample.sampledAt,
    source: sample.ladderSample.source,
    reason: null,
  };
};

const keywordTexts = (reason: string): string[] =>
  reason
    .split(/[+;,，、/|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '--');

const memberEvidence = (input: {
  readonly ctx: ScanContext;
  readonly sectorId: string;
  readonly index: number;
  readonly lookback: number;
  readonly sample: SampleView;
}): MarketRoomEventMember[] => {
  const members = ctxMembers(input.ctx, input.sectorId);
  const peers: MarketRoomEventMember[] = members
    .filter((membership) => !isNonTradable(membership))
    .map((membership) => {
      const item = input.sample.items.get(membership.stockId);
      const entry = input.sample.ladderByCode.get(codeOfStockId(membership.stockId)) ?? null;
      const reason =
        entry === null ? null : entry.reason === '--' ? null : entry.reason.trim() || null;
      return {
        stockId: membership.stockId,
        code: codeOfStockId(membership.stockId),
        name: item?.name ?? entry?.name ?? null,
        dayChangePct: item?.changePct ?? null,
        windowChangePct: null,
        sealed: entry !== null,
        ladderLevel: entry?.ladderLevel ?? null,
        firstTime: entry?.firstTime ?? null,
        reason,
      };
    });
  const withWindow = peers.map((peer) => ({
    ...peer,
    windowChangePct: windowChangeForMember({
      ctx: input.ctx,
      sectorId: input.sectorId,
      index: input.index,
      lookback: input.lookback,
      stockId: peer.stockId,
    }),
  }));
  withWindow.sort((left, right) => {
    const leftValue = left.dayChangePct;
    const rightValue = right.dayChangePct;
    if (leftValue === null && rightValue === null) return left.code.localeCompare(right.code);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return left.code.localeCompare(right.code);
  });
  return withWindow.slice(0, MARKET_ROOM_EVENT_PEER_LIMIT);
};

const ctxMembers = (ctx: ScanContext, sectorId: string): readonly StockSectorMembership[] =>
  ctx.membersBySector.get(sectorId) ?? [];

const windowChangeForMember = (input: {
  readonly ctx: ScanContext;
  readonly sectorId: string;
  readonly index: number;
  readonly lookback: number;
  readonly stockId: string;
}): number | null => {
  const { ctx } = input;
  const from = ctx.samples[input.index - input.lookback];
  const to = ctx.samples[input.index];
  if (from === undefined || to === undefined) return null;
  // 板块成员关系只用于取数：单只成分的窗口涨幅按同一条回看口径计算。
  const membership = ctxMembers(ctx, input.sectorId).find(
    (entry) => entry.stockId === input.stockId,
  );
  if (membership === undefined) return null;
  const fromClose = from.items.get(input.stockId)?.close;
  const toClose = to.items.get(input.stockId)?.close;
  if (fromClose === undefined || toClose === undefined || fromClose <= 0 || toClose <= 0)
    return null;
  return round4((toClose / fromClose - 1) * 100);
};

const buildEvent = (input: {
  readonly ctx: ScanContext;
  readonly kind: MarketRoomEventKind;
  readonly sector: SectorCatalogEntry;
  readonly index: number;
  readonly baseIndex: number;
  readonly thresholds: MarketRoomEventThresholds;
  readonly rotation?: MarketRoomEventRotation;
}): MarketRoomEvent => {
  const { ctx, sector, index, baseIndex, thresholds } = input;
  const sample = ctx.samples[index];
  const baseSample = ctx.samples[baseIndex];
  const base = ctx.breadthBySample[baseIndex]?.get(sector.id);
  const current = ctx.breadthBySample[index]?.get(sector.id);
  if (
    sample === undefined ||
    baseSample === undefined ||
    base === undefined ||
    current === undefined
  ) {
    throw new InvariantError('盘中事件缺少检测样本或上涨面事实');
  }
  const minSampleCount = thresholds.minSampleCount;
  const lookback = thresholds.lookbackSamples;
  const window = windowFactsAt(ctx, sector.id, index, lookback);
  const turnover = turnoverFactsAt(ctx, sector.id, index, lookback);
  // 检测样本之前不足一个完整窗口时，没有「上一窗口」可比：占比记缺失，不拿半个窗口冒充。
  const baseTurnover =
    baseIndex >= lookback ? turnoverFactsAt(ctx, sector.id, baseIndex, lookback) : null;
  const ranking = rankingAt(ctx, sector.kind, index);
  const ladder = ladderOfSampleAt(sample);

  const breadthWarnings: string[] = [];
  if (base.sampleCount < minSampleCount || current.sampleCount < minSampleCount) {
    breadthWarnings.push(
      `thin_sample: 有效成分 ${base.sampleCount}/${current.sampleCount} 只，低于判定下限 ${minSampleCount} 只`,
    );
  }
  for (const [label, facts] of [
    ['base', base],
    ['current', current],
  ] as const) {
    if (facts.missingCount > 0) {
      breadthWarnings.push(`missing_change_pct(${label}): ${facts.missingCount} 只成分缺涨幅`);
    }
    if (facts.nonTradableCount > 0) {
      breadthWarnings.push(
        `non_tradable(${label}): ${facts.nonTradableCount} 只停牌 / 退市成分已排除，不计作 0`,
      );
    }
  }

  const windowWarnings: string[] = [];
  if (window.missingCount > 0) {
    windowWarnings.push(`missing_window_price: ${window.missingCount} 只成分窗口两端缺价格`);
  }
  if (window.nonTradableCount > 0) {
    windowWarnings.push(`non_tradable: ${window.nonTradableCount} 只停牌 / 退市成分已排除`);
  }
  const windowReason =
    window.changePct === null ? 'missing_window_price: 没有两端都有价格的成分，窗口涨幅缺失' : null;

  const turnoverWarnings: string[] = [];
  if (turnover.missingCount > 0) {
    turnoverWarnings.push(`missing_window_amount: ${turnover.missingCount} 只成分窗口两端缺成交额`);
  }
  if (turnover.nonTradableCount > 0) {
    turnoverWarnings.push(`non_tradable: ${turnover.nonTradableCount} 只停牌 / 退市成分已排除`);
  }
  const shareDelta =
    turnover.sharePct === null || baseTurnover?.sharePct === null || baseTurnover === null
      ? null
      : round2(turnover.sharePct - baseTurnover.sharePct);

  const sealedStocks: MarketRoomEventLadderStock[] = ctxMembers(ctx, sector.id)
    .map((membership) => sample.ladderByCode.get(codeOfStockId(membership.stockId)))
    .filter((entry): entry is LimitUpLadderEntry => entry !== undefined)
    .map((entry) => ({
      code: entry.code,
      name: entry.name,
      ladderLevel: entry.ladderLevel,
      firstTime: entry.firstTime,
      reason: entry.reason === '--' ? null : entry.reason.trim() || null,
    }))
    .sort(
      (left, right) => right.ladderLevel - left.ladderLevel || left.code.localeCompare(right.code),
    );

  const keywords = [
    ...new Set(
      sealedStocks.flatMap((stock) => (stock.reason === null ? [] : keywordTexts(stock.reason))),
    ),
  ]
    .slice(0, MARKET_ROOM_EVENT_KEYWORD_LIMIT)
    .map((text) => ({ text, source: 'limit_up_ladder_reason' }));

  const peers = memberEvidence({ ctx, sectorId: sector.id, index, lookback, sample });
  const memberCount = ctxMembers(ctx, sector.id).length;
  const tradableMemberCount = ctxMembers(ctx, sector.id).filter(
    (membership) => !isNonTradable(membership),
  ).length;

  const windowStatus = dimensionStatus({
    hasValue: window.changePct !== null,
    missingCount: window.missingCount,
    nonTradableCount: window.nonTradableCount,
    sampleCount: window.sampleCount,
    minSampleCount,
    reason: windowReason,
  });
  const breadthStatus = dimensionStatus({
    hasValue: current.advanceRatio !== null && base.advanceRatio !== null,
    missingCount: current.missingCount,
    nonTradableCount: current.nonTradableCount,
    sampleCount: Math.min(current.sampleCount, base.sampleCount),
    minSampleCount,
    reason: missingReason('change_pct', current.missingCount, current.sampleCount, minSampleCount),
  });
  const turnoverStatus = dimensionStatus({
    hasValue: turnover.sharePct !== null,
    missingCount: turnover.missingCount,
    nonTradableCount: turnover.nonTradableCount,
    sampleCount: turnover.sampleCount,
    minSampleCount,
    reason:
      turnover.reason ??
      missingReason('window_amount', turnover.missingCount, turnover.sampleCount, minSampleCount),
  });
  const ladderStatus = ladder.status;

  const status: MarketRoomEventStatus = [
    windowStatus,
    breadthStatus,
    turnoverStatus,
    ladderStatus,
  ].every((dimension) => dimension === 'complete')
    ? 'complete'
    : 'partial';

  const event: MarketRoomEvent = {
    id: marketRoomEventId({
      tradingDate: ctx.tradingDate,
      kind: input.kind,
      sectorId: sector.id,
      sampledAt: sample.batch.sampledAt,
    }),
    tradingDate: ctx.tradingDate,
    kind: input.kind,
    sector: sectorRef(sector),
    sampledAt: sample.batch.sampledAt,
    previousSampledAt: index === 0 ? null : (ctx.samples[index - 1]?.batch.sampledAt ?? null),
    status,
    thresholds,
    evidence: {
      window: {
        lookbackSamples: lookback,
        baseSampledAt: window.baseSampledAt,
        sampledAt: window.sampledAt,
        spanMs: window.spanMs,
        status: windowStatus,
        changePct: window.changePct,
        sampleCount: window.sampleCount,
        missingCount: window.missingCount,
        nonTradableCount: window.nonTradableCount,
        method: WINDOW_METHOD(lookback),
        reason: windowReason,
        warnings: windowWarnings,
      },
      ranking: {
        sort: 'day',
        dayRank: ranking.dayRank.get(sector.id) ?? null,
        sectorCount: ranking.sectorCount,
        dayChangePct: current.dayChangePct,
        method: RANK_METHOD,
      },
      breadth: {
        status: breadthStatus,
        advancing: current.advancing,
        declining: current.declining,
        unchanged: current.unchanged,
        sampleCount: current.sampleCount,
        memberCount: current.memberCount,
        missingCount: current.missingCount,
        nonTradableCount: current.nonTradableCount,
        advanceRatio: current.advanceRatio,
        baseAdvanceRatio: base.advanceRatio,
        deltaPp:
          current.advanceRatio === null || base.advanceRatio === null
            ? null
            : round2(current.advanceRatio - base.advanceRatio),
        baseSampledAt: baseSample.batch.sampledAt,
        method: BREADTH_METHOD,
        warnings: breadthWarnings,
      },
      turnover: {
        status: turnoverStatus,
        sharePct: turnover.sharePct,
        baseSharePct: baseTurnover?.sharePct ?? null,
        deltaPp: shareDelta,
        numeratorAmount: turnover.numeratorAmount,
        marketAmountDelta: turnover.marketAmountDelta,
        sampleCount: turnover.sampleCount,
        memberCount: turnover.memberCount,
        missingCount: turnover.missingCount,
        baseSampledAt: baseSample.batch.sampledAt,
        method: TURNOVER_METHOD,
        reason: turnover.reason,
        warnings: turnoverWarnings,
      },
      ladder: {
        status: ladder.status,
        sampledAt: ladder.sampledAt,
        source: ladder.source,
        sealedCount: ladder.status === 'unavailable' ? null : sealedStocks.length,
        stocks: sealedStocks,
        method: LADDER_METHOD,
        reason: ladder.reason,
      },
      members: {
        memberCount,
        shownCount: peers.length,
        truncated: peers.length < tradableMemberCount,
        peers,
        method: MEMBERS_METHOD,
      },
      keywords,
      ...(input.rotation === undefined ? {} : { rotation: input.rotation }),
    },
    verification: {
      status: 'verified',
      basis: `sector_catalog:${sector.kind}:${sector.vendorCode}`,
    },
    recordedAt: ctx.recordedAt,
  };
  assertMarketRoomEventInvariants(event);
  return event;
};

const detectDiffusion = (
  ctx: ScanContext,
  sector: SectorCatalogEntry,
  index: number,
): MarketRoomEvent | null => {
  const rule = ctx.rules.diffusion;
  const baseIndex = index - rule.lookbackSamples;
  if (baseIndex < rule.lookbackSamples) return null;
  const base = ctx.breadthBySample[baseIndex]?.get(sector.id);
  const current = ctx.breadthBySample[index]?.get(sector.id);
  if (base === undefined || current === undefined) return null;
  if (base.sampleCount < rule.minSampleCount || current.sampleCount < rule.minSampleCount) {
    return null;
  }
  if (base.advanceRatio === null || current.advanceRatio === null) return null;
  const gain = round2(current.advanceRatio - base.advanceRatio);
  if (gain < rule.advanceRatioGainPp) return null;
  const window = windowFactsAt(ctx, sector.id, index, rule.lookbackSamples);
  if (window.changePct === null || !(window.changePct > rule.windowChangePctAbove)) return null;
  const turnover = turnoverFactsAt(ctx, sector.id, index, rule.lookbackSamples);
  const baseTurnover = turnoverFactsAt(ctx, sector.id, baseIndex, rule.lookbackSamples);
  if (turnover.sharePct === null || baseTurnover.sharePct === null) return null;
  const shareDelta = round2(turnover.sharePct - baseTurnover.sharePct);
  if (shareDelta < rule.turnoverShareDeltaPpAtLeast) return null;
  return buildEvent({
    ctx,
    kind: 'diffusion',
    sector,
    index,
    baseIndex,
    thresholds: rule,
  });
};

const detectDivergence = (
  ctx: ScanContext,
  sector: SectorCatalogEntry,
  index: number,
): MarketRoomEvent | null => {
  const rule = ctx.rules.divergence;
  const baseIndex = index - rule.lookbackSamples;
  if (baseIndex < 0) return null;
  const base = ctx.breadthBySample[baseIndex]?.get(sector.id);
  const current = ctx.breadthBySample[index]?.get(sector.id);
  if (base === undefined || current === undefined) return null;
  if (base.sampleCount < rule.minSampleCount || current.sampleCount < rule.minSampleCount) {
    return null;
  }
  if (base.advanceRatio === null || current.advanceRatio === null) return null;
  const rank = rankingAt(ctx, sector.kind, index).dayRank.get(sector.id);
  if (rank === undefined || rank > rule.dayRankMax) return null;
  const drop = round2(base.advanceRatio - current.advanceRatio);
  if (drop < rule.advanceRatioDropPp) return null;
  const window = windowFactsAt(ctx, sector.id, index, rule.lookbackSamples);
  if (window.changePct === null || !(window.changePct < rule.windowChangePctBelow)) return null;
  return buildEvent({
    ctx,
    kind: 'divergence',
    sector,
    index,
    baseIndex,
    thresholds: rule,
  });
};

const rotationSideOf = (
  ctx: ScanContext,
  sectorId: string,
  index: number,
  lookback: number,
): MarketRoomEventRotation['from'] | null => {
  const sector = ctx.sectorsById.get(sectorId);
  if (sector === undefined) return null;
  const breadth = ctx.breadthBySample[index]?.get(sectorId);
  if (breadth === undefined) return null;
  const window = windowFactsAt(ctx, sectorId, index, lookback);
  return {
    sector: sectorRef(sector),
    dayRank: rankingAt(ctx, sector.kind, index).dayRank.get(sectorId) ?? null,
    dayChangePct: breadth.dayChangePct,
    windowChangePct: window.changePct,
  };
};

const detectRotation = (
  ctx: ScanContext,
  kind: SectorKind,
  index: number,
): MarketRoomEvent | null => {
  const rule = ctx.rules.rotation;
  if (index < 1) return null;
  const previous = rankingAt(ctx, kind, index - 1);
  const current = rankingAt(ctx, kind, index);
  if (previous.leaderId === null || current.leaderId === null) return null;
  if (previous.leaderId === current.leaderId) return null;
  const newLeader = ctx.sectorsById.get(current.leaderId);
  const oldLeader = ctx.sectorsById.get(previous.leaderId);
  if (newLeader === undefined || oldLeader === undefined) return null;
  if (index - rule.lookbackSamples < 0) return null;

  const leadSamples: MarketRoomEventRotation['leadSamples'] = [];
  for (let cursor = index - rule.consecutiveSamples + 1; cursor <= index; cursor += 1) {
    if (cursor - rule.lookbackSamples < 0) return null;
    const newBreadth = ctx.breadthBySample[cursor]?.get(newLeader.id);
    const oldBreadth = ctx.breadthBySample[cursor]?.get(oldLeader.id);
    if (newBreadth === undefined || oldBreadth === undefined) return null;
    if (
      newBreadth.sampleCount < rule.minSampleCount ||
      oldBreadth.sampleCount < rule.minSampleCount
    ) {
      return null;
    }
    const toWindow = windowFactsAt(ctx, newLeader.id, cursor, rule.lookbackSamples);
    const fromWindow = windowFactsAt(ctx, oldLeader.id, cursor, rule.lookbackSamples);
    if (toWindow.changePct === null || fromWindow.changePct === null) return null;
    const deltaPp = round2(toWindow.changePct - fromWindow.changePct);
    if (deltaPp < rule.windowLeadPpAtLeast) return null;
    const sampledAt = ctx.samples[cursor]?.batch.sampledAt;
    if (sampledAt === undefined) return null;
    leadSamples.push({
      sampledAt,
      fromWindowChangePct: fromWindow.changePct,
      toWindowChangePct: toWindow.changePct,
      deltaPp,
    });
  }

  const fromSide = rotationSideOf(ctx, oldLeader.id, index, rule.lookbackSamples);
  const toSide = rotationSideOf(ctx, newLeader.id, index, rule.lookbackSamples);
  if (fromSide === null || toSide === null) return null;
  return buildEvent({
    ctx,
    kind: 'rotation',
    sector: newLeader,
    index,
    baseIndex: index - rule.lookbackSamples,
    thresholds: rule,
    rotation: { from: fromSide, to: toSide, leadSamples },
  });
};

const KIND_ORDER: Readonly<Record<MarketRoomEventKind, number>> = {
  diffusion: 0,
  divergence: 1,
  rotation: 2,
};

export interface MarketRoomEventScanInput {
  readonly tradingDate: string;
  /** 同一交易日的已发布批次；调用方负责先按交易日过滤，本函数仍会复核。 */
  readonly batches: readonly MarketSnapshotBatch[];
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
  readonly ladderSamples: readonly LimitUpLadderSample[];
  /** 本次扫描的写入时点；事件只保留首次写入的 recordedAt。 */
  readonly recordedAt: Date;
  readonly ruleOverrides?: MarketRoomEventRuleOverrides;
}

/** 扫描最近样本，产出「应写入」的事件候选；不写库、不去重（去重由仓储主键保证）。 */
export const detectMarketRoomEvents = (input: MarketRoomEventScanInput): MarketRoomEvent[] => {
  const ctx = buildContext(input);
  const events: MarketRoomEvent[] = [];
  for (const kind of ['industry', 'concept'] as const) {
    const sectors = ctx.sectors.filter((sector) => sector.kind === kind);
    for (let index = 0; index < ctx.samples.length; index += 1) {
      for (const sector of sectors) {
        const diffusion = detectDiffusion(ctx, sector, index);
        if (diffusion !== null) events.push(diffusion);
        const divergence = detectDivergence(ctx, sector, index);
        if (divergence !== null) events.push(divergence);
      }
      const rotation = detectRotation(ctx, kind, index);
      if (rotation !== null) events.push(rotation);
    }
  }
  events.sort((left, right) => {
    const byTime = left.sampledAt.getTime() - right.sampledAt.getTime();
    if (byTime !== 0) return byTime;
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    return left.sector.sectorId.localeCompare(right.sector.sectorId);
  });
  return events;
};

// ---------- 只读视图 ----------

export const MARKET_ROOM_EVENTS_EMPTY_REASONS = ['no_batch', 'no_events'] as const;
export const MarketRoomEventsEmptyReasonSchema = z.enum(MARKET_ROOM_EVENTS_EMPTY_REASONS);
export type MarketRoomEventsEmptyReason = z.infer<typeof MarketRoomEventsEmptyReasonSchema>;

export const MarketRoomEventsFiltersSchema = z.object({
  date: dateString.nullable(),
  from: z.coerce.date().nullable(),
  to: z.coerce.date().nullable(),
  kind: MarketRoomEventKindSchema.nullable(),
  sectorId: z.string().min(1).nullable(),
  /** 回放时点：只返回该时点之前已记录的事件；null 表示最新模式。 */
  knownAt: z.coerce.date().nullable(),
});
export type MarketRoomEventsFilters = z.infer<typeof MarketRoomEventsFiltersSchema>;

export const MarketRoomEventsViewSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: MarketRoomEventsEmptyReasonSchema.optional(),
  tradingDate: dateString.nullable(),
  filters: MarketRoomEventsFiltersSchema,
  counts: z.object({
    total: z.number().int().nonnegative(),
    diffusion: z.number().int().nonnegative(),
    divergence: z.number().int().nonnegative(),
    rotation: z.number().int().nonnegative(),
  }),
  /** 按检测时点升序；页面按时间倒序展示，点击事件的时点切换属 #43。 */
  events: z.array(MarketRoomEventSchema),
  notes: z.array(z.string()),
});
export type MarketRoomEventsView = z.infer<typeof MarketRoomEventsViewSchema>;

const EVENT_VIEW_NOTES: readonly string[] = [
  '事件按检测时点升序返回；页面按时间倒序展示。',
  '每个事件保存扫描当时的阈值与证据，后续阈值调整不回改历史事件。',
  '同一份数据重复扫描、重试或重启只落一条事件；单次排名抖动不产生换位事件。',
  '未收录方向的「待核实」为二期，当前只产出已收录目录板块的 verified 事件。',
];

export const MARKET_ROOM_EVENTS_REPLAY_NOTE =
  '回放只返回已知时点（knownAt）之前已记录的事件：之后扫描出来的事件不会出现在更早的回放里。';

export const buildMarketRoomEventsView = (input: {
  readonly tradingDate: string | null;
  readonly events: readonly MarketRoomEvent[];
  readonly filters: {
    readonly date: string | null;
    readonly from: Date | null;
    readonly to: Date | null;
    readonly kind: MarketRoomEventKind | null;
    readonly sectorId: string | null;
    readonly knownAt: Date | null;
  };
  readonly emptyReason?: MarketRoomEventsEmptyReason;
}): MarketRoomEventsView => {
  const events = [...input.events].sort((left, right) => {
    const byTime = left.sampledAt.getTime() - right.sampledAt.getTime();
    if (byTime !== 0) return byTime;
    const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (byKind !== 0) return byKind;
    return left.sector.sectorId.localeCompare(right.sector.sectorId);
  });
  if (events.length === 0) {
    if (input.emptyReason === undefined) {
      throw new InvariantError('盘中事件空视图必须给出原因');
    }
  } else if (input.emptyReason !== undefined) {
    throw new InvariantError('盘中事件非空视图不得携带空态原因');
  }
  for (const event of events) {
    if (event.tradingDate !== input.tradingDate) {
      throw new InvariantError('盘中事件视图必须只包含同一交易日的事件');
    }
  }
  const count = (kind: MarketRoomEventKind): number =>
    events.filter((event) => event.kind === kind).length;
  return MarketRoomEventsViewSchema.parse({
    state: events.length === 0 ? 'empty' : 'ready',
    ...(input.emptyReason === undefined ? {} : { emptyReason: input.emptyReason }),
    tradingDate: input.tradingDate,
    filters: input.filters,
    counts: {
      total: events.length,
      diffusion: count('diffusion'),
      divergence: count('divergence'),
      rotation: count('rotation'),
    },
    events,
    notes:
      input.filters.knownAt === null
        ? [...EVENT_VIEW_NOTES]
        : [...EVENT_VIEW_NOTES, MARKET_ROOM_EVENTS_REPLAY_NOTE],
  });
};

// ---------- 身份与不变量 ----------

const EVENT_ID_SEPARATOR = '|';

export const marketRoomEventId = (input: {
  readonly tradingDate: string;
  readonly kind: MarketRoomEventKind;
  readonly sectorId: string;
  readonly sampledAt: Date;
}): string =>
  `${input.tradingDate}${EVENT_ID_SEPARATOR}${input.kind}${EVENT_ID_SEPARATOR}${input.sectorId}${EVENT_ID_SEPARATOR}${input.sampledAt.toISOString()}`;

const DIMENSION_STATUSES = (evidence: MarketRoomEventEvidence): EvidenceDimensionStatus[] => [
  evidence.window.status,
  evidence.breadth.status,
  evidence.turnover.status,
  evidence.ladder.status,
];

export const assertMarketRoomEventInvariants = (event: MarketRoomEvent): void => {
  const expectedId = marketRoomEventId({
    tradingDate: event.tradingDate,
    kind: event.kind,
    sectorId: event.sector.sectorId,
    sampledAt: event.sampledAt,
  });
  if (event.id !== expectedId) {
    throw new InvariantError(
      `market room event id (${event.id}) 必须由交易日 / 种类 / 板块 / 检测时点派生 (${expectedId})`,
    );
  }
  if (event.tradingDate !== dateInShanghai(event.sampledAt)) {
    throw new InvariantError(
      `market room event tradingDate (${event.tradingDate}) 与 sampledAt 不一致`,
    );
  }
  if (event.thresholds.kind !== event.kind) {
    throw new InvariantError('market room event 阈值种类必须与事件种类一致');
  }
  if (event.evidence.window.sampledAt.getTime() !== event.sampledAt.getTime()) {
    throw new InvariantError('market room event 窗口终点必须等于检测时点');
  }
  if (event.evidence.window.baseSampledAt.getTime() >= event.sampledAt.getTime()) {
    throw new InvariantError('market room event 窗口起点必须早于检测时点');
  }
  if (event.evidence.window.lookbackSamples !== event.thresholds.lookbackSamples) {
    throw new InvariantError('market room event 窗口回看样本数必须与阈值一致');
  }
  if (
    event.previousSampledAt !== null &&
    event.previousSampledAt.getTime() >= event.sampledAt.getTime()
  ) {
    throw new InvariantError('market room event 上一个样本必须早于检测时点');
  }
  if ((event.kind === 'rotation') !== (event.evidence.rotation !== undefined)) {
    throw new InvariantError('market room event 只有换位事件才携带 rotation 证据');
  }
  if (event.verification.status !== 'verified') {
    throw new InvariantError('market room event 当前只允许 verified 核实状态');
  }
  const expectedStatus = DIMENSION_STATUSES(event.evidence).every((status) => status === 'complete')
    ? 'complete'
    : 'partial';
  if (event.status !== expectedStatus) {
    throw new InvariantError('market room event 状态必须与证据维度完整度一致');
  }
};
