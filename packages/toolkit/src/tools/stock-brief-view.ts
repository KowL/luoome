import type { PluginPolicyLike, Quote, StockBrief } from '@luoome/core';
import { z } from 'zod';

import { type GetStockBriefOutput, StockBriefWordingSchema } from './get-stock-brief.js';
import {
  type BriefListItem,
  StockBriefBudgetSchema,
  StockBriefCoverageSchema,
} from './list-stock-briefs.js';

/**
 * `StockBriefView` 展示投影（design.md §5.2）。
 *
 * Web API、CLI 与脚本共用同一装配：只从 `get_stock_brief` / `list_stock_briefs`
 * 的输出派生展示字段，不重新拉行情、不调 LLM；缺失维度一律显式标注，不补造数值。
 * 措辞复用 `stockBriefWordingOf`（§12.2），本文件不另写一套文案。
 */

export const STOCK_BRIEF_MISSING_LABELS: Readonly<Record<string, string>> = {
  quote: '行情报价',
  'daily-bars': '日线',
  intraday: '分时',
  news: '新闻',
  'sector-quote': '板块行情',
  'sector-membership': '板块归属',
  signals: '策略信号',
  account: '账户事实',
  llm: 'AI 分析',
  plugin: '个股分析插件',
  budget: 'AI 预算',
};

export const stockBriefMissingLabel = (dimension: string): string =>
  STOCK_BRIEF_MISSING_LABELS[dimension] ?? dimension;

export const StockBriefEvidenceSchema = z.object({
  label: z.string().min(1),
  /** 缺失维度为 null：只用 `reason` 说明缺口，不编造数值。 */
  value: z.string().nullable(),
  source: z.string().min(1),
  dataAsOf: z.coerce.date().nullable(),
  missing: z.boolean(),
  reason: z.string().min(1).nullable(),
});
export type StockBriefEvidence = z.infer<typeof StockBriefEvidenceSchema>;

export const StockBriefViewSchema = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  phase: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  decision: z.string().min(1).optional(),
  confidence: z.number().min(0).max(100).optional(),
  horizon: z.string().min(1).optional(),
  adviceId: z.string().min(1).optional(),
  dataAsOf: z.coerce.date().nullable(),
  validUntil: z.coerce.date().nullable(),
  wording: StockBriefWordingSchema,
  disclaimer: z.string().min(1),
  isRuleOnly: z.boolean(),
  evidence: z.array(StockBriefEvidenceSchema),
  missing: z.array(
    z.object({
      dimension: z.string().min(1),
      reason: z.string().min(1),
      source: z.string().min(1).optional(),
      dataAsOf: z.coerce.date().optional(),
    }),
  ),
  warnings: z.array(z.string().min(1)),
  budget: StockBriefBudgetSchema.optional(),
});
export type StockBriefView = z.infer<typeof StockBriefViewSchema>;

export const StockBriefListDegradationSchema = z.object({
  reason: z.literal('plugin_disabled'),
  message: z.string().min(1),
});
export type StockBriefListDegradation = z.infer<typeof StockBriefListDegradationSchema>;

/** `business.analysis` 未启用时的可见降级（design §5.5 / §11）：所有入口共用同一文案。 */
export const BRIEF_PLUGIN_DISABLED_DEGRADATION: StockBriefListDegradation = {
  reason: 'plugin_disabled',
  message:
    '个股分析插件未启用（plugins.json）：仅展示既有规则观察，生成能力不可用；本内容不构成投资建议。',
};

export const stockBriefDegradationOf = (
  policy: PluginPolicyLike | undefined,
): StockBriefListDegradation | undefined =>
  policy?.isEnabled('business.analysis') === false ? BRIEF_PLUGIN_DISABLED_DEGRADATION : undefined;

export const StockBriefListViewSchema = z.object({
  date: z.string().min(1),
  items: z.array(StockBriefViewSchema),
  coverage: StockBriefCoverageSchema,
  budget: StockBriefBudgetSchema,
  degradation: StockBriefListDegradationSchema.optional(),
});
export type StockBriefListView = z.infer<typeof StockBriefListViewSchema>;

const missingEvidence = (
  missing: readonly {
    readonly dimension: string;
    readonly reason: string;
    readonly source?: string | undefined;
    readonly dataAsOf?: Date | undefined;
  }[],
): StockBriefEvidence[] =>
  missing.map((item) => ({
    label: `${stockBriefMissingLabel(item.dimension)}（缺失）`,
    value: null,
    source: item.source ?? 'local/missing',
    dataAsOf: item.dataAsOf ?? null,
    missing: true,
    reason: item.reason,
  }));

const dataSourceEvidence = (
  sources: readonly string[],
  dataAsOf: Date | null,
): StockBriefEvidence[] =>
  sources.map((source) => ({
    label: '数据来源',
    value: source,
    source,
    dataAsOf,
    missing: false,
    reason: null,
  }));

const quoteEvidence = (quote: Quote, dataAsOf: Date | null): StockBriefEvidence => ({
  label: '行情收盘价',
  value: String(quote.close),
  source: quote.source,
  dataAsOf: quote.observedAt ?? quote.ts ?? dataAsOf,
  missing: false,
  reason: null,
});

const INDICATOR_FIELDS = ['ma5', 'ma20', 'ma60', 'rsi14', 'macdHist'] as const;

