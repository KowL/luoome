import { z } from 'zod';
import type { AccountFacts } from '../entity/account-facts.js';
import type { Stock } from '../entity/stock.js';
import { type TradingPlan, tradingPlanVersionId } from '../entity/trading-plan.js';
import { InvariantError } from '../error/index.js';

export interface TradingPlanBudgetLimits {
  readonly totalStockPct: number;
  readonly singleStockPct: number;
}

export const TradingPlanBudgetLimitsSchema = z.object({
  totalStockPct: z.number().finite().min(0).max(100),
  singleStockPct: z.number().finite().min(0).max(100),
});

/**
 * 组合预算默认上限。
 *
 * 总仓位上限取 100%：账户已经用满或接近用满时，80% 这类"建议上限"会让任何增量计划永久
 * 停留在草案（用户 2026-09-20 决定）。保留这条校验是为了挡住"多个计划的建议仓位合计超过
 * 账户总资产"这种不可执行状态（不新增融资路径），而不是限制用户实际愿意持有的比例。
 * 单只股票上限取 30%（用户同日决定，原 15%）：集中度由用户自行判断，超过上限的持仓仍可减仓，
 * 但不能继续加仓。
 */
export const DEFAULT_TRADING_PLAN_BUDGET_LIMITS: TradingPlanBudgetLimits = {
  totalStockPct: 100,
  singleStockPct: 30,
};

export interface TradingPlanBudgetAllocation {
  readonly planId: string;
  readonly stockId: string;
  readonly industry?: string | undefined;
  /** 计划声明的目标仓位区间（百分点）；预算按 max 占用，min 仅用于披露。 */
  readonly targetPctMin: number;
  readonly targetPctMax: number;
  readonly incrementalPct: number;
  readonly status: 'included' | 'blocked' | 'unavailable';
  readonly reasons: readonly string[];
}

export const TradingPlanBudgetAllocationSchema = z.object({
  planId: z.string().min(1),
  stockId: z.string().min(1),
  industry: z.string().min(1).optional(),
  targetPctMin: z.number().finite().min(0).max(100),
  targetPctMax: z.number().finite().min(0).max(100),
  incrementalPct: z.number().finite().min(0).max(100),
  status: z.enum(['included', 'blocked', 'unavailable']),
  reasons: z.array(z.string()),
});

export interface TradingPlanBudgetResult {
  readonly accountId: string;
  readonly asOf: Date;
  readonly digest: string;
  readonly limits: TradingPlanBudgetLimits;
  readonly currentStockPct: number | null;
  readonly proposedStockPct: number | null;
  readonly availableStockPct: number | null;
  /** 全部计划按 min 声明的合计（读侧派生，不持久化）；不可用时为 null。 */
  readonly minTotalPct: number | null;
  /** 全部计划按 max 声明的合计（预算占用口径）；不可用时为 null。 */
  readonly maxTotalPct: number | null;
  readonly totalStatus: 'passed' | 'blocked' | 'unavailable';
  readonly reasons: readonly string[];
  readonly allocations: readonly TradingPlanBudgetAllocation[];
}

export const TradingPlanBudgetResultSchema = z.object({
  accountId: z.string().min(1),
  asOf: z.coerce.date(),
  digest: z.string().min(8),
  limits: TradingPlanBudgetLimitsSchema,
  currentStockPct: z.number().finite().min(0).max(100).nullable(),
  proposedStockPct: z.number().finite().min(0).max(100).nullable(),
  availableStockPct: z.number().finite().min(0).max(100).nullable(),
  minTotalPct: z.number().finite().min(0).max(100).nullable(),
  maxTotalPct: z.number().finite().min(0).max(100).nullable(),
  totalStatus: z.enum(['passed', 'blocked', 'unavailable']),
  reasons: z.array(z.string()),
  allocations: z.array(TradingPlanBudgetAllocationSchema),
});

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 把所有可能同时执行的 active plan 合并校验。未登记卖出不提前释放预算，
 * 因此只计算 enter/add 的正向增量；reduce/exit 仍能降低 proposed exposure。
 * 账户输入是当前事实（现金字段 + 持仓 × 行情），不再依赖手工核对的账户快照。
 */
