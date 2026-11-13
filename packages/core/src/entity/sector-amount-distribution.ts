import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { EvidenceDimensionStatusSchema } from './ashare-sentiment.js';
import type { MarketSnapshotItem } from './market-snapshot.js';
import type { MarketSnapshotBatch } from './market-snapshot-batch.js';
import {
  type SectorCatalogEntry,
  type SectorKind,
  SectorKindSchema,
  type StockSectorMembership,
} from './sector-catalog.js';
import {
  buildSectorTurnoverMetric,
  buildSectorTurnoverWindow,
  resolveSectorWindow,
  SECTOR_EMPTY_REASON_TEXT,
  SECTOR_INTRADAY_WINDOWS,
  SECTOR_TURNOVER_METHOD,
  SectorRankingAnchorSchema,
  type SectorRankingEmptyReason,
  SectorRankingEmptyReasonSchema,
  type SectorTurnoverMetric,
  SectorTurnoverMetricSchema,
  type SectorTurnoverWindow,
  SectorTurnoverWindowSchema,
  type SectorWindowKey,
  SectorWindowKeySchema,
  type SectorWindowRef,
  SectorWindowRefSchema,
  sectorRankingAnchorSummary,
} from './sector-intraday-ranking.js';

/**
 * 成交分布（ticket #40）：同一张榜给出按窗口的板块成交占比、较上一窗口的百分点变化
 * 与成交集中度。
 *
 * - 占比 = 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量（复用板块盘中榜的同一口径）；
 * - 环比 = 本窗口占比 − 上一窗口占比，单位百分点；上一窗口用上一窗口自己的全市场分母；
 * - 集中度只选 CR3（前 3 名占比之和），定义写进响应字段，因为概念成分可重叠、占比不可加总；
 * - 分母无效 / 窗口缺样本 / 跨午休不可比 / 批次不完整一律 null + 原因，绝不补零；
 * - 停牌与漏采分开计数：停牌排除但不算缺失，漏采计缺失样本，两者都不计作零成交。
 */

export const SECTOR_AMOUNT_CONCENTRATION_BASIS = 'CR3' as const;

/** CR3 需要至少 3 个有可用占比的板块，否则缺失而不是用 1–2 个板块凑数。 */
export const SECTOR_AMOUNT_CR3_MIN_SECTORS = 3;

export const SECTOR_AMOUNT_CONCENTRATION_METHOD = 'CR3 = 前 3 名板块窗口成交占比之和（百分点）';

export const SECTOR_AMOUNT_CONCENTRATION_DEFINITION =
  'CR3 = 本窗口成交占比排名前 3 的板块占比之和（百分点）。每个板块的占比按自身成分与同期全市场去重增量独立计算；概念间成分可重叠，占比不可加总为市场总量，前 3 名概念共享成分时 CR3 缺失并给出原因，不把同一批股票重复计入；行业按不重叠成分计算，只作「成交是否集中在少数方向」的指示值。有可用占比的板块不足 3 个时缺失。';

