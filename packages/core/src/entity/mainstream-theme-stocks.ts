import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import type { EvidenceDimensionStatus } from './ashare-sentiment.js';
import type { LimitUpLadder, LimitUpLadderEntry } from './limit-up-ladder.js';
import { type LimitUpLadderSample, ladderOfSample } from './limit-up-ladder-sample.js';
import {
  buildMainstreamThemeMemberIndex,
  MAINSTREAM_THEME_RULE_VERSION,
  MAINSTREAM_THEMES,
} from './mainstream-themes.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import type { SectorCatalogEntry } from './sector-catalog.js';
import {
  type SectorMemberStatus,
  SectorMemberStatusSchema,
  type StockSectorMembership,
} from './sector-catalog.js';
import {
  resolveSectorWindow,
  SECTOR_EMPTY_REASON_TEXT,
  SECTOR_INTRADAY_WINDOWS,
  SectorRankingAnchorSchema,
  type SectorRankingEmptyReason,
  SectorRankingEmptyReasonSchema,
  type SectorWindowKey,
  SectorWindowKeySchema,
  type SectorWindowRef,
  sectorRankingAnchorSummary,
} from './sector-intraday-ranking.js';
import type { ListingStatus } from './stock-universe.js';

/**
 * 主流题材的短线核心股与全部成分读模型（v2）。
 *
 * - 标准题材成分 = `MAINSTREAM_THEMES` 全部原始概念的 active 成分并集，同一 stockId 只计一次；
 * - 代表股 = 日涨幅第一的领涨股；核心股最多 5 只：领涨、当前窗口成交额增量最高、最高连板，
 *   剩余位置按当前窗口成交额增量补足，角色可合并且不硬凑；
 * - 中文名只取 stockUniverse，快照里的代码占位名不当中文名；ST 由 stockUniverse 名称识别；
 * - 资金口径只有可核验成交额：个股窗口增量 ÷ 该题材非 ST 去重成分窗口增量合计，缺失不补 0；
 * - 炸板只在前后两个与批次时点对齐的天梯样本都可用、且前一样本封板当前不在时成立；
 * - 1 分钟序列只读本地已发布批次，缺口不插值，成交额差分为负修正时按缺失。
 */

export const MAINSTREAM_STOCK_ROLE_KINDS = ['leader', 'funds', 'height'] as const;
export const MainstreamStockRoleSchema = z.enum(MAINSTREAM_STOCK_ROLE_KINDS);
export type MainstreamStockRole = z.infer<typeof MainstreamStockRoleSchema>;

export const MAINSTREAM_STOCK_ROLE_LABELS: Readonly<Record<MainstreamStockRole, string>> = {
  leader: '领涨',
  funds: '资金',
  height: '高度',
};

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStringOrNull = z.union([z.string().regex(/^\d{2}:\d{2}:\d{2}$/), z.null()]);

const SHARE_METHOD =
  '题材内窗口成交占比 = 个股窗口成交额增量 ÷ 该标准题材非 ST 去重成分窗口成交额增量合计；分母缺失、增量缺失、负修正或窗口不可比一律 null + 原因，不补 0';
const SHARE_METHOD_PREVIOUS =
  '上一窗占比使用独立的上一窗口起点与分母，不复用当前窗分母；上一窗不可比时缺失';

export const MainstreamStockRowSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  /** 只取 stockUniverse 中文名；目录缺该股票时为 null，不用快照代码占位冒充。 */
  name: z.string().min(1).nullable(),
  nameSource: z.enum(['stock_universe']).nullable(),
  isSt: z.boolean(),
  memberStatus: SectorMemberStatusSchema,
  close: z.number().finite().positive().nullable(),
  dayChangePct: z.number().finite().nullable(),
  window5ChangePct: z.number().finite().nullable(),
  window15ChangePct: z.number().finite().nullable(),
  todayAmount: z.number().finite().nonnegative().nullable(),
  window5AmountDelta: z.number().finite().nonnegative().nullable(),
  window15AmountDelta: z.number().finite().nonnegative().nullable(),
  /** 请求窗口（w5 / w15）的成交额增量。 */
  windowAmountDelta: z.number().finite().nonnegative().nullable(),
  sharePct: z.number().finite().nullable(),
  previousSharePct: z.number().finite().nullable(),
  shareDeltaPp: z.number().finite().nullable(),
  amountDeltaChange: z.number().finite().nullable(),
  shareReason: z.string().min(1).nullable(),
  previousShareReason: z.string().min(1).nullable(),
  sealed: z.boolean().nullable(),
  ladderLevel: z.number().int().positive().nullable(),
  firstTime: timeStringOrNull,
  brokenBoard: z.boolean().nullable(),
  brokenBoardReason: z.string().min(1).nullable(),
  roles: z.array(MainstreamStockRoleSchema),
});
export type MainstreamStockRow = z.infer<typeof MainstreamStockRowSchema>;

