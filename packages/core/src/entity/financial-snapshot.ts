import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * 财务当前快照（current-vendor-view）—— 非 PIT 事实。
 *
 * 设计：docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §11
 *
 * 关键约束：
 * - viewKind='current-vendor-view'，pitStatus='not-ready'；
 * - 不写入 financial_fact_revisions，不进入 strict PIT 评分；
 * - 金额原币元，EPS 元/股；null 保留缺失，不补零；
 * - 指标 value 是字符串，用显式 metric registry 解析，禁止按中文名猜单位；
 * - 季报累计值不单季化；TTM 不由当前快照临时拼接；
 * - 估值只有最新快照；data.timestamp 是上游元数据最大有效时间，不代表五个指标同刻更新。
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

// ============================================================================
// 财务报表（三大报表）
// ============================================================================

export const FinancialStatementTypeSchema = z.enum([
  'income-statement',
  'balance-sheet',
  'cash-flow-statement',
]);
export type FinancialStatementType = z.infer<typeof FinancialStatementTypeSchema>;

export const FinancialStatementPeriodSchema = z.enum(['annual', 'quarterly']);
export type FinancialStatementPeriod = z.infer<typeof FinancialStatementPeriodSchema>;

/**
 * 三大报表统一元数据字段（实测 Phase 0：三张表一致）。
 * report_date_ms → reportDate（披露日）；period_end_ms → periodEnd（报告期末）。
 */
const FinancialStatementMetaSchema = z.object({
  thscode: z.string().min(1),
  ticker: z.string().min(1),
  period: FinancialStatementPeriodSchema,
  fiscal_year: z.number().int(),
  fiscal_period: z.enum(['FY', 'Q1', 'Q2', 'Q3', 'Q4']),
  report_date_ms: z.number().int().positive(),
  period_end_ms: z.number().int().positive(),
  currency: z.literal('CNY'),
});

/** 利润表业务字段（13 个，Phase 0 实测）。 */
export const IncomeStatementFieldsSchema = z.object({
  operating_income: z.number().nullable(),
  operating_costs: z.number().nullable(),
  operating_expenses: z.number().nullable(),
  sales_fee: z.number().nullable(),
  manage_fee: z.number().nullable(),
  research_and_development_expenses: z.number().nullable(),
  operating_profit: z.number().nullable(),
  interest_expenses: z.number().nullable(),
  profit_total: z.number().nullable(),
  income_tax_expense: z.number().nullable(),
  net_profit: z.number().nullable(),
  parent_holder_net_profit: z.number().nullable(),
  basic_eps: z.number().nullable(),
});

/** 资产负债表业务字段（7 个，Phase 0 实测）。 */
export const BalanceSheetFieldsSchema = z.object({
  assets_total: z.number().nullable(),
  total_current_assets: z.number().nullable(),
  non_current_nets_total: z.number().nullable(),
  cash: z.number().nullable(),
  accounts_receivable: z.number().nullable(),
  total_debt: z.number().nullable(),
  holder_equity_total: z.number().nullable(),
});

/** 现金流量表业务字段（6 个，Phase 0 实测）。 */
export const CashFlowStatementFieldsSchema = z.object({
  act_cash_flow_net: z.number().nullable(),
  invest_cash_flow_net: z.number().nullable(),
  financing_cash_flow_net: z.number().nullable(),
  pay_fixed_assets_etc_cash: z.number().nullable(),
  pay_dividends_profits_interest_cash: z.number().nullable(),
  cash_equivalents_net_addition: z.number().nullable(),
});

export const IncomeStatementItemSchema = FinancialStatementMetaSchema.merge(
  IncomeStatementFieldsSchema,
);
export const BalanceSheetItemSchema = FinancialStatementMetaSchema.merge(BalanceSheetFieldsSchema);
export const CashFlowStatementItemSchema = FinancialStatementMetaSchema.merge(
  CashFlowStatementFieldsSchema,
);

export type IncomeStatementItem = z.infer<typeof IncomeStatementItemSchema>;
export type BalanceSheetItem = z.infer<typeof BalanceSheetItemSchema>;
export type CashFlowStatementItem = z.infer<typeof CashFlowStatementItemSchema>;