export const SECTOR_AMOUNT_DELTA_METHOD =
  '环比 = 本窗口成交占比 − 上一窗口成交占比（百分点，pp）；上一窗口占比使用上一窗口自己的全市场去重成交额增量作分母';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const SectorAmountDeltaSchema = z.object({
  /** 百分点：本窗口占比 − 上一窗口占比；任一窗口不可用时为 null。 */
  value: z.number().finite().nullable(),
  status: EvidenceDimensionStatusSchema,
  reason: z.string().min(1).nullable(),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorAmountDelta = z.infer<typeof SectorAmountDeltaSchema>;

export const SectorAmountConcentrationSchema = z.object({
  /** 明确选定的集中度口径，只支持 CR3。 */
  basis: z.literal(SECTOR_AMOUNT_CONCENTRATION_BASIS),
  /** 口径定义随响应返回，避免前端另写一套说法。 */
  definition: z.string().min(1),
  /** 前 3 名板块占比之和（百分点）；口径不可用时为 null。 */
  value: z.number().finite().nullable(),
  status: EvidenceDimensionStatusSchema,
  reason: z.string().min(1).nullable(),
  /** 本窗口有可用占比的板块数（CR3 的候选样本）。 */
  sectorCount: z.number().int().nonnegative(),
  top: z.array(
    z.object({
      sectorId: z.string().min(1),
      name: z.string().min(1),
      share: z.number().finite(),
    }),
  ),
  method: z.string().min(1),
  warnings: z.array(z.string()),
});
export type SectorAmountConcentration = z.infer<typeof SectorAmountConcentrationSchema>;

export const SectorAmountDistributionRowSchema = z.object({
  sectorId: z.string().min(1),
  kind: SectorKindSchema,
  vendorCode: z.string().min(1),
  name: z.string().min(1),
  /** 当前窗口占比名次（1 起）；占比缺失时为 null。 */
  rank: z.number().int().positive().nullable(),
  /** 本窗口成交占比与样本口径（与板块盘中榜同一 schema）。 */
  share: SectorTurnoverMetricSchema,
  /** 上一窗口成交占比，用上一窗口自己的全市场分母。 */
  previousShare: SectorTurnoverMetricSchema,
  deltaPp: SectorAmountDeltaSchema,
});
export type SectorAmountDistributionRow = z.infer<typeof SectorAmountDistributionRowSchema>;

export const SectorAmountDistributionSchema = z.object({
  state: z.enum(['ready', 'empty']),
  emptyReason: SectorRankingEmptyReasonSchema.optional(),
  kind: SectorKindSchema,
  window: SectorWindowKeySchema,
  tradingDate: dateString.nullable(),
  anchor: SectorRankingAnchorSchema.nullable(),
  windows: z.object({ current: SectorWindowRefSchema, previous: SectorWindowRefSchema }),
  turnover: z.object({
    current: SectorTurnoverWindowSchema,
    previous: SectorTurnoverWindowSchema,
  }),
  concentration: SectorAmountConcentrationSchema,
  coverage: z.object({
    sectorCount: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    /** 目录里有但没有任何 active 成分、因而未进入榜单的板块数。 */
    omittedSectorCount: z.number().int().nonnegative(),
  }),
  rows: z.array(SectorAmountDistributionRowSchema),
  notes: z.array(z.string()),
});
export type SectorAmountDistribution = z.infer<typeof SectorAmountDistributionSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const DISTRIBUTION_NOTES: readonly string[] = [
  '窗口成交占比 = 板块 active 成分累计成交额增量之和 ÷ 同期全市场去重成交额增量；同一股票只在窗口两端批次都出现且都有成交额时计入分母。',
  '环比以百分点（pp）表示：本窗口占比 − 上一窗口占比；上一窗口占比用上一窗口自己的全市场去重成交额增量作分母。',
  '概念间成分可重叠，各板块占比不可加总为市场总量；前 3 名概念共享成分时 CR3 缺失并给出原因，不重复计入同一批股票；行业 CR3 只作「成交是否集中在少数方向」的指示值，不等于市场集中度。',
  '停牌 / 退市成分从占比中排除，但不算缺失、也不计作零成交；漏采（批次缺条目、缺成交额）标注为缺失样本，同样不补零。',
  '分母无效（全市场增量不为正、分母覆盖不全、批次不完整）、窗口缺样本、跨午休 / 跨日 / 盘前盘后不可比时，占比与环比一律缺失并给出原因。',
];

const itemMap = (batch: MarketSnapshotBatch | null): ReadonlyMap<string, MarketSnapshotItem> =>
  new Map((batch?.items ?? []).map((entry) => [entry.id, entry]));

const unavailableTurnoverWindow = (input: {
  readonly window: SectorWindowKey;
  readonly reason: string;
  readonly marketTotalCount: number;
}): SectorTurnoverWindow => ({
  window: input.window,
  status: 'unavailable',
  reason: input.reason,
  marketAmountDelta: null,
  marketSampleCount: 0,
  marketTotalCount: input.marketTotalCount,
  method: SECTOR_TURNOVER_METHOD,
  warnings: [],
});

/** 环比：两端都有占比才给值；任一窗口缺失时 null 并把两端的缺失原因都写进 warnings。 */
export const buildSectorAmountDelta = (
  share: SectorTurnoverMetric,
  previousShare: SectorTurnoverMetric,
): SectorAmountDelta => {
  const reasons: string[] = [];
  if (share.value === null) {
    reasons.push(`current_window_missing: ${share.warnings[0] ?? '本窗口占比缺失'}`);
  }
  if (previousShare.value === null) {
    reasons.push(`previous_window_missing: ${previousShare.warnings[0] ?? '上一窗口占比缺失'}`);
  }
  if (share.value === null || previousShare.value === null) {
    return {
      value: null,
      status: 'unavailable',
      reason: reasons[0] ?? 'delta_unavailable: 窗口占比缺失，环比不可比',
      method: SECTOR_AMOUNT_DELTA_METHOD,
      warnings: reasons,
    };
  }
  const complete = share.status === 'complete' && previousShare.status === 'complete';
  return {
    value: round2(share.value - previousShare.value),
    status: complete ? 'complete' : 'partial',
    reason: null,
    method: SECTOR_AMOUNT_DELTA_METHOD,
    warnings: complete ? [] : ['delta_partial: 本窗口或上一窗口占比标注为部分可用，环比随之标注'],
  };
};

/**
 * 前 3 名概念之间的共享成分：概念是重叠集合，占比相加会把同一批股票重复计入，
 * 因此有交集时不产出 CR3，只给出交集明细作为缺失原因。
 */
const sharedConstituents = (
  top: readonly { readonly sectorId: string; readonly name: string }[],
  memberIdsBySector: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] => {
  const pairs: string[] = [];
  for (let leftIndex = 0; leftIndex < top.length; leftIndex += 1) {
    const left = top[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < top.length; rightIndex += 1) {
      const right = top[rightIndex];
      if (right === undefined) continue;
      const leftMembers = memberIdsBySector.get(left.sectorId) ?? new Set<string>();
      const rightMembers = memberIdsBySector.get(right.sectorId) ?? new Set<string>();
      const shared = [...leftMembers].filter((stockId) => rightMembers.has(stockId)).sort();
      if (shared.length > 0) {
        pairs.push(`${left.name} ↔ ${right.name}: ${shared.join(' / ')}`);
      }
    }
  }
  return pairs;
};

const buildConcentration = (input: {
  readonly kind: SectorKind;
  readonly rows: readonly SectorAmountDistributionRow[];
  readonly turnover: SectorTurnoverWindow;
  readonly memberIdsBySector: ReadonlyMap<string, ReadonlySet<string>>;
}): SectorAmountConcentration => {
  const valid = input.rows.filter((row) => row.share.value !== null);
  const base = {
    basis: SECTOR_AMOUNT_CONCENTRATION_BASIS,
    definition: SECTOR_AMOUNT_CONCENTRATION_DEFINITION,
    method: SECTOR_AMOUNT_CONCENTRATION_METHOD,
    sectorCount: valid.length,
  };
  if (input.turnover.status === 'unavailable') {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      reason: `concentration_unavailable: ${input.turnover.reason ?? '全市场分母无效'}`,
      top: [],
      warnings: [],
    };
  }
  if (valid.length < SECTOR_AMOUNT_CR3_MIN_SECTORS) {
    return {
      ...base,
      value: null,
      status: 'unavailable',
      reason: `concentration_insufficient_sectors: 只有 ${valid.length} 个板块有可用占比，CR3 需要至少 ${SECTOR_AMOUNT_CR3_MIN_SECTORS} 个`,
      top: [],
      warnings: [],
    };
  }
  const top: { sectorId: string; name: string; share: number }[] = [];
  for (const row of valid) {
    if (top.length === SECTOR_AMOUNT_CR3_MIN_SECTORS) break;
    if (row.share.value === null) continue;
    top.push({ sectorId: row.sectorId, name: row.name, share: row.share.value });
  }
  if (input.kind === 'concept') {
    const shared = sharedConstituents(top, input.memberIdsBySector);
    if (shared.length > 0) {
      return {
        ...base,
        value: null,
        status: 'unavailable',
        reason: `concentration_overlapping_constituents: 前 3 名概念共享成分（${shared.join('；')}），占比不可加总，CR3 缺失`,
        top: [],
        warnings: [],
      };
    }
  }
  const value = round2(top.reduce((sum, entry) => sum + entry.share, 0));
  const warnings =
    valid.length < input.rows.length
      ? [
          `concentration_partial_sectors: ${valid.length} / ${input.rows.length} 个板块有可用占比，其余不参与 CR3`,
        ]
      : [];
  return {
    ...base,
    value,
    status: warnings.length === 0 ? 'complete' : 'partial',
    reason: null,
    top,
    warnings,
  };
};

const compareRows = (left: SectorAmountDistributionRow, right: SectorAmountDistributionRow) => {
  const leftValue = left.share.value;
  const rightValue = right.share.value;
  if (leftValue === null && rightValue === null)
    return left.vendorCode.localeCompare(right.vendorCode);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  if (rightValue !== leftValue) return rightValue - leftValue;
  return left.vendorCode.localeCompare(right.vendorCode);
};

export interface SectorAmountDistributionInput {
  readonly kind: SectorKind;
  readonly window: SectorWindowKey;
  readonly anchor: MarketSnapshotBatch;
  /** 当前窗口起点（锚点 − 窗口分钟）；null 表示当日没有更早批次。 */
  readonly currentStart: MarketSnapshotBatch | null;
  /** 上一窗口起点（当前窗口起点 − 窗口分钟）。 */
  readonly previousStart: MarketSnapshotBatch | null;
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
}

export const buildSectorAmountDistribution = (
  input: SectorAmountDistributionInput,
): SectorAmountDistribution => {
  const minutes = SECTOR_INTRADAY_WINDOWS[input.window];
  const currentWindow = resolveSectorWindow({
    key: input.window,
    anchor: input.anchor,
    start: input.currentStart,
  });
  const previousWindow: SectorWindowRef =
    input.currentStart === null
      ? {
          key: input.window,
          minutes,
          status: 'unavailable',
          targetSampledAt: null,
          startSampledAt: input.previousStart?.sampledAt ?? null,
          spanMs: null,
          reason: 'window_start_missing: 当前窗口起点批次缺失，上一窗口无法确定，环比缺失',
          warnings: [],
        }
      : resolveSectorWindow({
          key: input.window,
          anchor: input.currentStart,
          start: input.previousStart,
        });

  const anchorItems = itemMap(input.anchor);
  const currentStartItems = itemMap(input.currentStart);
  const previousStartItems = itemMap(input.previousStart);

  const currentTurnover = buildSectorTurnoverWindow({
    window: input.window,
    windowRef: currentWindow,
    anchor: input.anchor,
    start: input.currentStart,
  });
  const previousTurnover =
    input.currentStart === null
      ? unavailableTurnoverWindow({
          window: input.window,
          reason: previousWindow.reason ?? 'window_start_missing: 上一窗口不可用',
          marketTotalCount: 0,
        })
      : buildSectorTurnoverWindow({
          window: input.window,
          windowRef: previousWindow,
          anchor: input.currentStart,
          start: input.previousStart,
        });

  const membersBySector = new Map<string, StockSectorMembership[]>();
  const memberIdsBySector = new Map<string, Set<string>>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const list = membersBySector.get(membership.sectorId) ?? [];
    list.push(membership);
    membersBySector.set(membership.sectorId, list);
    const ids = memberIdsBySector.get(membership.sectorId) ?? new Set<string>();
    ids.add(membership.stockId);
    memberIdsBySector.set(membership.sectorId, ids);
  }

  const catalog = input.sectors.filter(
    (sector) => sector.kind === input.kind && sector.state === 'active',
  );
  let omittedSectorCount = 0;
  const rows: SectorAmountDistributionRow[] = [];
  for (const sector of catalog) {
    const members = membersBySector.get(sector.id) ?? [];
    if (members.length === 0) {
      omittedSectorCount += 1;
      continue;
    }
    const share = buildSectorTurnoverMetric({
      denominator: currentTurnover,
      members,
      items: anchorItems,
      startItems: currentStartItems,
    });
    const previousShare = buildSectorTurnoverMetric({
      denominator: previousTurnover,
      members,
      items: currentStartItems,
      startItems: previousStartItems,
    });
    rows.push({
      sectorId: sector.id,
      kind: sector.kind,
      vendorCode: sector.vendorCode,
      name: sector.name,
      rank: null,
      share,
      previousShare,
      deltaPp: buildSectorAmountDelta(share, previousShare),
    });
  }

  rows.sort(compareRows);
  let rank = 0;
  const ranked = rows.map((row) => {
    if (row.share.value === null) return row;
    rank += 1;
    return { ...row, rank };
  });

  const parsed = SectorAmountDistributionSchema.parse({
    state: 'ready',
    kind: input.kind,
    window: input.window,
    tradingDate: input.anchor.tradingDate,
    anchor: sectorRankingAnchorSummary(input.anchor),
    windows: { current: currentWindow, previous: previousWindow },
    turnover: { current: currentTurnover, previous: previousTurnover },
    concentration: buildConcentration({
      kind: input.kind,
      rows: ranked,
      turnover: currentTurnover,
      memberIdsBySector,
    }),
    coverage: {
      sectorCount: catalog.length,
      rowCount: ranked.length,
      omittedSectorCount,
    },
    rows: ranked,
    notes: [...DISTRIBUTION_NOTES],
  });
  assertSectorAmountDistributionInvariants(parsed);
  return parsed;
};

