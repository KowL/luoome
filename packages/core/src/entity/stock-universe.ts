import { z } from 'zod';

import { StockCodeSchema } from '../types/branded.js';
import { type Exchange, ExchangeSchema } from './stock.js';

export const MarketCoverageSchema = z.enum([
  'CN_A_SHARES_SH_SZ',
  'CN_A_SHARES_BJ',
  'HK_EQUITIES',
  'US_EQUITIES',
]);
export type MarketCoverage = z.infer<typeof MarketCoverageSchema>;

export const ListingStatusSchema = z.enum(['listed', 'suspended', 'delisted', 'unknown']);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

/** ST 状态：来自同步时点的目录属性（PIT），不是当前名称推断。 */
export const StStatusSchema = z.enum(['st', 'non-st', 'unknown']);
export type StStatus = z.infer<typeof StStatusSchema>;

/**
 * 从**同步时点**的目录名称派生 ST 状态（与 limit-up-ladder 的 `isSTName` 同一约定）。
 * 股改旧前缀 `S*ST` / `SST` 语义不稳定，返回 unknown，不猜。
 */
export const deriveStStatus = (name: string): StStatus => {
  const normalized = name.trim().toUpperCase();
  if (/^S(\*?ST)/.test(normalized)) return 'unknown';
  return /^\*?ST/.test(normalized) ? 'st' : 'non-st';
};

/**
 * PIT 快照可承载的属性；数组顺序即对外展示顺序。
 * 数据源不提供某属性时整列为 NULL/unknown——覆盖率函数让这种缺口可见，而不是静默 unknown。
 */
export const STOCK_UNIVERSE_ATTRIBUTES = [
  'listingStatus',
  'stStatus',
  'industry',
  'listDate',
  'delistDate',
] as const;
export const StockUniverseAttributeSchema = z.enum(STOCK_UNIVERSE_ATTRIBUTES);
export type StockUniverseAttribute = z.infer<typeof StockUniverseAttributeSchema>;

