import { MoneySchema, PortfolioMetricReasonSchema, ReportSchema } from '@luoome/core';
import {
  type GetPortfolioRiskOutput,
  PORTFOLIO_RISK_SCHEMA_VERSION,
  PortfolioRiskCoverageSchema,
  PortfolioRiskLimitCheckSchema,
  RiskMetricSchema,
} from '@luoome/tools';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { envelopeSections } from './internal/report-envelope.js';
import { executeReportWorkflow, type ReportSectionPiece } from './internal/report-runner.js';

type PortfolioRiskData = z.output<typeof GetPortfolioRiskOutput>;

/**
 * risk-report（v0.4）：
 * 集中度与 VaR 的**数学只有一份实现**——`get_portfolio_risk` 工具。
 * 本 workflow 只负责把工具输出映射成日报形状，不再自己算 HHI、不再自己算 VaR、
 * 也不再持有 `HHI_THRESHOLD_*` / `VAR_LOOKBACK_DAYS` 这类口径常量。
 *
 * 旧版（v0.3）用 `list_holdings.totalValue` 当 HHI 分母，而那个分母在缺价时会用
 * `avgCost` 顶替（`holding-pnl.ts`），等于伪造分母；`historicalVaR95` 又会把
 * 「样本全为涨」返回成 0 元。两处都已在工具侧修正，workflow 不再保留第二份。
 */

export const RiskReportInput = z.object({
  accountId: z.string().min(1).optional(),
});

export type RiskReportInputT = z.infer<typeof RiskReportInput>;

export const RiskReportOutput = z.object({
  /** 与工具同源：`value` 从「可为 null」改为「键缺席」是破坏性形状变更，外部脚本据此判定。 */
  schemaVersion: z.literal(PORTFOLIO_RISK_SCHEMA_VERSION),
  accountId: z.string(),
  /**
   * 总资产（含现金）。**仅在总资产分母完整可用时出现**；有未定价持仓或缺价时
   * 字段缺席而不是填 0 或填一个不完整的数。
   */
  totalValue: MoneySchema.optional(),
  holdingsCount: z.number().int().nonnegative(),
  /** 指标可用性由工具表达（`available` / `partial` / `insufficient` / `unavailable`）。 */
  metrics: z.array(RiskMetricSchema),
  limitCheck: PortfolioRiskLimitCheckSchema,
  coverage: PortfolioRiskCoverageSchema,
  benchmark: z.object({
    stockId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    status: z.enum(['available', 'unavailable', 'not-evaluated']),
    reason: PortfolioMetricReasonSchema.optional(),
    note: z.string().min(1),
  }),
  /**
   * 披露行：工具的 warnings + 刷新结论。刷新失败/跳过时不追加任何文案——
   * 此时工具自己的 `note` 已经点名「缺什么 + 怎么补」，两处说法必须一致。
   */
  warnings: z.array(z.string().min(1)),
  /** 数据健康角标：任一指标非 available 时列出原因，避免「报告看起来完整」。 */
  dataHealth: z.object({
    status: z.enum(['available', 'partial', 'insufficient', 'unavailable']),
    unavailableMetrics: z.array(z.string().min(1)),
  }),
  marketSummary: z.string(),
  generatedAt: z.coerce.date(),
  /**
   * S6a 新增：同时落一份 `Report`（kind `risk`），供 `write_report_artifact` 交付成文件。
   * 既有字段一个不改；落库失败时为 undefined。
   */
  report: ReportSchema.optional(),
});

export type RiskReportOutputT = z.infer<typeof RiskReportOutput>;

const MARKET_SUMMARY = '（大盘背景随内置 AI 下线，不再生成本地市场判断）';

const DAY_MS = 86_400_000;

/**
 * 刷新区间：≥31 个交易日的自然日跨度，跨春节/国庆长假仍够 VaR 的 30 个样本。
 * 具体样本够不够由工具判定，这里只负责「把区间给足」。
 */
const PERFORMANCE_REFRESH_LOOKBACK_DAYS = 120;

/** 只有「收益样本缺失」才值得刷新；缺价导致的 `coverage-gap` 刷新行情快照也治不了。 */
const needsReturnSampleRefresh = (data: PortfolioRiskData): boolean => {
  const var95Pct = data.metrics.find((metric) => metric.name === 'var95Pct');
  return var95Pct !== undefined && var95Pct.status !== 'available';
};

