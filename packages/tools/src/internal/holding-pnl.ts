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
  marketValue: MoneySchema,
  cost: MoneySchema,
  pnl: MoneySchema,
  pnlPct: PercentageSchema,
});

export type HoldingPnl = z.infer<typeof HoldingPnlSchema>;

/** Percentage 合法区间 [-1, 10]；极端行情截断而不是炸 invariant。 */
const clampPercentage = (rate: number): Percentage => percentage(Math.min(10, Math.max(-1, rate)));

/**
 * 用现价丰富单条持仓。
 * 行情缺失时降级用成本价（mock 不会缺；真实 adapter 的故障由上层错误模型兜底）。
 */
export const enrichHolding = (
  holding: Holding,
  quote: Quote | undefined,
  stockName: string,
): HoldingPnl => {
  const currentPrice = quote?.close ?? holding.avgCost;
  const marketValue = money(currentPrice * holding.quantity);
  const cost = money(holding.avgCost * holding.quantity);
  const pnl = money(marketValue - cost);
  const pnlPct = cost > 0 ? clampPercentage(pnl / cost) : percentage(0);
  return { holding, stockName, currentPrice, marketValue, cost, pnl, pnlPct };
};

export interface PnlSummary {
  readonly totalValue: Money;
  readonly totalCost: Money;
  readonly totalPnL: Money;
  readonly totalPnLPct: Percentage;
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
  return { totalValue, totalCost, totalPnL, totalPnLPct };
};
