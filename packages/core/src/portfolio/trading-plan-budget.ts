import { z } from 'zod';
import type { AccountSnapshot } from '../entity/account-snapshot.js';
import type { Stock } from '../entity/stock.js';
import type { TradingPlan } from '../entity/trading-plan.js';
import { InvariantError } from '../error/index.js';

export interface TradingPlanBudgetLimits {
  readonly totalStockPct: number;
  readonly singleStockPct: number;
  readonly industryPct: number;
}

export const TradingPlanBudgetLimitsSchema = z.object({
  totalStockPct: z.number().finite().min(0).max(100),
  singleStockPct: z.number().finite().min(0).max(100),
  industryPct: z.number().finite().min(0).max(100),
});

export const DEFAULT_TRADING_PLAN_BUDGET_LIMITS: TradingPlanBudgetLimits = {
  totalStockPct: 80,
  singleStockPct: 15,
  industryPct: 30,
};

export interface TradingPlanBudgetAllocation {
  readonly planId: string;
  readonly stockId: string;
  readonly industry?: string;
  readonly targetPct: number;
  readonly incrementalPct: number;
  readonly status: 'included' | 'blocked' | 'unavailable';
  readonly reasons: readonly string[];
}

export const TradingPlanBudgetAllocationSchema = z.object({
  planId: z.string().min(1),
  stockId: z.string().min(1),
  industry: z.string().min(1).optional(),
  targetPct: z.number().finite().min(0).max(100),
  incrementalPct: z.number().finite().min(0).max(100),
  status: z.enum(['included', 'blocked', 'unavailable']),
  reasons: z.array(z.string()),
});

export interface TradingPlanBudgetResult {
  readonly accountId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly limits: TradingPlanBudgetLimits;
  readonly currentStockPct: number | null;
  readonly proposedStockPct: number | null;
  readonly availableStockPct: number | null;
  readonly totalStatus: 'passed' | 'blocked' | 'unavailable';
  readonly reasons: readonly string[];
  readonly allocations: readonly TradingPlanBudgetAllocation[];
}

export const TradingPlanBudgetResultSchema = z.object({
  accountId: z.string().min(1),
  snapshotId: z.string().min(1),
  snapshotVersion: z.number().int().positive(),
  limits: TradingPlanBudgetLimitsSchema,
  currentStockPct: z.number().finite().min(0).max(100).nullable(),
  proposedStockPct: z.number().finite().min(0).max(100).nullable(),
  availableStockPct: z.number().finite().min(0).max(100).nullable(),
  totalStatus: z.enum(['passed', 'blocked', 'unavailable']),
  reasons: z.array(z.string()),
  allocations: z.array(TradingPlanBudgetAllocationSchema),
});

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 把所有可能同时执行的 active plan 合并校验。未登记卖出不提前释放预算，
 * 因此只计算 enter/add 的正向增量；reduce/exit 仍能降低 proposed exposure。
 */
