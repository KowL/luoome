import {
  isHoliday,
  isWeekend,
  MIN_TWR_SAMPLE_TRADING_DAYS,
  MoneySchema,
  money,
  PortfolioMetricReasonSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { latestQualifiedQuote, latestQuoteWithinDays } from './account-facts.js';

/**
 * 组合风险只读工具（REQ-M3-06）。
 *
 * 三条硬约束（Lead 裁定 R1–R5，见 output/dsh-brainstorm/t06-portfolio-risk-plan.md）：
 * 1. **不取外部行情、不写库**：只读 `quote` / `holding` / `tradingPlan` /
 *    `portfolioPerformanceSnapshot` 四类已落库事实。缺价就是缺价，不回退 `avgCost`，
 *    也不触发任何 adapter 调用。
 * 2. **「基准」分三列**：`valuation.*` 是口径分母（`holdings-value` 给集中度、
 *    `total-assets` 给上限判定），`benchmark` 是市场基准（沪深300，本轮只声明身份、
 *    计算留给 M3-07 的 `get_account_performance`），`limitCheck.basis` 是
 *    `targetPctRange.max`。三者同词不同义，绝不合并。
 * 3. **可用性优先于数字**：非 `available` / `partial` 的分支**没有 `value` 键**
 *    （不是 `null`、不是 `0`），与 `portfolio-performance.ts` 的既有硬约定一致。
 *    `level` 只表示风险等级，不兼任可用性。
 */

const DAY_MS = 86_400_000;

/** VaR 目标样本：最近 30 个有效日收益率（需 31 个连续交易日估值日才有 30 个收益）。 */
export const VAR_REQUIRED_RETURNS = 30;

/**
 * VaR 最低样本：直接复用 `MIN_TWR_SAMPLE_TRADING_DAYS`（20），不新造第二个
 * 「样本够不够」阈值。少于该数量只报 `insufficient`，不给数字——旧实现允许 1 个
 * 收益率算出「VaR」，那是噪声冒充结论。
 */
export const VAR_MIN_RETURNS = MIN_TWR_SAMPLE_TRADING_DAYS;

/** 超限判定容差：与仓内 `round2` 的量级对齐，避免浮点边界把「刚好等于上限」判成超限。 */
export const LIMIT_BREACH_TOLERANCE = 1e-6;

/** 参考报价回看窗口：与 `account-facts` 的参考估值口径一致（30 天）。 */
const REFERENCE_QUOTE_LOOKBACK_DAYS = 30;

/**
 * 缺价/参考价的可操作补法。与 VaR 那条「点名缺什么 + 怎么补」同一标准：
 * 只读工具不刷新行情，代价必须写成用户能执行的一步，而不是一句「不可用」。
 */
const QUOTE_REMEDY = '补法：先运行 batch_quote（external 面）刷新报价后重试';

/** 输出形状版本：`value` 从「可为 null」改为「键缺席」属破坏性变更，外部脚本据此判定。 */
export const PORTFOLIO_RISK_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// 纯数学（从 workflows/risk-report 下沉的唯一实现）
// ---------------------------------------------------------------------------

/** 升序数组的线性插值分位（`p` 为 0–1）。空数组返回 undefined。 */
export const lowerTailQuantile = (sortedAsc: readonly number[], p: number): number | undefined => {
  if (sortedAsc.length === 0) return undefined;
  const position = (sortedAsc.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  const low = sortedAsc[lower];
  const high = sortedAsc[upper];
  if (low === undefined) return undefined;
  if (high === undefined) return low;
  return low + (high - low) * fraction;
};

/**
 * 历史 95% VaR，**百分点**口径（正数 = 损失）。
 *
 * 两处口径修正（Lead 裁定的既有缺陷）：
 * - 样本少于 `minReturns` 返回 undefined，由调用方映射为 `insufficient`；
 *   达到门槛后 VaR=0 是合法值（样本里确实没有亏损尾部），保留，不伪造成 `unavailable`。
 * - 不再由本函数乘 `portfolioValue`：金额口径是派生量（`var95Cny`），
 *   依赖总资产分母，必须在分母可用时才算。
 */
export const historicalVaR95Pct = (
  returnsPct: readonly number[],
  minReturns: number = VAR_MIN_RETURNS,
): number | undefined => {
  const finite = returnsPct.filter((value) => Number.isFinite(value));
  if (finite.length < minReturns) return undefined;
  const sorted = [...finite].sort((left, right) => left - right);
  const quantile = lowerTailQuantile(sorted, 0.05);
  if (quantile === undefined) return undefined;
  return Math.max(0, -quantile);
};

/** Herfindahl 指数：Σw²，权重为比例（和为 1）。 */
export const herfindahlIndex = (weights: readonly number[]): number =>
  weights.reduce((sum, weight) => sum + weight * weight, 0);

/** 前 N 大权重合计。 */
export const topNShare = (weights: readonly number[], n: number): number =>
  [...weights]
    .sort((left, right) => right - left)
    .slice(0, Math.max(0, n))
    .reduce((sum, weight) => sum + weight, 0);

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export const GetPortfolioRiskInput = z.object({
  accountId: z.string().min(1).optional(),
  /** PIT 时点；缺省 `ctx.clock()`。集中度按该时刻的持仓与已落库报价计算。 */
  asOf: z.coerce.date().optional(),
  /** 集中度前 N（1..10，默认 3）。 */
  topN: z.coerce.number().int().min(1).max(10).default(3),
});
export type GetPortfolioRiskInputT = z.input<typeof GetPortfolioRiskInput>;

// ---------------------------------------------------------------------------
// 输出 schema
// ---------------------------------------------------------------------------

/**
 * 本工具的可用性词汇 = core 的 `PortfolioMetricStatusSchema` + `partial`。
 *
 * `partial` 是 Lead 裁定的缺陷修法：部分持仓未定价时，集中度仍在**已定价子集**上计算，
 * 但状态降级并把覆盖率写进 `coverage`——数字是真的，只是分母不完整。`insufficient` /
 * `unavailable` 才表示「不给数字」，这两个分支**没有 `value` 键**。
 */
export const RiskMetricStatusSchema = z.enum([
  'available',
  'partial',
  'insufficient',
  'unavailable',
]);

export const RiskLevelSchema = z.enum(['low', 'mid', 'high']);

export const RiskMetricNameSchema = z.enum([
  'concentration_hhi',
  'concentration_top1',
  'concentration_topN',
  'var95Pct',
  'var95Cny',
]);

/**
 * 指标窗口。时点指标（集中度）与收益序列指标（VaR）都用这一个形状：
 * - `point-in-time`：`from === to === asOf`，`returnsCount` / `requiredReturns` /
 *   `minReturns` / `gapTradingDays` 全为 0（没有收益样本可谈）。
 * - `returns`：`from`/`to` 是样本首末估值日，其余字段回答「30 个样本里实际有几个」。
 */
export const RiskWindowSchema = z.object({
  kind: z.enum(['point-in-time', 'returns']),
  from: z.coerce.date(),
  to: z.coerce.date(),
  returnsCount: z.number().int().nonnegative(),
  requiredReturns: z.number().int().nonnegative(),
  minReturns: z.number().int().nonnegative(),
  /** 窗口内应产出却缺失的交易日数（跨停牌/快照断档），0 = 连续。 */
  gapTradingDays: z.number().int().nonnegative(),
});
export type RiskWindow = z.infer<typeof RiskWindowSchema>;

const RiskMetricBase = {
  name: RiskMetricNameSchema,
  note: z.string().min(1),
};

/**
 * 逐指标可用性。三种「不给结论」的分支各有明确语义：
 *
 * - `available`：`value` + `level` 都在（数字与结论都成立）。
 * - `partial`：**只有 `value`，没有 `level`**。数字是真的，但它是在**已定价子集**上
 *   算出来的（权重重归一后和为 1），把子集集中度当成组合集中度会系统性放大风险等级
 *   （2 只票 1 只未定价 → HHI 恒为 1.0 / 高）。所以：有数字、无结论、缺口必披露。
 * - `insufficient` / `unavailable`：**没有 `value` 键**——下游拿不到可以 `?? 0` 的东西。
 *
 * **四个分支全部 `.strict()`**：Zod object 默认会静默 strip 未知键，于是「有人给某个分支
 * 多加了一个键」（例如把 `level` 加回 `partial`）会变成无声无息、测试也抓不到的回归。
 * 只堵一个分支等于给下一个 bug 留门，所以统一收紧——多出任何键都是硬错误。
 */
export const RiskMetricSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...RiskMetricBase,
      status: z.literal('available'),
      value: z.number().finite(),
      unit: z.enum(['fraction', 'pct-point', 'cny']),
      level: RiskLevelSchema,
      dataAsOf: z.coerce.date(),
      window: RiskWindowSchema,
    })
    .strict(),
  z
    .object({
      ...RiskMetricBase,
      status: z.literal('partial'),
      value: z.number().finite(),
      unit: z.enum(['fraction', 'pct-point', 'cny']),
      dataAsOf: z.coerce.date(),
      window: RiskWindowSchema,
      /** 部分持仓未定价：数字只在已定价子集上成立，覆盖率见顶层 `coverage`。 */
      coverageGap: z.object({
        holdingsCount: z.number().int().nonnegative(),
        pricedCount: z.number().int().nonnegative(),
        unpricedStockIds: z.array(z.string().min(1)),
      }),
    })
    .strict(),
  z
    .object({
      ...RiskMetricBase,
      status: z.literal('insufficient'),
      reason: PortfolioMetricReasonSchema,
      window: RiskWindowSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...RiskMetricBase,
      status: z.literal('unavailable'),
      reason: PortfolioMetricReasonSchema,
      missingStockIds: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);
export type RiskMetric = z.infer<typeof RiskMetricSchema>;

const DenominatorBasisSchema = z.enum(['holdings-value', 'total-assets']);

/**
 * 口径分母。**两个 basis 都输出**：集中度用 `holdings-value`（现金不承担价格风险，
 * 计入会机械性压低 HHI），上限判定用 `total-assets`（与 `singleStockPct` 同口径，含现金）。
 *
 * `partial` 同样表示「值只在已定价子集上成立」；`unavailable` 分支没有 `value` 键。
 */
export const PortfolioDenominatorSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    basis: DenominatorBasisSchema,
    value: MoneySchema,
    dataAsOf: z.coerce.date(),
    note: z.string().min(1),
  }),
  z.object({
    status: z.literal('partial'),
    basis: DenominatorBasisSchema,
    value: MoneySchema,
    dataAsOf: z.coerce.date(),
    note: z.string().min(1),
    unpricedStockIds: z.array(z.string().min(1)),
  }),
  z.object({
    status: z.literal('unavailable'),
    basis: DenominatorBasisSchema,
    reason: PortfolioMetricReasonSchema,
    missingStockIds: z.array(z.string().min(1)),
    note: z.string().min(1),
  }),
]);
export type PortfolioDenominator = z.infer<typeof PortfolioDenominatorSchema>;