export const MainstreamThemeStockCoverageSchema = z.object({
  /** 该标准题材全部 active 并集成分（去重）。 */
  memberCount: z.number().int().nonnegative(),
  /** 返回的成分子集（可交易且锚点批次有有效报价，含 ST）。 */
  constituentCount: z.number().int().nonnegative(),
  /** 参与占比分母的非 ST 成分数。 */
  eligibleCount: z.number().int().nonnegative(),
  stCount: z.number().int().nonnegative(),
  nonTradableCount: z.number().int().nonnegative(),
  missingQuoteCount: z.number().int().nonnegative(),
  unnamedCount: z.number().int().nonnegative(),
});
export type MainstreamThemeStockCoverage = z.infer<typeof MainstreamThemeStockCoverageSchema>;

export const MainstreamThemeShareBlockSchema = z.object({
  window: SectorWindowKeySchema,
  status: z.enum(['complete', 'partial', 'unavailable']),
  reason: z.string().min(1).nullable(),
  denominator: z.number().finite().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative(),
  previousStatus: z.enum(['complete', 'partial', 'unavailable']),
  previousReason: z.string().min(1).nullable(),
  previousDenominator: z.number().finite().nonnegative().nullable(),
  previousSampleCount: z.number().int().nonnegative(),
  method: z.string().min(1),
  previousMethod: z.string().min(1),
});
export type MainstreamThemeShareBlock = z.infer<typeof MainstreamThemeShareBlockSchema>;

export const MainstreamThemeLadderBlockSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  reason: z.string().min(1).nullable(),
  sampledAt: z.coerce.date().nullable(),
  previousSampledAt: z.coerce.date().nullable(),
  brokenBoardStatus: z.enum(['complete', 'partial', 'unavailable']),
  brokenBoardReason: z.string().min(1).nullable(),
});
export type MainstreamThemeLadderBlock = z.infer<typeof MainstreamThemeLadderBlockSchema>;

export const MainstreamThemeStockRowSchema = z.object({
  themeId: z.string().min(1),
  parentId: z.string().min(1),
  name: z.string().min(1),
  representative: MainstreamStockRowSchema.nullable(),
  coreStocks: z.array(MainstreamStockRowSchema).max(5),
  constituents: z.array(MainstreamStockRowSchema),
  coverage: MainstreamThemeStockCoverageSchema,
  share: MainstreamThemeShareBlockSchema,
  ladder: MainstreamThemeLadderBlockSchema,
  notes: z.array(z.string()),
});
export type MainstreamThemeStockRow = z.infer<typeof MainstreamThemeStockRowSchema>;

export const MainstreamStockBoardSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorRankingEmptyReasonSchema.optional(),
  ruleVersion: z.string().min(1),
  window: SectorWindowKeySchema,
  tradingDate: dateString.nullable(),
  anchor: SectorRankingAnchorSchema.nullable(),
  coverage: z.object({
    themeCount: z.number().int().nonnegative(),
    themeWithConstituentsCount: z.number().int().nonnegative(),
    constituentCount: z.number().int().nonnegative(),
    stCount: z.number().int().nonnegative(),
    nonTradableCount: z.number().int().nonnegative(),
    missingQuoteCount: z.number().int().nonnegative(),
    unnamedCount: z.number().int().nonnegative(),
    universeCount: z.number().int().nonnegative(),
    hasCurrentLadderSample: z.boolean(),
    hasPreviousLadderSample: z.boolean(),
  }),
  themes: z.array(MainstreamThemeStockRowSchema),
  notes: z.array(z.string()),
});
export type MainstreamStockBoard = z.infer<typeof MainstreamStockBoardSchema>;

const BOARD_NOTES: readonly string[] = [
  '标准题材成分 = 该标准题材全部原始概念的 active 成分并集，同一 stockId 只计一次；不取代表概念、不伪造目录条目。',
  '核心股顺序：日涨幅领涨 → 当前窗口成交额增量最高 → 最高连板高度 → 按当前窗口成交额增量补足，最多 5 只；角色可合并且不硬凑。',
  '中文名只取 stockUniverse；不在目录里的股票名称缺失，不用快照里的代码占位冒充。',
  '默认排除 ST；ST 成分保留在全部成分里，由前端「显示 ST」开关决定是否显示，且不参与核心股与占比分母。',
  '题材内窗口成交占比只使用成交额增量，分母为该题材非 ST 去重成分窗口增量合计；缺失、负修正与窗口不可比一律 null + 原因。',
  '炸板只在前后两个与批次采样时点对齐的天梯样本都可用、且前一样本封板当前不在时显示；不能仅凭 sealed=false 推断。',
  '停牌、退市、缺少有效报价的成分不计入成分表与核心股，只在 coverage 里计数。',
];

export const MAINSTREAM_STOCK_BOARD_NOTES = BOARD_NOTES;

