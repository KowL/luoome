import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { SourceIdSchema } from '../source.js';

/**
 * 龙虎榜资金流向拓扑（跨交易日概念聚合）实体。
 *
 * 设计要点：
 * - 输入是「交易日 × 个股」的龙虎榜证据（同花顺龙虎榜接口按个股返回 concept_list /
 *   org_net_value / hot_money_net_value），输出是概念级累计净额轨迹与个股穿透。
 * - 一股多概念时按概念数等分净额，保证 sum(概念净额) == sum(个股净额)（口径守恒）；
 *   无概念的上榜股票进入 `未归类` 桶而不是被丢弃。
 * - 区间起点归零，`series[i]` 是截至第 i 个交易日的累计净额（元），
 *   `netAmount` 是区间累计（== series 末项）。
 * - 净额拆解恒为 机构 / 游资 / 其他，且在所选榜单内部闭合：
 *   all → 机构 = org_net_value、游资 = hot_money_net_value、其他 = 全榜净额 -（机构 + 游资）；
 *   org / hot → 机构（或游资）等于所选净额本身，其余两路为 0。
 *   这样轨迹、排行与拓扑三处永远对得上，不会出现「机构榜净额为正、拓扑三路相加却对不上」。
 * - board 只影响「用哪一列净额做轨迹与排行」：all → 全榜，org → 机构净额，
 *   hot → 游资净额；机构 / 游资 / 其他的拆解始终用同一交易日的全榜证据。
 */

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD');

export const DRAGON_TIGER_UNCLASSIFIED_CONCEPT = '未归类';

/** 榜单口径（对齐同花顺 board_type：all / org / hot_money）。 */
export const DragonTigerFlowBoardSchema = z.enum(['all', 'org', 'hot']);
export type DragonTigerFlowBoard = z.infer<typeof DragonTigerFlowBoardSchema>;

/** 上榜区间天数：1 为当日榜，3 为三日榜（两者不可混算，避免同一笔资金重复计入）。 */
export const DragonTigerFlowRangeDaysSchema = z.union([z.literal(1), z.literal(3)]);
export type DragonTigerFlowRangeDays = z.infer<typeof DragonTigerFlowRangeDaysSchema>;

/** 单只股票在单个交易日的龙虎榜证据（金额单位：元；涨跌幅为小数）。 */
export const DragonTigerFlowStockSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string(),
  changePct: z.number(),
  /** 全榜净买入额。 */
  netAmount: z.number(),
  /** 机构净买入额。 */
  orgNetAmount: z.number(),
  /** 游资净买入额。 */
  hotNetAmount: z.number(),
  buyAmount: z.number().nonnegative(),
  sellAmount: z.number().nonnegative(),
  /** 当日成交额。 */
  amount: z.number().nonnegative(),
  /** 所属概念（同花顺口径）；可为空数组。 */
  concepts: z.array(z.string()),
});

export type DragonTigerFlowStock = z.infer<typeof DragonTigerFlowStockSchema>;

/** 单个交易日的个股证据集合。 */
export const DragonTigerFlowDaySchema = z.object({
  date: dateString,
  stocks: z.array(DragonTigerFlowStockSchema),
});

export type DragonTigerFlowDay = z.infer<typeof DragonTigerFlowDaySchema>;

/** 概念内的个股贡献（区间累计，已按概念等分）。 */
export const DragonTigerFlowConceptStockSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: z.string(),
  netAmount: z.number(),
  orgNetAmount: z.number(),
  hotNetAmount: z.number(),
  /** 该股在区间内上榜并归属该概念的天数。 */
  days: z.number().int().nonnegative(),
});

export type DragonTigerFlowConceptStock = z.infer<typeof DragonTigerFlowConceptStockSchema>;

