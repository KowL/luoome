import { z } from 'zod';

/**
 * 行业 / 概念目录与成分（扶摇同花顺指数目录）。
 *
 * 三类标识必须分别表达，不得互相顶替：
 * - `id`：本地生成的不透明内部标识，不含供应商编码；
 * - `kind`：行业 / 概念分类，决定命名空间（同一供应商代码不会混进另一个分类）；
 * - `vendorCode`：供应商指数代码（如 `881273.TI`），只用于外部请求与溯源。
 *
 * 成分是多对多事实：保存来源、首次观测时间与每次同步的观测时点；成员消失只标记
 * `missing`，不物理删除。
 */

export const SectorKindSchema = z.enum(['industry', 'concept']);
export type SectorKind = z.infer<typeof SectorKindSchema>;

export const SectorCatalogStateSchema = z.enum(['active', 'retired']);
export type SectorCatalogState = z.infer<typeof SectorCatalogStateSchema>;

export const SectorMembershipStateSchema = z.enum(['active', 'missing']);
export type SectorMembershipState = z.infer<typeof SectorMembershipStateSchema>;

/**
 * 成员股票状态。停牌 / 退市 / 无报价的股票只标注状态，不删除成分关系；
 * `unknown` 覆盖无法核实的情形（如上游未返回该股）。
 */
export const SectorMemberStatusSchema = z.enum(['listed', 'suspended', 'delisted', 'unknown']);
export type SectorMemberStatus = z.infer<typeof SectorMemberStatusSchema>;

export const SectorVendorCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}\.(TI|SH|SZ|BJ)$/);

export const SectorStockIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/);

/** 目录条目：内部标识、分类、来源与供应商编码各自独立。 */
export const SectorCatalogEntrySchema = z
  .object({
    id: z.string().trim().min(8).max(64),
    kind: SectorKindSchema,
    source: z.string().trim().min(1).max(40),
    vendorCode: SectorVendorCodeSchema,
    name: z.string().trim().min(1).max(100),
    state: SectorCatalogStateSchema,
    firstSeenAt: z.coerce.date(),
    lastSeenAt: z.coerce.date(),
    retiredAt: z.coerce.date().nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.id === entry.vendorCode) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'internal sector id must not reuse the vendor code',
      });
    }
    if (entry.firstSeenAt.getTime() > entry.lastSeenAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'lastSeenAt must not be earlier than firstSeenAt',
      });
    }
    if (entry.state === 'active' && entry.retiredAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['retiredAt'],
        message: 'active sector must not carry retiredAt',
      });
    }
  });
export type SectorCatalogEntry = z.infer<typeof SectorCatalogEntrySchema>;

/** 外部目录观测项（尚无内部标识）。 */
export const SectorCatalogObservationSchema = z.object({
  kind: SectorKindSchema,
  vendorCode: SectorVendorCodeSchema,
  name: z.string().trim().min(1).max(100),
});
export type SectorCatalogObservation = z.infer<typeof SectorCatalogObservationSchema>;

/** 单只股票的一次完整成分观测；空 sectors 表示已观测且当前无匹配关系。 */
export const StockSectorObservationSchema = z.object({
  stockId: SectorStockIdSchema,
  sectors: z.array(SectorCatalogObservationSchema),
});
export type StockSectorObservation = z.infer<typeof StockSectorObservationSchema>;

export const SectorStockStatusObservationSchema = z.object({
  stockId: SectorStockIdSchema,
  status: SectorMemberStatusSchema,
});
export type SectorStockStatusObservation = z.infer<typeof SectorStockStatusObservationSchema>;