/** 空态：保留最近批次时点，窗口、分母、CR3 与行全部不可用。 */
export const buildSectorAmountDistributionEmpty = (input: {
  readonly kind: SectorKind;
  readonly window: SectorWindowKey;
  readonly reason: SectorRankingEmptyReason;
  readonly latest: MarketSnapshotBatch | null;
}): SectorAmountDistribution => {
  if ((input.reason === 'no_batch') !== (input.latest === null)) {
    throw new InvariantError('成交分布空态原因与最近批次状态不一致');
  }
  const reasonText = `${input.reason}: ${SECTOR_EMPTY_REASON_TEXT[input.reason]}`;
  const minutes = SECTOR_INTRADAY_WINDOWS[input.window];
  const windowRef: SectorWindowRef = {
    key: input.window,
    minutes,
    status: 'unavailable',
    targetSampledAt: null,
    startSampledAt: null,
    spanMs: null,
    reason: reasonText,
    warnings: [],
  };
  const turnover = (): SectorTurnoverWindow => ({
    window: input.window,
    status: 'unavailable',
    reason: reasonText,
    marketAmountDelta: null,
    marketSampleCount: 0,
    marketTotalCount: 0,
    method: SECTOR_TURNOVER_METHOD,
    warnings: [],
  });
  const parsed = SectorAmountDistributionSchema.parse({
    state: 'empty',
    emptyReason: input.reason,
    kind: input.kind,
    window: input.window,
    tradingDate: input.latest?.tradingDate ?? null,
    anchor: input.latest === null ? null : sectorRankingAnchorSummary(input.latest),
    windows: { current: windowRef, previous: windowRef },
    turnover: { current: turnover(), previous: turnover() },
    concentration: {
      basis: SECTOR_AMOUNT_CONCENTRATION_BASIS,
      definition: SECTOR_AMOUNT_CONCENTRATION_DEFINITION,
      method: SECTOR_AMOUNT_CONCENTRATION_METHOD,
      value: null,
      status: 'unavailable',
      reason: reasonText,
      sectorCount: 0,
      top: [],
      warnings: [],
    },
    coverage: { sectorCount: 0, rowCount: 0, omittedSectorCount: 0 },
    rows: [],
    notes: [...DISTRIBUTION_NOTES],
  });
  assertSectorAmountDistributionInvariants(parsed);
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
      `成交分布 ${name} 样本数必须等于有效 + 缺失 + 停牌退市（${metric.sampleCount} + ${metric.missingCount} + ${metric.nonTradableCount} ≠ ${metric.memberCount}）`,
    );
  }
};

