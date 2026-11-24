import {
  dateInShanghai,
  type StockBrief,
  type StockBriefMissingDimension,
  StockBriefMissingSchema,
  StockBriefPhaseSchema,
  StockBriefQualitySchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { DEFAULT_BRIEF_BUDGET_LIMITS, readBriefBudget } from '../internal/llm-budget.js';
import { StockBriefWordingSchema, stockBriefWordingOf } from './get-stock-brief.js';

/**
 * 每日个股观察列表（design.md §5.1）：`read`，只读本地 `stock_briefs`。
 *
 * 不调 LLM、不拉外部行情、不触发生成；budget 只是从 `sumUsage` 读出的当日用量与默认限额。
 */

const BriefListItem = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  tradingDate: z.string().min(1),
  phase: StockBriefPhaseSchema,
  quality: StockBriefQualitySchema,
  decision: z.enum(['buy', 'sell', 'hold', 'watch', 'avoid']),
  confidence: z.number().min(0).max(100),
  horizon: z.string().min(1),
  adviceId: z.string().min(1).optional(),
  factDigest: z.string().min(1),
  factsAsOf: z.coerce.date(),
  validUntil: z.coerce.date(),
  missing: z.array(StockBriefMissingSchema),
  dataSources: z.array(z.string().min(1)),
  llmHttpCalls: z.number().int().nonnegative(),
  llmTokens: z.number().int().nonnegative(),
  wording: StockBriefWordingSchema,
});
export type BriefListItem = z.infer<typeof BriefListItem>;

export const ListStockBriefsInput = z.object({
  /** Asia/Shanghai 交易日；缺省取当日。 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  accountId: z.string().min(1).optional(),
  watchlistId: z.string().min(1).optional(),
  stockIds: z.array(z.string().min(1)).max(50).optional(),
  phase: StockBriefPhaseSchema.optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export const StockBriefCoverageSchema = z.object({
  date: z.string().min(1),
  requested: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  byQuality: z.object({
    ai: z.number().int().nonnegative(),
    ruleOnly: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  missingDimensions: z.array(z.string().min(1)),
});
export type StockBriefCoverage = z.infer<typeof StockBriefCoverageSchema>;

export const StockBriefBudgetSchema = z.object({
  date: z.string().min(1),
  httpCalls: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  limit: z.object({
    maxBriefs: z.number().int().positive(),
    maxHttpCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  }),
});
export type StockBriefBudget = z.infer<typeof StockBriefBudgetSchema>;

export const ListStockBriefsOutput = z.object({
  date: z.string().min(1),
  items: z.array(BriefListItem),
  coverage: StockBriefCoverageSchema,
  budget: StockBriefBudgetSchema,
});
export type ListStockBriefsOutput = z.infer<typeof ListStockBriefsOutput>;

const toItem = (brief: StockBrief, stockName: string | undefined): BriefListItem => ({
  stockId: brief.stockId,
  ...(stockName === undefined ? {} : { stockName }),
  tradingDate: brief.tradingDate,
  phase: brief.phase,
  quality: brief.quality,
  decision: brief.decision,
  confidence: brief.confidence,
  horizon: brief.horizon,
  ...(brief.adviceId === undefined ? {} : { adviceId: brief.adviceId }),
  factDigest: brief.factDigest,
  factsAsOf: brief.factsAsOf,
  validUntil: brief.validUntil,
  missing: brief.missing,
  dataSources: brief.dataSources,
  llmHttpCalls: brief.llmHttpCalls,
  llmTokens: brief.llmPromptTokens + brief.llmCompletionTokens + brief.llmReasoningTokens,
  wording: stockBriefWordingOf(brief),
});

export const listStockBriefsTool = defineTool({
  name: 'list_stock_briefs',
  description:
    '按交易日 / 账户 / 关注列表 / 股票查询每日观察记录，返回结论、质量、缺失维度与当日 AI 用量预算；' +
    '只读本地记录，不触发 AI 生成；本内容为技术研究记录，不构成投资建议。',
  sideEffect: 'read',
  input: ListStockBriefsInput,
  output: ListStockBriefsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const tradingDate = input.date ?? dateInShanghai(ctx.clock());
    const rows =
      input.watchlistId === undefined
        ? await ctx.repos.stockBrief.findByDay({
            tradingDate,
            accountId,
            ...(input.phase === undefined ? {} : { phase: input.phase }),
          })
        : await ctx.repos.stockBrief.listByWatchlistDay({
            watchlistId: input.watchlistId,
            tradingDate,
            accountId,
          });
    const wanted = input.stockIds === undefined ? undefined : new Set(input.stockIds);
    const filtered = rows
      .filter((row) => wanted === undefined || wanted.has(row.stockId))
      .filter((row) => input.phase === undefined || row.phase === input.phase);
    const limited = filtered.slice(0, input.limit);

    const stockIds = [...new Set(limited.map((row) => row.stockId))];
    const names = new Map<string, string>();
    for (const stockId of stockIds) {
      const stock = await ctx.repos.stock.findById(stockId);
      if (stock !== null) names.set(stockId, stock.name);
    }

    const missingDimensions = [
      ...new Set(
        limited.flatMap((row) =>
          row.missing.map((item) => item.dimension as StockBriefMissingDimension),
        ),
      ),
    ].sort();
    const budget = await readBriefBudget(ctx, tradingDate, DEFAULT_BRIEF_BUDGET_LIMITS);

    return {
      date: tradingDate,
      items: limited.map((row) => toItem(row, names.get(row.stockId))),
      coverage: {
        date: tradingDate,
        requested: filtered.length,
        returned: limited.length,
        limit: input.limit,
        byQuality: {
          ai: limited.filter((row) => row.quality === 'ai').length,
          ruleOnly: limited.filter((row) => row.quality === 'rule-only').length,
          partial: limited.filter((row) => row.quality === 'partial').length,
          unavailable: limited.filter((row) => row.quality === 'unavailable').length,
        },
        missingDimensions,
      },
      budget: {
        date: budget.date,
        httpCalls: budget.httpCalls,
        tokens: budget.tokens,
        costUsd: budget.costUsd,
        limit: budget.limit,
      },
    };
  },
});