export const evaluateTradingPlanBudget = (input: {
  readonly facts: AccountFacts;
  readonly plans: readonly TradingPlan[];
  readonly stocks: ReadonlyMap<string, Stock>;
  readonly limits?: TradingPlanBudgetLimits;
}): TradingPlanBudgetResult => {
  const limits = input.limits ?? DEFAULT_TRADING_PLAN_BUDGET_LIMITS;
  if (
    input.facts.status !== 'complete' ||
    input.facts.totalAssets === null ||
    input.facts.stockMarketValue === null
  ) {
    return {
      accountId: input.facts.accountId,
      asOf: input.facts.asOf,
      digest: input.facts.digest,
      limits,
      currentStockPct: null,
      proposedStockPct: null,
      availableStockPct: null,
      minTotalPct: null,
      maxTotalPct: null,
      totalStatus: 'unavailable',
      reasons: ['账户事实不可用（现金待核对或持仓缺少合格行情），无法计算精确预算'],
      allocations: input.plans.map((plan) => ({
        planId: tradingPlanKey(plan),
        stockId: plan.stockId,
        ...(plan.industry === undefined ? {} : { industry: plan.industry }),
        targetPctMin: plan.position.targetPctRange?.min ?? 0,
        targetPctMax: plan.position.targetPctRange?.max ?? 0,
        incrementalPct: 0,
        status: 'unavailable' as const,
        reasons: ['account-snapshot-unavailable'],
      })),
    };
  }

  const totalAssets = input.facts.totalAssets;
  const currentStockPct = round((input.facts.stockMarketValue / totalAssets) * 100);
  const currentByStock = new Map<string, number>();
  for (const position of input.facts.positions) {
    const pct = (position.marketValue / totalAssets) * 100;
    currentByStock.set(position.stockId, round((currentByStock.get(position.stockId) ?? 0) + pct));
  }

  const allocations: Array<{
    planId: string;
    stockId: string;
    industry?: string;
    targetPctMin: number;
    targetPctMax: number;
    incrementalPct: number;
    status: TradingPlanBudgetAllocation['status'];
    reasons: string[];
  }> = [];
  const plannedByStock = new Map<string, number>();
  const reasons: string[] = [];
  let minClaim = 0;
  let maxClaim = 0;
  for (const plan of input.plans) {
    const current = currentByStock.get(plan.stockId) ?? 0;
    const range = plan.position.targetPctRange;
    // 维持计划不随行情重写：计划自身记录的目标仍是"保持"，或区间整体不高于当前行情仓位时，
    // 都不把旧百分比解释成新的加仓额度。
    const recordedMaintain =
      range !== null &&
      range.min === range.max &&
      plan.position.currentPct !== null &&
      range.min === plan.position.currentPct;
    const belowLive = range !== null && range.max <= current + 1e-9;
    const maintainsPosition =
      (plan.action === 'hold' ||
        (plan.action === 'observe' && (plan.position.currentPct ?? 0) > 0)) &&
      (recordedMaintain || belowLive);
    const target = maintainsPosition ? current : (range?.max ?? null);
    const sameStock = plannedByStock.get(plan.stockId) ?? 0;
    // 多个计划的目标仓位都表示执行后的同一只股票仓位，按最高目标（max）预留一次。
    const incremental = target === null ? null : Math.max(0, target - current - sameStock);
    const incrementalMin =
      maintainsPosition || range === null ? 0 : Math.max(0, range.min - current - sameStock);
    const industry = plan.industry ?? input.stocks.get(plan.stockId)?.industry;
    const allocationReasons: string[] = [];
    let status: TradingPlanBudgetAllocation['status'] = 'included';
    if (target === null) {
      status = 'unavailable';
      allocationReasons.push('position-percentage-unavailable');
    }
    if (plan.position.constraintStatus === 'unavailable') {
      status = 'unavailable';
      allocationReasons.push('plan-constraint-unavailable');
    }
    if (
      incremental !== null &&
      incremental > 0 &&
      current + sameStock + incremental > limits.singleStockPct + 1e-9
    ) {
      status = 'blocked';
      allocationReasons.push('single-stock-limit');
    }
    const increment = incremental ?? 0;
    if (status === 'included') {
      plannedByStock.set(plan.stockId, round(sameStock + increment));
    } else if (allocationReasons.length > 0) {
      reasons.push(`${tradingPlanKey(plan)}: ${allocationReasons.join(',')}`);
    }
    allocations.push({
      planId: tradingPlanKey(plan),
      stockId: plan.stockId,
      ...(industry === undefined ? {} : { industry }),
      targetPctMin: maintainsPosition ? current : (range?.min ?? 0),
      targetPctMax: maintainsPosition ? current : (range?.max ?? 0),
      incrementalPct: round(increment),
      status,
      reasons: allocationReasons,
    });
    minClaim += incrementalMin;
    maxClaim += increment;
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
    accountId: input.facts.accountId,
    asOf: input.facts.asOf,
    digest: input.facts.digest,
    limits,
    currentStockPct,
    proposedStockPct: round(includedProposed),
    availableStockPct: round(Math.max(0, limits.totalStockPct - includedProposed)),
    // 合计口径：min/max 合计覆盖**全部**分配（含被 blocked 的候选），用于解释"这份提案整体
    // 占多少"；`proposedStockPct` 仍只统计 included，保持原有"实际可执行"语义。
    minTotalPct: round(currentStockPct + minClaim),
    maxTotalPct: round(currentStockPct + maxClaim),
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
};

/**
 * draft 冲突处置：预算冲突只记录 constraintStatus/constraintReasons，不阻止保存。
 * 供 save_trading_plan 与生成器共用，避免两处漂移。
 */
export const applyTradingPlanBudgetConstraint = (
  plan: TradingPlan,
  budget: TradingPlanBudgetResult,
): TradingPlan => {
  if (plan.status !== 'draft') return plan;
  const allocation = budget.allocations.find((item) => item.planId === tradingPlanVersionId(plan));
  const blocked = budget.totalStatus === 'blocked' || allocation?.status === 'blocked';
  if (!blocked) return plan;
  const reasons = [
    ...new Set([
      ...plan.position.constraintReasons,
      ...(allocation?.reasons ?? []),
      ...budget.reasons,
    ]),
  ];
  return {
    ...plan,
    position: {
      ...plan.position,
      constraintStatus: 'blocked',
      constraintReasons: reasons.length === 0 ? ['budget-blocked'] : reasons,
    },
  };
};

/**
 * draft → active 闸门：预算超限或不可用时抛 InvariantError。
 * 消息同时给出 min/max 合计，便于按保守口径复算。
 */
export const assertTradingPlanBudgetAllowsActivation = (
  plan: TradingPlan,
  budget: TradingPlanBudgetResult,
): void => {
  if (plan.status !== 'active') return;
  const versionId = tradingPlanVersionId(plan);
  const allocation = budget.allocations.find((item) => item.planId === versionId);
  if (budget.totalStatus === 'unavailable' || allocation?.status === 'unavailable') {
    throw new InvariantError(`计划 ${versionId} 的预算不可用，不能激活`);
  }
  const singleStockBlocked =
    allocation !== undefined &&
    allocation.status === 'blocked' &&
    allocation.reasons.includes('single-stock-limit');
  if (budget.totalStatus !== 'blocked' && allocation?.status !== 'blocked') return;
  const detail = singleStockBlocked
    ? `；单股上限：max ${allocation.targetPctMax} > ${budget.limits.singleStockPct}（min ${allocation.targetPctMin}）`
    : '';
  throw new InvariantError(
    `计划 ${versionId} 超出组合预算：max 合计 ${budget.maxTotalPct} > ${budget.limits.totalStockPct}（min 合计 ${budget.minTotalPct}）${detail}`,
  );
};