/** 三大报表统一输出项（领域层）。 */
export const FinancialStatementSchema = z.object({
  statementType: FinancialStatementTypeSchema,
  stockId: z.string().min(1),
  period: z.string().min(1),
  fiscalYear: z.number().int(),
  fiscalPeriod: z.number().int().min(1).max(4),
  periodEnd: z.date(),
  reportDate: z.date(),
  currency: z.literal('CNY'),
  fields: z.record(z.string(), z.number().nullable()),
});
export type FinancialStatement = z.infer<typeof FinancialStatementSchema>;

// ============================================================================
// 财务指标（23 项 registry，Phase 0 实测）
// ============================================================================

export const FinancialIndicatorCategorySchema = z.enum([
  'growth',
  'profitability',
  'solvency',
  'operation',
  'cash-flow',
]);
export type FinancialIndicatorCategory = z.infer<typeof FinancialIndicatorCategorySchema>;

export const FinancialIndicatorUnitSchema = z.enum([
  'percent-points',
  'ratio',
  'times',
  'CNY',
  'day',
]);
export type FinancialIndicatorUnit = z.infer<typeof FinancialIndicatorUnitSchema>;

/**
 * 23 项财务指标 registry（Phase 0 实测 index_id 全集）。
 * 单位映射：按字段定义，禁止按中文名猜单位。
 */
export const FINANCIAL_INDICATOR_REGISTRY = {
  // growth（4 项）
  calculate_operating_income_yoy_growth_ratio: {
    category: 'growth',
    unit: 'percent-points',
    description: '营业收入同比增长率',
  },
  calculate_operating_profit_yoy_growth_ratio: {
    category: 'growth',
    unit: 'percent-points',
    description: '营业利润同比增长率',
  },
  total_assets_growth_ratio: {
    category: 'growth',
    unit: 'percent-points',
    description: '总资产增长率',
  },
  calculate_parent_holder_net_profit_yoy_growth_ratio: {
    category: 'growth',
    unit: 'percent-points',
    description: '归母净利润同比增长率',
  },
  // profitability（5 项）
  total_assets_net_ratio: {
    category: 'profitability',
    unit: 'percent-points',
    description: '总资产净利率',
  },
  index_deduct_weighted_avg_roe: {
    category: 'profitability',
    unit: 'percent-points',
    description: '扣非加权平均净资产收益率',
  },
  sale_gross_margin: {
    category: 'profitability',
    unit: 'percent-points',
    description: '销售毛利率',
  },
  sale_net_interest_ratio: {
    category: 'profitability',
    unit: 'percent-points',
    description: '销售净利率',
  },
  index_weighted_avg_roe: {
    category: 'profitability',
    unit: 'percent-points',
    description: '加权平均净资产收益率',
  },
  // solvency（5 项）
  current_ratio: {
    category: 'solvency',
    unit: 'ratio',
    description: '流动比率',
  },
  cash_ratio: {
    category: 'solvency',
    unit: 'ratio',
    description: '现金比率',
  },
  quick_ratio: {
    category: 'solvency',
    unit: 'ratio',
    description: '速动比率',
  },
  earned_interest_multiple: {
    category: 'solvency',
    unit: 'times',
    description: '已获利息倍数',
  },
  assets_debt_ratio: {
    category: 'solvency',
    unit: 'percent-points',
    description: '资产负债率',
  },
  // operation（5 项）
  total_assets_turnover_ratio: {
    category: 'operation',
    unit: 'times',
    description: '总资产周转率',
  },
  inventory_turnover_ratio: {
    category: 'operation',
    unit: 'times',
    description: '存货周转率',
  },
  long_term_debt_equity_ratio: {
    category: 'operation',
    unit: 'ratio',
    description: '长期债务权益比',
  },
  current_assets_turnover_ratio: {
    category: 'operation',
    unit: 'times',
    description: '流动资产周转率',
  },
  receive_account_turnover_ratio: {
    category: 'operation',
    unit: 'times',
    description: '应收账款周转率',
  },
  // cash-flow（4 项）
  net_profit_cash_content: {
    category: 'cash-flow',
    unit: 'ratio',
    description: '净利润现金含量',
  },
  cash_operating_index: {
    category: 'cash-flow',
    unit: 'ratio',
    description: '现金营运指数',
  },
  operating_cash_flow_net_divide_income: {
    category: 'cash-flow',
    unit: 'ratio',
    description: '经营活动现金流量净额与营业收入比率',
  },
  cash_meet_invest_ratio: {
    category: 'cash-flow',
    unit: 'ratio',
    description: '现金满足投资比率',
  },
} as const satisfies Record<
  string,
  { category: FinancialIndicatorCategory; unit: FinancialIndicatorUnit; description: string }
