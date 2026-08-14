import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

/**
 * risk-report（v0.3，plan-v0.2-v0.3 §3.5）：
 * list_holdings + 集中度 + VaR 估算 + market_outlook 拼成风险日报。
 */

export const RiskReportInput = z.object({
  accountId: z.uuid().optional(),
});

export type RiskReportInputT = z.infer<typeof RiskReportInput>;

export const RiskMetricSchema = z.object({
  name: z.string().min(1),
  /** 无足够历史事实时保持 null，不能用固定比例伪造 VaR。 */
  value: z.number().nullable(),
  unit: z.enum(['pct', 'ratio', 'cny', 'fraction']),
  level: z.enum(['low', 'mid', 'high', 'unavailable']),
  note: z.string().min(1),
});

export const RiskReportOutput = z.object({
  accountId: z.string(),
  totalValue: z.number(),
  holdingsCount: z.number().int().nonnegative(),
  metrics: z.array(RiskMetricSchema),
  marketSummary: z.string(),
  generatedAt: z.coerce.date(),
});

export type RiskReportOutputT = z.infer<typeof RiskReportOutput>;

const HHI_THRESHOLD_HIGH = 0.5;
const HHI_THRESHOLD_MID = 0.3;

interface ComputeState {
  accountId: string;
  totalValue: number;
  holdingsCount: number;
  metrics: Array<z.infer<typeof RiskMetricSchema>>;
}

const DAY_MS = 86_400_000;
const VAR_LOOKBACK_DAYS = 30;

/**
 * Historical 95% VaR from daily portfolio returns.
 * Returns are percentage points (e.g. -2 means -2%).
 * A null result is intentional when there is no usable historical fact.
 */
export const historicalVaR95 = (
  portfolioValue: number,
  dailyReturnPct: readonly number[],
): number | null => {
  if (!Number.isFinite(portfolioValue) || portfolioValue <= 0) return null;
  const returns = dailyReturnPct.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (returns.length === 0) return null;
  const position = (returns.length - 1) * 0.05;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  const quantile =
    lower === upper
      ? (returns[lower] ?? 0)
      : (returns[lower] ?? 0) + ((returns[upper] ?? 0) - (returns[lower] ?? 0)) * fraction;
  return Math.max(0, (-quantile / 100) * portfolioValue);
};

const riskLevelForVaR = (
  value: number | null,
  portfolioValue: number,
): 'low' | 'mid' | 'high' | 'unavailable' => {
  if (value === null || portfolioValue <= 0) return 'unavailable';
  const ratio = value / portfolioValue;
  return ratio >= 0.1 ? 'high' : ratio >= 0.05 ? 'mid' : 'low';
};

const stepHoldings: WorkflowStep = async (prev, ctx) => {
  const input = prev as RiskReportInputT;
  return ctx.tools.list_holdings.execute(
    input.accountId === undefined ? {} : { accountId: input.accountId },
  );
};

const stepCompute: WorkflowStep = async (prev, ctx) => {
  // 引擎已自动 unwrap ToolResult：prev 直接就是 list_holdings 的 data。
  // 若 stepHoldings 透传了 error result，则 prev 为 { ok: false, error }，
  // 此处把它当作 ComputeState 透传会被后续 stepMarket spread — 提前判别短路。
  const maybeError = prev as { ok?: unknown };
  if (maybeError.ok === false) return prev as unknown as ComputeState;
  const { accountId, totalValue, holdings } = prev as {
    accountId: string;
    totalValue: { readonly __brand: 'Money' } & number;
    holdings: readonly {
      holding: { stockId: string; quantity: number; avgCost: number; close?: number };
    }[];
  };
  const totalValueNum = Number(totalValue);
  const active = holdings.filter((h) => h.holding.quantity > 0);
  const weights = active.map((h) => {
    const v = Number(h.holding.close ?? h.holding.avgCost) * h.holding.quantity;
    return totalValueNum === 0 ? 0 : v / totalValueNum;
  });
  const hhi = weights.reduce((acc, w) => acc + w * w, 0);
  const top1 = weights.length > 0 ? Math.max(...weights) : 0;
  const sorted = [...weights].sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((a, b) => a + b, 0);

  // Use the existing account-performance Tool as the single fact path. It loads
  // real daily bars, applies cash flows/company actions, and exposes only complete
  // daily TWR observations. If history is unavailable, report null explicitly.
  const to = ctx.clock();
  const performance = await ctx.tools.get_account_performance.execute({
    accountId,
    from: new Date(to.getTime() - VAR_LOOKBACK_DAYS * DAY_MS),
    to,
  });
  const dailyReturns = performance.ok
    ? performance.data.valuation
        .map((day) => day.twrReturnPct)
        .filter((value): value is number => value !== undefined && Number.isFinite(value))
    : [];
  const historicalVaR = historicalVaR95(totalValueNum, dailyReturns);

  const classify = (v: number, high: number, mid: number): 'low' | 'mid' | 'high' =>
    v >= high ? 'high' : v >= mid ? 'mid' : 'low';

  const state: ComputeState = {
    accountId,
    totalValue: totalValueNum,
    holdingsCount: active.length,
    metrics: [
      {
        name: 'concentration_hhi',
        value: hhi,
        unit: 'fraction',
        level: classify(hhi, HHI_THRESHOLD_HIGH, HHI_THRESHOLD_MID),
        note: `Herfindahl 指数：≥${HHI_THRESHOLD_HIGH} 高 / ≥${HHI_THRESHOLD_MID} 中`,
      },
      {
        name: 'concentration_top1',
        value: top1,
        unit: 'fraction',
        level: classify(top1, 0.4, 0.25),
        note: '单只最大持仓权重',
      },
      {
        name: 'concentration_top3',
        value: top3,
        unit: 'fraction',
        level: classify(top3, 0.75, 0.5),
        note: '前 3 大持仓权重合计',
      },
      {
        name: 'var95_30d',
        value: historicalVaR,
        unit: 'cny',
        level: riskLevelForVaR(historicalVaR, totalValueNum),
        note:
          historicalVaR === null
            ? '最近 30 日没有足够完整估值收益，VaR 不可用'
            : `最近 30 日历史 95% VaR（有效收益样本 ${dailyReturns.length}）`,
      },
    ],
  };
  return state;
};

const stepMarket: WorkflowStep = async (prev, ctx) => {
  const state = prev as ComputeState;
  const r = await ctx.tools.market_outlook.execute({});
  if (!r.ok) {
    return { ...state, marketSummary: '（大盘数据暂不可用）' };
  }
  const avgChangePct = (r.data.advice.basedOn as { avgChangePct?: number }).avgChangePct ?? 0;
  return {
    ...state,
    marketSummary: `市场平均涨跌 ${(avgChangePct * 100).toFixed(2)}%（${r.data.advice.decision}）`,
  };
};

const stepFinalize: WorkflowStep = async (prev) => {
  const state = prev as ComputeState & { marketSummary: string };
  return RiskReportOutput.parse({
    accountId: state.accountId,
    totalValue: state.totalValue,
    holdingsCount: state.holdingsCount,
    metrics: state.metrics,
    marketSummary: state.marketSummary,
    generatedAt: new Date(),
  });
};

export const riskReportWorkflow = defineWorkflow<RiskReportInputT, RiskReportOutputT>({
  name: 'risk-report',
  description: '生成账户风险日报（集中度 + VaR + 大盘背景）',
  input: RiskReportInput,
  steps: [stepHoldings, stepCompute, stepMarket, stepFinalize],
});