/** A 股 ST / *ST / S*ST / SST 等前缀；只用于 stockUniverse 中文名。 */
export const isStStockName = (name: string | null | undefined): boolean => {
  if (typeof name !== 'string') return false;
  return /^(?:\*ST|ST|S\*ST|SST)/i.test(name.trim());
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const codeOfStockId = (stockId: string): string => stockId.split('.')[0] ?? stockId;

const isNonTradableStatus = (status: SectorMemberStatus | ListingStatus): boolean =>
  status === 'suspended' || status === 'delisted';

const itemMap = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((entry) => [entry.id, entry]));

interface WindowValue {
  readonly value: number | null;
  readonly reason: string | null;
}

const windowPriceReturn = (input: {
  readonly window: SectorWindowRef;
  readonly current: MarketSnapshotItem | undefined;
  readonly start: MarketSnapshotItem | undefined;
}): WindowValue => {
  if (input.window.status === 'unavailable') {
    return { value: null, reason: input.window.reason ?? 'window_unavailable: 窗口不可比' };
  }
  if (input.current?.close === undefined || input.start?.close === undefined) {
    return { value: null, reason: 'missing_window_price: 窗口两端缺价格' };
  }
  if (input.current.close <= 0 || input.start.close <= 0) {
    return { value: null, reason: 'invalid_window_price: 窗口两端价格不为正' };
  }
  return {
    value: round4((input.current.close / input.start.close - 1) * 100),
    reason: null,
  };
};

const windowAmountDelta = (input: {
  readonly window: SectorWindowRef;
  readonly current: MarketSnapshotItem | undefined;
  readonly start: MarketSnapshotItem | undefined;
}): WindowValue => {
  if (input.window.status === 'unavailable') {
    return { value: null, reason: input.window.reason ?? 'window_unavailable: 窗口不可比' };
  }
  if (input.current?.amount === undefined || input.start?.amount === undefined) {
    return { value: null, reason: 'missing_window_amount: 窗口两端缺成交额' };
  }
  const delta = input.current.amount - input.start.amount;
  if (delta < 0) {
    return { value: null, reason: 'amount_correction: 窗口成交额增量为负，按缺失处理，不补 0' };
  }
  return { value: round2(delta), reason: null };
};

const ladderIssue = (ladder: LimitUpLadder | null, label: string): string | null => {
  if (ladder === null) {
    return `limit_up_sample_missing: ${label}没有与批次采样时点对齐的连板天梯样本，封板与高度信息缺失（不写 0）`;
  }
  if (ladder.total === 0 && ladder.warnings.length > 0) {
    return `limit_up_empty: ${ladder.warnings[0] ?? '天梯为空'}，封板与高度信息缺失（不写 0）`;
  }
  return null;
};

const ladderCodes = (ladder: LimitUpLadder | null): ReadonlyMap<string, LimitUpLadderEntry> => {
  const map = new Map<string, LimitUpLadderEntry>();
  for (const level of ladder?.levels ?? []) {
    for (const entry of level.stocks) map.set(entry.code, entry);
  }
  return map;
};

const compareNullableDesc = (left: number | null, right: number | null): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};

export interface MainstreamStockUniverseEntry {
  readonly stockId: string;
  readonly name: string;
  readonly listingStatus: ListingStatus;
}

export interface MainstreamStockBoardInput {
  readonly window: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  readonly windowStarts: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  /** 上一窗口起点（当前窗口起点再往前一个窗口）；缺失时上一窗占比与变化为 null。 */
  readonly previousWindowStarts?: Readonly<Record<SectorWindowKey, MarketSnapshotBatch | null>>;
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
  readonly ladderSamples: readonly LimitUpLadderSample[];
  readonly universe: readonly MainstreamStockUniverseEntry[];
}

interface BaseRow {
  readonly stockId: string;
  readonly code: string;
  readonly name: string | null;
  readonly nameSource: 'stock_universe' | null;
  readonly isSt: boolean;
  readonly memberStatus: SectorMemberStatus;
  readonly close: number | null;
  readonly dayChangePct: number | null;
  readonly window5ChangePct: number | null;
  readonly window15ChangePct: number | null;
  readonly todayAmount: number | null;
  readonly window5AmountDelta: number | null;
  readonly window15AmountDelta: number | null;
  readonly windowAmountDelta: number | null;
  readonly windowDeltaReason: string | null;
  readonly previousWindowAmountDelta: number | null;
  readonly previousWindowDeltaReason: string | null;
  readonly sealed: boolean | null;
  readonly ladderLevel: number | null;
  readonly firstTime: string | null;
  readonly brokenBoard: boolean | null;
  readonly brokenBoardReason: string | null;
  readonly roles: MainstreamStockRole[];
  sharePct: number | null;
  previousSharePct: number | null;
  shareDeltaPp: number | null;
  amountDeltaChange: number | null;
  shareReason: string | null;
  previousShareReason: string | null;
}

