import { z } from 'zod';

import { InvariantError } from '../error/index.js';

/**
 * 行业板块行情快照实体。
 *
 * 设计要点（对齐 news / dragon-tiger 的组织风格）：
 * - 一次查询 = 排序字段 `sort` + `limit` + 不可变的 `items`；实时行情快照，无交易日历逻辑
 * - 上游（东方财富 push2 clist，fs=m:90+t:2 行业板块）字段：f2 最新价 / f3 涨跌幅 /
 *   f4 涨跌额 / f6 成交额(元) / f12 板块代码(BKxxxx) / f14 名称 / f104 上涨家数 /
 *   f105 下跌家数 / f128 领涨股名称 / f140 领涨股代码 / f136 领涨股涨跌幅 / f124 行情时间戳
 *   （字段码经真实请求冒烟验证 2026-08-22）
 * - 涨跌幅统一存小数（0.10 = 10%），与 limit-up-ladder / dragon-tiger 的 changePct 口径一致；
 *   成交额单位为元，不做换算
 * - 领涨股字段上游可能缺（极个别板块），item 层置 undefined，不视为数据错误
 */

// ---------- 枚举与基础类型 ----------

/** 数据源名称（当前仅 eastmoney；保留枚举便于 schema 限定与将来扩展）。 */
export type SectorQuoteSource = 'eastmoney';

export const SectorQuoteSourceSchema = z.enum(['eastmoney']);

/** 排序字段（映射上游 fid：changePct → f3，amount → f6；均为降序）。 */
export const SectorQuoteSortSchema = z.enum(['changePct', 'amount']);

export type SectorQuoteSort = z.infer<typeof SectorQuoteSortSchema>;

// ---------- 单个板块 ----------

export const SectorQuoteItemSchema = z.object({
  /** 板块代码（BKxxxx）。 */
  code: z.string().min(1),
  name: z.string().min(1),
  /** 板块指数最新点位。 */
  price: z.number().positive(),
  /** 涨跌幅（小数，0.10 = 10%）。 */
  changePct: z.number().min(-1).max(10),
  /** 涨跌额（点位）。 */
  change: z.number(),
  /** 成交额（元）。 */
  amount: z.number().nonnegative(),
  /** 板块内上涨 / 下跌家数；上游缺失时为 undefined。 */
  upCount: z.number().int().nonnegative().optional(),
  downCount: z.number().int().nonnegative().optional(),
  /** 领涨股名称 / 代码 / 涨跌幅（小数）；上游缺失时为 undefined。 */
  leadingStockName: z.string().optional(),
  leadingStockCode: z.string().optional(),
  leadingStockChangePct: z.number().min(-1).max(10).optional(),
});

export type SectorQuoteItem = z.infer<typeof SectorQuoteItemSchema>;

// ---------- 列表快照 ----------

export const SectorQuoteListSchema = z.object({
  /** 返回的板块数（== items.length）。 */
  total: z.number().int().nonnegative(),
  source: SectorQuoteSourceSchema,
  /** 按查询 sort 字段降序。 */
  items: z.array(SectorQuoteItemSchema),
  /** 数据异常/口径提示；非空列表也可能有警告。 */
  warnings: z.array(z.string()),
  /** manager 拉取时间。 */
  asOf: z.coerce.date(),
});

export type SectorQuoteList = z.infer<typeof SectorQuoteListSchema>;

// ---------- 查询参数 ----------

export const FetchSectorQuotesQuerySchema = z.object({
  /** 排序字段（默认 changePct 涨跌幅降序）。 */
  sort: SectorQuoteSortSchema.default('changePct'),
  /** 返回条数（默认 50）。 */
  limit: z.number().int().min(1).max(200).default(50),
  source: SectorQuoteSourceSchema.default('eastmoney'),
});

export type FetchSectorQuotesQuery = z.infer<typeof FetchSectorQuotesQuerySchema>;

// ---------- 不变量 ----------

/**
 * 不变量：
 * - total 为非负整数且 == items.length
 * - item：code / name 非空、price > 0、changePct ∈ [-1, 10]、amount 非负
 * - upCount/downCount 同时存在或同时缺失
 */
export const assertSectorQuoteListInvariants = (list: SectorQuoteList): void => {
  if (list.total < 0 || !Number.isInteger(list.total)) {
    throw new InvariantError(`total 必须为非负整数，实际 ${list.total}`);
  }
  if (list.total !== list.items.length) {
    throw new InvariantError(`total (${list.total}) != items.length (${list.items.length})`);
  }
  for (const item of list.items) {
    if (item.code.trim().length === 0) throw new InvariantError('item.code 必须非空');
    if (item.name.trim().length === 0)
      throw new InvariantError(`item.name 必须非空 [${item.code}]`);
    if (item.price <= 0) throw new InvariantError(`item.price 必须 > 0 [${item.code}]`);
    if (item.changePct < -1 || item.changePct > 10) {
      throw new InvariantError(`item.changePct 越界 [${item.code}] = ${item.changePct}`);
    }
    if (item.amount < 0) throw new InvariantError(`item.amount 必须非负 [${item.code}]`);
    if ((item.upCount === undefined) !== (item.downCount === undefined)) {
      throw new InvariantError(`item.upCount/downCount 必须同时存在或同时缺失 [${item.code}]`);
    }
  }
};
