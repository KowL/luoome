import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type SourceId, SourceIdSchema } from '../source.js';

/**
 * 北向资金（沪深港通北向）日级历史流实体。
 *
 * 设计要点（对齐 dragon-tiger 的组织风格）：
 * - 一次查询 = 截止交易日 `endDate` + 样本窗口 `days` + 不可变的 `series`（按 date ASC）
 * - 金额为沪股通 + 深股通合计，单位元（上游为百万元，adapter 已换算）
 * - 2024-08-16 起交易所不再披露北向每日净买入：netAmount/buyAmount/sellAmount 为 null，
 *   不臆造、不估算；dealAmount（成交总额）始终有值
 * - series 只含实际有成交记录的交易日，不为非交易日补零
 */

// ---------- 枚举与基础类型 ----------

/**
 * 数据源标识（通用 SourceId；当前仅 eastmoney 数据中心公开报表注册）。
 * 兼容扩宽：docs/ddd/source-pluggability-and-observation-design.md §4.6。
 */
export type NorthboundFlowSource = SourceId;

export const NorthboundFlowSourceSchema = SourceIdSchema;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

/** 金额（元）或 null（null = 上游不再披露，区别于缺失）。 */
const amountOrNull = z.union([z.number(), z.null()]);

// ---------- 单日记录 ----------

export const NorthboundFlowEntrySchema = z.object({
  /** 交易日 YYYY-MM-DD；Asia/Shanghai。 */
  date: dateString,
  /** 北向当日净买入合计（元）；2024-08-16 起为 null（交易所停止披露）。 */
  netAmount: amountOrNull,
  /** 北向当日买入额合计（元）；披露口径同 netAmount。 */
  buyAmount: amountOrNull,
  /** 北向当日卖出额合计（元）；披露口径同 netAmount。 */
  sellAmount: amountOrNull,
  /** 北向当日成交总额合计（元）；始终有值。 */
  dealAmount: z.number().nonnegative(),
});

export type NorthboundFlowEntry = z.infer<typeof NorthboundFlowEntrySchema>;

// ---------- 序列快照 ----------

export const NorthboundFlowSeriesSchema = z.object({
  /** 实际截止交易日（endDate 为非交易日时向前对齐到最近交易日）。 */
  endDate: dateString,
  /** 实际样本窗口（== series.length，可能 < 请求的 days）。 */
  days: z.number().int().nonnegative(),
  source: NorthboundFlowSourceSchema,
  /** 按 date ASC 排列的日级记录。 */
  series: z.array(NorthboundFlowEntrySchema),
  /** 数据异常/口径提示；非空序列也可能有警告（如净买入未披露）。 */
  warnings: z.array(z.string()),
  /** manager 拉取时间。 */
  asOf: z.coerce.date(),
});

export type NorthboundFlowSeries = z.infer<typeof NorthboundFlowSeriesSchema>;

// ---------- 查询参数 ----------

export const NorthboundFlowQuerySchema = z.object({
  /** 样本窗口（默认 30 个交易日）。 */
  days: z.number().int().min(1).max(250).default(30),
  /** 缺省时由 manager 解析为当天（非交易日向前对齐到最近交易日）。 */
  endDate: dateString.optional(),
  /** 可选单源路由约束：未传时按配置顺序 fallback；显式传入时只尝试该源（§4.6）。 */
  source: NorthboundFlowSourceSchema.optional(),
});

export type NorthboundFlowQuery = z.infer<typeof NorthboundFlowQuerySchema>;

// ---------- 不变量 ----------

/**
 * 不变量：
 * - days 为非负整数且 == series.length
 * - series 按 date ASC 且无重复日期
 * - entry：dealAmount >= 0；netAmount ≈ buyAmount - sellAmount（披露口径内，容差 1 元）
 */
export const assertNorthboundFlowInvariants = (flow: NorthboundFlowSeries): void => {
  if (flow.days < 0 || !Number.isInteger(flow.days)) {
    throw new InvariantError(`days 必须为非负整数，实际 ${flow.days}`);
  }
  if (flow.days !== flow.series.length) {
    throw new InvariantError(`days (${flow.days}) != series.length (${flow.series.length})`);
  }
  let prev = '';
  for (const e of flow.series) {
    if (e.date <= prev) {
      throw new InvariantError(`series 必须按 date ASC 且无重复：${prev} -> ${e.date}`);
    }
    prev = e.date;
    if (e.dealAmount < 0) {
      throw new InvariantError(`entry.dealAmount 必须 >= 0 [${e.date}]`);
    }
    if (e.netAmount !== null && e.buyAmount !== null && e.sellAmount !== null) {
      const diff = Math.abs(e.netAmount - (e.buyAmount - e.sellAmount));
      if (diff > 1) {
        throw new InvariantError(
          `entry.netAmount (${e.netAmount}) != buyAmount - sellAmount [${e.date}]`,
        );
      }
    }
  }
};

/** 净买入未披露提示（2024-08-16 起交易所口径变更）。 */
export const NORTHBOUND_NET_UNDISCLOSED_WARNING =
  'net-undisclosed: 2024-08-16 起交易所不再披露北向每日净买入';