>;

export type FinancialIndicatorId = keyof typeof FINANCIAL_INDICATOR_REGISTRY;

export const FinancialIndicatorIdSchema = z.enum(
  Object.keys(FINANCIAL_INDICATOR_REGISTRY) as [FinancialIndicatorId, ...FinancialIndicatorId[]],
);

/** 财务指标原始响应项（上游 value 是字符串）。 */
export const FinancialIndicatorRawItemSchema = z.object({
  index_id: z.string().min(1),
  value: z.string().nullable(),
});

/** 财务指标解析后输出项（领域层）。 */
export const FinancialIndicatorSchema = z.object({
  indicatorId: FinancialIndicatorIdSchema,
  category: FinancialIndicatorCategorySchema,
  unit: FinancialIndicatorUnitSchema,
  value: z.number().nullable(),
  rawValue: z.string().nullable(),
});
export type FinancialIndicator = z.infer<typeof FinancialIndicatorSchema>;

/** 财务指标响应（按类别分组）。 */
export const FinancialIndicatorSetSchema = z.object({
  stockId: z.string().min(1),
  report: z.string().min(1),
  indicators: z.array(FinancialIndicatorSchema),
});
export type FinancialIndicatorSet = z.infer<typeof FinancialIndicatorSetSchema>;

// ============================================================================
// 估值快照
// ============================================================================

export const ValuationSnapshotItemSchema = z.object({
  thscode: z.string().min(1),
  ticker: z.string().min(1),
  name: z.string().min(1),
  pe_ttm: z.number().nullable(),
  pe_mrq: z.number().nullable(),
  pb_mrq: z.number().nullable(),
  ps_ttm: z.number().nullable(),
  pcf_ttm: z.number().nullable(),
});
export type ValuationSnapshotItem = z.infer<typeof ValuationSnapshotItemSchema>;

/** 估值快照输出项（领域层）。 */
export const ValuationSnapshotSchema = z.object({
  stockId: z.string().min(1),
  ticker: z.string().min(1),
  name: z.string().min(1),
  peTtm: z.number().nullable(),
  peMrq: z.number().nullable(),
  pbMrq: z.number().nullable(),
  psTtm: z.number().nullable(),
  pcfTtm: z.number().nullable(),
});
export type ValuationSnapshot = z.infer<typeof ValuationSnapshotSchema>;

// ============================================================================
// 财务当前快照（聚合输出）
// ============================================================================

export const FinancialSnapshotViewKindSchema = z.literal('current-vendor-view');
export type FinancialSnapshotViewKind = z.infer<typeof FinancialSnapshotViewKindSchema>;

export const FinancialSnapshotPitStatusSchema = z.literal('not-ready');
export type FinancialSnapshotPitStatus = z.infer<typeof FinancialSnapshotPitStatusSchema>;

/**
 * 财务当前快照（聚合输出）。
 *
 * 统一带：
 * - source='fuyao'
 * - viewKind='current-vendor-view'
 * - periodEnd / reportDate（若端点提供）
 * - observedAt / fetchedAt
 * - pitStatus='not-ready'
 * - rawContentHash
 * - missingFields / issues
 */