interface Denominator {
  readonly status: EvidenceDimensionStatus;
  readonly reason: string | null;
  readonly value: number | null;
  readonly sampleCount: number;
  readonly eligibleCount: number;
}

const denominatorOf = (input: {
  readonly window: SectorWindowRef | null;
  readonly anchor: MarketSnapshotBatch;
  readonly start: MarketSnapshotBatch | null;
  readonly rows: readonly BaseRow[];
  readonly deltaOf: (row: BaseRow) => number | null;
  readonly label: string;
}): Denominator => {
  const eligible = input.rows.filter((row) => !row.isSt);
  const base = { eligibleCount: eligible.length };
  if (input.window === null || input.window.status === 'unavailable') {
    return {
      ...base,
      status: 'unavailable',
      reason:
        input.window?.reason === null || input.window?.reason === undefined
          ? `${input.label}_window_unavailable: ${input.label}窗口不可比，占比缺失`
          : `${input.label}_${input.window.reason}`,
      value: null,
      sampleCount: 0,
    };
  }
  if (input.start === null) {
    return {
      ...base,
      status: 'unavailable',
      reason: `${input.label}_start_missing: ${input.label}窗口起点缺失，占比缺失`,
      value: null,
      sampleCount: 0,
    };
  }
  if (!input.anchor.completeness.complete || !input.start.completeness.complete) {
    return {
      ...base,
      status: 'unavailable',
      reason: `${input.label}_batch_incomplete: ${input.label}端点批次不完整，分母不完整`,
      value: null,
      sampleCount: 0,
    };
  }
  if (eligible.length === 0) {
    return {
      ...base,
      status: 'unavailable',
      reason: `${input.label}_denominator_empty: 没有参与分母的非 ST 成分`,
      value: null,
      sampleCount: 0,
    };
  }
  const missing = eligible.filter((row) => input.deltaOf(row) === null);
  if (missing.length > 0) {
    return {
      ...base,
      status: 'unavailable',
      reason: `${input.label}_denominator_incomplete: ${missing.length} / ${eligible.length} 只非 ST 成分缺窗口成交额增量，分母不完整`,
      value: null,
      sampleCount: eligible.length - missing.length,
    };
  }
  let sum = 0;
  for (const row of eligible) sum += input.deltaOf(row) as number;
  const value = round2(sum);
  if (value <= 0) {
    return {
      ...base,
      status: 'unavailable',
      reason: `${input.label}_denominator_invalid: 非 ST 成分窗口成交额增量合计 ${value}，不为正，占比无意义`,
      value,
      sampleCount: eligible.length,
    };
  }
  return { ...base, status: 'complete', reason: null, value, sampleCount: eligible.length };
};

const compareForFill =
  (deltaOf: (row: BaseRow) => number | null) => (left: BaseRow, right: BaseRow) => {
    const byDelta = compareNullableDesc(deltaOf(left), deltaOf(right));
    if (byDelta !== 0) return byDelta;
    const byDay = compareNullableDesc(left.dayChangePct, right.dayChangePct);
    if (byDay !== 0) return byDay;
    return left.stockId.localeCompare(right.stockId);
  };

const compareConstituents = (left: BaseRow, right: BaseRow): number => {
  const byDelta15 = compareNullableDesc(left.window15AmountDelta, right.window15AmountDelta);
  if (byDelta15 !== 0) return byDelta15;
  const byDay = compareNullableDesc(left.dayChangePct, right.dayChangePct);
  if (byDay !== 0) return byDay;
  return left.stockId.localeCompare(right.stockId);
};

const toStockRow = (row: BaseRow): MainstreamStockRow => ({
  stockId: row.stockId,
  code: row.code,
  name: row.name,
  nameSource: row.nameSource,
  isSt: row.isSt,
  memberStatus: row.memberStatus,
  close: row.close,
  dayChangePct: row.dayChangePct,
  window5ChangePct: row.window5ChangePct,
  window15ChangePct: row.window15ChangePct,
  todayAmount: row.todayAmount,
  window5AmountDelta: row.window5AmountDelta,
  window15AmountDelta: row.window15AmountDelta,
  windowAmountDelta: row.windowAmountDelta,
  sharePct: row.sharePct,
  previousSharePct: row.previousSharePct,
  shareDeltaPp: row.shareDeltaPp,
  amountDeltaChange: row.amountDeltaChange,
  shareReason: row.shareReason,
  previousShareReason: row.previousShareReason,
  sealed: row.sealed,
  ladderLevel: row.ladderLevel,
  firstTime: row.firstTime,
  brokenBoard: row.brokenBoard,
  brokenBoardReason: row.brokenBoardReason,
  roles: [...row.roles],
});