export const StockSectorMembershipSchema = z
  .object({
    sectorId: z.string().trim().min(1),
    stockId: SectorStockIdSchema,
    source: z.string().trim().min(1).max(40),
    state: SectorMembershipStateSchema,
    memberStatus: SectorMemberStatusSchema,
    firstSeenAt: z.coerce.date(),
    lastSeenAt: z.coerce.date(),
    missingSince: z.coerce.date().nullable(),
  })
  .superRefine((membership, ctx) => {
    if (membership.firstSeenAt.getTime() > membership.lastSeenAt.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'lastSeenAt must not be earlier than firstSeenAt',
      });
    }
    if (membership.state === 'active' && membership.missingSince !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingSince'],
        message: 'active membership must not carry missingSince',
      });
    }
  });
export type StockSectorMembership = z.infer<typeof StockSectorMembershipSchema>;

/** 按股票反查用的联表投影：成分事实 + 目录身份。 */
export const StockSectorMembershipViewSchema = StockSectorMembershipSchema.and(
  z.object({
    kind: SectorKindSchema,
    vendorCode: SectorVendorCodeSchema,
    name: z.string().trim().min(1).max(100),
    sectorState: SectorCatalogStateSchema,
  }),
);
export type StockSectorMembershipView = z.infer<typeof StockSectorMembershipViewSchema>;

export const SectorChangeKindSchema = z.enum([
  'sector-created',
  'sector-renamed',
  'sector-retired',
  'sector-reactivated',
  'member-entered',
  'member-rejoined',
  'member-left',
]);
export type SectorChangeKind = z.infer<typeof SectorChangeKindSchema>;

/** 目录与成分变更记录：append-only，不回写历史。 */
export const SectorChangeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  sectorId: z.string().min(1),
  stockId: SectorStockIdSchema.nullable(),
  kind: SectorChangeKindSchema,
  occurredAt: z.coerce.date(),
  syncId: z.string().min(1),
  previousValue: z.string().nullable(),
  nextValue: z.string().nullable(),
});
export type SectorChangeEvent = z.infer<typeof SectorChangeEventSchema>;

export const SectorSyncStatusSchema = z.enum(['succeeded', 'partial']);
export type SectorSyncStatus = z.infer<typeof SectorSyncStatusSchema>;

export const SectorSyncFailureSchema = z.object({
  scope: z.enum(['catalog', 'memberships']),
  kind: SectorKindSchema.nullable(),
  message: z.string().min(1),
});
export type SectorSyncFailure = z.infer<typeof SectorSyncFailureSchema>;

export interface SectorSyncApplyInput {
  readonly syncId: string;
  readonly source: string;
  readonly appliedAt: Date;
  readonly status: SectorSyncStatus;
  /** 本次成功取到的完整目录（按 kind 全量）。 */
  readonly catalog: readonly SectorCatalogObservation[];
  /** 目录请求成功的 kind；只有这些分类可以下线未出现的旧条目。 */
  readonly catalogKinds: readonly SectorKind[];
  /** 本次成功观测到成分的个股；未出现的个股保持原状。 */
  readonly observations: readonly StockSectorObservation[];
  /** 全部股票目录状态；停牌 / 退市只更新状态，不删除成分。 */
  readonly stockStatuses: readonly SectorStockStatusObservation[];
  readonly failures: readonly SectorSyncFailure[];
}

export interface SectorSyncApplySummary {
  readonly observedSectors: number;
  readonly createdSectors: number;
  readonly renamedSectors: number;
  readonly retiredSectors: number;
  readonly observedStocks: number;
  readonly createdMemberships: number;
  readonly removedMemberships: number;
  readonly reactivatedMemberships: number;
}

/** 外部数据源在 core 的投影：目录 + 按股批量反查成分。 */
export interface SectorCatalogAdapterLike {
  readonly name: string;
  fetchSectorCatalog(kind: SectorKind): Promise<readonly SectorCatalogObservation[]>;
  /** 部分批次失败不抛错：失败批次列入 failures，其余观测照常返回。 */
  fetchStockSectors(stockIds: readonly string[]): Promise<SectorStockObservationBatch>;
}

export interface SectorStockObservationBatch {
  readonly observations: readonly StockSectorObservation[];
  readonly failures: readonly SectorSyncFailure[];
}
