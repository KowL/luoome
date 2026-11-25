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

export const SectorConceptScopeSchema = z.enum(['focused', 'all']);
export type SectorConceptScope = z.infer<typeof SectorConceptScopeSchema>;

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

const NON_THEME_CONCEPT_NAMES = [
  /^(?:融资融券|沪股通|深股通)$/,
  /^(?:ST板块|摘帽|新股与次新股|注册制次新股|科创次新股)$/,
  /^(?:高股息精选|证金持股|国家大基金持股|中字头股票|超级品牌|专精特新|举牌)$/,
  /^\d{4}(?:一季报|中报|三季报|年报)(?:预增|预减|预盈|预亏)$/,
  /^同花顺/,
  /^中国AI\d+$/,
];

/**
 * 精选只改变原始概念榜的读模型；原始目录与成分事实仍完整保留，可通过 all 查看。
 * 宽概念不再按成分数量剔除：主流锚点（人工智能、新能源汽车等）本身就很宽，
 * 是否属于主流方向由 mainstream-themes 的 vendorCode 映射决定，不由成分数决定。
 */
export const selectMarketRoomSectorCatalog = (input: {
  readonly sectors: readonly SectorCatalogEntry[];
  readonly members: readonly StockSectorMembership[];
  readonly conceptScope?: SectorConceptScope;
}): readonly SectorCatalogEntry[] => {
  if (input.conceptScope === 'all') return input.sectors;

  const memberIdsBySector = new Map<string, Set<string>>();
  for (const membership of input.members) {
    if (membership.state !== 'active') continue;
    const ids = memberIdsBySector.get(membership.sectorId) ?? new Set<string>();
    ids.add(membership.stockId);
    memberIdsBySector.set(membership.sectorId, ids);
  }
  const eligible = input.sectors.filter((sector) => {
    if (sector.kind !== 'concept') return true;
    return !NON_THEME_CONCEPT_NAMES.some((pattern) => pattern.test(sector.name));
  });
  const representatives = new Map<string, SectorCatalogEntry>();
  const fingerprint = (sector: SectorCatalogEntry): string | null => {
    if (sector.kind !== 'concept') return null;
    const ids = memberIdsBySector.get(sector.id);
    if (ids === undefined || ids.size === 0) return null;
    return [...ids].sort().join('\u0000');
  };
  for (const sector of eligible) {
    const key = fingerprint(sector);
    if (key === null) continue;
    const current = representatives.get(key);
    if (
      current === undefined ||
      sector.name.length < current.name.length ||
      (sector.name.length === current.name.length && sector.vendorCode < current.vendorCode)
    ) {
      representatives.set(key, sector);
    }
  }
  return eligible.filter((sector) => {
    const key = fingerprint(sector);
    return key === null || representatives.get(key)?.id === sector.id;
  });
};

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