export const buildMainstreamStockBoardEmpty = (input: {
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): MainstreamStockBoard => {
  if ((input.reason === 'no_batch') !== (input.latest === null)) {
    throw new InvariantError('主流题材核心股空态原因与最近批次状态不一致');
  }
  return MainstreamStockBoardSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
    window: input.window,
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : sectorRankingAnchorSummary(input.latest),
    coverage: {
      themeCount: MAINSTREAM_THEMES.length,
      themeWithConstituentsCount: 0,
      constituentCount: 0,
      stCount: 0,
      nonTradableCount: 0,
      missingQuoteCount: 0,
      unnamedCount: 0,
      universeCount: 0,
      hasCurrentLadderSample: false,
      hasPreviousLadderSample: false,
    },
    themes: [],
    notes: [`${input.reason}: ${SECTOR_EMPTY_REASON_TEXT[input.reason]}`, ...BOARD_NOTES],
  });
};

export const buildMainstreamStockBoard = (
  input: MainstreamStockBoardInput,
): MainstreamStockBoard => {
  const memberIndex = buildMainstreamThemeMemberIndex({
    sectors: input.sectors,
    members: input.members,
  });
  const anchorItems = itemMap(input.anchor);
  const startItems = {
    w5: itemMap(input.windowStarts.w5),
    w15: itemMap(input.windowStarts.w15),
  };
  const windows = {
    w5: resolveSectorWindow({ key: 'w5', anchor: input.anchor, start: input.windowStarts.w5 }),
    w15: resolveSectorWindow({ key: 'w15', anchor: input.anchor, start: input.windowStarts.w15 }),
  };
  const currentStart = input.windowStarts[input.window];
  const previousStart = input.previousWindowStarts?.[input.window] ?? null;
  const previousStartItems = itemMap(previousStart);
  const previousWindow =
    currentStart === null
      ? null
      : resolveSectorWindow({ key: input.window, anchor: currentStart, start: previousStart });

  const sampleByTime = new Map(
    input.ladderSamples.map((sample) => [sample.sampledAt.getTime(), sample]),
  );
  const currentSample = sampleByTime.get(input.anchor.sampledAt.getTime()) ?? null;
  const previousSample =
    currentStart === null ? null : (sampleByTime.get(currentStart.sampledAt.getTime()) ?? null);
  const currentLadder = currentSample === null ? null : ladderOfSample(currentSample);
  const previousLadder = previousSample === null ? null : ladderOfSample(previousSample);
  const currentLadderReason = ladderIssue(currentLadder, '当前');
  const previousLadderReason = ladderIssue(previousLadder, '上一窗口');
  const currentCodes = ladderCodes(currentLadderReason === null ? currentLadder : null);
  const previousCodes = ladderCodes(previousLadderReason === null ? previousLadder : null);
  const ladderUsable = currentLadderReason === null;
  const previousLadderUsable = previousLadderReason === null;
  const brokenBoardReason =
    ladderUsable && previousLadderUsable
      ? null
      : `broken_board_unverified: ${
          currentLadderReason ?? previousLadderReason ?? '前后天梯样本不可用'
        }，炸板状态缺失，不能仅凭 sealed=false 推断`;

  const universeById = new Map(input.universe.map((entry) => [entry.stockId, entry]));

  const themes: MainstreamThemeStockRow[] = [];
  let totalConstituent = 0;
  let totalSt = 0;
  let totalNonTradable = 0;
  let totalMissingQuote = 0;
  let totalUnnamed = 0;
  let themeWithConstituents = 0;

  for (const theme of MAINSTREAM_THEMES) {
    const memberships = memberIndex.themeMembers.get(theme.id) ?? [];
    const rows: BaseRow[] = [];
    let nonTradableCount = 0;
    let missingQuoteCount = 0;
    let stCount = 0;
    let unnamedCount = 0;

    for (const membership of memberships) {
      const current = anchorItems.get(membership.stockId);
      const universe = universeById.get(membership.stockId);
      const universeStatus = universe?.listingStatus ?? 'unknown';
      if (isNonTradableStatus(membership.memberStatus) || isNonTradableStatus(universeStatus)) {
        nonTradableCount += 1;
        continue;
      }
      if (
        current === undefined ||
        current.close === undefined ||
        current.changePct === undefined ||
        current.close <= 0
      ) {
        missingQuoteCount += 1;
        continue;
      }
      const name = universe?.name ?? null;
      if (name === null) unnamedCount += 1;
      const isSt = name !== null && isStStockName(name);
      if (isSt) stCount += 1;

      const start5 = startItems.w5.get(membership.stockId);
      const start15 = startItems.w15.get(membership.stockId);
      const window5 = windowPriceReturn({ window: windows.w5, current, start: start5 });
      const window15 = windowPriceReturn({ window: windows.w15, current, start: start15 });
      const delta5 = windowAmountDelta({ window: windows.w5, current, start: start5 });
      const delta15 = windowAmountDelta({ window: windows.w15, current, start: start15 });
      const requestedDelta = input.window === 'w5' ? delta5 : delta15;
      const previousDelta =
        previousWindow === null
          ? {
              value: null,
              reason: 'previous_window_missing: 上一窗口起点缺失，变化缺失',
            }
          : windowAmountDelta({
              window: previousWindow,
              current: startItems[input.window].get(membership.stockId),
              start: previousStartItems.get(membership.stockId),
            });

      const ladderEntry = ladderUsable
        ? currentCodes.get(codeOfStockId(membership.stockId))
        : undefined;
      const brokenBoard =
        ladderUsable && previousLadderUsable
          ? previousCodes.has(codeOfStockId(membership.stockId)) && ladderEntry === undefined
          : null;

      rows.push({
        stockId: membership.stockId,
        code: codeOfStockId(membership.stockId),
        name,
        nameSource: name === null ? null : 'stock_universe',
        isSt,
        memberStatus: membership.memberStatus,
        close: current.close,
        dayChangePct: current.changePct,
        window5ChangePct: window5.value,
        window15ChangePct: window15.value,
        todayAmount: current.amount === undefined ? null : current.amount,
        window5AmountDelta: delta5.value,
        window15AmountDelta: delta15.value,
        windowAmountDelta: requestedDelta.value,
        windowDeltaReason: requestedDelta.reason,
        previousWindowAmountDelta: previousDelta.value,
        previousWindowDeltaReason: previousDelta.reason,
        sealed: ladderUsable ? ladderEntry !== undefined : null,
        ladderLevel: ladderEntry?.ladderLevel ?? null,
        firstTime: ladderEntry?.firstTime ?? null,
        brokenBoard,
        brokenBoardReason: brokenBoard === null ? brokenBoardReason : null,
        roles: [],
        sharePct: null,
        previousSharePct: null,
        shareDeltaPp: null,
        amountDeltaChange: null,
        shareReason: null,
        previousShareReason: null,
      });
    }

    const eligibleRows = rows.filter((row) => !row.isSt);
    const denominator = denominatorOf({
      window: windows[input.window],
      anchor: input.anchor,
      start: currentStart,
      rows,
      deltaOf: (row) => row.windowAmountDelta,
      label: 'current',
    });
    const previousDenominator = denominatorOf({
      window: previousWindow,
      anchor: currentStart ?? input.anchor,
      start: previousStart,
      rows,
      deltaOf: (row) => row.previousWindowAmountDelta,
      label: 'previous',
    });

    for (const row of rows) {
      if (row.isSt) {
        row.shareReason = 'st_excluded: ST 成分默认排除，不参与占比分母';
        continue;
      }
      if (denominator.status === 'unavailable' || denominator.value === null) {
        row.shareReason = denominator.reason;
        continue;
      }
      if (row.windowAmountDelta === null) {
        row.shareReason = row.windowDeltaReason ?? 'missing_window_amount: 窗口成交额增量缺失';
        continue;
      }
      row.sharePct = round2((row.windowAmountDelta / denominator.value) * 100);
      row.shareReason = null;
      if (previousDenominator.status !== 'unavailable' && previousDenominator.value !== null) {
        if (row.previousWindowAmountDelta !== null) {
          row.previousSharePct = round2(
            (row.previousWindowAmountDelta / previousDenominator.value) * 100,
          );
          row.shareDeltaPp = round2(row.sharePct - row.previousSharePct);
          row.amountDeltaChange = round2(row.windowAmountDelta - row.previousWindowAmountDelta);
          row.previousShareReason = null;
        } else {
          row.previousShareReason =
            row.previousWindowDeltaReason ??
            'missing_previous_window_amount: 上一窗口成交额增量缺失';
        }
      } else {
        row.previousShareReason = previousDenominator.reason;
      }
    }

    const leader = [...eligibleRows].sort((left, right) => {
      const byDay = compareNullableDesc(left.dayChangePct, right.dayChangePct);
      if (byDay !== 0) return byDay;
      return left.stockId.localeCompare(right.stockId);
    })[0];
    const funds = [...eligibleRows]
      .filter((row) => row.windowAmountDelta !== null)
      .sort(compareForFill((row) => row.windowAmountDelta))[0];
    const height = ladderUsable
      ? [...eligibleRows]
          .filter((row) => currentCodes.has(row.code))
          .sort((left, right) => {
            const leftEntry = currentCodes.get(left.code);
            const rightEntry = currentCodes.get(right.code);
            const byLevel = (rightEntry?.ladderLevel ?? 0) - (leftEntry?.ladderLevel ?? 0);
            if (byLevel !== 0) return byLevel;
            const byFirst = (leftEntry?.firstTime ?? '99:99:99').localeCompare(
              rightEntry?.firstTime ?? '99:99:99',
            );
            if (byFirst !== 0) return byFirst;
            const byDelta = compareNullableDesc(left.windowAmountDelta, right.windowAmountDelta);
            if (byDelta !== 0) return byDelta;
            return left.stockId.localeCompare(right.stockId);
          })[0]
      : undefined;

    const selected = new Map<string, BaseRow>();
    const addRole = (row: BaseRow | undefined, role: MainstreamStockRole): void => {
      if (row === undefined) return;
      selected.set(row.stockId, row);
      if (!row.roles.includes(role)) row.roles.push(role);
    };
    addRole(leader, 'leader');
    addRole(funds, 'funds');
    addRole(height, 'height');
    for (const row of [...eligibleRows].sort(compareForFill((entry) => entry.windowAmountDelta))) {
      if (selected.size >= 5) break;
      selected.set(row.stockId, row);
    }

    const coreStocks = [...selected.values()].slice(0, 5).map(toStockRow);
    const constituents = [...rows].sort(compareConstituents).map(toStockRow);
    const representative =
      leader === undefined
        ? null
        : (coreStocks.find((row) => row.stockId === leader.stockId) ?? null);

    const coverage: MainstreamThemeStockCoverage = {
      memberCount: memberships.length,
      constituentCount: rows.length,
      eligibleCount: eligibleRows.length,
      stCount,
      nonTradableCount,
      missingQuoteCount,
      unnamedCount,
    };
    const share: MainstreamThemeShareBlock = {
      window: input.window,
      status: denominator.status,
      reason: denominator.reason,
      denominator: denominator.value,
      sampleCount: denominator.sampleCount,
      previousStatus: previousDenominator.status,
      previousReason: previousDenominator.reason,
      previousDenominator: previousDenominator.value,
      previousSampleCount: previousDenominator.sampleCount,
      method: SHARE_METHOD,
      previousMethod: SHARE_METHOD_PREVIOUS,
    };
    const ladder: MainstreamThemeLadderBlock = {
      status: ladderUsable ? 'complete' : 'unavailable',
      reason: currentLadderReason,
      sampledAt: currentSample?.sampledAt ?? null,
      previousSampledAt: previousSample?.sampledAt ?? null,
      brokenBoardStatus: ladderUsable && previousLadderUsable ? 'complete' : 'unavailable',
      brokenBoardReason,
    };

    themes.push({
      themeId: theme.id,
      parentId: theme.parentId,
      name: theme.name,
      representative,
      coreStocks,
      constituents,
      coverage,
      share,
      ladder,
      notes: [
        `核心股 ${coreStocks.length} / 5，领涨 ${leader?.name ?? leader?.code ?? '缺失'}`,
        `占比分母 ${denominator.value === null ? '缺失' : round2(denominator.value)} 元（非 ST 成分 ${denominator.sampleCount} 只）`,
        ...(ladderUsable ? [] : [currentLadderReason ?? '天梯缺失']),
      ],
    });

    totalConstituent += rows.length;
    totalSt += stCount;
    totalNonTradable += nonTradableCount;
    totalMissingQuote += missingQuoteCount;
    totalUnnamed += unnamedCount;
    if (rows.length > 0) themeWithConstituents += 1;
  }

  return MainstreamStockBoardSchema.parse({
    state: 'ready',
    ruleVersion: MAINSTREAM_THEME_RULE_VERSION,
    window: input.window,
    tradingDate: input.anchor.tradingDate,
    anchor: sectorRankingAnchorSummary(input.anchor),
    coverage: {
      themeCount: themes.length,
      themeWithConstituentsCount: themeWithConstituents,
      constituentCount: totalConstituent,
      stCount: totalSt,
      nonTradableCount: totalNonTradable,
      missingQuoteCount: totalMissingQuote,
      unnamedCount: totalUnnamed,
      universeCount: universeById.size,
      hasCurrentLadderSample: currentSample !== null,
      hasPreviousLadderSample: previousSample !== null,
    },
    themes,
    notes: [...BOARD_NOTES],
  });
};

