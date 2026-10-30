import { z } from 'zod';

import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 个股档案（Stock Profile）实体。
 *
 * 设计要点：
 * - 一只股票 = 不可变的股东户数序列 + 所属板块清单 + 单一数据源 `source`
 * - 股东户数按统计截止日（`endDate`）排列，最新一期在前；上游没有则空数组，不回退到估算
 * - 变动比例统一存小数（0.05 = 5%）；上游未披露为 null，不做推断
 * - 户均持股单位为股，户均市值单位为元
 * - 板块区分行业 / 概念 / 地域（`boardType`），不做跨类型去重
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

/** 单期股东户数统计。 */
export const StockHolderStatSchema = z.object({
  /** 统计截止日。 */
  endDate: dateString,
  /** 股东户数（户）。 */
  holderNum: z.number().int().nonnegative(),
  /** 较上期变动比例（小数，0.05 = 5%）；上游未披露为 null。 */
  changePct: z.number().nullable(),
  /** 户均持股（股）；上游未披露为 null。 */
  avgShares: z.number().nonnegative().nullable(),
  /** 户均市值（元）；上游未披露为 null。 */
  avgMarketValue: z.number().nonnegative().nullable(),
});
export type StockHolderStat = z.infer<typeof StockHolderStatSchema>;

/** 所属板块（行业 / 概念 / 地域）。 */
export const StockConceptSchema = z.object({
  /** 板块代码。 */
  code: z.string(),
  /** 板块名称。 */
  name: z.string(),
  /** 板块类型（上游标注）；上游未标注为 null，不从代码前缀推断。 */
  boardType: z.string().nullable(),
  /** 上游标记是否为精确归属；宽泛归属（如指数成分）为 false。 */
  precise: z.boolean(),
  /** 板块内排序；上游未给出为 null。 */
  rank: z.number().nullable(),
  /** 入选理由原文；上游未给出为 null。 */
  reason: z.string().nullable(),
});
export type StockConcept = z.infer<typeof StockConceptSchema>;

export const StockProfileSchema = z.object({
  /** 标的代码，带交易所后缀。 */
  stockId: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/, '股票代码必须为 6 位数字加交易所后缀'),
  /** 数据源。 */
  source: SourceIdSchema,
  /** 快照生成时间（ISO 8601）。 */
  asOf: z.string(),
  /** 股东户数序列，最新一期在前。 */
  holders: z.array(StockHolderStatSchema),
  /** 所属板块清单。 */
  concepts: z.array(StockConceptSchema),
});
export type StockProfile = z.infer<typeof StockProfileSchema>;

/** 单只股票的档案查询参数。 */
export const StockProfileQuerySchema = z.object({
  stockId: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/, '股票代码必须为 6 位数字加交易所后缀'),
  /** 显式数据源约束；缺省按启用顺序 fallback。 */
  source: SourceIdSchema.optional(),
});
export type StockProfileQuery = z.infer<typeof StockProfileQuerySchema>;

export type StockProfileSource = SourceId;