const indicatorsEvidence = (
  indicators: Readonly<Record<string, unknown>>,
  dataAsOf: Date | null,
): StockBriefEvidence | null => {
  const parts = INDICATOR_FIELDS.flatMap((key) => {
    const value = indicators[key];
    return typeof value === 'number' ? [`${key.toUpperCase()} ${value}`] : [];
  });
  if (parts.length === 0) return null;
  return {
    label: '技术指标',
    value: parts.join(' · '),
    source: 'compute_indicators',
    dataAsOf,
    missing: false,
    reason: null,
  };
};

const adviceEvidence = (
  advice: NonNullable<GetStockBriefOutput['advice']>,
  stockId: string,
): StockBriefEvidence[] => {
  const evidence: StockBriefEvidence[] = [];
  const dataAsOf = advice.basedOn.dataAsOf;
  const quote = advice.basedOn.quotes?.[stockId] ?? advice.basedOn.quotes?.[advice.subjectId];
  if (quote !== undefined) evidence.push(quoteEvidence(quote, dataAsOf));
  const indicators =
    advice.basedOn.indicators?.[stockId] ?? advice.basedOn.indicators?.[advice.subjectId];
  if (indicators !== undefined) {
    const row = indicatorsEvidence(indicators, dataAsOf);
    if (row !== null) evidence.push(row);
  }
  for (const line of advice.reasoning.evidence) {
    evidence.push({
      label: '研究证据',
      value: line,
      source: advice.sourceTool ?? 'analysis',
      dataAsOf,
      missing: false,
      reason: null,
    });
  }
  return evidence;
};

const detailEvidence = (
  brief: StockBrief | undefined,
  advice: GetStockBriefOutput['advice'],
  stockId: string,
): StockBriefEvidence[] => {
  if (brief === undefined) return [];
  const rows =
    advice === undefined
      ? dataSourceEvidence(brief.dataSources, brief.factsAsOf)
      : adviceEvidence(advice, stockId);
  return [...rows, ...missingEvidence(brief.missing)];
};

export const stockBriefViewOfDetail = (
  detail: GetStockBriefOutput,
  budget?: z.infer<typeof StockBriefBudgetSchema>,
): StockBriefView => {
  const brief = detail.brief;
  return {
    stockId: detail.stockId,
    ...(detail.stockName === undefined ? {} : { stockName: detail.stockName }),
    ...(detail.date === undefined ? {} : { date: detail.date }),
    ...(brief === undefined ? {} : { phase: brief.phase }),
    ...(brief === undefined ? {} : { quality: brief.quality }),
    ...(brief === undefined ? {} : { decision: brief.decision }),
    ...(brief === undefined ? {} : { confidence: brief.confidence }),
    ...(brief === undefined ? {} : { horizon: brief.horizon }),
    ...(brief?.adviceId === undefined ? {} : { adviceId: brief.adviceId }),
    dataAsOf: brief?.factsAsOf ?? null,
    validUntil: brief?.validUntil ?? null,
    wording: detail.wording,
    disclaimer: detail.wording.disclaimer,
    isRuleOnly: detail.wording.isRuleOnly,
    evidence: detailEvidence(brief, detail.advice, detail.stockId),
    missing: (brief?.missing ?? []).map((item) => ({
      dimension: item.dimension,
      reason: item.reason,
      ...(item.source === undefined ? {} : { source: item.source }),
      ...(item.dataAsOf === undefined ? {} : { dataAsOf: item.dataAsOf }),
    })),
    warnings: [...detail.warnings],
    ...(budget === undefined ? {} : { budget }),
  };
};

export const stockBriefViewOfItem = (
  item: BriefListItem,
  budget?: z.infer<typeof StockBriefBudgetSchema>,
): StockBriefView => ({
  stockId: item.stockId,
  ...(item.stockName === undefined ? {} : { stockName: item.stockName }),
  date: item.tradingDate,
  phase: item.phase,
  quality: item.quality,
  decision: item.decision,
  confidence: item.confidence,
  horizon: item.horizon,
  ...(item.adviceId === undefined ? {} : { adviceId: item.adviceId }),
  dataAsOf: item.factsAsOf,
  validUntil: item.validUntil,
  wording: item.wording,
  disclaimer: item.wording.disclaimer,
  isRuleOnly: item.wording.isRuleOnly,
  evidence: [
    ...dataSourceEvidence(item.dataSources, item.factsAsOf),
    ...missingEvidence(item.missing),
  ],
  missing: item.missing.map((entry) => ({
    dimension: entry.dimension,
    reason: entry.reason,
    ...(entry.source === undefined ? {} : { source: entry.source }),
    ...(entry.dataAsOf === undefined ? {} : { dataAsOf: entry.dataAsOf }),
  })),
  warnings: [],
  ...(budget === undefined ? {} : { budget }),
});

export const stockBriefListViewOf = (
  output: {
    readonly date: string;
    readonly items: readonly BriefListItem[];
    readonly coverage: z.infer<typeof StockBriefCoverageSchema>;
    readonly budget: z.infer<typeof StockBriefBudgetSchema>;
  },
  degradation?: StockBriefListDegradation,
): StockBriefListView => ({
  date: output.date,
  items: output.items.map((item) => stockBriefViewOfItem(item, output.budget)),
  coverage: output.coverage,
  budget: output.budget,
  ...(degradation === undefined ? {} : { degradation }),
});