/** 单个概念的累计轨迹与资金构成。 */
export const DragonTigerFlowConceptSchema = z.object({
  name: z.string(),
  /** 逐交易日累计净额（长度 == tradingDates.length；起点 0 隐含在首日前）。 */
  series: z.array(z.number()),
  /** 区间累计净额（== series 末项，无数据时为 0）。 */
  netAmount: z.number(),
  orgNetAmount: z.number(),
  hotNetAmount: z.number(),
  /** 其他资金 = 全榜净额 - 机构 - 游资。 */
  otherNetAmount: z.number(),
  /** 归属该概念的股票数（区间去重）。 */
  stockCount: z.number().int().nonnegative(),
  /** 正负贡献 Top N（正贡献按降序、负贡献按升序；不足 N 条时如实较少）。 */
  stocks: z.array(DragonTigerFlowConceptStockSchema),
});

export type DragonTigerFlowConcept = z.infer<typeof DragonTigerFlowConceptSchema>;

export const DragonTigerFlowStatsSchema = z.object({
  /** 区间内上榜股票数（按 board 口径去重）。 */
  stockCount: z.number().int().nonnegative(),
  /** 区间内上榜明细行数（未按概念展开）。 */
  detailCount: z.number().int().nonnegative(),
  buyAmount: z.number().nonnegative(),
  sellAmount: z.number().nonnegative(),
  /** 区间净额合计（按 board 口径选择列）。 */
  netAmount: z.number(),
  orgNetAmount: z.number(),
  hotNetAmount: z.number(),
  /** 概念净额绝对值 Top5 之和 / 全部概念净额绝对值之和；无数据为 0。 */
  top5Concentration: z.number().min(0).max(1),
  /** 区间内出现的概念总数（截断前的值）。 */
  conceptCount: z.number().int().nonnegative(),
});

export type DragonTigerFlowStats = z.infer<typeof DragonTigerFlowStatsSchema>;

export const DragonTigerFlowSchema = z.object({
  startDate: dateString,
  endDate: dateString,
  /** 实际取数的交易日数（== tradingDates.length）。 */
  days: z.number().int().nonnegative(),
  board: DragonTigerFlowBoardSchema,
  rangeDays: DragonTigerFlowRangeDaysSchema,
  source: SourceIdSchema,
  /** 按时间升序的交易日（含无数据的交易日）。 */
  tradingDates: z.array(dateString),
  stats: DragonTigerFlowStatsSchema,
  concepts: z.array(DragonTigerFlowConceptSchema),
  warnings: z.array(z.string()),
  asOf: z.coerce.date(),
});

export type DragonTigerFlow = z.infer<typeof DragonTigerFlowSchema>;

/** 查询参数（date 缺省时由 manager 解析为最近交易日；非交易日向前对齐并给 warning）。 */
export const DragonTigerFlowQuerySchema = z.object({
  date: dateString.optional(),
  days: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(10),
  board: DragonTigerFlowBoardSchema.default('all'),
  rangeDays: DragonTigerFlowRangeDaysSchema.default(1),
});

export type DragonTigerFlowQuery = z.infer<typeof DragonTigerFlowQuerySchema>;

interface ConceptAccumulator {
  readonly name: string;
  readonly delta: number[];
  org: number;
  hot: number;
  net: number;
  readonly stocks: Map<
    string,
    { code: string; name: string; net: number; org: number; hot: number; days: Set<string> }
  >;
}

export interface AggregateDragonTigerFlowOptions {
  readonly tradingDates: readonly string[];
  readonly board: DragonTigerFlowBoard;
  readonly rangeDays: DragonTigerFlowRangeDays;
  readonly source: string;
  readonly asOf: Date;
  readonly warnings?: readonly string[];
  /** 概念保留上限（按区间净额绝对值降序截断）；默认 60。 */
  readonly maxConcepts?: number;
  /** 概念内正 / 负贡献各保留多少只；默认 5。 */
  readonly stocksPerSide?: number;
}

const DEFAULT_MAX_CONCEPTS = 60;
const DEFAULT_STOCKS_PER_SIDE = 5;

const netColumn = (stock: DragonTigerFlowStock, board: DragonTigerFlowBoard): number => {
  if (board === 'org') return stock.orgNetAmount;
  if (board === 'hot') return stock.hotNetAmount;
  return stock.netAmount;
};

/** board 口径下的入榜判定：机构 / 游资榜只保留该路资金有净额的股票。 */
const inBoard = (stock: DragonTigerFlowStock, board: DragonTigerFlowBoard): boolean => {
  if (board === 'org') return stock.orgNetAmount !== 0;
  if (board === 'hot') return stock.hotNetAmount !== 0;
  return true;
};

