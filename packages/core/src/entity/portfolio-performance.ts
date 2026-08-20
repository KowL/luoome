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
