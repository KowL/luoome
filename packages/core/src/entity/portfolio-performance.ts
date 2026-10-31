import { z } from 'zod';

export const PortfolioCashFlowKindSchema = z.enum([
  'deposit',
  'withdrawal',
  'dividend',
  'fee',
  'tax',
  'transfer-in',
  'transfer-out',
]);
export type PortfolioCashFlowKind = z.infer<typeof PortfolioCashFlowKindSchema>;

/** 账户绩效首期默认基准；生产 composition root 可通过环境变量覆盖标的。 */
export const DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID = '000300.SH';
export const DEFAULT_PORTFOLIO_BENCHMARK_NAME = '沪深300';

export const PortfolioCashFlowSourceSchema = z.enum(['manual', 'import', 'system']);
export type PortfolioCashFlowSource = z.infer<typeof PortfolioCashFlowSourceSchema>;

export const PortfolioCashFlowSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  occurredAt: z.coerce.date(),
  kind: PortfolioCashFlowKindSchema,
  amount: z.number().finite().positive(),
  currency: z.string().length(3),
  stockId: z.string().min(1).optional(),
  source: PortfolioCashFlowSourceSchema,
  note: z.string().max(500).optional(),
  createdAt: z.coerce.date(),
});
export type PortfolioCashFlow = z.infer<typeof PortfolioCashFlowSchema>;

export const PortfolioCorporateActionKindSchema = z.enum(['split', 'bonus', 'dividend']);
export type PortfolioCorporateActionKind = z.infer<typeof PortfolioCorporateActionKindSchema>;

export const PortfolioCorporateActionSchema = z
  .object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    stockId: z.string().min(1),
    occurredAt: z.coerce.date(),
    kind: PortfolioCorporateActionKindSchema,
    ratio: z.number().finite().positive().optional(),
    cashPerShare: z.number().finite().nonnegative().optional(),
    source: PortfolioCashFlowSourceSchema,
    note: z.string().max(500).optional(),
    createdAt: z.coerce.date(),
  })
  .superRefine((action, ctx) => {
    if ((action.kind === 'split' || action.kind === 'bonus') && action.ratio === undefined) {
      ctx.addIssue({ code: 'custom', path: ['ratio'], message: '拆股/送转必须提供 ratio' });
    }
    if (action.kind === 'dividend' && action.cashPerShare === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cashPerShare'],
        message: '分红公司行动必须提供 cashPerShare',
      });
    }
  });
export type PortfolioCorporateAction = z.infer<typeof PortfolioCorporateActionSchema>;

export const PortfolioValuationCompletenessSchema = z.enum(['complete', 'partial', 'unavailable']);
export type PortfolioValuationCompleteness = z.infer<typeof PortfolioValuationCompletenessSchema>;

/**
 * TWR 的最小样本：完整估值日少于该数量时只报 `insufficient`，不给百分比。
 *
 * 2 个交易日也能算出「TWR=5%」，但那是两天噪声而不是区间收益，把噪声写成百分比
 * 等于用「有数据」冒充「有结论」。与 `get_confidence_calibration` 的
 * `minimumOutcomes: 20` 取同一量级，避免同一产品里出现两套「样本够不够」口径。
 */
export const MIN_TWR_SAMPLE_TRADING_DAYS = 20;

/** 单项指标的可用性；`insufficient` 专指「样本不够，不给数字」，不是 0。 */
export const PortfolioMetricStatusSchema = z.enum(['available', 'insufficient', 'unavailable']);
export type PortfolioMetricStatus = z.infer<typeof PortfolioMetricStatusSchema>;

/**
 * 非 `available` 的机器可读原因。刻意用枚举而不是自由文本：调用方要能据原因
 * 决定「补数据」还是「换区间」，而不是解析一句人话。
 */
export const PortfolioMetricReasonSchema = z.enum([
  'no-valuation-day',
  'coverage-gap',
  'no-return-sample',
  'sample-too-small',
  'benchmark-not-configured',
  'benchmark-coverage-gap',
  'benchmark-sample-too-small',
  'twr-unavailable',
  'benchmark-unavailable',
  /** 账户没有未平仓持仓：集中度/上限判定没有对象，不是「零集中度」。 */
  'no-holdings',
]);
export type PortfolioMetricReason = z.infer<typeof PortfolioMetricReasonSchema>;

export const PortfolioMetricAvailabilitySchema = z.object({
  status: PortfolioMetricStatusSchema,
  reason: PortfolioMetricReasonSchema.optional(),
});
export type PortfolioMetricAvailability = z.infer<typeof PortfolioMetricAvailabilitySchema>;

export const PortfolioPerformanceMetricsSchema = z.object({
  twr: PortfolioMetricAvailabilitySchema,
  benchmarkTwr: PortfolioMetricAvailabilitySchema,
  excessTwr: PortfolioMetricAvailabilitySchema,
});
export type PortfolioPerformanceMetrics = z.infer<typeof PortfolioPerformanceMetricsSchema>;

/**
 * 区间覆盖事实：缺口只报状态和日期，不用 0 或上一日价格补位。
 *
 * `missingDates` 是「该交易日的估值不完整（缺任一持仓价格）」的日期，`sampleDays`
 * 是可用于 TWR 的完整估值日数——两者都不含推算值。
 */