/** 概念名去空白 / 去重 / 去空；无概念 → ['未归类']。 */
export const conceptNamesOf = (concepts: readonly string[]): string[] => {
  const names: string[] = [];
  for (const raw of concepts) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0 || names.includes(name)) continue;
    names.push(name);
  }
  return names.length === 0 ? [DRAGON_TIGER_UNCLASSIFIED_CONCEPT] : names;
};

const topContributors = (
  stocks: ConceptAccumulator['stocks'],
  perSide: number,
): DragonTigerFlowConceptStock[] => {
  const list = [...stocks.values()].map((s) => ({
    code: s.code,
    name: s.name,
    netAmount: s.net,
    orgNetAmount: s.org,
    hotNetAmount: s.hot,
    days: s.days.size,
  }));
  const positive = list
    .filter((s) => s.netAmount > 0)
    .sort((a, b) => b.netAmount - a.netAmount)
    .slice(0, perSide);
  const negative = list
    .filter((s) => s.netAmount < 0)
    .sort((a, b) => a.netAmount - b.netAmount)
    .slice(0, perSide);
  return [...positive, ...negative];
};

/**
 * 把「交易日 × 个股」证据聚合为概念累计净额轨迹。
 *
 * 口径：
 * - 每只股票的当日净额按概念数等分，机构 / 游资净额用同一等分系数；
 * - 同一交易日内同代码只计一次（调用方负责按 range_days 过滤与去重）；
 * - 没有数据的交易日按 0 计入，保持 series 与 tradingDates 一一对应。
 */
export const aggregateDragonTigerFlow = (
  days: readonly DragonTigerFlowDay[],
  options: AggregateDragonTigerFlowOptions,
): DragonTigerFlow => {
  if (options.tradingDates.length === 0) {
    throw new InvariantError('dragon-tiger-flow 至少需要一个交易日');
  }
  const dayCount = options.tradingDates.length;
  const maxConcepts = options.maxConcepts ?? DEFAULT_MAX_CONCEPTS;
  const perSide = options.stocksPerSide ?? DEFAULT_STOCKS_PER_SIDE;
  const byDate = new Map<string, DragonTigerFlowDay>();
  for (const day of days) {
    if (!byDate.has(day.date)) byDate.set(day.date, day);
  }

  const concepts = new Map<string, ConceptAccumulator>();
  const stockCodes = new Set<string>();
  let detailCount = 0;
  let buyAmount = 0;
  let sellAmount = 0;
  let netAmount = 0;
  let orgNetAmount = 0;
  let hotNetAmount = 0;

  for (let index = 0; index < dayCount; index += 1) {
    const date = options.tradingDates[index];
    if (date === undefined) continue;
    const day = byDate.get(date);
    if (day === undefined) continue;
    const seen = new Set<string>();
    for (const stock of day.stocks) {
      if (seen.has(stock.code) || !inBoard(stock, options.board)) continue;
      seen.add(stock.code);
      detailCount += 1;
      stockCodes.add(stock.code);
      buyAmount += stock.buyAmount;
      sellAmount += stock.sellAmount;
      const net = netColumn(stock, options.board);
      const orgShare =
        options.board === 'all' ? stock.orgNetAmount : options.board === 'org' ? net : 0;
      const hotShare =
        options.board === 'all' ? stock.hotNetAmount : options.board === 'hot' ? net : 0;
      netAmount += net;
      orgNetAmount += orgShare;
      hotNetAmount += hotShare;

      const names = conceptNamesOf(stock.concepts);
      const weight = 1 / names.length;
      for (const name of names) {
        let acc = concepts.get(name);
        if (acc === undefined) {
          acc = {
            name,
            delta: new Array<number>(dayCount).fill(0),
            org: 0,
            hot: 0,
            net: 0,
            stocks: new Map(),
          };
          concepts.set(name, acc);
        }
        acc.delta[index] = (acc.delta[index] ?? 0) + net * weight;
        acc.net += net * weight;
        acc.org += orgShare * weight;
        acc.hot += hotShare * weight;
        let entry = acc.stocks.get(stock.code);
        if (entry === undefined) {
          entry = {
            code: stock.code,
            name: stock.name,
            net: 0,
            org: 0,
            hot: 0,
            days: new Set<string>(),
          };
          acc.stocks.set(stock.code, entry);
        }
        entry.net += net * weight;
        entry.org += orgShare * weight;
        entry.hot += hotShare * weight;
        entry.days.add(date);
      }
    }
  }

  const all: DragonTigerFlowConcept[] = [...concepts.values()].map((acc) => {
    const series: number[] = [];
    let running = 0;
    for (let index = 0; index < dayCount; index += 1) {
      running += acc.delta[index] ?? 0;
      series.push(running);
    }
    return {
      name: acc.name,
      series,
      netAmount: running,
      orgNetAmount: acc.org,
      hotNetAmount: acc.hot,
      otherNetAmount: running - acc.org - acc.hot,
      stockCount: acc.stocks.size,
      stocks: topContributors(acc.stocks, perSide),
    };
  });

  const concentrationBase = all.reduce((sum, concept) => sum + Math.abs(concept.netAmount), 0);
  const top5 = all
    .map((concept) => Math.abs(concept.netAmount))
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((sum, value) => sum + value, 0);
  const shown = [...all]
    .sort((a, b) => Math.abs(b.netAmount) - Math.abs(a.netAmount))
    .slice(0, maxConcepts)
    .sort((a, b) => b.netAmount - a.netAmount);

  const startDate = options.tradingDates[0] ?? '';
  const endDate = options.tradingDates[dayCount - 1] ?? '';

  return {
    startDate,
    endDate,
    days: dayCount,
    board: options.board,
    rangeDays: options.rangeDays,
    source: options.source,
    tradingDates: [...options.tradingDates],
    stats: {
      stockCount: stockCodes.size,
      detailCount,
      buyAmount,
      sellAmount,
      netAmount,
      orgNetAmount,
      hotNetAmount,
      top5Concentration: concentrationBase === 0 ? 0 : top5 / concentrationBase,
      conceptCount: all.length,
    },
    concepts: shown,
    warnings: [...(options.warnings ?? [])],
    asOf: options.asOf,
  };
};

