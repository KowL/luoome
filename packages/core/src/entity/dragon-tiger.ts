import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 龙虎榜（Dragon-Tiger List）实体。
 *
 * 设计要点（对齐 limit-up-ladder 的组织风格）：
 * - 一次龙虎榜快照 = 单一交易日 `date` + 单一数据源 `source` + 不可变的 `entries`
 * - 同一股票同日可因不同上榜原因出现多条（API 按 (股票, 原因) 一行），不做跨条目去重
 * - 涨跌幅 / 换手率统一存小数（0.10 = 10%），与 limit-up-ladder 的 changePct 口径一致
 * - 金额字段单位为元；netAmount 可为负（净卖出）
 * - 缺字段哨兵：name 缺失回退到 code；reason 缺失显示 '--'（manager 内归一化）
 */

// ---------- 枚举与基础类型 ----------

/**
 * 数据源标识（通用 SourceId；当前仅 eastmoney 数据中心公开报表注册）。
 * 兼容扩宽：docs/ddd/source-pluggability-and-observation-design.md §4.6。
 */
export type DragonTigerSource = SourceId;

export const DragonTigerSourceSchema = SourceIdSchema;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

// ---------- 单条上榜记录 ----------

export const DragonTigerEntrySchema = z.object({
  /** A 股代码 6 位（'600xxx' / '000xxx' / '300xxx'）；不带交易所后缀。 */
  code: z.string().regex(/^\d{6}$/),
  /** 中文名称；缺失时回退到 code（manager 内归一化）。 */
  name: z.string(),
  /** 当日收盘价。 */
  close: z.number().positive(),
  /** 相对昨收的小数（0.10 = 10%）；[-1, 10] 覆盖跌停与无涨跌幅限制新股。 */
  changePct: z.number().min(-1).max(10),
  /** 换手率小数（0.15 = 15%）。 */
  turnoverRate: z.number().nonnegative(),
  /** 上榜原因（EXPLANATION）；缺失显示 '--'。 */
  reason: z.string(),
  /** 龙虎榜净买入额（元）；负值 = 净卖出。 */
  netAmount: z.number(),
  /** 龙虎榜买入额（元）。 */
  buyAmount: z.number().nonnegative(),
  /** 龙虎榜卖出额（元）。 */
  sellAmount: z.number().nonnegative(),
  /** 当日总成交额（元）。 */
  amount: z.number().nonnegative(),
  /** 上榜交易日 YYYY-MM-DD；应 == 快照基准日 `date`（runtime 校验）。 */
  tradeDate: dateString,
});

export type DragonTigerEntry = z.infer<typeof DragonTigerEntrySchema>;

// ---------- 单日快照 ----------

export const DragonTigerListSchema = z.object({
  /** 请求方关心的基准交易日；Asia/Shanghai。 */
  date: dateString,
  /** 上榜条目数（== entries.length，不去重）。 */
  total: z.number().int().nonnegative(),
  source: DragonTigerSourceSchema,
  /** 按净买入额 DESC 排列（与上游排序一致）。 */
  entries: z.array(DragonTigerEntrySchema),
  /** 数据异常/字段缺失提示；非空榜单也可能有警告。 */
  warnings: z.array(z.string()),
  /** manager 拉取时间。 */
  asOf: z.coerce.date(),
});

export type DragonTigerList = z.infer<typeof DragonTigerListSchema>;

// ---------- 查询参数 ----------

export const DragonTigerListQuerySchema = z.object({
  /** 缺省时由 manager 解析为当天；当天非交易日时回退到最近交易日。 */
  date: dateString.optional(),
  /** 可选单源路由约束：未传时按配置顺序 fallback；显式传入时只尝试该源（§4.6）。 */
  source: DragonTigerSourceSchema.optional(),
});

export type DragonTigerListQuery = z.infer<typeof DragonTigerListQuerySchema>;

// ---------- 不变量 ----------

/**
 * 不变量：
 * - total 为非负整数且 == entries.length
 * - entry：close > 0、changePct ∈ [-1, 10]、金额非负（netAmount 除外）
 * - baseDate 提供时：entry.tradeDate 与快照 date 都必须等于 baseDate
 */
export const assertDragonTigerListInvariants = (list: DragonTigerList, baseDate?: string): void => {
  if (list.total < 0 || !Number.isInteger(list.total)) {
    throw new InvariantError(`total 必须为非负整数，实际 ${list.total}`);
  }
  if (list.total !== list.entries.length) {
    throw new InvariantError(`total (${list.total}) != entries.length (${list.entries.length})`);
  }
  if (baseDate !== undefined && list.date !== baseDate) {
    throw new InvariantError(`list.date (${list.date}) != date (${baseDate})`);
  }
  for (const e of list.entries) {
    if (e.close <= 0) throw new InvariantError(`entry.close 必须 > 0 [${e.code}]`);
    if (e.changePct < -1 || e.changePct > 10) {
      throw new InvariantError(`entry.changePct 越界 [${e.code}] = ${e.changePct}`);
    }
    if (baseDate !== undefined && e.tradeDate !== baseDate) {
      throw new InvariantError(
        `entry.tradeDate (${e.tradeDate}) != date (${baseDate}) [${e.code}]`,
      );
    }
  }
};

// 暴露哨兵常量给 surface 使用，避免硬编码字符串散落多处
export const DragonTigerSentinels = {
  REASON_MISSING: '--',
} as const;