export const PortfolioCoverageSchema = z.object({
  status: PortfolioValuationCompletenessSchema,
  expectedTradingDays: z.number().int().nonnegative(),
  completeTradingDays: z.number().int().nonnegative(),
  missingDates: z.array(z.string().date()),
  sampleDays: z.number().int().nonnegative(),
  requiredSampleDays: z.literal(MIN_TWR_SAMPLE_TRADING_DAYS),
});
export type PortfolioCoverage = z.infer<typeof PortfolioCoverageSchema>;

export const PortfolioValuationDaySchema = z.object({
  date: z.coerce.date(),
  cash: z.number().finite(),
  /** 缺少任一持仓价格时不输出伪造的 0；调用方应依据 completeness 判断是否可用。 */
  holdingsValue: z.number().finite().nonnegative().optional(),
  /** 缺少任一持仓价格时不输出总市值，避免把现金误呈现为组合总值。 */
  totalValue: z.number().finite().nonnegative().optional(),
  completeness: PortfolioValuationCompletenessSchema,
  missingStockIds: z.array(z.string()),
  externalCashFlow: z.number().finite(),
  twrReturnPct: z.number().finite().optional(),
  cumulativeTwrPct: z.number().finite().optional(),
  drawdownPct: z.number().finite().optional(),
});
export type PortfolioValuationDay = z.infer<typeof PortfolioValuationDaySchema>;

export const PortfolioContributionSchema = z.object({
  stockId: z.string().min(1),
  /**
   * 归因指向的事实 id，不是自由文本结论。格式固定为
   * `trade:<Trade.id>` / `cash-flow:<PortfolioCashFlow.id>` /
   * `corporate-action:<PortfolioCorporateAction.id>` / `holding:<Holding.id>` /
   * `daily_bar:<stockId>:<YYYY-MM-DD>`（后者是 daily_bars 的复合主键，可回表核对）。
   * 存量快照没有该字段，读取方必须按「无法追溯」处理，不能当空结论。
   */
  factIds: z.array(z.string().min(1)).optional(),
  /** 缺价时保持 undefined，不能用 0 伪造当前市值。 */
  currentValue: z.number().finite().nonnegative().optional(),
  realizedPnl: z.number().finite(),
  unrealizedPnl: z.number().finite().optional(),
  dividends: z.number().finite().nonnegative(),
  contribution: z.number().finite(),
  completeness: PortfolioValuationCompletenessSchema,
});
export type PortfolioContribution = z.infer<typeof PortfolioContributionSchema>;

export const PortfolioPerformanceInputFactsSchema = z.object({
  trades: z.number().int().nonnegative(),
  holdings: z.number().int().nonnegative(),
  cashFlows: z.number().int().nonnegative(),
  corporateActions: z.number().int().nonnegative(),
  priceSeries: z.number().int().nonnegative(),
  dailyBars: z.number().int().nonnegative(),
  benchmarkBars: z.number().int().nonnegative(),
});
export type PortfolioPerformanceInputFacts = z.infer<typeof PortfolioPerformanceInputFactsSchema>;

export const PortfolioPerformanceSchema = z.object({
  accountId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
  currency: z.string().length(3),
  completeness: PortfolioValuationCompletenessSchema,
  cashFlowComplete: z.boolean(),
  benchmarkStatus: z.enum(['available', 'unavailable', 'partial']),
  /**
   * 覆盖与样本事实。optional 只为兼容存量快照 JSON：旧记录没有该字段时读取方
   * 必须报「无法判定」，不能默认成 complete（给默认值就是把「不知道」伪造成结论）。
   * 计算器本身总是输出它。
   */
  coverage: PortfolioCoverageSchema.optional(),
  /** TWR / 基准 TWR / 超额的可用性；非 available 时对应百分比字段必须缺席。 */
  metrics: PortfolioPerformanceMetricsSchema.optional(),
  benchmarkStockId: z.string().min(1).optional(),
  twrPct: z.number().finite().optional(),
  maxDrawdownPct: z.number().finite().optional(),
  benchmarkTwrPct: z.number().finite().optional(),
  excessTwrPct: z.number().finite().optional(),
  realizedPnl: z.number().finite(),
  unrealizedPnl: z.number().finite().optional(),
  totalPnl: z.number().finite().optional(),
  valuation: z.array(PortfolioValuationDaySchema),
  contributions: z.array(PortfolioContributionSchema),
  warnings: z.array(z.string()),
  audit: z
    .object({
      snapshotId: z.string().min(1),
      inputFingerprint: z.string().min(1),
      calculatedAt: z.coerce.date(),
      dataAsOf: z.coerce.date().optional(),
      calculationDurationMs: z.number().finite().nonnegative().optional(),
      inputFacts: PortfolioPerformanceInputFactsSchema.optional(),
      cacheStatus: z.enum(['created', 'reused']).optional(),
    })
    .optional(),
});
export type PortfolioPerformance = z.infer<typeof PortfolioPerformanceSchema>;

/**
 * 绩效快照只保存计算结果和输入指纹；原始交易、现金流、公司行动与行情仍是事实源。
 * 同一账户、区间和指纹只能得到一个可复用的审计快照。
 */
export const PortfolioPerformanceSnapshotSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
  currency: z.string().length(3),
  inputFingerprint: z.string().min(1),
  calculatedAt: z.coerce.date(),
  dataAsOf: z.coerce.date().optional(),
  performance: PortfolioPerformanceSchema,
});
export type PortfolioPerformanceSnapshot = z.infer<typeof PortfolioPerformanceSnapshotSchema>;
