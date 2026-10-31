import {
  addMoney,
  type Holding,
  HoldingSchema,
  type Money,
  MoneySchema,
  money,
  type Percentage,
  PercentageSchema,
  percentage,
  type Quote,
  QuoteSchema,
} from '@luoome/core';
import { z } from 'zod';

/** 缺价原因的统一文案：渲染层直接用它，不再各自拼。 */
export const HOLDING_PRICE_UNAVAILABLE = '缺价：该标的没有可用行情，成本价不代表现价';

/**
 * 用现价丰富单条持仓。
 *
 * **行情缺失时不降级用成本价**（REQ-M3-09 / D2）：成本价顶替会产出伪造的 0% 盈亏，
 * 比「没有数字」更坏——它看起来像一个真实结论。缺价 → 相关字段缺席 + `priceStatus='unpriced'`。
 * previousClose 缺失时今日盈亏为 null（调用方不要伪造基准）。
 */
export const enrichHolding = (
  holding: Holding,
  quote: Quote | undefined,
  stockName: string,
  previousClose: Money | null = null,
): HoldingPnl => {
  const cost = money(holding.avgCost * holding.quantity);
  if (quote === undefined) {
    return {
      holding,
      stockName,
      priceStatus: 'unpriced',
      priceUnavailableReason: HOLDING_PRICE_UNAVAILABLE,
      quote: null,
      previousClose,
      cost,
      todayPnl: null,
      todayPnlPct: null,
    };
  }
  const currentPrice = quote.close;
  const marketValue = money(currentPrice * holding.quantity);
  const pnl = money(marketValue - cost);
  // 成本为 0（清仓后残留行）时没有可用的收益率分母：缺席而不是 0。
  const pnlPct = cost > 0 ? clampPercentage(pnl / cost) : undefined;
  const todayPnl =
    previousClose === null ? null : money((currentPrice - previousClose) * holding.quantity);
  const todayPnlPct =
    previousClose === null || previousClose <= 0
      ? null
      : clampPercentage((currentPrice - previousClose) / previousClose);
  return {
    holding,
    stockName,
    priceStatus: 'priced',
    currentPrice,
    quote,
    previousClose,
    marketValue,
    cost,
    pnl,
    ...(pnlPct === undefined ? {} : { pnlPct }),
    todayPnl,
    todayPnlPct,
  };
};

/**
 * 单条持仓 + 现价盈亏（list_holdings / get_holding 共用的输出元素）。
 *
 * **缺价时不给百分比**：`currentPrice` / `marketValue` / `pnl` / `pnlPct` 一律**字段缺席**，
 * 而不是用成本价兜底算出伪造的 0%。缺席 + `priceStatus` 才是诚实答案；
 * 真实的 0 盈亏（有价、成本等于市值）仍然会输出 0。
 */
export const HoldingPnlSchema = z
  .object({
    holding: HoldingSchema,
    stockName: z.string().min(1),
    /** 报价可用性：`priced` 才保证下面四个字段存在。 */
    priceStatus: z.enum(['priced', 'unpriced']),
    /** 缺价原因（只在 `unpriced` 时出现）：让调用方能渲染「缺价」而不是「0」。 */
    priceUnavailableReason: z.string().min(1).optional(),
    currentPrice: MoneySchema.optional(),
    quote: QuoteSchema.nullable().optional(),
    /** 昨收（今日盈亏基准）；取不到为 null，今日盈亏同步为 null。 */
    previousClose: MoneySchema.nullable(),
    marketValue: MoneySchema.optional(),
    cost: MoneySchema,
    pnl: MoneySchema.optional(),
    pnlPct: PercentageSchema.optional(),
    /** 今日盈亏金额 = (现价 − 昨收) × 数量；缺价或缺昨收时为 null（不伪造基准）。 */
    todayPnl: MoneySchema.nullable(),
    /** 今日涨跌幅 = (现价 − 昨收) / 昨收。 */
    todayPnlPct: PercentageSchema.nullable(),
  })
  .strict();

export type HoldingPnl = z.infer<typeof HoldingPnlSchema>;

/** Percentage 合法区间 [-1, 10]；极端行情截断而不是炸 invariant。 */
const clampPercentage = (rate: number): Percentage => percentage(Math.min(10, Math.max(-1, rate)));

export interface PnlSummary {
  /** 只要有一只持仓缺价就缺席：部分求和的市值不是结论（REQ-M3-09）。 */
  readonly totalValue?: Money;
  readonly totalCost: Money;
  readonly totalPnL?: Money;
  readonly totalPnLPct?: Percentage;
  /** 有持仓但全部有价：`totalPnLPct` 恒为数字；空持仓时为 0（没有持仓是事实）。 */
  /** 缺价的持仓数；>0 时上面四个字段缺席，渲染层据此显示「缺价」。 */
  readonly unpricedCount: number;
  /** 今日盈亏合计；任一持仓缺昨收或缺价时为 null（不伪造部分合计）。 */
  readonly totalTodayPnl: Money | null;
  readonly totalTodayPnlPct: Percentage | null;
}

/** 汇总一组持仓盈亏（Money 运算一律走 core 的 branded 运算函数）。 */
export const summarizePnl = (items: readonly HoldingPnl[]): PnlSummary => {
  let totalValue = money(0);
  let totalCost = money(0);
  const unpricedCount = items.filter((item) => item.priceStatus === 'unpriced').length;
  for (const item of items) {
    if (item.marketValue !== undefined) totalValue = addMoney(totalValue, item.marketValue);
    totalCost = addMoney(totalCost, item.cost);
  }
  if (unpricedCount > 0) {
    // 有任何一只缺价，整组市值/盈亏都不成立——缺席而不是拿已定价的那部分冒充全量。
    return {
      totalCost,
      unpricedCount,
      totalTodayPnl: null,
      totalTodayPnlPct: null,
    };
  }
  // 概览列表的空账户：0 是事实（没有持仓），不是伪造。
  const totalPnL = money(totalValue - totalCost);
  const totalPnLPct = totalCost > 0 ? clampPercentage(totalPnL / totalCost) : percentage(0);
  const todayComplete = items.every((item) => item.todayPnl !== null);
  const totalTodayPnl = todayComplete
    ? items.reduce((sum, item) => addMoney(sum, item.todayPnl ?? money(0)), money(0))
    : null;
  const previousTotalValue = totalTodayPnl === null ? 0 : money(totalValue - totalTodayPnl);
  const totalTodayPnlPct =
    totalTodayPnl !== null && previousTotalValue > 0
      ? clampPercentage(totalTodayPnl / previousTotalValue)
      : null;
  return {
    totalValue,
    totalCost,
    totalPnL,
    totalPnLPct,
    unpricedCount,
    totalTodayPnl,
    totalTodayPnlPct,
  };
};