export const evaluateTradingPlanBudget = (input: {
  readonly snapshot: AccountSnapshot;
  readonly plans: readonly TradingPlan[];
  readonly stocks: ReadonlyMap<string, Stock>;
  readonly limits?: TradingPlanBudgetLimits;
}): TradingPlanBudgetResult => {
  const limits = input.limits ?? DEFAULT_TRADING_PLAN_BUDGET_LIMITS;
  if (
    input.snapshot.status !== 'complete' ||
    input.snapshot.totalAssets === null ||
    input.snapshot.stockMarketValue === null
  ) {
    return {
      accountId: input.snapshot.accountId,
      snapshotId: input.snapshot.id,
      snapshotVersion: input.snapshot.version,
      limits,
      currentStockPct: null,
      proposedStockPct: null,
      availableStockPct: null,
      totalStatus: 'unavailable',
      reasons: ['账户现金或持仓估值待核对，无法计算精确预算'],
      allocations: input.plans.map((plan) => ({
        planId: tradingPlanKey(plan),
        stockId: plan.stockId,
        ...(plan.industry === undefined ? {} : { industry: plan.industry }),
        targetPct: plan.position.targetPct ?? 0,
        incrementalPct: 0,
        status: 'unavailable' as const,
        reasons: ['account-snapshot-unavailable'],
      })),
    };
  }

  const totalAssets = input.snapshot.totalAssets;
  const currentStockPct = round((input.snapshot.stockMarketValue / totalAssets) * 100);
  const currentByStock = new Map<string, number>();
  const currentByIndustry = new Map<string, number>();
  let hasUnknownCurrentIndustry = false;
  for (const position of input.snapshot.positions) {
    const pct = (position.marketValue / totalAssets) * 100;
    currentByStock.set(position.stockId, round((currentByStock.get(position.stockId) ?? 0) + pct));
    const industry = position.industry ?? input.stocks.get(position.stockId)?.industry;
    if (industry !== undefined) {
      currentByIndustry.set(industry, round((currentByIndustry.get(industry) ?? 0) + pct));
    } else if (position.marketValue > 0) {
      hasUnknownCurrentIndustry = true;
    }
  }

  const allocations: Array<{
    planId: string;
    stockId: string;
    industry?: string;
    targetPct: number;
    incrementalPct: number;
    status: TradingPlanBudgetAllocation['status'];
    reasons: string[];
  }> = [];
  const plannedByStock = new Map<string, number>();
  const plannedByIndustry = new Map<string, number>();
  const reasons: string[] = [];
  for (const plan of input.plans) {
    const target = plan.position.targetPct;
    const current = currentByStock.get(plan.stockId) ?? 0;
    const incremental = target === null || current === null ? null : Math.max(0, target - current);
    const industry = plan.industry ?? input.stocks.get(plan.stockId)?.industry;
    const allocationReasons: string[] = [];
    let status: TradingPlanBudgetAllocation['status'] = 'included';
    if (target === null || current === null) {
      status = 'unavailable';
      allocationReasons.push('position-percentage-unavailable');
    }
    if (plan.position.constraintStatus === 'unavailable') {
      status = 'unavailable';
      allocationReasons.push('plan-constraint-unavailable');
    }
    const existingStock = currentByStock.get(plan.stockId) ?? 0;
    const stockIncrement = Math.max(0, target === null ? 0 : target - existingStock);
    if (
      (industry === undefined || hasUnknownCurrentIndustry) &&
      (plan.action === 'enter' || plan.action === 'add' || stockIncrement > 0)
    ) {
      status = 'unavailable';
      allocationReasons.push('industry-unavailable');
    }
    const sameStock = plannedByStock.get(plan.stockId) ?? 0;
    if (
      stockIncrement > 0 &&
      existingStock + sameStock + stockIncrement > limits.singleStockPct + 1e-9
    ) {
      status = 'blocked';
      allocationReasons.push('single-stock-limit');
    }
    if (industry !== undefined) {
      const existingIndustry = currentByIndustry.get(industry) ?? 0;
      const sameIndustry = plannedByIndustry.get(industry) ?? 0;
      if (
        stockIncrement > 0 &&
        existingIndustry + sameIndustry + stockIncrement > limits.industryPct + 1e-9
      ) {
        status = 'blocked';
        allocationReasons.push('industry-limit');
      }
    }
    const increment = incremental ?? 0;
    if (status === 'included') {
      plannedByStock.set(plan.stockId, round(sameStock + increment));
      if (industry !== undefined)
        plannedByIndustry.set(industry, round((plannedByIndustry.get(industry) ?? 0) + increment));
    } else if (allocationReasons.length > 0) {
      reasons.push(`${tradingPlanKey(plan)}: ${allocationReasons.join(',')}`);
    }
    allocations.push({
      planId: tradingPlanKey(plan),
      stockId: plan.stockId,
      ...(industry === undefined ? {} : { industry }),
      targetPct: target ?? 0,
      incrementalPct: round(increment),
      status,
      reasons: allocationReasons,
    });
  }

  const proposedStockPct = round(
    currentStockPct +
      [...allocations]
        .filter((allocation) => allocation.status === 'included')
        .reduce((sum, allocation) => sum + allocation.incrementalPct, 0),
  );
  if (proposedStockPct > limits.totalStockPct + 1e-9) {
    reasons.push(`total-stock-limit: ${proposedStockPct} > ${limits.totalStockPct}`);
    for (const allocation of allocations) {
      if (allocation.status === 'included' && allocation.incrementalPct > 0) {
        allocation.status = 'blocked';
        allocation.reasons = [...allocation.reasons, 'total-stock-limit'];
      }
    }
  }
  const includedProposed =
    currentStockPct +
    allocations
      .filter((allocation) => allocation.status === 'included')
      .reduce((sum, allocation) => sum + allocation.incrementalPct, 0);
  const hasBlockedAllocation = allocations.some((allocation) => allocation.status === 'blocked');
  const hasUnavailableAllocation = allocations.some(
    (allocation) => allocation.status === 'unavailable',
  );
  return {
    accountId: input.snapshot.accountId,
    snapshotId: input.snapshot.id,
    snapshotVersion: input.snapshot.version,
    limits,
    currentStockPct,
    proposedStockPct: round(includedProposed),
    availableStockPct: round(Math.max(0, limits.totalStockPct - includedProposed)),
    totalStatus: hasBlockedAllocation
      ? 'blocked'
      : hasUnavailableAllocation
        ? 'unavailable'
        : 'passed',
    reasons,
    allocations,
  };
};

const tradingPlanKey = (plan: TradingPlan): string => `${plan.id}:v${plan.version}`;

export const assertTradingPlanBudgetLimits = (limits: TradingPlanBudgetLimits): void => {
  if (limits.totalStockPct < 0 || limits.totalStockPct > 100)
    throw new InvariantError('totalStockPct must be within [0,100]');
  if (limits.singleStockPct < 0 || limits.singleStockPct > 100)
    throw new InvariantError('singleStockPct must be within [0,100]');
  if (limits.industryPct < 0 || limits.industryPct > 100)
    throw new InvariantError('industryPct must be within [0,100]');
};
