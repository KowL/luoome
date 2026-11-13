import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import type { EvidenceDimensionStatus } from './ashare-sentiment.js';
import type { LimitUpLadder, LimitUpLadderEntry } from './limit-up-ladder.js';
import { type LimitUpLadderSample, ladderOfSample } from './limit-up-ladder-sample.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  SectorKindSchema,
  SectorMemberStatusSchema,
  type StockSectorMembership,
  type StockSectorMembershipView,
} from './sector-catalog.js';
import {
  resolveSectorWindow,
  SECTOR_RANKING_EMPTY_REASONS,
  type SectorWindowKey,
  SectorWindowKeySchema,
} from './sector-intraday-ranking.js';

/**
 * 核心股角色与换位时间线（ticket #41）。
 *
 * 三个角色都由本地已发布事实复算，每个角色都必须给出可复现证据；证据不足时为空或并列：
 * - 启动先锋：首次可核实的异动（优先天梯首次封板，其次日涨幅达到异动阈值）之后，
 *   板块上涨面必须扩散，否则空；
 * - 成交核心：锚点累计成交额最高者，且最近连续样本跑赢板块中位数；最高成交额成分
 *   不满足持续相对强度时该角色为空，不降级选第二名；
 * - 高度标：天梯样本中连板层级最高的 active 成分，同层级按锚点成交额，仍相同则并列。
 *
 * 时间线只呈现出现 / 开板 / 换位 / 退出事实与缺样本提示，不写入任何事件存储（#42）。
 * 供应商只给封板时间时按原口径保存与展示，不用采样时点反推封板时刻。
 */

export const CORE_ROLE_KINDS = ['ignition', 'turnover', 'height'] as const;
export const CoreRoleKindSchema = z.enum(CORE_ROLE_KINDS);
export type CoreRoleKind = z.infer<typeof CoreRoleKindSchema>;

export const CORE_ROLE_LABELS: Readonly<Record<CoreRoleKind, string>> = {
  ignition: '启动先锋',
  turnover: '成交核心',
  height: '高度标',
};

/** 没有天梯证据时，首次可核实异动的日涨幅阈值（百分点）。 */
export const CORE_IGNITION_CHANGE_PCT = 5;
/** 上涨面扩散：上涨比例至少提高的百分点。 */
export const CORE_EXPANSION_DELTA_PP = 10;
/** 上涨面扩散：或上涨家数至少增加的家数。 */
export const CORE_EXPANSION_ADVANCING_DELTA = 2;
/** 持续相对强度要求的最少连续样本数。 */
export const CORE_SUSTAINED_MIN_SAMPLES = 2;
/** 持续相对强度回看的样本数上限（含锚点）。 */
export const CORE_SUSTAINED_LOOKBACK_SAMPLES = 3;
/** 从核心股反查题材时，每个题材展示的其他成员上限。 */
export const CORE_LOOKUP_PEER_LIMIT = 20;

const IGNITION_METHOD = `启动先锋 = 首次可核实的异动（优先天梯首次封板）后，板块上涨面至少扩散 ${CORE_EXPANSION_DELTA_PP}pp 或上涨家数至少 +${CORE_EXPANSION_ADVANCING_DELTA}；并列先按异动时点、再按供应商封板时间，仍相同则并列`;
const TURNOVER_METHOD =
  '成交核心 = 锚点累计成交额最高的 active 成分（缺成交额成分不参与比较），且最近连续样本跑赢板块中位数（至少 2 个样本）；最高成交额成分不满足持续相对强度时该角色缺失，不降级选第二名';
const HEIGHT_METHOD =
  '高度标 = 天梯样本中连板层级最高的 active 成分；同层级按锚点累计成交额选出，成交额仍相同则并列；无天梯样本时缺失';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const CORE_STOCKS_EMPTY_REASONS = [
  ...SECTOR_RANKING_EMPTY_REASONS,
  'sector_not_found',
] as const;
export const CoreStocksEmptyReasonSchema = z.enum(CORE_STOCKS_EMPTY_REASONS);
export type CoreStocksEmptyReason = z.infer<typeof CoreStocksEmptyReasonSchema>;

// ---------- 证据与角色 ----------

const EvidenceValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const CoreEvidenceSchema = z.object({
  /** 该证据事实所属的采样时点；无时点概念的静态证据为 null。 */
  sampledAt: z.coerce.date().nullable(),
  /** 字段名（如 ladderLevel / firstTime / amount / sectorAdvanceRatio）。 */
  field: z.string().min(1),
  value: EvidenceValueSchema,
  /** 事实来源，如 `limit_up_ladder:eastmoney`、`market_snapshot_batch:...`。 */
  source: z.string().min(1),
  note: z.string().min(1).nullable(),
});
export type CoreEvidence = z.infer<typeof CoreEvidenceSchema>;

export const CoreStockIdentitySchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  /** 批次与天梯都没有名称时为 null，不用代码编造名称。 */
  name: z.string().min(1).nullable(),
});
export type CoreStockIdentity = z.infer<typeof CoreStockIdentitySchema>;

export const CoreRoleHolderSchema = CoreStockIdentitySchema.extend({
  evidence: z.array(CoreEvidenceSchema).min(1),
});
export type CoreRoleHolder = z.infer<typeof CoreRoleHolderSchema>;

export const CORE_ROLE_STATUSES = ['assigned', 'tied', 'unavailable'] as const;
export const CoreRoleStatusSchema = z.enum(CORE_ROLE_STATUSES);

export const CoreRoleSchema = z.object({
  kind: CoreRoleKindSchema,
  label: z.string().min(1),
  status: CoreRoleStatusSchema,
  holders: z.array(CoreRoleHolderSchema),
  method: z.string().min(1),
  /** 角色缺失的原因；assigned / tied 时为 null。 */
  reason: z.string().min(1).nullable(),
  warnings: z.array(z.string()),
});
export type CoreRole = z.infer<typeof CoreRoleSchema>;

// ---------- 时间线 ----------

export const CORE_TIMELINE_KINDS = [
  'sample_missing',
  'appear',
  'rotate',
  'exit',
  'open_board',
] as const;
export const CoreTimelineKindSchema = z.enum(CORE_TIMELINE_KINDS);
export type CoreTimelineKind = z.infer<typeof CoreTimelineKindSchema>;

export const CoreTimelineEventSchema = z.object({
  sampledAt: z.coerce.date(),
  /** 上一个样本时点；首个样本为 null。 */
  previousSampledAt: z.coerce.date().nullable(),
  kind: CoreTimelineKindSchema,
  /** 开板 / 缺样本事件不绑定单个角色，roleKind 为 null。 */
  roleKind: CoreRoleKindSchema.nullable(),
  from: z.array(CoreStockIdentitySchema),
  to: z.array(CoreStockIdentitySchema),
  basis: z.string().min(1),
  evidence: z.array(CoreEvidenceSchema),
});
export type CoreTimelineEvent = z.infer<typeof CoreTimelineEventSchema>;

// ---------- 从核心股反查题材 ----------

export const CoreThemePeerSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1).nullable(),
  memberStatus: SectorMemberStatusSchema,
  dayChangePct: z.number().finite().nullable(),
  /** 与目标板块同一窗口口径的涨幅；窗口不可比时为 null。 */
  windowChangePct: z.number().finite().nullable(),
  sealed: z.boolean().nullable(),
  ladderLevel: z.number().int().positive().nullable(),
  /** 该题材内按日涨幅降序的名次（有效成分从 1 开始）；无涨幅时为 null。 */
  dayRank: z.number().int().positive().nullable(),
});
export type CoreThemePeer = z.infer<typeof CoreThemePeerSchema>;