const assertStatus = (
  name: string,
  metric: {
    readonly status: string;
    readonly value: unknown;
    readonly warnings: readonly string[];
  },
): void => {
  if ((metric.value === null) !== (metric.status === 'unavailable')) {
    throw new InvariantError(`成交分布 ${name} 只有缺失值才允许 unavailable`);
  }
  if (metric.status !== 'complete' && metric.warnings.length === 0) {
    throw new InvariantError(`成交分布 ${name} 非 complete 时必须给出缺失原因`);
  }
};

export const assertSectorAmountDistributionInvariants = (
  distribution: SectorAmountDistribution,
): void => {
  if (distribution.state === 'empty') {
    if (distribution.emptyReason === undefined) {
      throw new InvariantError('成交分布空态必须给出原因');
    }
    if (distribution.rows.length > 0) {
      throw new InvariantError('成交分布空态不得有榜单行');
    }
  } else {
    if (distribution.emptyReason !== undefined) {
      throw new InvariantError('成交分布 ready 不得携带空态原因');
    }
    if (distribution.anchor === null || distribution.tradingDate === null) {
      throw new InvariantError('成交分布 ready 必须基于已发布批次');
    }
    if (distribution.rows.length !== distribution.coverage.rowCount) {
      throw new InvariantError('成交分布行数必须与覆盖统计一致');
    }
    if (distribution.coverage.rowCount > distribution.coverage.sectorCount) {
      throw new InvariantError('成交分布行数不得超过目录板块数');
    }
  }

  const { window } = distribution;
  if (distribution.windows.current.key !== window || distribution.windows.previous.key !== window) {
    throw new InvariantError('成交分布窗口键必须与请求口径一致');
  }
  if (distribution.turnover.current.window !== window) {
    throw new InvariantError('成交分布当前窗口占比口径必须与请求一致');
  }
  if (distribution.turnover.previous.window !== window) {
    throw new InvariantError('成交分布上一窗口占比口径必须与请求一致');
  }

  const concentration = distribution.concentration;
  if (concentration.value === null) {
    if (concentration.status !== 'unavailable' || concentration.reason === null) {
      throw new InvariantError('成交分布 CR3 缺失时必须标注 unavailable 并给出原因');
    }
    if (concentration.top.length > 0) {
      throw new InvariantError('成交分布 CR3 缺失时不得给出参与板块');
    }
  } else {
    if (concentration.status === 'unavailable') {
      throw new InvariantError('成交分布 CR3 有值时不得标注 unavailable');
    }
    if (concentration.reason !== null) {
      throw new InvariantError('成交分布 CR3 有值时不得携带缺失原因');
    }
    if (concentration.sectorCount < SECTOR_AMOUNT_CR3_MIN_SECTORS) {
      throw new InvariantError('成交分布 CR3 有值时至少需要 3 个板块有可用占比');
    }
    if (concentration.top.length !== SECTOR_AMOUNT_CR3_MIN_SECTORS) {
      throw new InvariantError('成交分布 CR3 有值时必须给出前 3 名板块');
    }
    const sum = round2(concentration.top.reduce((total, entry) => total + entry.share, 0));
    if (Math.abs(sum - concentration.value) > 1e-9) {
      throw new InvariantError('成交分布 CR3 必须等于前 3 名板块占比之和');
    }
  }

  let previousValue: number | null = null;
  let expectedRank = 0;
  for (const row of distribution.rows) {
    assertCounted(`share(${row.name})`, row.share);
    assertCounted(`previousShare(${row.name})`, row.previousShare);
    assertStatus(`share(${row.name})`, row.share);
    assertStatus(`previousShare(${row.name})`, row.previousShare);
    assertStatus(`deltaPp(${row.name})`, row.deltaPp);
    if (row.deltaPp.value === null && row.deltaPp.reason === null) {
      throw new InvariantError('成交分布环比缺失时必须给出原因');
    }
    if (row.share.value !== null && row.previousShare.value !== null) {
      const expected = round2(row.share.value - row.previousShare.value);
      if (row.deltaPp.value === null || Math.abs(row.deltaPp.value - expected) > 1e-9) {
        throw new InvariantError('成交分布环比必须等于本窗口与上一窗口占比之差');
      }
    }
    if (row.kind !== distribution.kind) {
      throw new InvariantError('成交分布行分类必须与请求一致');
    }
    if (row.share.value === null) {
      if (row.rank !== null) throw new InvariantError('成交分布占比缺失不得有名次');
      continue;
    }
    if (previousValue !== null && row.share.value > previousValue) {
      throw new InvariantError('成交分布行序必须按当前窗口占比降序');
    }
    previousValue = row.share.value;
    expectedRank += 1;
    if (row.rank !== expectedRank) {
      throw new InvariantError('成交分布名次必须按当前窗口占比连续且从 1 开始');
    }
  }
};