/**
 * 不变量：
 * - days == tradingDates.length；每个概念的 series 长度同为 days；
 * - 概念的净额 == 机构 + 游资 + 其他，且 == series 末项（浮点容差内）；
 * - 概念内个股数不超过正负各 stocksPerSide + 重叠上限（此处按 2 倍宽松校验）。
 */
export const assertDragonTigerFlowInvariants = (flow: DragonTigerFlow): void => {
  if (flow.days !== flow.tradingDates.length) {
    throw new InvariantError(
      `dragon-tiger-flow days (${flow.days}) != tradingDates.length (${flow.tradingDates.length})`,
    );
  }
  if (flow.days === 0 && flow.concepts.length > 0) {
    throw new InvariantError('dragon-tiger-flow 无交易日时不应有概念轨迹');
  }
  if (flow.stats.conceptCount < flow.concepts.length) {
    throw new InvariantError('dragon-tiger-flow 概念数小于展示概念数');
  }
  for (const concept of flow.concepts) {
    if (concept.series.length !== flow.days) {
      throw new InvariantError(
        `concept ${concept.name} series 长度 (${concept.series.length}) != days (${flow.days})`,
      );
    }
    const last = concept.series[concept.series.length - 1] ?? 0;
    const tolerance = Math.max(1, Math.abs(last)) * 1e-9;
    if (Math.abs(last - concept.netAmount) > tolerance) {
      throw new InvariantError(`concept ${concept.name} netAmount != series 末项`);
    }
    if (
      Math.abs(
        concept.netAmount - concept.orgNetAmount - concept.hotNetAmount - concept.otherNetAmount,
      ) > tolerance
    ) {
      throw new InvariantError(`concept ${concept.name} 净额拆解不守恒`);
    }
    if (concept.stockCount < concept.stocks.length) {
      throw new InvariantError(`concept ${concept.name} stocks 数超过 stockCount`);
    }
  }
};