export const PositionRiskSchema = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  quantity: z.number().int().nonnegative(),
  /** 真实报价；缺价时**缺席**，绝不回退 `avgCost`。 */
  price: MoneySchema.optional(),
  /** `qualified` = 达到决策资格；`reference` = 30 天内的非合格报价；`missing` = 无任何报价。 */
  priceStatus: z.enum(['qualified', 'reference', 'missing']),
  priceObservedAt: z.coerce.date().optional(),
  marketValue: MoneySchema.optional(),
  /** 集中度分母下的权重（已定价子集，和为 1）；分母不可用时缺席。 */
  weightOfHoldingsPct: z.number().finite().nonnegative().optional(),
  /** 上限判定分母下的权重（百分点）；仅当总资产分母 `available` 时给出。 */
  weightOfTotalAssetsPct: z.number().finite().nonnegative().optional(),
  /** 上限依据：无 active TradingPlan 或缺区间时**缺席**（不是 0、不是 100）。 */
  limitMaxPct: z.number().finite().min(0).max(100).optional(),
  limitSource: z.enum(['trading-plan', 'none']),
  limitPlanVersion: z.number().int().positive().optional(),
  breach: z.boolean().optional(),
  excessPct: z.number().finite().optional(),
});
export type PositionRisk = z.infer<typeof PositionRiskSchema>;