/** 从核心股 / 成分读模型按 stockId 反查（弹窗与深链接恢复用）。 */
export const mainstreamStockRowById = (
  board: MainstreamStockBoard,
  stockId: string,
): MainstreamStockRow | null => {
  for (const theme of board.themes) {
    const found = theme.constituents.find((row) => row.stockId === stockId);
    if (found !== undefined) return found;
  }
  return null;
};

// ---------- 个股 1 分钟价格与成交额序列 ----------

export const StockIntradayPointSchema = z.object({
  sampledAt: z.coerce.date(),
  close: z.number().finite().positive(),
  amount: z.number().finite().nonnegative().nullable(),
  amountDelta: z.number().finite().nonnegative().nullable(),
  gapBefore: z.boolean(),
  amountReason: z.string().min(1).nullable(),
});
export type StockIntradayPoint = z.infer<typeof StockIntradayPointSchema>;

export const StockIntradaySeriesSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorRankingEmptyReasonSchema.optional(),
  stockId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1).nullable(),
  nameSource: z.enum(['stock_universe']).nullable(),
  tradingDate: dateString.nullable(),
  anchor: SectorRankingAnchorSchema.nullable(),
  points: z.array(StockIntradayPointSchema),
  coverage: z.object({
    batchCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    amountMissingCount: z.number().int().nonnegative(),
    negativeCorrectionCount: z.number().int().nonnegative(),
  }),
  notes: z.array(z.string()),
});
export type StockIntradaySeries = z.infer<typeof StockIntradaySeriesSchema>;

