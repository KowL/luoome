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
} from '@luoome/core';
import { z } from 'zod';

/** 单条持仓 + 现价盈亏（list_holdings / get_holding 共用的输出元素）。 */
export const HoldingPnlSchema = z.object({
  holding: HoldingSchema,
  stockName: z.string().min(1),
  currentPrice: MoneySchema,
  /** 昨收（今日盈亏基准）；取不到为 null，今日盈亏同步为 null。 */
  previousClose: MoneySchema.nullable(),
  marketValue: MoneySchema,
  cost: MoneySchema,
  pnl: MoneySchema,
  pnlPct: PercentageSchema,
  /** 今日盈亏金额 = (现价 − 昨收) × 数量。 */
  todayPnl: MoneySchema.nullable(),
  /** 今日涨跌幅 = (现价 − 昨收) / 昨收。 */
  todayPnlPct: PercentageSchema.nullable(),
});

export type HoldingPnl = z.infer<typeof HoldingPnlSchema>;

/** Percentage 合法区间 [-1, 10]；极端行情截断而不是炸 invariant。 */
const clampPercentage = (rate: number): Percentage => percentage(Math.min(10, Math.max(-1, rate)));

/**
 * 用现价丰富单条持仓。
 * 行情缺失时降级用成本价；真实 adapter 的故障由上层错误模型兜底。
 * previousClose 缺失时今日盈亏为 null（调用方不要伪造基准）。
 */
export const enrichHolding = (
  holding: Holding,
  quote: Quote | undefined,
  stockName: string,
  previousClose: Money | null = null,
): HoldingPnl => {
  const currentPrice = quote?.close ?? holding.avgCost;
  const marketValue = money(currentPrice * holding.quantity);
  const cost = money(holding.avgCost * holding.quantity);
  const pnl = money(marketValue - cost);
  const pnlPct = cost > 0 ? clampPercentage(pnl / cost) : percentage(0);
  const todayPnl =
    previousClose === null ? null : money((currentPrice - previousClose) * holding.quantity);
  const todayPnlPct =
    previousClose === null || previousClose <= 0
      ? null
      : clampPercentage((currentPrice - previousClose) / previousClose);
  return {
    holding,
    stockName,
    currentPrice,
    previousClose,
    marketValue,
    cost,
    pnl,
    pnlPct,
    todayPnl,
    todayPnlPct,
  };
};

export interface PnlSummary {
  readonly totalValue: Money;
  readonly totalCost: Money;
  readonly totalPnL: Money;
  readonly totalPnLPct: Percentage;
  /** 今日盈亏合计；任一持仓缺昨收时为 null（不伪造部分合计）。 */
  readonly totalTodayPnl: Money | null;
  readonly totalTodayPnlPct: Percentage | null;
}

/** 汇总一组持仓盈亏（Money 运算一律走 core 的 branded 运算函数）。 */
export const summarizePnl = (items: readonly HoldingPnl[]): PnlSummary => {
  let totalValue = money(0);
  let totalCost = money(0);
  for (const item of items) {
    totalValue = addMoney(totalValue, item.marketValue);
    totalCost = addMoney(totalCost, item.cost);
  }
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
  return { totalValue, totalCost, totalPnL, totalPnLPct, totalTodayPnl, totalTodayPnlPct };
};