export const PortfolioRiskCoverageSchema = z.object({
  holdingsCount: z.number().int().nonnegative(),
  pricedCount: z.number().int().nonnegative(),
  unpricedCount: z.number().int().nonnegative(),
  /** 覆盖率（只数口径，0–100）。值口径需要价格，会循环依赖，故不采用。 */
  pricedRatioPct: z.number().finite().min(0).max(100),
  unpricedStockIds: z.array(z.string().min(1)),
});

export const PortfolioRiskLimitCheckSchema = z.object({
  basis: z.literal('trading-plan-position-target-pct-range-max'),
  /**
   * `evaluated` 全部持仓都有上限依据 / `partial` 部分有 / `no-basis` 一个都没有
   * （缺省语义 = 无上限依据，**不是合规**）/ `not-evaluated` 总资产分母不完整或空仓，
   * 无法计算权重。
   */
  status: z.enum(['evaluated', 'partial', 'no-basis', 'not-evaluated']),
  evaluated: z.number().int().nonnegative(),
  skippedNoPlan: z.number().int().nonnegative(),
  breaches: z.array(
    z.object({
      stockId: z.string().min(1),
      weightPct: z.number().finite(),
      maxPct: z.number().finite(),
      excessPct: z.number().finite(),
      planVersion: z.number().int().positive(),
    }),
  ),
  note: z.string().min(1),
});

export const GetPortfolioRiskOutput = z.object({
  /** 输出形状版本；`value` 从「可为 null」改为「键缺席」是破坏性变更，外部脚本据此判定。 */
  schemaVersion: z.literal(PORTFOLIO_RISK_SCHEMA_VERSION),
  accountId: z.string().min(1),
  /** PIT 时点：持仓与报价的口径时刻。 */
  asOf: z.coerce.date(),
  /** 保守口径：参与计算的序列里**最早**的观测时间；没有任何事实时缺席（不给 `new Date()`）。 */
  dataAsOf: z.coerce.date().optional(),
  coverage: PortfolioRiskCoverageSchema,
  valuation: z.object({
    cashBalance: MoneySchema,
    holdingsValue: PortfolioDenominatorSchema,
    totalAssets: PortfolioDenominatorSchema,
  }),
  benchmark: z.object({
    stockId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    /** 本轮固定 `not-evaluated`：基准 TWR / 超额由 M3-07 的 `get_account_performance` 负责。 */
    status: z.enum(['available', 'unavailable', 'not-evaluated']),
    reason: PortfolioMetricReasonSchema.optional(),
    note: z.string().min(1),
  }),
  metrics: z.array(RiskMetricSchema),
  positions: z.array(PositionRiskSchema),
  limitCheck: PortfolioRiskLimitCheckSchema,
  warnings: z.array(z.string().min(1)),
});
export type GetPortfolioRiskOutputT = z.infer<typeof GetPortfolioRiskOutput>;

// ---------------------------------------------------------------------------
// 交易日工具
// ---------------------------------------------------------------------------

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const dayToDate = (key: string): Date => new Date(`${key}T00:00:00.000Z`);
const isTradingDay = (date: Date): boolean => !isWeekend(date) && !isHoliday(date);

