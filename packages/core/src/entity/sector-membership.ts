import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 个股板块关系（SectorMembership）实体。
 *
 * 设计要点（docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §10.2）：
 * - 一次查询 = 一组股票（≤100 只）× 可选板块类型过滤 + 不可变的 `items`；
 *   结果是**当前关系快照**，带 fetchedAt / source / contentHash
 * - 板块身份保留上游 `.TI` 标准代码与四种类型（industry / cn_concept / region / tszs），
 *   不伪造 Eastmoney `BKxxxx`，不做跨类型去重
 * - 空 `memberships` 只表示当前无匹配关系，不证明股票不存在（北交所等上游可能无数据）
 * - 这是当前关系，不是历史 PIT 成分：不回写 `StockUniverseSnapshotMember.industry`，
 *   不充当历史指数成分或权重，也不与历史板块行情相乘生成历史归因
 * - `fetchedAt` 是本地获取时间（上游反查端点不返回数据时间）；`contentHash` 由
 *   规范化响应内容稳定派生，用于审计与幂等识别，不冒充上游 revision
 */

// ---------- 枚举与基础类型 ----------

/** 数据源标识（通用 SourceId；当前仅 fuyao 注册）。 */
export type SectorMembershipSource = SourceId;

export const SectorMembershipSourceSchema = SourceIdSchema;

/** 板块类型（上游 type 原值；tszs 为特色/动态榜单型指数，不是静态行业分类）。 */
export const SectorMembershipTypeSchema = z.enum(['industry', 'cn_concept', 'region', 'tszs']);

export type SectorMembershipType = z.infer<typeof SectorMembershipTypeSchema>;

const stockIdString = z
  .string()
  .regex(/^\d{6}\.(SH|SZ|BJ)$/, '股票代码必须为 6 位数字加交易所后缀');

// ---------- 单条板块归属 ----------

export const SectorMembershipEntrySchema = z.object({
  /** 板块代码（上游 `.TI` 同花顺指数标准代码）。 */
  sectorCode: z.string().min(1),
  /** 板块名称；上游目录缺失时保持缺失，不用代码回填。 */
  sectorName: z.string().min(1).optional(),
  type: SectorMembershipTypeSchema,
});

export type SectorMembershipEntry = z.infer<typeof SectorMembershipEntrySchema>;

// ---------- 单只股票的关系组 ----------

export const StockSectorMembershipSchema = z.object({
  /** 标的代码，带交易所后缀；与请求代码一一对应，按请求顺序返回。 */
  stockId: stockIdString,
  /** 当前板块归属；空数组只表示当前无匹配，不证明股票不存在。 */
  memberships: z.array(SectorMembershipEntrySchema),
});

export type StockSectorMembership = z.infer<typeof StockSectorMembershipSchema>;

// ---------- 关系快照 ----------

export const SectorMembershipSnapshotSchema = z.object({
  /** 返回的股票组数（== items.length）。 */
  total: z.number().int().nonnegative(),
  source: SectorMembershipSourceSchema,
  /** 与请求代码一一对应（含空关系组），按请求顺序。 */
  items: z.array(StockSectorMembershipSchema),
  /** 数据异常/口径提示；非空列表也可能有警告。 */
  warnings: z.array(z.string()),
  /** 本地获取时间（上游不返回数据时间，只有 retrieval 语义）。 */
  fetchedAt: z.coerce.date(),
  /** 规范化响应内容的稳定 hash（审计 / 幂等识别；不是上游 revision）。 */
  contentHash: z.string().min(1),
});

export type SectorMembershipSnapshot = z.infer<typeof SectorMembershipSnapshotSchema>;

// ---------- 查询参数 ----------

export const GetStockSectorMembershipsQuerySchema = z.object({
  /** 标的代码列表（带交易所后缀）；单次最多 100 只（上游硬上限，超出由 tool 分批）。 */
  stockIds: z.array(stockIdString).min(1).max(100),
  /** 板块类型过滤；缺省返回全部四类。 */
  type: SectorMembershipTypeSchema.optional(),
  /** 可选单源路由约束：未传时按配置顺序 fallback；显式传入时只尝试该源（§4.6）。 */
  source: SectorMembershipSourceSchema.optional(),
});

export type GetStockSectorMembershipsQuery = z.infer<typeof GetStockSectorMembershipsQuerySchema>;

// ---------- 不变量 ----------

/**
 * 不变量：
 * - total 为非负整数且 == items.length
 * - items 与请求 stockIds 一一对应（同长度、同顺序、同代码；含空关系组）
 * - entry：sectorCode 非空；sectorName 存在时非空
 */
export const assertSectorMembershipSnapshotInvariants = (
  snapshot: SectorMembershipSnapshot,
  requestedStockIds: readonly string[],
): void => {
  if (snapshot.total < 0 || !Number.isInteger(snapshot.total)) {
    throw new InvariantError(`total 必须为非负整数，实际 ${snapshot.total}`);
  }
  if (snapshot.total !== snapshot.items.length) {
    throw new InvariantError(
      `total (${snapshot.total}) != items.length (${snapshot.items.length})`,
    );
  }
  if (snapshot.items.length !== requestedStockIds.length) {
    throw new InvariantError(
      `items.length (${snapshot.items.length}) != 请求股票数 (${requestedStockIds.length})`,
    );
  }
  snapshot.items.forEach((item, index) => {
    if (item.stockId !== requestedStockIds[index]) {
      throw new InvariantError(
        `items[${index}].stockId (${item.stockId}) 与请求顺序不符 (${requestedStockIds[index]})`,
      );
    }
    for (const entry of item.memberships) {
      if (entry.sectorCode.trim().length === 0) {
        throw new InvariantError(`entry.sectorCode 必须非空 [${item.stockId}]`);
      }
      if (entry.sectorName !== undefined && entry.sectorName.trim().length === 0) {
        throw new InvariantError(`entry.sectorName 存在时必须非空 [${item.stockId}]`);
      }
    }
  });
};
