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

export const StockUniverseEntrySchema = z
  .object({
    stockId: z.string().regex(/^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/),
    code: StockCodeSchema,
    exchange: ExchangeSchema,
    name: z.string().trim().min(1).max(100),
    listingStatus: ListingStatusSchema,
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

export const StockUniverseSnapshotSchema = z
  .object({
    source: z.string().trim().min(1),
    coverage: MarketCoverageSchema,
    observedAt: z.coerce.date(),
    complete: z.literal(true),
    reportedTotal: z.number().int().positive().optional(),
    entries: z.array(StockUniverseEntrySchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
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
  readonly industry?: string;
  readonly listDate?: Date;
  readonly delistDate?: Date;
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