export const CoreThemeSchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
  /** 该核心股在这个题材里占用的角色；无法复算的空数组。 */
  roleKinds: z.array(CoreRoleKindSchema),
  breadth: z.object({
    status: z.enum(['complete', 'partial', 'unavailable']),
    advancing: z.number().int().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
    advanceRatio: z.number().finite().nullable(),
  }),
  thisStock: CoreThemePeerSchema,
  peerCount: z.number().int().nonnegative(),
  peers: z.array(CoreThemePeerSchema),
  warnings: z.array(z.string()),
});
export type CoreTheme = z.infer<typeof CoreThemeSchema>;

export const CoreStockLookupSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1).nullable(),
  /** 出现的在册题材数（行业 + 概念，去重）。 */
  themeCount: z.number().int().nonnegative(),
  /** 其中该股票占用核心角色的题材数。 */
  roleThemeCount: z.number().int().nonnegative(),
  /** 同一只股票是否在多个题材里都是核心角色。 */
  pullsMultipleThemes: z.boolean(),
  themes: z.array(CoreThemeSchema),
  warnings: z.array(z.string()),
});
export type CoreStockLookup = z.infer<typeof CoreStockLookupSchema>;

// ---------- 整体输出 ----------

const anchorShape = z
  .object({
    sampledAt: z.coerce.date(),
    source: z.string().min(1),
    tradingDate: dateString,
    complete: z.boolean(),
    expectedCount: z.number().int().nonnegative(),
    receivedCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
  })
  .nullable();

export const CoreStocksCoverageSchema = z.object({
  batchCount: z.number().int().nonnegative(),
  ladderSampleCount: z.number().int().nonnegative(),
  ladderMissingCount: z.number().int().nonnegative(),
  timelineEventCount: z.number().int().nonnegative(),
  lookupCount: z.number().int().nonnegative(),
});
export type CoreStocksCoverage = z.infer<typeof CoreStocksCoverageSchema>;

export const MarketRoomCoreStocksSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: CoreStocksEmptyReasonSchema.optional(),
  sector: z
    .object({
      sectorId: z.string().min(1),
      kind: SectorKindSchema,
      vendorCode: z.string().min(1),
      name: z.string().min(1),
    })
    .nullable(),
  tradingDate: dateString.nullable(),
  anchor: anchorShape,
  window: SectorWindowKeySchema,
  roles: z.object({
    ignition: CoreRoleSchema,
    turnover: CoreRoleSchema,
    height: CoreRoleSchema,
  }),
  timeline: z.array(CoreTimelineEventSchema),
  lookups: z.array(CoreStockLookupSchema),
  coverage: CoreStocksCoverageSchema,
  notes: z.array(z.string()),
});
export type MarketRoomCoreStocks = z.infer<typeof MarketRoomCoreStocksSchema>;