const SERIES_NOTES: readonly string[] = [
  '价格与成交额只取本地已发布的 market_snapshot_batches；不请求另一个实时行情源。',
  '缺口断线、不插值：相邻点不是 1 分钟间隔时，该点成交额差分缺失。',
  '成交额差分 = 相邻 1 分钟批次累计成交额之差；负修正与缺字段按缺失说明，不补 0。',
];

export const buildStockIntradaySeriesEmpty = (input: {
  readonly stockId: string;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
  readonly name?: string | null;
}): StockIntradaySeries =>
  StockIntradaySeriesSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    stockId: input.stockId,
    code: codeOfStockId(input.stockId),
    name: input.name ?? null,
    nameSource: input.name === undefined || input.name === null ? null : 'stock_universe',
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : sectorRankingAnchorSummary(input.latest),
    points: [],
    coverage: {
      batchCount: 0,
      pointCount: 0,
      gapCount: 0,
      amountMissingCount: 0,
      negativeCorrectionCount: 0,
    },
    notes: [`${input.reason}: ${SECTOR_EMPTY_REASON_TEXT[input.reason]}`, ...SERIES_NOTES],
  });

export interface StockIntradaySeriesInput {
  readonly stockId: string;
  readonly anchor: MarketSnapshotBatch;
  /** 同一交易日的已发布批次；函数内按采样时点升序并截断到 anchor。 */
  readonly batches: readonly MarketSnapshotBatch[];
  readonly name: string | null;
}