/** 从 `to` 往回数 `tradingDays` 个交易日（含 `to` 当日若有交易日）。 */
const lookbackStart = (to: Date, tradingDays: number): Date => {
  let cursor = new Date(to);
  let counted = isTradingDay(cursor) ? 1 : 0;
  while (counted < tradingDays) {
    cursor = new Date(cursor.getTime() - DAY_MS);
    if (isTradingDay(cursor)) counted += 1;
  }
  return cursor;
};

/** 统计 `(fromKey, toKey]` 内的交易日数（`fromKey` 当日不计）。 */
const tradingDaysAfter = (fromKey: string, toKey: string): number => {
  let count = 0;
  let cursor = new Date(dayToDate(fromKey).getTime() + DAY_MS);
  const end = dayToDate(toKey).getTime();
  while (cursor.getTime() <= end) {
    if (isTradingDay(cursor)) count += 1;
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return count;
};

// ---------------------------------------------------------------------------
// 事实读取（全部只读，零 adapter 调用）
// ---------------------------------------------------------------------------

interface PricedPosition {
  readonly stockId: string;
  readonly quantity: number;
  readonly price: number;
  readonly observedAt: Date;
  readonly priceStatus: 'qualified' | 'reference';
}

interface PositionValuation {
  readonly priced: readonly PricedPosition[];
  readonly unpriced: readonly { readonly stockId: string; readonly quantity: number }[];
}

/**
 * 逐持仓定价：合格报价优先，30 天内非合格报价降级为 `reference`，都没有就是 `missing`。
 * **绝不**用 `avgCost` 顶替（`holding-pnl.ts` 的历史缺陷正是这样伪造了 HHI 分母）。
 */
const valuePositions = async (
  ctx: ToolContext,
  holdings: readonly { readonly stockId: string; readonly quantity: number }[],
  asOf: Date,
): Promise<PositionValuation> => {
  const priced: PricedPosition[] = [];
  const unpriced: { stockId: string; quantity: number }[] = [];
  for (const holding of holdings) {
    const qualified = await latestQualifiedQuote(ctx, holding.stockId, asOf);
    if (qualified !== null) {
      priced.push({
        stockId: holding.stockId,
        quantity: holding.quantity,
        price: qualified.close,
        observedAt: qualified.observedAt,
        priceStatus: 'qualified',
      });
      continue;
    }
    const reference = await latestQuoteWithinDays(
      ctx,
      holding.stockId,
      asOf,
      REFERENCE_QUOTE_LOOKBACK_DAYS,
    );
    if (reference !== null) {
      priced.push({
        stockId: holding.stockId,
        quantity: holding.quantity,
        price: reference.close,
        observedAt: reference.observedAt,
        priceStatus: 'reference',
      });
      continue;
    }
    unpriced.push({ stockId: holding.stockId, quantity: holding.quantity });
  }
  return { priced, unpriced };
};

interface ValuationDayFact {
  readonly key: string;
  readonly completeness: 'complete' | 'partial' | 'unavailable';
  readonly twrReturnPct?: number;
}

/**
 * VaR 的收益序列只来自**已落库绩效快照**（Lead 裁定 R3）。
 *
 * 工具内自己按「当前权重 × 历史个股收益」求和会犯两个错：① 用今日权重套历史收益
 * （前视 + 权重漂移）；② 忽略区间内的买卖、分红与现金流。账户级 TWR 已经在
 * `calculatePortfolioPerformance` 里正确处理了这些，并保证 `twrReturnPct` 只出现在
 * 前后两日都完整的估值日上。错数字比 `unavailable` 危险，所以这里不重算。
 */
const readValuationDays = async (
  ctx: ToolContext,
  accountId: string,
  asOf: Date,
): Promise<readonly ValuationDayFact[]> => {
  const from = lookbackStart(asOf, VAR_REQUIRED_RETURNS + 1);
  const snapshots = await ctx.repos.portfolioPerformanceSnapshot.listByAccountAndRange(
    accountId,
    from,
    asOf,
  );
  const byDay = new Map<string, ValuationDayFact>();
  // 仓储按 calculatedAt 倒序返回：先到的是最新 vintage，同一天不覆盖。
  for (const snapshot of snapshots) {
    for (const day of snapshot.performance.valuation) {
      if (day.date.getTime() > asOf.getTime()) continue;
      const key = isoDay(day.date);
      if (byDay.has(key)) continue;
      byDay.set(key, {
        key,
        completeness: day.completeness,
        ...(day.twrReturnPct === undefined ? {} : { twrReturnPct: day.twrReturnPct }),
      });
    }
  }
  return [...byDay.values()].sort((left, right) => left.key.localeCompare(right.key));
};

// ---------------------------------------------------------------------------
// 逐指标计算
// ---------------------------------------------------------------------------

const concentrationLevel = (value: number, high: number, mid: number): 'low' | 'mid' | 'high' =>
  value >= high ? 'high' : value >= mid ? 'mid' : 'low';

const VAR_MISSING_NOTE =
  '缺少已落库绩效快照的有效日收益样本（valuation[].twrReturnPct）；' +
  '补法：先运行 get_account_performance（external 面）或盘后绩效快照任务 ' +
  'snapshot-account-performance，落库后本工具只读复用，不自行重算收益序列';

interface ConcentrationInput {
  readonly asOf: Date;
  readonly weights: readonly number[];
  readonly topN: number;
  readonly coverage: {
    readonly holdingsCount: number;
    readonly pricedCount: number;
    readonly unpricedStockIds: readonly string[];
  };
  readonly dataAsOf: Date | undefined;
}

const buildConcentrationMetrics = (input: ConcentrationInput): RiskMetric[] => {
  const { asOf, weights, topN, coverage, dataAsOf } = input;
  const window: RiskWindow = {
    kind: 'point-in-time',
    from: asOf,
    to: asOf,
    returnsCount: 0,
    requiredReturns: 0,
    minReturns: 0,
    gapTradingDays: 0,
  };
  const missing = [...coverage.unpricedStockIds];
  const noHoldings = coverage.holdingsCount === 0;
  const status = noHoldings
    ? 'unavailable'
    : coverage.pricedCount === 0
      ? 'unavailable'
      : missing.length > 0
        ? 'partial'
        : 'available';
  const reason = noHoldings ? 'no-holdings' : 'coverage-gap';
  const names = [
    { name: 'concentration_hhi' as const, value: herfindahlIndex(weights), high: 0.5, mid: 0.3 },
    {
      name: 'concentration_top1' as const,
      value: weights.length === 0 ? 0 : Math.max(...weights),
      high: 0.4,
      mid: 0.25,
    },
    { name: 'concentration_topN' as const, value: topNShare(weights, topN), high: 0.75, mid: 0.5 },
  ];
  return names.map((item): RiskMetric => {
    if (status === 'unavailable') {
      return {
        status: 'unavailable',
        name: item.name,
        reason,
        ...(noHoldings ? {} : { missingStockIds: missing }),
        note: noHoldings
          ? '账户没有未平仓持仓，集中度无从计算（不是 HHI=0）'
          : `所有持仓都没有可用报价，集中度分母为空；缺价不填 0，也不回退成本价。${QUOTE_REMEDY}`,
      };
    }
    const base = {
      name: item.name,
      value: round4(item.value),
      unit: 'fraction' as const,
      dataAsOf: dataAsOf ?? asOf,
      window,
      note:
        item.name === 'concentration_hhi'
          ? 'Herfindahl 指数：≥0.5 高 / ≥0.3 中；分母为持仓市值（不含现金）'
          : item.name === 'concentration_top1'
            ? '单只最大持仓权重；分母为持仓市值（不含现金）'
            : `前 ${String(topN)} 大持仓权重合计；分母为持仓市值（不含现金）`,
    };
    if (status === 'partial') {
      // 刻意不给 level：这是「已定价子集内」的集中度，不是组合集中度。
      return {
        ...base,
        status: 'partial',
        coverageGap: {
          holdingsCount: coverage.holdingsCount,
          pricedCount: coverage.pricedCount,
          unpricedStockIds: missing,
        },
        note: `${base.note}；这是「已定价子集内」的集中度，不是组合集中度——仅覆盖 ${String(coverage.pricedCount)}/${String(coverage.holdingsCount)} 只已定价持仓，未定价持仓不计入分母，权重重归一后和仍为 1，故不给风险等级。${QUOTE_REMEDY}`,
      };
    }
    return {
      ...base,
      status: 'available',
      level: concentrationLevel(item.value, item.high, item.mid),
    };
  });
};

interface ReturnsInput {
  readonly days: readonly ValuationDayFact[];
  readonly totalAssets: number | undefined;
}

const buildVarMetrics = (input: ReturnsInput): RiskMetric[] => {
  const { days, totalAssets } = input;
  const returnDays = days.filter((day) => day.twrReturnPct !== undefined);
  const sampled = returnDays.slice(-VAR_REQUIRED_RETURNS);
  const first = sampled[0];
  const last = sampled.at(-1);
  const windowOf = (): RiskWindow | undefined => {
    if (first === undefined || last === undefined) return undefined;
    const expected = tradingDaysAfter(first.key, last.key);
    return {
      kind: 'returns',
      from: dayToDate(first.key),
      to: dayToDate(last.key),
      returnsCount: sampled.length,
      requiredReturns: VAR_REQUIRED_RETURNS,
      minReturns: VAR_MIN_RETURNS,
      gapTradingDays: Math.max(0, expected - sampled.length),
    };
  };
  const window = windowOf();
  const completeDays =
    window === undefined
      ? 0
      : days.filter(
          (day) =>
            day.completeness === 'complete' &&
            day.key >= isoDay(window.from) &&
            day.key <= isoDay(window.to),
        ).length;

  const unavailable = (reason: 'no-valuation-day' | 'no-return-sample'): RiskMetric[] => {
    const base = {
      name: 'var95Pct' as const,
      status: 'unavailable' as const,
      reason,
      note:
        reason === 'no-valuation-day'
          ? VAR_MISSING_NOTE
          : '已有估值日但没有任何「前后两日都完整」的日收益率（中间缺价切断收益），不给数字',
      ...(window === undefined ? {} : { window }),
    };
    return [
      base,
      {
        name: 'var95Cny',
        status: 'unavailable',
        reason,
        note: `${base.note}；金额 VaR 同样不给`,
      },
    ];
  };

  if (days.length === 0) return unavailable('no-valuation-day');
  if (sampled.length === 0) return unavailable('no-return-sample');

  const returns = sampled.flatMap((day) =>
    day.twrReturnPct === undefined ? [] : [day.twrReturnPct],
  );
  const var95Pct = historicalVaR95Pct(returns, VAR_MIN_RETURNS);
  const dataAsOf = dayToDate(sampled.at(-1)?.key ?? isoDay(new Date()));
  const baseWindow = window ?? {
    kind: 'returns' as const,
    from: dataAsOf,
    to: dataAsOf,
    returnsCount: sampled.length,
    requiredReturns: VAR_REQUIRED_RETURNS,
    minReturns: VAR_MIN_RETURNS,
    gapTradingDays: 0,
  };

  if (var95Pct === undefined) {
    const note =
      `有效日收益率 ${String(sampled.length)} 个 < 最低样本 ${String(VAR_MIN_RETURNS)} 个` +
      `（目标 ${String(VAR_REQUIRED_RETURNS)} 个），样本不足不给 VaR 数字；` +
      `完整估值日 ${String(completeDays)} 个`;
    return [
      {
        status: 'insufficient',
        name: 'var95Pct',
        reason: 'sample-too-small',
        window: baseWindow,
        note,
      },
      {
        status: 'insufficient',
        name: 'var95Cny',
        reason: 'sample-too-small',
        window: baseWindow,
        note,
      },
    ];
  }

  const level = var95Pct >= 10 ? 'high' : var95Pct >= 5 ? 'mid' : 'low';
  const pctMetric: RiskMetric = {
    status: 'available',
    name: 'var95Pct',
    value: round4(var95Pct),
    unit: 'pct-point',
    level,
    dataAsOf,
    window: baseWindow,
    note:
      `最近 ${String(sampled.length)} 个有效日收益率的 5% 分位损失（百分点，正数 = 损失）；` +
      '序列来自账户级 TWR，已扣现金流，不做权重套历史收益的重算',
  };
  if (totalAssets === undefined) {
    return [
      pctMetric,
      {
        status: 'unavailable',
        name: 'var95Cny',
        reason: 'coverage-gap',
        note: '总资产分母不可用（有未定价持仓），金额 VaR 不给数字；百分点 VaR 已单独给出',
      },
    ];
  }
  return [
    pctMetric,
    {
      status: 'available',
      name: 'var95Cny',
      value: money(round4((var95Pct / 100) * totalAssets)),
      unit: 'cny',
      level,
      dataAsOf,
      window: baseWindow,
      note: `百分点 VaR × 总资产 ${String(round2(totalAssets))} 元（含现金，现金会稀释波动，与「持仓 VaR」不同口径）`,
    },
  ];
};

interface DenominatorInput {
  readonly basis: 'holdings-value' | 'total-assets';
  readonly status: 'available' | 'partial' | 'unavailable';
  readonly value: number;
  readonly dataAsOf: Date;
  readonly holdingsCount: number;
  readonly unpricedStockIds: readonly string[];
  readonly noteAvailable: string;
  readonly notePartial: string;
  readonly noteNoHoldings: string;
  readonly noteUnpriced: string;
}

const buildDenominator = (input: DenominatorInput): PortfolioDenominator => {
  if (input.status === 'available')
    return {
      status: 'available',
      basis: input.basis,
      value: money(input.value),
      dataAsOf: input.dataAsOf,
      note: input.noteAvailable,
    };
  if (input.status === 'partial')
    return {
      status: 'partial',
      basis: input.basis,
      value: money(input.value),
      dataAsOf: input.dataAsOf,
      note: input.notePartial,
      unpricedStockIds: [...input.unpricedStockIds],
    };
  return {
    status: 'unavailable',
    basis: input.basis,
    reason: input.holdingsCount === 0 ? 'no-holdings' : 'coverage-gap',
    missingStockIds: [...input.unpricedStockIds],
    note: input.holdingsCount === 0 ? input.noteNoHoldings : input.noteUnpriced,
  };
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export const getPortfolioRiskTool = defineTool({
  name: 'get_portfolio_risk',
  description:
    '读取本地持仓、已落库报价、已落库绩效快照与 active TradingPlan，输出组合风险：' +
    'HHI / 前 N 大持仓占比 / 历史 95% VaR（百分点与金额）/ 逐票权重与单票上限判定。' +
    '集中度用持仓市值分母，上限判定用总资产分母（与 singleStockPct 同口径）；' +
    '不取外部行情、不写库、不回退成本价：缺价 / 样本不足 / 缺快照时对应指标返回 ' +
    'insufficient 或 unavailable 并给出原因与窗口，不给数字',
  sideEffect: 'read',
  input: GetPortfolioRiskInput,
  output: GetPortfolioRiskOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (accountId.length === 0) return errInvalidInput('缺少 accountId');
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    const asOf = input.asOf ?? ctx.clock();

    const allHoldings = await ctx.repos.holding.listByAccount(accountId);
    const holdings = allHoldings.filter(
      (holding) => holding.closedAt === null && holding.quantity > 0,
    );
    const { priced, unpriced } = await valuePositions(ctx, holdings, asOf);

    const warnings: string[] = [];
    for (const item of priced) {
      if (item.priceStatus === 'reference')
        warnings.push(
          `持仓 ${item.stockId} 使用 ${isoDay(item.observedAt)} 的参考报价估值（无当日合格行情）；${QUOTE_REMEDY}`,
        );
    }
    if (account.cashBalance < 0) warnings.push('账户现金余额为负，总资产口径请先核对账本');
    if (unpriced.length > 0)
      warnings.push(
        `${String(unpriced.length)} 只持仓没有可用报价（${unpriced
          .map((item) => item.stockId)
          .join('、')}），不计入市值分母、不回退成本价；集中度降级为 partial。${QUOTE_REMEDY}`,
      );

    const pricedValue = priced.reduce((sum, item) => sum + item.quantity * item.price, 0);
    const holdingsValue = round4(pricedValue);
    const cashBalance = account.cashBalance;
    const totalAssets = round4(cashBalance + holdingsValue);
    const unpricedStockIds = unpriced.map((item) => item.stockId);
    const pricedRatioPct =
      holdings.length === 0 ? 0 : round2((priced.length / holdings.length) * 100);
    const pricedObservedAt = priced
      .map((item) => item.observedAt.getTime())
      .sort((left, right) => left - right)
      .at(0);
    const pricedDataAsOf = pricedObservedAt === undefined ? undefined : new Date(pricedObservedAt);

    const denominatorStatus: 'available' | 'partial' | 'unavailable' =
      holdings.length === 0 || priced.length === 0
        ? 'unavailable'
        : unpriced.length === 0
          ? 'available'
          : 'partial';

    const holdingsValueDenominator = buildDenominator({
      basis: 'holdings-value',
      status: denominatorStatus,
      value: holdingsValue,
      dataAsOf: pricedDataAsOf ?? asOf,
      holdingsCount: holdings.length,
      unpricedStockIds,
      noteAvailable: '集中度分母：持仓市值（不含现金）',
      notePartial: `集中度分母：仅已定价子集市值，未覆盖 ${String(unpriced.length)} 只持仓；${QUOTE_REMEDY}`,
      noteNoHoldings: '账户没有未平仓持仓，持仓市值分母为空',
      noteUnpriced: `所有持仓都缺可用报价，持仓市值分母为空；不填 0，不回退成本价。${QUOTE_REMEDY}`,
    });
    const totalAssetsDenominator = buildDenominator({
      basis: 'total-assets',
      status: denominatorStatus,
      value: totalAssets,
      dataAsOf: pricedDataAsOf ?? asOf,
      holdingsCount: holdings.length,
      unpricedStockIds,
      noteAvailable: '上限判定分母：现金 + 持仓市值（与 singleStockPct 同口径）',
      notePartial: `上限判定分母不完整（未覆盖 ${String(unpriced.length)} 只持仓），本工具拒绝据此判定超限；${QUOTE_REMEDY}`,
      noteNoHoldings: '账户没有未平仓持仓，总资产 = 现金，上限判定无对象',
      noteUnpriced: `所有持仓都缺可用报价，总资产分母不可用。${QUOTE_REMEDY}`,
    });

    const weights =
      holdingsValue > 0 ? priced.map((item) => (item.quantity * item.price) / holdingsValue) : [];

    const metrics: RiskMetric[] = [
      ...buildConcentrationMetrics({
        asOf,
        weights,
        topN: input.topN,
        coverage: {
          holdingsCount: holdings.length,
          pricedCount: priced.length,
          unpricedStockIds,
        },
        dataAsOf: pricedDataAsOf,
      }),
    ];

    const days = await readValuationDays(ctx, accountId, asOf);
    const fullPricing = denominatorStatus === 'available';
    metrics.push(...buildVarMetrics({ days, totalAssets: fullPricing ? totalAssets : undefined }));

    const planCache = new Map<string, { max: number; version: number } | null>();
    const limitFor = async (stockId: string) => {
      const cached = planCache.get(stockId);
      if (cached !== undefined) return cached;
      const plans = await ctx.repos.tradingPlan.list({
        accountId,
        stockId,
        activeOnly: true,
        asOf,
      });
      const plan = plans.at(0);
      const resolved =
        plan === undefined || plan.position.targetPctRange === null
          ? null
          : { max: plan.position.targetPctRange.max, version: plan.version };
      planCache.set(stockId, resolved);
      return resolved;
    };

    const positions: PositionRisk[] = [];
    let evaluated = 0;
    let skippedNoPlan = 0;
    const breaches: z.infer<typeof PortfolioRiskLimitCheckSchema>['breaches'] = [];
    for (const holding of holdings) {
      const stock = await ctx.repos.stock.findById(holding.stockId);
      const pricedItem = priced.find((item) => item.stockId === holding.stockId);
      const weightOfHoldingsPct =
        pricedItem === undefined || holdingsValue <= 0
          ? undefined
          : ((pricedItem.quantity * pricedItem.price) / holdingsValue) * 100;
      const weightOfTotalAssetsPct =
        pricedItem === undefined || !fullPricing || totalAssets <= 0
          ? undefined
          : ((pricedItem.quantity * pricedItem.price) / totalAssets) * 100;
      const limit = await limitFor(holding.stockId);
      if (limit === null) skippedNoPlan += 1;
      const breach =
        limit !== null && weightOfTotalAssetsPct !== undefined
          ? weightOfTotalAssetsPct > limit.max + LIMIT_BREACH_TOLERANCE
          : undefined;
      if (limit !== null && weightOfTotalAssetsPct !== undefined) {
        evaluated += 1;
        if (breach === true) {
          breaches.push({
            stockId: holding.stockId,
            weightPct: round4(weightOfTotalAssetsPct),
            maxPct: limit.max,
            excessPct: round2(weightOfTotalAssetsPct - limit.max),
            planVersion: limit.version,
          });
        }
      }
      positions.push({
        stockId: holding.stockId,
        ...(stock === null ? {} : { stockName: stock.name }),
        quantity: holding.quantity,
        ...(pricedItem === undefined ? {} : { price: money(pricedItem.price) }),
        priceStatus: pricedItem?.priceStatus ?? 'missing',
        ...(pricedItem === undefined ? {} : { priceObservedAt: pricedItem.observedAt }),
        ...(pricedItem === undefined
          ? {}
          : { marketValue: money(round4(pricedItem.quantity * pricedItem.price)) }),
        ...(weightOfHoldingsPct === undefined
          ? {}
          : { weightOfHoldingsPct: round4(weightOfHoldingsPct) }),
        ...(weightOfTotalAssetsPct === undefined
          ? {}
          : { weightOfTotalAssetsPct: round4(weightOfTotalAssetsPct) }),
        ...(limit === null ? {} : { limitMaxPct: limit.max }),
        limitSource: limit === null ? 'none' : 'trading-plan',
        ...(limit === null ? {} : { limitPlanVersion: limit.version }),
        ...(breach === undefined ? {} : { breach }),
        ...(breach === true && weightOfTotalAssetsPct !== undefined && limit !== null
          ? { excessPct: round2(weightOfTotalAssetsPct - limit.max) }
          : {}),
      });
    }

    const limitStatus: z.infer<typeof PortfolioRiskLimitCheckSchema>['status'] = !fullPricing
      ? 'not-evaluated'
      : evaluated === 0
        ? 'no-basis'
        : skippedNoPlan === 0
          ? 'evaluated'
          : 'partial';
    const limitCheck: z.infer<typeof PortfolioRiskLimitCheckSchema> = {
      basis: 'trading-plan-position-target-pct-range-max',
      status: limitStatus,
      evaluated,
      skippedNoPlan,
      breaches,
      note:
        limitStatus === 'not-evaluated'
          ? holdings.length === 0
            ? '账户没有未平仓持仓，无上限判定对象'
            : `总资产分母不完整（有未定价持仓），无法计算仓位百分比，因此不给超限判定。${QUOTE_REMEDY}`
          : limitStatus === 'no-basis'
            ? '所有持仓都没有 active TradingPlan 的 targetPctRange.max：缺省语义是「无上限依据」，不是合规'
            : limitStatus === 'partial'
              ? `${String(skippedNoPlan)} 只持仓没有上限依据，已跳过判定（不等于合规）；其余 ${String(evaluated)} 只按 targetPctRange.max 判定`
              : `全部 ${String(evaluated)} 只持仓按 active TradingPlan 的 targetPctRange.max 判定`,
    };

    const benchmark: GetPortfolioRiskOutputT['benchmark'] =
      ctx.portfolioBenchmark === undefined
        ? {
            status: 'unavailable',
            reason: 'benchmark-not-configured',
            note: '未注入组合基准标的；基准 TWR / 超额由 M3-07 的 get_account_performance 计算',
          }
        : {
            stockId: ctx.portfolioBenchmark.stockId,
            name: ctx.portfolioBenchmark.name,
            status: 'not-evaluated',
            note: '本工具只声明基准身份，不重复计算基准 TWR / 超额（口径唯一实现：get_account_performance）',
          };
    // 保守口径：参与计算的序列里最早的那个观测时间，不给 `new Date()`。
    const earliestMetricDataAsOf = metrics
      .flatMap((metric) => ('dataAsOf' in metric ? [metric.dataAsOf] : []))
      .sort((left, right) => left.getTime() - right.getTime())
      .at(0);

    return {
      schemaVersion: PORTFOLIO_RISK_SCHEMA_VERSION,
      accountId,
      asOf,
      ...(earliestMetricDataAsOf === undefined ? {} : { dataAsOf: earliestMetricDataAsOf }),
      coverage: {
        holdingsCount: holdings.length,
        pricedCount: priced.length,
        unpricedCount: unpriced.length,
        pricedRatioPct,
        unpricedStockIds,
      },
      valuation: {
        cashBalance: money(cashBalance),
        holdingsValue: holdingsValueDenominator,
        totalAssets: totalAssetsDenominator,
      },
      benchmark,
      metrics,
      positions,
      limitCheck,
      warnings,
    };
  },
});