export const StockUniverseEntrySchema = z
  .object({
    stockId: z.string().regex(/^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/),
    code: StockCodeSchema,
    exchange: ExchangeSchema,
    name: z.string().trim().min(1).max(100),
    listingStatus: ListingStatusSchema,
    stStatus: StStatusSchema.optional(),
    industry: z.string().trim().min(1).max(100).optional(),
    listDate: z.coerce.date().optional(),
    delistDate: z.coerce.date().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.stockId !== `${entry.code}.${entry.exchange}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['stockId'],
        message: 'stockId must match code and exchange',
      });
    }
  });
export type StockUniverseEntry = z.infer<typeof StockUniverseEntrySchema>;

/** 属性是否在单个成员上取到真实值；`unknown`/缺省一律算「没提供」，不猜。 */
const memberProvidesAttribute = (
  member: Pick<
    StockUniverseSnapshotMember,
    'listingStatus' | 'stStatus' | 'industry' | 'listDate' | 'delistDate'
  >,
  attribute: StockUniverseAttribute,
): boolean => {
  switch (attribute) {
    case 'listingStatus':
      return member.listingStatus !== 'unknown';
    case 'stStatus':
      return member.stStatus !== 'unknown';
    case 'industry':
      return member.industry !== undefined;
    case 'listDate':
      return member.listDate !== undefined;
    case 'delistDate':
      return member.delistDate !== undefined;
  }
};

/**
 * 快照实际带出的 PIT 属性：某属性在**至少一个**成员上取到真实值才算提供。
 * 全列 NULL/unknown（= 数据源不提供）时该属性不出现在结果里，调用方据此显式降级。
 */
export const stockUniverseMemberAttributeCoverage = (
  members: readonly Pick<
    StockUniverseSnapshotMember,
    'listingStatus' | 'stStatus' | 'industry' | 'listDate' | 'delistDate'
  >[],
): StockUniverseAttribute[] =>
  STOCK_UNIVERSE_ATTRIBUTES.filter((attribute) =>
    members.some((member) => memberProvidesAttribute(member, attribute)),
  );

/** 同上，入参为待落库的 snapshot entries。 */
export const stockUniverseAttributeCoverage = (
  entries: readonly StockUniverseEntry[],
): StockUniverseAttribute[] =>
  stockUniverseMemberAttributeCoverage(
    entries.map((entry) => ({
      listingStatus: entry.listingStatus,
      stStatus: entry.stStatus ?? 'unknown',
      ...(entry.industry === undefined ? {} : { industry: entry.industry }),
      ...(entry.listDate === undefined ? {} : { listDate: entry.listDate }),
      ...(entry.delistDate === undefined ? {} : { delistDate: entry.delistDate }),
    })),
  );

export const StockUniverseSnapshotSchema = z
  .object({
    source: z.string().trim().min(1),
    coverage: MarketCoverageSchema,
    observedAt: z.coerce.date(),
    complete: z.literal(true),
    reportedTotal: z.number().int().positive().optional(),
    /**
     * 本快照实际带出的属性（由 `stockUniverseAttributeCoverage(entries)` 得出）。
     * 数据源缺字段时在这里显式变短，让降级可见；未声明时按 entries 现算，语义不变。
     */
    attributeCoverage: z.array(StockUniverseAttributeSchema).optional(),
    entries: z.array(StockUniverseEntrySchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.attributeCoverage !== undefined) {
      const declared = [...snapshot.attributeCoverage].sort().join(',');
      const actual = [...stockUniverseAttributeCoverage(snapshot.entries)].sort().join(',');
      if (declared !== actual) {
        ctx.addIssue({
          code: 'custom',
          path: ['attributeCoverage'],
          message: `attributeCoverage 必须与实际成员属性一致（应为 ${actual === '' ? '空' : actual}）`,
        });
      }
    }
    const identities = new Set<string>();
    for (const [index, entry] of snapshot.entries.entries()) {
      if (identities.has(entry.stockId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'stockId'],
          message: `duplicate stockId: ${entry.stockId}`,
        });
      }
      identities.add(entry.stockId);

      if (
        snapshot.coverage === 'CN_A_SHARES_SH_SZ' &&
        entry.exchange !== 'SH' &&
        entry.exchange !== 'SZ'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['entries', index, 'exchange'],
          message: `exchange ${entry.exchange} is outside ${snapshot.coverage}`,
        });
      }
    }

    if (
      snapshot.reportedTotal !== undefined &&
      snapshot.reportedTotal !== snapshot.entries.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reportedTotal'],
        message: 'reportedTotal must match the number of unique entries',
      });
    }
  });
export type StockUniverseSnapshot = z.infer<typeof StockUniverseSnapshotSchema>;

export type StockUniverseMembershipState = 'active' | 'missing';

export interface StockUniverseSyncRun {
  readonly id: string;
  readonly source: string;
  readonly coverage: MarketCoverage;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly observedAt: Date | null;
  readonly reportedTotal: number | null;
  readonly observedCount: number;
  readonly createdStocks: number;
  readonly updatedStocks: number;
  readonly reactivated: number;
  readonly markedMissing: number;
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

/**
 * 某个成功 universe sync 的 PIT 成员属性快照。
 * 旧 snapshot（T35 之前的行）没有属性：`listingStatus` 为 'unknown'，industry/listDate/delistDate 缺省，
 * 迁移时**不回填**当前值（回填等于把前视固化进历史）。
 */
export interface StockUniverseSnapshotMember {
  readonly stockId: string;
  readonly code: string;
  readonly exchange: Exchange;
  /** 当前目录里能解析到时的展示名；股票已从 `stocks` 删除时缺省（成员行仍返回）。 */
  readonly name?: string;
  readonly listingStatus: ListingStatus;
  /** 快照期的 ST 状态；旧行/来源未提供时为 'unknown'（tradability 因此 partial）。 */
  readonly stStatus: StStatus;
  readonly industry?: string;
  readonly listDate?: Date;
  readonly delistDate?: Date;
}

/**
 * 某次成功 sync 的 PIT 属性覆盖：回测门禁用它解释「为什么 partial」——
 * 缺哪些属性、这批快照来自哪个数据源。旧 snapshot 行按 NULL 计，不假装完整。
 */
export interface StockUniverseSnapshotAttributeCoverage {
  readonly syncId: string;
  readonly source: string;
  readonly observedAt: Date | null;
  readonly memberCount: number;
  readonly provided: readonly StockUniverseAttribute[];
}

/** 从 `CODE.EXCHANGE` 身份串解析 code/exchange；快照成员行即使缺少 stocks 行也能解析身份。 */
export const stockUniverseMemberIdentity = (
  stockId: string,
): { readonly code: string; readonly exchange: Exchange } => {
  const index = stockId.lastIndexOf('.');
  return {
    code: index > 0 ? stockId.slice(0, index) : stockId,
    exchange: (index > 0 ? stockId.slice(index + 1) : '') as Exchange,
  };
};

export interface StockUniverseApplySummary {
  readonly observedCount: number;
  readonly createdStocks: number;
  readonly updatedStocks: number;
  readonly reactivated: number;
  readonly markedMissing: number;
}

export interface StockUniverseSourceLike {
  readonly name: string;
  readonly coverage: readonly MarketCoverage[];
  fetchStockUniverse(coverage: MarketCoverage): Promise<StockUniverseSnapshot>;
}