export const FinancialSnapshotSchema = z.object({
  stockId: z.string().min(1),
  source: z.literal('fuyao'),
  viewKind: FinancialSnapshotViewKindSchema,
  pitStatus: FinancialSnapshotPitStatusSchema,
  /** 报告期末（period_end_ms）。 */
  periodEnd: z.date().optional(),
  /** 披露日（report_date_ms）。 */
  reportDate: z.date().optional(),
  /** 可信的数据观察时间；报表期末和估值元数据 timestamp 不作为观察时间。 */
  observedAt: z.date().optional(),
  /** 本地抓取时间。 */
  fetchedAt: z.date(),
  /** 原始响应内容 hash（SHA-256）。 */
  rawContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** 三大报表（可选，按请求参数返回）。 */
  statements: z
    .object({
      incomeStatements: z.array(FinancialStatementSchema).optional(),
      balanceSheets: z.array(FinancialStatementSchema).optional(),
      cashFlowStatements: z.array(FinancialStatementSchema).optional(),
    })
    .optional(),
  /** 财务指标（可选，按请求参数返回）。 */
  indicators: FinancialIndicatorSetSchema.optional(),
  /** 估值快照（可选，按请求参数返回）。 */
  valuation: ValuationSnapshotSchema.optional(),
  /** 缺失字段列表。 */
  missingFields: z.array(z.string()).default([]),
  /** 问题列表。 */
  issues: z.array(z.string()).default([]),
});
export type FinancialSnapshot = z.infer<typeof FinancialSnapshotSchema>;

// ============================================================================
// 内容 hash 计算
// ============================================================================

/**
 * 内容 hash 的输入契约：完整快照去掉 rawContentHash。
 *
 * rawContentHash 由本函数计算产生，把完整 FinancialSnapshotSchema 当输入会形成
 * 自引用（hash 尚未存在时无法通过 parse）。调用方在算 hash 前构造的对象天然
 * 没有 rawContentHash，因此输入契约显式排除它。
 */
export const FinancialSnapshotHashInputSchema = FinancialSnapshotSchema.omit({
  rawContentHash: true,
});
export type FinancialSnapshotHashInput = z.infer<typeof FinancialSnapshotHashInputSchema>;

const financialSnapshotHashPayload = (
  snapshot: FinancialSnapshotHashInput,
): Record<string, unknown> => ({
  stockId: snapshot.stockId,
  source: snapshot.source,
  viewKind: snapshot.viewKind,
  pitStatus: snapshot.pitStatus,
  ...(snapshot.periodEnd === undefined ? {} : { periodEnd: snapshot.periodEnd }),
  ...(snapshot.reportDate === undefined ? {} : { reportDate: snapshot.reportDate }),
  ...(snapshot.observedAt === undefined ? {} : { observedAt: snapshot.observedAt }),
  fetchedAt: snapshot.fetchedAt,
  ...(snapshot.statements === undefined
    ? {}
    : {
        statements: {
          ...(snapshot.statements.incomeStatements === undefined
            ? {}
            : { incomeStatements: snapshot.statements.incomeStatements }),
          ...(snapshot.statements.balanceSheets === undefined
            ? {}
            : { balanceSheets: snapshot.statements.balanceSheets }),
          ...(snapshot.statements.cashFlowStatements === undefined
            ? {}
            : { cashFlowStatements: snapshot.statements.cashFlowStatements }),
        },
      }),
  ...(snapshot.indicators === undefined ? {} : { indicators: snapshot.indicators }),
  ...(snapshot.valuation === undefined ? {} : { valuation: snapshot.valuation }),
  missingFields: snapshot.missingFields,
  issues: snapshot.issues,
});

export const canonicalFinancialSnapshotJson = (snapshot: FinancialSnapshotHashInput): string =>
  JSON.stringify(
    canonicalize(financialSnapshotHashPayload(FinancialSnapshotHashInputSchema.parse(snapshot))),
  );

export const financialSnapshotContentHash = (snapshot: FinancialSnapshotHashInput): string =>
  sha256(canonicalFinancialSnapshotJson(snapshot));

// ============================================================================
// 查询输入
// ============================================================================

export const FinancialSnapshotQuerySchema = z.object({
  stockId: z.string().min(1),
  /** 是否包含三大报表。 */
  includeStatements: z.boolean().default(true),
  /** 是否包含财务指标。 */
  includeIndicators: z.boolean().default(true),
  /** 是否包含估值快照。 */
  includeValuation: z.boolean().default(true),
  /** 报表期间类型（annual/quarterly）。 */
  statementPeriod: FinancialStatementPeriodSchema.default('annual'),
  /** 报表期数限制（默认 3 期）。 */
  statementLimit: z.number().int().min(1).max(10).default(3),
  /** 指标报告期（如 '2025-1' 表示 2025 年 Q1）。 */
  indicatorReport: z.string().optional(),
});
export type FinancialSnapshotQuery = z.infer<typeof FinancialSnapshotQuerySchema>;