const executeRisk = async (
  ctx: Parameters<WorkflowStep>[1],
  accountId: string | undefined,
  asOf: Date,
) =>
  ctx.tools.get_portfolio_risk.execute({
    asOf,
    ...(accountId === undefined ? {} : { accountId }),
  });

const stepRisk: WorkflowStep = async (prev, ctx) => {
  const input = prev as RiskReportInputT;
  // PIT 时点固定一次：刷新后重试必须落在同一个时点，否则两次口径不可比。
  return executeRisk(ctx, input.accountId, ctx.clock());
};

/**
 * 刷新步骤：`get_portfolio_risk` 是纯 read（R3：**工具**不自算收益序列），
 * 但报告流程有权编排 external 能力——旧版 `stepCompute` 就是这样做的。
 *
 * 缺收益样本时先跑一次 `get_account_performance`（external：回源拉日线 + 落绩效快照），
 * 再重试一次工具。这样「新装账户第一次跑 risk-report」不会因为库里没快照就交白卷；
 * 刷新失败则保留第一次的诚实缺口，不伪造数字。
 */
/**
 * 刷新结论。用户看到「跑完还是不足」时必须能分辨是**数据本身不够**还是**没去拿数据**——
 * 两者的下一步动作完全不同（补历史 vs 跑刷新）。
 */
type RefreshOutcome = 'not-needed' | 'refreshed' | 'refreshed-still-insufficient' | 'failed';

interface RiskState {
  readonly data: PortfolioRiskData;
  readonly refresh: RefreshOutcome;
}

const var95Metric = (data: PortfolioRiskData) =>
  data.metrics.find((metric) => metric.name === 'var95Pct');

const stepRefresh: WorkflowStep = async (prev, ctx) => {
  const maybeError = prev as { ok?: unknown };
  if (maybeError.ok === false) return prev;
  const first = prev as PortfolioRiskData;
  if (!needsReturnSampleRefresh(first)) {
    return { data: first, refresh: 'not-needed' } satisfies RiskState;
  }

  const to = first.asOf;
  const from = new Date(to.getTime() - PERFORMANCE_REFRESH_LOOKBACK_DAYS * DAY_MS);
  const refreshed = await ctx.tools.get_account_performance.execute({
    accountId: first.accountId,
    from,
    to,
  });
  if (!refreshed.ok) return { data: first, refresh: 'failed' } satisfies RiskState;
  const retried = await executeRisk(ctx, first.accountId, to);
  if (!retried.ok) return { data: first, refresh: 'failed' } satisfies RiskState;
  return {
    data: retried.data,
    refresh:
      var95Metric(retried.data)?.status === 'available'
        ? 'refreshed'
        : 'refreshed-still-insufficient',
  } satisfies RiskState;
};

/**
 * 只有「刷新过、样本仍然不够」才追加一行——这一行回答的是「我已经去拿数据了，
 * 是数据本身不够」。刷新失败/跳过不追加：此时工具自己的 note 就是「没去拿数据」的补法。
 */
const refreshWarnings = (state: RiskState): string[] => {
  if (state.refresh !== 'refreshed-still-insufficient') return [];
  const metric = var95Metric(state.data);
  if (metric === undefined || metric.status !== 'insufficient') return [];
  const count = metric.window?.returnsCount;
  const min = metric.window?.minReturns;
  return [
    `已刷新绩效快照（get_account_performance），但有效日收益仍只有 ${String(count ?? 0)} 个` +
      `${min === undefined ? '' : `（需 ≥${String(min)}）`}，样本本身不足：` +
      '需要更长的账户历史或更多完整估值日，刷新解决不了',
  ];
};

const stepFinalize: WorkflowStep = async (prev) => {
  const state = prev as RiskState;
  const data = state.data;
  const totalAssets = data.valuation.totalAssets;
  const unavailableMetrics = data.metrics
    .filter((metric) => metric.status === 'unavailable' || metric.status === 'insufficient')
    .map((metric) => metric.name);
  return RiskReportOutput.parse({
    schemaVersion: PORTFOLIO_RISK_SCHEMA_VERSION,
    accountId: data.accountId,
    // 分母不完整时不给 totalValue：不完整的总额比缺席更容易被当成结论。
    ...(totalAssets.status === 'available' ? { totalValue: totalAssets.value } : {}),
    holdingsCount: data.coverage.holdingsCount,
    metrics: data.metrics,
    limitCheck: data.limitCheck,
    coverage: data.coverage,
    benchmark: data.benchmark,
    dataHealth: {
      // 缺口优先于「部分可用」：有 unavailable 就不把整份报告标成 partial。
      status: data.metrics.some(
        (metric) => metric.status === 'unavailable' || metric.status === 'insufficient',
      )
        ? 'unavailable'
        : data.metrics.some((metric) => metric.status === 'partial')
          ? 'partial'
          : 'available',
      unavailableMetrics,
    },
    warnings: [...data.warnings, ...refreshWarnings(state)],
    marketSummary: MARKET_SUMMARY,
    generatedAt: new Date(),
  });
};