// ---------- 内部工具 ----------

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const clockLabel = (date: Date): string => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(
    shifted.getUTCMinutes(),
  ).padStart(2, '0')}`;
};

const codeOfStockId = (stockId: string): string => stockId.split('.')[0] ?? stockId;

const isNonTradable = (membership: StockSectorMembership): boolean =>
  membership.memberStatus === 'suspended' || membership.memberStatus === 'delisted';

const activeMembersOf = (
  members: readonly StockSectorMembership[],
): readonly StockSectorMembership[] =>
  members.filter((membership) => membership.state === 'active');

const tradableMembersOf = (
  members: readonly StockSectorMembership[],
): readonly StockSectorMembership[] =>
  activeMembersOf(members).filter((membership) => !isNonTradable(membership));

const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
};

const itemMapOf = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((entry) => [entry.id, entry]));

interface CoreSampleView {
  readonly batch: MarketSnapshotBatch;
  readonly items: ReadonlyMap<string, MarketSnapshotItem>;
  /** 与批次采样时点完全对齐的天梯样本；缺失为 null，不用相邻样本冒充。 */
  readonly ladderSample: LimitUpLadderSample | null;
  readonly ladder: LimitUpLadder | null;
  readonly ladderByCode: ReadonlyMap<string, LimitUpLadderEntry>;
  readonly advancing: number;
  readonly sampleCount: number;
  /** 上涨比例（0-100）；没有有效成分时为 null。 */
  readonly advanceRatio: number | null;
  readonly medianChangePct: number | null;
}

const buildSampleViews = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly batches: readonly MarketSnapshotBatch[];
  readonly ladderSamples: readonly LimitUpLadderSample[];
}): CoreSampleView[] => {
  const samplesByTime = new Map(
    input.ladderSamples.map((sample) => [sample.sampledAt.getTime(), sample]),
  );
  const tradable = tradableMembersOf(input.members);
  return input.batches.map((batch) => {
    const items = itemMapOf(batch);
    const ladderSample = samplesByTime.get(batch.sampledAt.getTime()) ?? null;
    const ladder = ladderSample === null ? null : ladderOfSample(ladderSample);
    const ladderByCode = new Map<string, LimitUpLadderEntry>();
    for (const level of ladder?.levels ?? []) {
      for (const entry of level.stocks) ladderByCode.set(entry.code, entry);
    }
    let advancing = 0;
    let sampleCount = 0;
    const changes: number[] = [];
    for (const membership of tradable) {
      const changePct = items.get(membership.stockId)?.changePct;
      if (changePct === undefined) continue;
      sampleCount += 1;
      changes.push(changePct);
      if (changePct > 0) advancing += 1;
    }
    return {
      batch,
      items,
      ladderSample,
      ladder,
      ladderByCode,
      advancing,
      sampleCount,
      advanceRatio: sampleCount === 0 ? null : round2((advancing / sampleCount) * 100),
      medianChangePct: medianOf(changes),
    };
  });
};

const breadthStatus = (view: CoreSampleView): EvidenceDimensionStatus => {
  if (view.sampleCount === 0) return 'unavailable';
  return view.sampleCount < 3 || !view.batch.completeness.complete ? 'partial' : 'complete';
};

interface AnomalyFact {
  readonly index: number;
  readonly evidenceKind: 'limit_up' | 'change_pct';
  readonly entry: LimitUpLadderEntry | null;
  readonly changePct: number | null;
}

const firstAnomalyOf = (input: {
  readonly code: string;
  readonly stockId: string;
  readonly views: readonly CoreSampleView[];
}): AnomalyFact | null => {
  for (const [index, view] of input.views.entries()) {
    const entry = view.ladderByCode.get(input.code);
    if (entry !== undefined) {
      return {
        index,
        evidenceKind: 'limit_up',
        entry,
        changePct: view.items.get(input.stockId)?.changePct ?? null,
      };
    }
  }
  for (const [index, view] of input.views.entries()) {
    const changePct = view.items.get(input.stockId)?.changePct;
    if (changePct !== undefined && changePct >= CORE_IGNITION_CHANGE_PCT) {
      return { index, evidenceKind: 'change_pct', entry: null, changePct };
    }
  }
  return null;
};

interface ExpansionFact {
  readonly index: number;
  readonly baseRatio: number;
  readonly ratio: number;
  readonly ratioDelta: number;
  readonly advancingDelta: number;
}

const expansionOf = (input: {
  readonly anomalyIndex: number;
  readonly views: readonly CoreSampleView[];
}): ExpansionFact | null => {
  const base = input.views[input.anomalyIndex];
  if (base === undefined || base.advanceRatio === null) return null;
  for (let index = input.anomalyIndex + 1; index < input.views.length; index += 1) {
    const view = input.views[index];
    if (view === undefined || view.advanceRatio === null) continue;
    const ratioDelta = round2(view.advanceRatio - base.advanceRatio);
    const advancingDelta = view.advancing - base.advancing;
    if (ratioDelta >= CORE_EXPANSION_DELTA_PP || advancingDelta >= CORE_EXPANSION_ADVANCING_DELTA) {
      return {
        index,
        baseRatio: base.advanceRatio,
        ratio: view.advanceRatio,
        ratioDelta,
        advancingDelta,
      };
    }
  }
  return null;
};

const unavailableRole = (
  kind: CoreRoleKind,
  method: string,
  reason: string,
  warnings: readonly string[] = [],
): CoreRole => ({
  kind,
  label: CORE_ROLE_LABELS[kind],
  status: 'unavailable',
  holders: [],
  method,
  reason,
  warnings: [...warnings],
});

const namesByStockId = (input: {
  readonly views: readonly CoreSampleView[];
}): ReadonlyMap<string, string | null> => {
  const names = new Map<string, string | null>();
  const stockIdByCode = new Map<string, string>();
  for (const view of input.views) {
    for (const [stockId, item] of view.items) {
      if (!names.has(stockId)) names.set(stockId, item.name);
      stockIdByCode.set(item.code, stockId);
    }
  }
  for (const view of input.views) {
    for (const [code, entry] of view.ladderByCode) {
      const stockId = stockIdByCode.get(code);
      if (stockId !== undefined && (names.get(stockId) ?? null) === null) {
        names.set(stockId, entry.name);
      }
    }
  }
  return names;
};

const identityOf = (input: {
  readonly stockId: string;
  readonly names: ReadonlyMap<string, string | null>;
}): CoreStockIdentity => ({
  stockId: input.stockId,
  code: codeOfStockId(input.stockId),
  name: input.names.get(input.stockId) ?? null,
});

const batchSource = (view: CoreSampleView): string => `market_snapshot_batch:${view.batch.source}`;

const ladderSource = (view: CoreSampleView): string =>
  `limit_up_ladder:${view.ladderSample?.source ?? 'unknown'}`;

// ---------- 三个角色 ----------

const resolveIgnition = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
  readonly names: ReadonlyMap<string, string | null>;
}): CoreRole => {
  const candidates: {
    readonly membership: StockSectorMembership;
    readonly anomaly: AnomalyFact;
    readonly expansion: ExpansionFact;
    readonly firstTime: string | null;
  }[] = [];
  let anomalyCount = 0;
  for (const membership of input.members) {
    const anomaly = firstAnomalyOf({
      code: codeOfStockId(membership.stockId),
      stockId: membership.stockId,
      views: input.views,
    });
    if (anomaly === null) continue;
    anomalyCount += 1;
    const expansion = expansionOf({ anomalyIndex: anomaly.index, views: input.views });
    if (expansion === null) continue;
    candidates.push({
      membership,
      anomaly,
      expansion,
      firstTime: anomaly.entry?.firstTime ?? null,
    });
  }

  if (candidates.length === 0) {
    if (anomalyCount === 0) {
      return unavailableRole(
        'ignition',
        IGNITION_METHOD,
        `ignition_evidence_missing: 所选时点内没有成分出现可核实异动（天梯封板或日涨幅达到 ${CORE_IGNITION_CHANGE_PCT}%）`,
      );
    }
    return unavailableRole(
      'ignition',
      IGNITION_METHOD,
      `expansion_unverified: ${anomalyCount} 只成分有异动，但之后没有可核实的上涨面扩散（需 ≥${CORE_EXPANSION_DELTA_PP}pp 或上涨家数 +${CORE_EXPANSION_ADVANCING_DELTA}）`,
    );
  }

  const rank = (candidate: (typeof candidates)[number]): [number, number, string] => [
    candidate.anomaly.index,
    candidate.anomaly.evidenceKind === 'limit_up' ? 0 : 1,
    candidate.firstTime ?? '99:99:99',
  ];
  const ordered = [...candidates].sort((left, right) => {
    const leftKey = rank(left);
    const rightKey = rank(right);
    if (leftKey[0] !== rightKey[0]) return leftKey[0] - rightKey[0];
    if (leftKey[1] !== rightKey[1]) return leftKey[1] - rightKey[1];
    const byTime = leftKey[2].localeCompare(rightKey[2]);
    if (byTime !== 0) return byTime;
    return left.membership.stockId.localeCompare(right.membership.stockId);
  });
  const best = ordered[0];
  if (best === undefined) {
    return unavailableRole('ignition', IGNITION_METHOD, 'ignition_evidence_missing: 没有可用候选');
  }
  const bestKey = rank(best);
  const tied = ordered.filter((candidate) => {
    const key = rank(candidate);
    return key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] === bestKey[2];
  });

  const holders: CoreRoleHolder[] = tied.map((candidate) => {
    const anomalyView = input.views[candidate.anomaly.index];
    const expansionView = input.views[candidate.expansion.index];
    if (anomalyView === undefined || expansionView === undefined) {
      throw new InvariantError('启动先锋证据时点越界');
    }
    const evidence: CoreEvidence[] = [];
    if (candidate.anomaly.evidenceKind === 'limit_up' && candidate.anomaly.entry !== null) {
      evidence.push({
        sampledAt: anomalyView.batch.sampledAt,
        field: 'ladderLevel',
        value: candidate.anomaly.entry.ladderLevel,
        source: ladderSource(anomalyView),
        note: '所选时点内首次在天梯样本中出现（封板事实）',
      });
      evidence.push({
        sampledAt: anomalyView.batch.sampledAt,
        field: 'firstTime',
        value: candidate.anomaly.entry.firstTime,
        source: ladderSource(anomalyView),
        note: '供应商涨停池封板时间，按原口径展示，不推算',
      });
      if (candidate.anomaly.changePct !== null) {
        evidence.push({
          sampledAt: anomalyView.batch.sampledAt,
          field: 'dayChangePct',
          value: candidate.anomaly.changePct,
          source: batchSource(anomalyView),
          note: '异动时点的日涨幅',
        });
      }
    } else {
      evidence.push({
        sampledAt: anomalyView.batch.sampledAt,
        field: 'dayChangePct',
        value: candidate.anomaly.changePct,
        source: batchSource(anomalyView),
        note: `首次达到 ${CORE_IGNITION_CHANGE_PCT}% 异动阈值（无天梯封板证据）`,
      });
    }
    evidence.push({
      sampledAt: expansionView.batch.sampledAt,
      field: 'sectorAdvanceRatio',
      value: expansionView.advanceRatio,
      source: batchSource(expansionView),
      note: `上涨面 ${candidate.expansion.baseRatio}% → ${candidate.expansion.ratio}%（${candidate.expansion.ratioDelta >= 0 ? '+' : ''}${candidate.expansion.ratioDelta}pp，上涨家数 ${candidate.expansion.advancingDelta >= 0 ? '+' : ''}${candidate.expansion.advancingDelta}）`,
    });
    return {
      ...identityOf({ stockId: candidate.membership.stockId, names: input.names }),
      evidence,
    };
  });

  return {
    kind: 'ignition',
    label: CORE_ROLE_LABELS.ignition,
    status: holders.length > 1 ? 'tied' : 'assigned',
    holders,
    method: IGNITION_METHOD,
    reason: null,
    warnings:
      holders.length > 1
        ? [`ignition_tied: ${holders.length} 只成分的首次异动时点与供应商封板时间相同，按事实并列`]
        : [],
  };
};

interface TurnoverStat {
  readonly membership: StockSectorMembership;
  readonly amount: number;
  readonly amountSharePct: number | null;
  readonly streak: number;
  readonly comparisons: readonly {
    readonly sampledAt: Date;
    readonly changePct: number;
    readonly median: number;
  }[];
}

const turnoverStats = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
  readonly anchorView: CoreSampleView;
}): TurnoverStat[] => {
  const anchorAmounts = new Map<string, number>();
  for (const membership of input.members) {
    const amount = input.anchorView.items.get(membership.stockId)?.amount;
    if (amount !== undefined) anchorAmounts.set(membership.stockId, amount);
  }
  const total = [...anchorAmounts.values()].reduce((sum, amount) => sum + amount, 0);
  const lookbackStart = Math.max(0, input.views.length - CORE_SUSTAINED_LOOKBACK_SAMPLES);
  const lookback = input.views.slice(lookbackStart);

  const stats: TurnoverStat[] = [];
  for (const membership of input.members) {
    const amount = anchorAmounts.get(membership.stockId);
    if (amount === undefined) continue;
    const comparisons: { sampledAt: Date; changePct: number; median: number }[] = [];
    let streak = 0;
    for (let index = lookback.length - 1; index >= 0; index -= 1) {
      const view = lookback[index];
      if (view === undefined || view.medianChangePct === null) break;
      const changePct = view.items.get(membership.stockId)?.changePct;
      if (changePct === undefined || changePct <= view.medianChangePct) break;
      streak += 1;
      comparisons.unshift({
        sampledAt: view.batch.sampledAt,
        changePct,
        median: view.medianChangePct,
      });
    }
    stats.push({
      membership,
      amount,
      amountSharePct: total > 0 ? round2((amount / total) * 100) : null,
      streak,
      comparisons,
    });
  }
  return stats;
};

const resolveTurnover = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
  readonly names: ReadonlyMap<string, string | null>;
}): CoreRole => {
  if (input.views.length === 0) {
    return unavailableRole('turnover', TURNOVER_METHOD, 'turnover_evidence_missing: 没有批次样本');
  }
  const anchorView = input.views[input.views.length - 1];
  if (anchorView === undefined) {
    return unavailableRole('turnover', TURNOVER_METHOD, 'turnover_evidence_missing: 没有批次样本');
  }
  const stats = turnoverStats({ members: input.members, views: input.views, anchorView });
  if (stats.length === 0) {
    return unavailableRole(
      'turnover',
      TURNOVER_METHOD,
      'turnover_evidence_missing: 锚点批次没有可用的成分成交额',
    );
  }
  const maxAmount = Math.max(...stats.map((stat) => stat.amount));
  const amountLeaders = stats.filter((stat) => stat.amount === maxAmount);
  const qualified = amountLeaders.filter((stat) => stat.streak >= CORE_SUSTAINED_MIN_SAMPLES);
  if (qualified.length === 0) {
    const leader = amountLeaders[0];
    const leaderCode = leader === undefined ? '--' : codeOfStockId(leader.membership.stockId);
    return unavailableRole(
      'turnover',
      TURNOVER_METHOD,
      `top_contributor_without_sustained_strength: 成交额最高的 ${leaderCode} 只在 ${leader?.streak ?? 0} 个连续样本跑赢板块中位数（要求 ≥${CORE_SUSTAINED_MIN_SAMPLES}）`,
      input.views.length < CORE_SUSTAINED_MIN_SAMPLES
        ? [
            `insufficient_samples: 仅 ${input.views.length} 个样本，不足 ${CORE_SUSTAINED_MIN_SAMPLES} 个连续样本`,
          ]
        : [],
    );
  }

  const holders: CoreRoleHolder[] = qualified.map((stat) => {
    const evidence: CoreEvidence[] = [
      {
        sampledAt: anchorView.batch.sampledAt,
        field: 'amount',
        value: stat.amount,
        source: batchSource(anchorView),
        note:
          stat.amountSharePct === null
            ? '锚点累计成交额（板块金额分母无效）'
            : `锚点累计成交额，占板块有效成分合计 ${stat.amountSharePct}%（缺成交额成分不计入分母）`,
      },
    ];
    for (const comparison of stat.comparisons) {
      evidence.push({
        sampledAt: comparison.sampledAt,
        field: 'dayChangePct',
        value: comparison.changePct,
        source: batchSource(anchorView),
        note: `跑赢板块中位数 ${round2(comparison.median)}%（连续样本）`,
      });
    }
    return {
      ...identityOf({ stockId: stat.membership.stockId, names: input.names }),
      evidence,
    };
  });

  return {
    kind: 'turnover',
    label: CORE_ROLE_LABELS.turnover,
    status: holders.length > 1 ? 'tied' : 'assigned',
    holders,
    method: TURNOVER_METHOD,
    reason: null,
    warnings:
      holders.length > 1
        ? [`turnover_tied: ${holders.length} 只成分成交额相同且都满足持续相对强度，按事实并列`]
        : [],
  };
};

const resolveHeight = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
  readonly names: ReadonlyMap<string, string | null>;
}): CoreRole => {
  const anchorView = input.views[input.views.length - 1];
  if (anchorView === undefined) {
    return unavailableRole('height', HEIGHT_METHOD, 'missing_limit_up_sample: 没有批次样本');
  }
  const sample = [...input.views]
    .reverse()
    .find((view) => view.ladderSample !== null)?.ladderSample;
  if (sample === undefined || sample === null) {
    return unavailableRole(
      'height',
      HEIGHT_METHOD,
      'missing_limit_up_sample: 所选时点内没有按采样时点保存的天梯样本',
    );
  }
  const warnings: string[] = [];
  if (sample.sampledAt.getTime() !== anchorView.batch.sampledAt.getTime()) {
    warnings.push(
      `ladder_sample_stale: 锚点批次 ${clockLabel(anchorView.batch.sampledAt)} 无天梯样本，使用 ${clockLabel(sample.sampledAt)} 的样本`,
    );
  }
  const ladder = ladderOfSample(sample);
  if (ladder.total === 0 && ladder.warnings.length > 0) {
    return unavailableRole(
      'height',
      HEIGHT_METHOD,
      `missing_limit_up_sample: 天梯样本标注 ${ladder.warnings.join(' / ')}`,
      warnings,
    );
  }
  const entries = new Map<string, LimitUpLadderEntry>();
  for (const level of ladder.levels) {
    for (const entry of level.stocks) entries.set(entry.code, entry);
  }

  const sealed: {
    membership: StockSectorMembership;
    entry: LimitUpLadderEntry;
    amount: number | null;
  }[] = [];
  for (const membership of input.members) {
    const entry = entries.get(codeOfStockId(membership.stockId));
    if (entry === undefined) continue;
    sealed.push({
      membership,
      entry,
      amount: anchorView.items.get(membership.stockId)?.amount ?? null,
    });
  }
  if (sealed.length === 0) {
    return unavailableRole(
      'height',
      HEIGHT_METHOD,
      `no_sealed_member: ${clockLabel(sample.sampledAt)} 的天梯样本里没有本板块 active 成分`,
      warnings,
    );
  }
  const maxLevel = Math.max(...sealed.map((row) => row.entry.ladderLevel));
  const topLevel = sealed.filter((row) => row.entry.ladderLevel === maxLevel);
  const amounts = topLevel
    .map((row) => row.amount)
    .filter((amount): amount is number => amount !== null);
  const maxAmount = amounts.length === 0 ? null : Math.max(...amounts);
  const holdersPool =
    maxAmount === null ? topLevel : topLevel.filter((row) => row.amount === maxAmount);
  const usedAmountTieBreak = topLevel.length > 1 && holdersPool.length < topLevel.length;

  const holders: CoreRoleHolder[] = holdersPool.map((row) => {
    const evidence: CoreEvidence[] = [
      {
        sampledAt: sample.sampledAt,
        field: 'ladderLevel',
        value: row.entry.ladderLevel,
        source: `limit_up_ladder:${sample.source}`,
        note: `${clockLabel(sample.sampledAt)} 天梯样本中的连板层级${row.entry.uncategorized ? '（层级来源未判定）' : ''}`,
      },
      {
        sampledAt: sample.sampledAt,
        field: 'firstTime',
        value: row.entry.firstTime,
        source: `limit_up_ladder:${sample.source}`,
        note: '供应商涨停池封板时间，按原口径展示，不推算',
      },
    ];
    if (usedAmountTieBreak) {
      evidence.push({
        sampledAt: anchorView.batch.sampledAt,
        field: 'amount',
        value: row.amount,
        source: batchSource(anchorView),
        note: '同层级并列，按锚点累计成交额选出',
      });
    }
    return {
      ...identityOf({ stockId: row.membership.stockId, names: input.names }),
      evidence,
    };
  });

  if (holders.length > 1) {
    warnings.push(
      `height_tied: ${holders.length} 只成分同为 ${maxLevel} 连板且成交额相同，按事实并列`,
    );
  }
  return {
    kind: 'height',
    label: CORE_ROLE_LABELS.height,
    status: holders.length > 1 ? 'tied' : 'assigned',
    holders,
    method: HEIGHT_METHOD,
    reason: null,
    warnings,
  };
};

interface ResolvedRoles {
  readonly ignition: CoreRole;
  readonly turnover: CoreRole;
  readonly height: CoreRole;
  readonly names: ReadonlyMap<string, string | null>;
}

const resolveRoles = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
}): ResolvedRoles => {
  const anchorView = input.views[input.views.length - 1];
  if (anchorView === undefined) {
    throw new InvariantError('core stocks 需要至少一个批次样本');
  }
  const names = namesByStockId({ views: input.views });
  const tradable = tradableMembersOf(input.members);
  return {
    ignition: resolveIgnition({ members: tradable, views: input.views, names }),
    turnover: resolveTurnover({ members: tradable, views: input.views, names }),
    height: resolveHeight({ members: tradable, views: input.views, names }),
    names,
  };
};

const holdersOf = (role: CoreRole): readonly string[] =>
  role.holders.map((holder) => holder.stockId).sort();

const sameHolders = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((stockId, index) => stockId === right[index]);

// ---------- 时间线 ----------

const CORE_TIMELINE_KIND_ORDER: Readonly<Record<CoreTimelineKind, number>> = {
  sample_missing: 0,
  appear: 1,
  rotate: 2,
  exit: 3,
  open_board: 4,
};

const buildTimeline = (input: {
  readonly views: readonly CoreSampleView[];
  readonly roleStates: readonly ResolvedRoles[];
  readonly names: ReadonlyMap<string, string | null>;
}): CoreTimelineEvent[] => {
  const events: CoreTimelineEvent[] = [];
  const roleOrder: Readonly<Record<CoreRoleKind, number>> = {
    ignition: 0,
    turnover: 1,
    height: 2,
  };
  const push = (event: CoreTimelineEvent): void => {
    events.push(event);
  };
  const watch = new Set<string>();
  const hasLadderCoverage = input.views.some((view) => view.ladderSample !== null);

  for (const [index, state] of input.roleStates.entries()) {
    const view = input.views[index];
    if (view === undefined) continue;
    for (const roleKind of CORE_ROLE_KINDS) {
      const role = state[roleKind];
      const previousRole = index === 0 ? null : (input.roleStates[index - 1]?.[roleKind] ?? null);
      const previous = previousRole === null ? [] : holdersOf(previousRole);
      const current = holdersOf(role);
      if (previous.length === 0 && current.length > 0) {
        push({
          sampledAt: view.batch.sampledAt,
          previousSampledAt: index === 0 ? null : (input.views[index - 1]?.batch.sampledAt ?? null),
          kind: 'appear',
          roleKind: role.kind,
          from: [],
          to: current.map((stockId) => identityOf({ stockId, names: input.names })),
          basis: `${clockLabel(view.batch.sampledAt)} ${CORE_ROLE_LABELS[role.kind]}出现：${current
            .map((stockId) => codeOfStockId(stockId))
            .join(' / ')}`,
          evidence: role.holders.flatMap((holder) => holder.evidence),
        });
      } else if (previous.length > 0 && current.length === 0) {
        push({
          sampledAt: view.batch.sampledAt,
          previousSampledAt: index === 0 ? null : (input.views[index - 1]?.batch.sampledAt ?? null),
          kind: 'exit',
          roleKind: role.kind,
          from: previous.map((stockId) => identityOf({ stockId, names: input.names })),
          to: [],
          basis: `${clockLabel(view.batch.sampledAt)} ${CORE_ROLE_LABELS[role.kind]}退出：${role.reason ?? '证据不足'}`,
          evidence: [],
        });
      } else if (previous.length > 0 && current.length > 0 && !sameHolders(previous, current)) {
        push({
          sampledAt: view.batch.sampledAt,
          previousSampledAt: index === 0 ? null : (input.views[index - 1]?.batch.sampledAt ?? null),
          kind: 'rotate',
          roleKind: role.kind,
          from: previous.map((stockId) => identityOf({ stockId, names: input.names })),
          to: current.map((stockId) => identityOf({ stockId, names: input.names })),
          basis: `${clockLabel(view.batch.sampledAt)} ${CORE_ROLE_LABELS[role.kind]}换位：${previous
            .map((stockId) => codeOfStockId(stockId))
            .join(' / ')} → ${current.map((stockId) => codeOfStockId(stockId)).join(' / ')}`,
          evidence: role.holders.flatMap((holder) => holder.evidence),
        });
      }
      if (role.status !== 'unavailable') for (const stockId of current) watch.add(stockId);
    }

    if (index === 0) continue;
    const previousView = input.views[index - 1];
    if (previousView === undefined) continue;
    if (watch.size === 0) continue;
    if (!hasLadderCoverage) continue;
    const previousSample = previousView.ladderSample;
    const currentSample = view.ladderSample;
    if (currentSample === null) {
      push({
        sampledAt: view.batch.sampledAt,
        previousSampledAt: previousView.batch.sampledAt,
        kind: 'sample_missing',
        roleKind: null,
        from: [],
        to: [],
        basis: `${clockLabel(view.batch.sampledAt)} 缺少天梯样本，无法判断核心股开板或高度标换位；按事实标注缺失，不推断`,
        evidence: [
          {
            sampledAt: view.batch.sampledAt,
            field: 'ladderSample',
            value: false,
            source: 'limit_up_ladder',
            note: `上一有样本时点 ${clockLabel(previousView.batch.sampledAt)}，该时点没有按采样时点保存的天梯事实`,
          },
        ],
      });
      continue;
    }
    if (previousSample === null) continue;
    const previousLadder = ladderOfSample(previousSample);
    const currentLadder = ladderOfSample(currentSample);
    const previousCodes = new Set(
      previousLadder.levels.flatMap((level) => level.stocks.map((entry) => entry.code)),
    );
    const currentCodes = new Set(
      currentLadder.levels.flatMap((level) => level.stocks.map((entry) => entry.code)),
    );
    for (const stockId of watch) {
      const code = codeOfStockId(stockId);
      if (!previousCodes.has(code) || currentCodes.has(code)) continue;
      push({
        sampledAt: view.batch.sampledAt,
        previousSampledAt: previousView.batch.sampledAt,
        kind: 'open_board',
        roleKind: null,
        from: [identityOf({ stockId, names: input.names })],
        to: [],
        basis: `${clockLabel(previousView.batch.sampledAt)} → ${clockLabel(view.batch.sampledAt)} ${code} 从封板变为未封（开板）`,
        evidence: [
          {
            sampledAt: view.batch.sampledAt,
            field: 'sealed',
            value: false,
            source: `limit_up_ladder:${currentSample.source}`,
            note: `上一有样本时点 ${clockLabel(previousView.batch.sampledAt)} 仍在天梯中`,
          },
        ],
      });
    }
  }

  const indexed = events.map((event, index) => ({ event, index }));
  indexed.sort((left, right) => {
    const byTime = left.event.sampledAt.getTime() - right.event.sampledAt.getTime();
    if (byTime !== 0) return byTime;
    const byKind =
      CORE_TIMELINE_KIND_ORDER[left.event.kind] - CORE_TIMELINE_KIND_ORDER[right.event.kind];
    if (byKind !== 0) return byKind;
    const leftRole = left.event.roleKind === null ? 9 : roleOrder[left.event.roleKind];
    const rightRole = right.event.roleKind === null ? 9 : roleOrder[right.event.roleKind];
    if (leftRole !== rightRole) return leftRole - rightRole;
    return left.index - right.index;
  });
  return indexed.map((entry) => entry.event);
};

// ---------- 从核心股反查题材 ----------

interface MemberPerf {
  readonly stockId: string;
  readonly code: string;
  readonly name: string | null;
  readonly memberStatus: StockSectorMembership['memberStatus'];
  readonly dayChangePct: number | null;
  readonly windowChangePct: number | null;
  readonly sealed: boolean | null;
  readonly ladderLevel: number | null;
  readonly dayRank: number | null;
}

const memberPerfRows = (input: {
  readonly members: readonly StockSectorMembership[];
  readonly anchorView: CoreSampleView;
  readonly windowStart: MarketSnapshotBatch | null;
  readonly windowComparable: boolean;
}): MemberPerf[] => {
  const startItems = itemMapOf(input.windowStart);
  const rows = input.members.map((membership): MemberPerf => {
    const item = input.anchorView.items.get(membership.stockId);
    const nonTradable = isNonTradable(membership);
    const dayChangePct = nonTradable ? null : (item?.changePct ?? null);
    let windowChangePct: number | null = null;
    if (!nonTradable && input.windowComparable) {
      const startClose = startItems.get(membership.stockId)?.close;
      const close = item?.close;
      if (startClose !== undefined && close !== undefined && startClose > 0 && close > 0) {
        windowChangePct = round2((close / startClose - 1) * 100);
      }
    }
    const entry = input.anchorView.ladderByCode.get(codeOfStockId(membership.stockId));
    return {
      stockId: membership.stockId,
      code: codeOfStockId(membership.stockId),
      name: item?.name ?? entry?.name ?? null,
      memberStatus: membership.memberStatus,
      dayChangePct,
      windowChangePct,
      sealed: input.anchorView.ladderSample === null ? null : entry !== undefined,
      ladderLevel: entry?.ladderLevel ?? null,
      dayRank: null,
    };
  });
  const ranked = [...rows]
    .filter((row) => row.dayChangePct !== null)
    .sort((left, right) => {
      if ((right.dayChangePct ?? 0) !== (left.dayChangePct ?? 0)) {
        return (right.dayChangePct ?? 0) - (left.dayChangePct ?? 0);
      }
      return left.code.localeCompare(right.code);
    });
  const ranks = new Map(ranked.map((row, index) => [row.stockId, index + 1]));
  return rows.map((row) => ({ ...row, dayRank: ranks.get(row.stockId) ?? null }));
};

const toThemePeer = (row: MemberPerf): CoreThemePeer => ({
  stockId: row.stockId,
  code: row.code,
  name: row.name,
  memberStatus: row.memberStatus,
  dayChangePct: row.dayChangePct,
  windowChangePct: row.windowChangePct,
  sealed: row.sealed,
  ladderLevel: row.ladderLevel,
  dayRank: row.dayRank,
});

export interface CoreLookupBuildInput {
  readonly roleHolders: readonly { readonly kind: CoreRoleKind; readonly holder: CoreRoleHolder }[];
  readonly roles: MarketRoomCoreStocks['roles'];
  readonly sector: SectorCatalogEntry;
  readonly members: readonly StockSectorMembership[];
  readonly membershipsByStock: ReadonlyMap<string, readonly StockSectorMembershipView[]>;
  readonly membersBySector: ReadonlyMap<string, readonly StockSectorMembership[]>;
  readonly views: readonly CoreSampleView[];
  readonly windowStart: MarketSnapshotBatch | null;
  readonly windowComparable: boolean;
}

const roleKindsOfStock = (input: {
  readonly roles: MarketRoomCoreStocks['roles'];
  readonly stockId: string;
}): CoreRoleKind[] =>
  CORE_ROLE_KINDS.filter((kind) =>
    input.roles[kind].holders.some((holder) => holder.stockId === input.stockId),
  );

const resolveThemeRoleKinds = (input: {
  readonly sectorId: string;
  readonly targetSectorId: string;
  readonly stockId: string;
  readonly members: readonly StockSectorMembership[];
  readonly views: readonly CoreSampleView[];
  readonly targetRoles: MarketRoomCoreStocks['roles'];
}): CoreRoleKind[] => {
  if (input.sectorId === input.targetSectorId) {
    return roleKindsOfStock({ roles: input.targetRoles, stockId: input.stockId });
  }
  if (input.members.length === 0) return [];
  const roles = resolveRoles({ members: input.members, views: input.views });
  return roleKindsOfStock({ roles, stockId: input.stockId });
};

export const buildCoreStockLookups = (input: CoreLookupBuildInput): CoreStockLookup[] => {
  const anchorView = input.views[input.views.length - 1];
  if (anchorView === undefined) return [];
  const lookups: CoreStockLookup[] = [];
  const holderIds = [...new Set(input.roleHolders.map((entry) => entry.holder.stockId))].sort();
  for (const stockId of holderIds) {
    const holder = input.roleHolders.find((entry) => entry.holder.stockId === stockId)?.holder;
    const warnings: string[] = [];
    const views = [...(input.membershipsByStock.get(stockId) ?? [])].filter(
      (membership) => membership.sectorState === 'active',
    );
    const themeIds = new Set(views.map((view) => view.sectorId));
    if (!themeIds.has(input.sector.id)) {
      themeIds.add(input.sector.id);
    }
    const themes: CoreTheme[] = [...themeIds]
      .map((sectorId): CoreTheme | null => {
        const sourceView = views.find((view) => view.sectorId === sectorId);
        const isTarget = sectorId === input.sector.id;
        const sectorIdentity = isTarget
          ? {
              sectorId: input.sector.id,
              kind: input.sector.kind,
              vendorCode: input.sector.vendorCode,
              name: input.sector.name,
            }
          : sourceView === undefined
            ? null
            : {
                sectorId: sourceView.sectorId,
                kind: sourceView.kind,
                vendorCode: sourceView.vendorCode,
                name: sourceView.name,
              };
        if (sectorIdentity === null) return null;
        const members = isTarget ? input.members : (input.membersBySector.get(sectorId) ?? []);
        const themeWarnings: string[] = [];
        if (members.length === 0) {
          themeWarnings.push(
            `no_members: 该题材没有可用的 active 成分，无法复算角色与其他成员表现`,
          );
        }
        const rows = memberPerfRows({
          members,
          anchorView,
          windowStart: input.windowStart,
          windowComparable: input.windowComparable,
        });
        const own = rows.find((row) => row.stockId === stockId);
        const thisStock: CoreThemePeer =
          own === undefined
            ? {
                stockId,
                code: codeOfStockId(stockId),
                name: holder?.name ?? anchorView.items.get(stockId)?.name ?? null,
                memberStatus: 'unknown',
                dayChangePct: anchorView.items.get(stockId)?.changePct ?? null,
                windowChangePct: null,
                sealed:
                  anchorView.ladderSample === null
                    ? null
                    : anchorView.ladderByCode.has(codeOfStockId(stockId)),
                ladderLevel:
                  anchorView.ladderByCode.get(codeOfStockId(stockId))?.ladderLevel ?? null,
                dayRank: null,
              }
            : toThemePeer(own);
        const peers = rows
          .filter((row) => row.stockId !== stockId)
          .map(toThemePeer)
          .sort((left, right) => {
            if (left.dayChangePct === null && right.dayChangePct !== null) return 1;
            if (left.dayChangePct !== null && right.dayChangePct === null) return -1;
            if (
              left.dayChangePct !== null &&
              right.dayChangePct !== null &&
              right.dayChangePct !== left.dayChangePct
            ) {
              return right.dayChangePct - left.dayChangePct;
            }
            return left.code.localeCompare(right.code);
          });
        return {
          ...sectorIdentity,
          roleKinds: resolveThemeRoleKinds({
            sectorId,
            targetSectorId: input.sector.id,
            stockId,
            members,
            views: input.views,
            targetRoles: input.roles,
          }),
          breadth: {
            status: breadthStatus(anchorView),
            advancing: advancingOf(members, anchorView),
            sampleCount: sampleCountOf(members, anchorView),
            advanceRatio: ratioOf(members, anchorView),
          },
          thisStock,
          peerCount: peers.length,
          peers: peers.slice(0, CORE_LOOKUP_PEER_LIMIT),
          warnings: themeWarnings,
        };
      })
      .filter((theme): theme is CoreTheme => theme !== null)
      .sort((left, right) => {
        if (left.roleKinds.length !== right.roleKinds.length) {
          return right.roleKinds.length - left.roleKinds.length;
        }
        if (right.breadth.advanceRatio !== left.breadth.advanceRatio) {
          return (right.breadth.advanceRatio ?? -1) - (left.breadth.advanceRatio ?? -1);
        }
        return left.name.localeCompare(right.name);
      });
    const roleThemeCount = themes.filter((theme) => theme.roleKinds.length > 0).length;
    if (themes.length === 0) {
      warnings.push('no_theme: 该股票当前没有在册题材归属');
    }
    lookups.push({
      stockId,
      code: codeOfStockId(stockId),
      name: themes[0]?.thisStock.name ?? null,
      themeCount: themes.length,
      roleThemeCount,
      pullsMultipleThemes: roleThemeCount > 1,
      themes,
      warnings,
    });
  }
  return lookups;
};

const advancingOf = (members: readonly StockSectorMembership[], view: CoreSampleView): number => {
  let advancing = 0;
  for (const membership of tradableMembersOf(members)) {
    const changePct = view.items.get(membership.stockId)?.changePct;
    if (changePct !== undefined && changePct > 0) advancing += 1;
  }
  return advancing;
};

const sampleCountOf = (members: readonly StockSectorMembership[], view: CoreSampleView): number => {
  let count = 0;
  for (const membership of tradableMembersOf(members)) {
    if (view.items.get(membership.stockId)?.changePct !== undefined) count += 1;
  }
  return count;
};

const ratioOf = (
  members: readonly StockSectorMembership[],
  view: CoreSampleView,
): number | null => {
  const count = sampleCountOf(members, view);
  return count === 0 ? null : round2((advancingOf(members, view) / count) * 100);
};

// ---------- 组装 ----------

const sectorIdentityOf = (sector: SectorCatalogEntry) => ({
  sectorId: sector.id,
  kind: sector.kind,
  vendorCode: sector.vendorCode,
  name: sector.name,
});

const anchorSummaryOf = (batch: MarketSnapshotBatch) => ({
  sampledAt: batch.sampledAt,
  source: batch.source,
  tradingDate: batch.tradingDate,
  complete: batch.completeness.complete,
  expectedCount: batch.completeness.expectedCount,
  receivedCount: batch.completeness.receivedCount,
  missingCount: batch.completeness.missingCount,
});

const CORE_NOTES: readonly string[] = [
  '核心角色由本地已发布批次与按采样时点保存的天梯事实复算；只读，不触发采集。',
  '证据不足时角色为空或并列，不降级硬凑；每个入选都带时点、字段、数值与来源。',
  '时间线只呈现出现 / 开板 / 换位 / 退出与缺样本事实，不写入事件存储（事件由 #42 负责）。',
  '供应商只给封板时间时按原口径展示，不用采样时点反推封板时刻。',
  '从核心股反查题材使用当前成分快照，不是历史 PIT 成分；同一只股票可在多个题材占用核心角色。',
];

const EMPTY_REASON_TEXT: Readonly<Record<CoreStocksEmptyReason, string>> = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '该板块没有 active 成分',
  sector_not_found: '指定的板块不在当前目录中',
};

const emptyRoles = (reasonText: string): MarketRoomCoreStocks['roles'] => ({
  ignition: unavailableRole('ignition', IGNITION_METHOD, `core_stocks_empty: ${reasonText}`),
  turnover: unavailableRole('turnover', TURNOVER_METHOD, `core_stocks_empty: ${reasonText}`),
  height: unavailableRole('height', HEIGHT_METHOD, `core_stocks_empty: ${reasonText}`),
});

export const buildMarketRoomCoreStocksEmpty = (input: {
  readonly reason: CoreStocksEmptyReason;
  readonly sector: SectorCatalogEntry | null;
  readonly latest: MarketSnapshotBatch | null;
  readonly window: SectorWindowKey;
}): MarketRoomCoreStocks => {
  if (input.sector !== null && input.reason === 'sector_not_found') {
    throw new InvariantError('核心股空态的 sector_not_found 不得携带板块身份');
  }
  const reasonText = `${input.reason}: ${EMPTY_REASON_TEXT[input.reason]}`;
  const parsed = MarketRoomCoreStocksSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    sector: input.sector === null ? null : sectorIdentityOf(input.sector),
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : anchorSummaryOf(input.latest),
    window: input.window,
    roles: emptyRoles(reasonText),
    timeline: [],
    lookups: [],
    coverage: {
      batchCount: 0,
      ladderSampleCount: 0,
      ladderMissingCount: 0,
      timelineEventCount: 0,
      lookupCount: 0,
    },
    notes: [...CORE_NOTES],
  });
  assertMarketRoomCoreStocksInvariants(parsed);
  return parsed;
};

export interface MarketRoomCoreStocksInput {
  readonly sector: SectorCatalogEntry;
  readonly members: readonly StockSectorMembership[];
  /** 锚点及之前的当日批次，按 sampledAt 升序，最后一个是锚点。 */
  readonly batches: readonly MarketSnapshotBatch[];
  /** 当日天梯样本；只使用同一交易日且不晚于锚点的样本。 */
  readonly ladderSamples: readonly LimitUpLadderSample[];
  readonly window: SectorWindowKey;
  readonly windowStart: MarketSnapshotBatch | null;
  /** 从核心股反查：股票 → 当前在册题材归属（含目标板块）。 */
  readonly membershipsByStock?: ReadonlyMap<string, readonly StockSectorMembershipView[]>;
  readonly membersBySector?: ReadonlyMap<string, readonly StockSectorMembership[]>;
  /** 只反查这些角色的持有者；缺省反查全部角色。 */
  readonly lookupKinds?: readonly CoreRoleKind[];
}

export const buildMarketRoomCoreStocks = (
  input: MarketRoomCoreStocksInput,
): MarketRoomCoreStocks => {
  const anchor = input.batches.at(-1);
  if (anchor === undefined) {
    throw new InvariantError('核心股需要至少一个已发布批次');
  }
  const members = activeMembersOf(input.members);
  if (members.length === 0) {
    throw new InvariantError('核心股需要目标板块的 active 成分');
  }
  const ladderSamples = input.ladderSamples
    .filter(
      (sample) =>
        sample.tradingDate === anchor.tradingDate &&
        sample.sampledAt.getTime() <= anchor.sampledAt.getTime(),
    )
    .sort((left, right) => left.sampledAt.getTime() - right.sampledAt.getTime());
  const views = buildSampleViews({ members, batches: input.batches, ladderSamples });
  const roleStates = views.map((_view, index) =>
    resolveRoles({ members, views: views.slice(0, index + 1) }),
  );
  const finalState = roleStates.at(-1);
  if (finalState === undefined) {
    throw new InvariantError('核心股需要至少一个批次样本');
  }
  const roles: MarketRoomCoreStocks['roles'] = {
    ignition: finalState.ignition,
    turnover: finalState.turnover,
    height: finalState.height,
  };
  const timeline = buildTimeline({
    views,
    roleStates,
    names: finalState.names,
  });

  const lookupKinds = input.lookupKinds ?? CORE_ROLE_KINDS;
  const roleHolders = lookupKinds.flatMap((kind) =>
    roles[kind].holders.map((holder) => ({ kind, holder })),
  );
  const windowRef = resolveSectorWindow({
    key: input.window,
    anchor,
    start: input.windowStart,
  });
  const lookups =
    input.membershipsByStock === undefined || input.membersBySector === undefined
      ? []
      : buildCoreStockLookups({
          roleHolders,
          roles,
          sector: input.sector,
          members,
          membershipsByStock: input.membershipsByStock,
          membersBySector: input.membersBySector,
          views,
          windowStart: input.windowStart,
          windowComparable: windowRef.status !== 'unavailable',
        });

  const ladderSampleCount = views.filter((view) => view.ladderSample !== null).length;
  const parsed = MarketRoomCoreStocksSchema.parse({
    state: 'ready',
    sector: sectorIdentityOf(input.sector),
    tradingDate: anchor.tradingDate,
    anchor: anchorSummaryOf(anchor),
    window: input.window,
    roles,
    timeline,
    lookups,
    coverage: {
      batchCount: views.length,
      ladderSampleCount,
      ladderMissingCount: views.length - ladderSampleCount,
      timelineEventCount: timeline.length,
      lookupCount: lookups.length,
    },
    notes: [
      ...CORE_NOTES,
      `窗口 ${input.window}（${input.window === 'w5' ? 5 : 15} 分钟）：${windowRef.status === 'unavailable' ? (windowRef.reason ?? '窗口不可比') : `起点 ${clockLabel(windowRef.startSampledAt ?? anchor.sampledAt)}`}`,
    ],
  });
  assertMarketRoomCoreStocksInvariants(parsed);
  return parsed;
};

export const assertMarketRoomCoreStocksInvariants = (core: MarketRoomCoreStocks): void => {
  const roles = [core.roles.ignition, core.roles.turnover, core.roles.height];
  for (const role of roles) {
    if (role.status === 'unavailable') {
      if (role.holders.length > 0 || role.reason === null) {
        throw new InvariantError(`core stocks ${role.kind} 缺失时必须没有持有者且给出原因`);
      }
    } else {
      if (role.reason !== null) {
        throw new InvariantError(`core stocks ${role.kind} 有持有者时不得携带缺失原因`);
      }
      if (role.status === 'assigned' && role.holders.length !== 1) {
        throw new InvariantError(`core stocks ${role.kind} assigned 必须恰好一个持有者`);
      }
      if (role.status === 'tied' && role.holders.length < 2) {
        throw new InvariantError(`core stocks ${role.kind} tied 必须至少两个持有者`);
      }
    }
    for (const holder of role.holders) {
      if (holder.evidence.length === 0) {
        throw new InvariantError(`core stocks ${role.kind} 持有者必须带证据`);
      }
      for (const evidence of holder.evidence) {
        if (evidence.source.length === 0) {
          throw new InvariantError(`core stocks ${role.kind} 证据必须带来源`);
        }
      }
    }
  }
  if (core.timeline.length !== core.coverage.timelineEventCount) {
    throw new InvariantError('core stocks 时间线事件数必须与覆盖统计一致');
  }
  if (core.lookups.length !== core.coverage.lookupCount) {
    throw new InvariantError('core stocks 反查数量必须与覆盖统计一致');
  }
  if (
    core.coverage.ladderSampleCount + core.coverage.ladderMissingCount !==
    core.coverage.batchCount
  ) {
    throw new InvariantError('core stocks 天梯样本数与缺失数必须覆盖全部批次');
  }
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const event of core.timeline) {
    const time = event.sampledAt.getTime();
    if (time < previousTime) {
      throw new InvariantError('core stocks 时间线必须按采样时点升序');
    }
    previousTime = time;
    if (event.kind === 'sample_missing' && event.roleKind !== null) {
      throw new InvariantError('core stocks 缺样本事件不得绑定角色');
    }
    if (event.kind === 'appear' && (event.from.length > 0 || event.to.length === 0)) {
      throw new InvariantError('core stocks 出现事件必须有 to 且没有 from');
    }
    if (event.kind === 'exit' && (event.from.length === 0 || event.to.length > 0)) {
      throw new InvariantError('core stocks 退出事件必须有 from 且没有 to');
    }
    if (
      event.kind === 'rotate' &&
      (event.from.length === 0 ||
        event.to.length === 0 ||
        event.from.map((entry) => entry.stockId).join('|') ===
          event.to.map((entry) => entry.stockId).join('|'))
    ) {
      throw new InvariantError('core stocks 换位事件必须更换持有者');
    }
  }
  const holderIds = new Set(roles.flatMap((role) => role.holders.map((holder) => holder.stockId)));
  for (const lookup of core.lookups) {
    if (!holderIds.has(lookup.stockId)) {
      throw new InvariantError('core stocks 只允许反查当前核心股');
    }
    if (lookup.themeCount !== lookup.themes.length) {
      throw new InvariantError('core stocks 反查题材数必须与题材列表一致');
    }
    const roleThemeCount = lookup.themes.filter((theme) => theme.roleKinds.length > 0).length;
    if (lookup.roleThemeCount !== roleThemeCount) {
      throw new InvariantError('core stocks 角色题材数必须与题材列表一致');
    }
    if (lookup.pullsMultipleThemes !== roleThemeCount > 1) {
      throw new InvariantError('core stocks 多题材拉动标记必须与角色题材数一致');
    }
    for (const theme of lookup.themes) {
      if (theme.peerCount < theme.peers.length) {
        throw new InvariantError('core stocks 题材成员展示数不得超过成员总数');
      }
    }
  }
  if (core.state === 'empty') {
    if (core.emptyReason === undefined) {
      throw new InvariantError('core stocks 空态必须给出原因');
    }
    if (core.timeline.length > 0 || core.lookups.length > 0) {
      throw new InvariantError('core stocks 空态不得携带时间线或反查');
    }
    if (core.sector !== null && core.emptyReason === 'sector_not_found') {
      throw new InvariantError('core stocks sector_not_found 不得携带板块身份');
    }
    return;
  }
  if (core.emptyReason !== undefined) {
    throw new InvariantError('core stocks ready 不得携带空态原因');
  }
  if (core.sector === null || core.anchor === null || core.tradingDate === null) {
    throw new InvariantError('core stocks ready 必须带板块、交易日与锚点');
  }
  if (core.anchor.tradingDate !== core.tradingDate) {
    throw new InvariantError('core stocks 锚点交易日必须与 tradingDate 一致');
  }
};