export const buildStockIntradaySeries = (input: StockIntradaySeriesInput): StockIntradaySeries => {
  const cutoff = input.anchor.sampledAt.getTime();
  const batches = [...input.batches]
    .filter(
      (batch) =>
        batch.tradingDate === input.anchor.tradingDate && batch.sampledAt.getTime() <= cutoff,
    )
    .sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime());
  const seen = new Set<number>();
  const points: StockIntradayPoint[] = [];
  let previous: { readonly sampledAt: Date; readonly amount: number | null } | null = null;
  let gapCount = 0;
  let amountMissingCount = 0;
  let negativeCorrectionCount = 0;

  for (const batch of batches) {
    if (seen.has(batch.sampledAt.getTime())) continue;
    seen.add(batch.sampledAt.getTime());
    const item = batch.items.find((entry) => entry.id === input.stockId);
    if (item?.close === undefined || item.close <= 0) {
      previous = null;
      continue;
    }
    const amount = item.amount === undefined ? null : item.amount;
    const gapBefore =
      previous !== null && previous.sampledAt.getTime() + 60_000 !== batch.sampledAt.getTime();
    if (gapBefore) gapCount += 1;
    let amountDelta: number | null = null;
    let amountReason: string | null = null;
    if (previous === null) {
      amountReason = 'first_point: 序列首点没有可比较的上一分钟累计成交额';
    } else if (gapBefore) {
      amountReason = 'gap_before: 上一分钟批次缺失，断线不插值';
    } else if (previous.amount === null || amount === null) {
      amountReason = 'missing_amount: 相邻批次缺累计成交额';
    } else {
      const delta = amount - previous.amount;
      if (delta < 0) {
        amountReason = 'negative_correction: 累计成交额向下修正，差分无效，按缺失处理';
        negativeCorrectionCount += 1;
      } else {
        amountDelta = round2(delta);
      }
    }
    if (amountDelta === null && previous !== null) amountMissingCount += 1;
    points.push({
      sampledAt: batch.sampledAt,
      close: item.close,
      amount,
      amountDelta,
      gapBefore,
      amountReason,
    });
    previous = { sampledAt: batch.sampledAt, amount };
  }

  return StockIntradaySeriesSchema.parse({
    state: 'ready',
    stockId: input.stockId,
    code: codeOfStockId(input.stockId),
    name: input.name,
    nameSource: input.name === null ? null : 'stock_universe',
    tradingDate: input.anchor.tradingDate,
    anchor: sectorRankingAnchorSummary(input.anchor),
    points,
    coverage: {
      batchCount: batches.length,
      pointCount: points.length,
      gapCount,
      amountMissingCount,
      negativeCorrectionCount,
    },
    notes: [...SERIES_NOTES],
  });
};

export const MAINSTREAM_STOCK_WINDOW_MINUTES = SECTOR_INTRADAY_WINDOWS;