/**
 * S6a：把已算好的风险日报落成 `Report`（kind `risk`）+ 六槽 envelope。
 * 反证与风险全部来自工具输出的**真实缺口**（指标 status / coverage / limitCheck），不是模板话术。
 */
const stepReport: WorkflowStep = async (prev, ctx) => {
  const output = prev as RiskReportOutputT;
  const now = ctx.clock();
  const date = now.toISOString().slice(0, 10);
  const degraded = output.metrics.filter(
    (metric) => metric.status === 'unavailable' || metric.status === 'insufficient',
  );
  const partial = output.metrics.filter((metric) => metric.status === 'partial');
  const counterEvidence = [
    ...degraded.map(
      (metric) =>
        `${metric.name} 不可用（${metric.status}）${metric.reason === undefined ? '' : `：${metric.reason}`}`,
    ),
    ...partial.map((metric) => `${metric.name} 只是部分可用，口径不完整`),
    output.coverage.unpricedCount > 0
      ? `有 ${output.coverage.unpricedCount} 只持仓缺少可用价格，市值与权重口径不完整`
      : '全部持仓都有可用价格，覆盖完整',
  ];
  const risks = [
    ...output.limitCheck.breaches.map(
      (breach) => `集中度上限被突破：${breach.stockId} 权重超过 ${String(breach.maxPct)}%`,
    ),
    output.dataHealth.status === 'available'
      ? '数据健康为 available；本报告不含缺口'
      : `数据健康为 ${output.dataHealth.status}：${output.dataHealth.unavailableMetrics.join('、') || '存在部分缺口'}`,
    'VaR 只读已落库绩效快照，样本不足时不外推、不估算',
  ];

  const result = await executeReportWorkflow(
    {
      workflowName: 'risk-report',
      kind: 'risk',
      template: 'risk-v1',
      mode: 'manual',
      notify: false,
      scope: { kind: 'account', accountId: output.accountId },
      periodStart: date,
      periodEnd: date,
      title: `${date} 风险日报`,
      buildSections: async (generatedAt): Promise<readonly ReportSectionPiece[]> => [
        {
          evidence: [],
          section: {
            key: 'risk-metrics',
            title: '风险指标',
            required: true,
            status: 'complete',
            dataAsOf: generatedAt,
            blocks: [
              {
                kind: 'metrics',
                items: output.metrics.map((metric) => ({
                  key: metric.name,
                  label: metric.name,
                  value: metric.status === 'available' ? (metric.value ?? null) : null,
                  ...(metric.status === 'available' ? {} : { displayValue: metric.status }),
                })),
              },
              {
                kind: 'text',
                tone: 'factual' as const,
                text: `覆盖：${output.coverage.pricedCount}/${output.coverage.holdingsCount} 只持仓有可用价格。`,
              },
            ],
            evidenceIds: [],
            missingDimensions: [],
          },
        },
        ...envelopeSections({
          dataAsOf: generatedAt,
          conclusion: `${date} 风险日报：${output.holdingsCount} 只持仓，数据健康 ${output.dataHealth.status}。`,
          counterEvidence,
          risks,
          validUntil: new Date(`${date}T23:59:59+08:00`),
        }).map((section) => ({ evidence: [], section })),
      ],
    },
    ctx,
  );
  return {
    ...output,
    ...('ok' in result ? {} : { report: result.report }),
  } satisfies RiskReportOutputT;
};

export const riskReportWorkflow = defineWorkflow<RiskReportInputT, RiskReportOutputT>({
  name: 'risk-report',
  description: '生成账户风险日报（集中度 + VaR，口径唯一实现：get_portfolio_risk）',
  input: RiskReportInput,
  steps: [stepRisk, stepRefresh, stepFinalize, stepReport],
});
