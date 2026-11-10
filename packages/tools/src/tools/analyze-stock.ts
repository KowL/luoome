import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  money,
  STANDARD_DISCLAIMERS,
  type Stock,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import {
  type AdviceLLMOutput,
  AdviceLLMSchema,
  computeValidUntil,
  extractLlmRaw,
  sanitizeAdviceReasoning,
  sanitizeAdviceRisks,
} from '../internal/build-advice.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import { resolveQuote } from '../internal/resolve-quotes.js';
import { analyzeStrategyCandidateTool } from './analyze-strategy-candidate.js';
import { MarketOutlookOutput, marketOutlookTool } from './market-outlook.js';

const DAY_MS = 86_400_000;
/** 拉日线的回看窗口。 */
const BARS_LOOKBACK_DAYS = 120;

export const AnalyzeStockInput = z
  .object({
    /** scope=stock / strategy-candidate 时必填；Stock.id 或纯代码。 */
    stockId: z.string().min(1).optional(),
    /** 附加备注（会进入 LLM 上下文，可选）。 */
    notes: z.string().max(2000).optional(),
    /** stock=个股深度分析；market=市场/板块展望（合并 market_outlook）；strategy-candidate=策略候选分析。 */
    scope: z.enum(['stock', 'market', 'strategy-candidate']).default('stock'),
    theme: z.string().max(50).optional(),
    watchlistIds: z.array(z.string().min(1)).max(50).optional(),
    strategyId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    recommendationTrigger: z
      .enum(['run', 'intraday-price', 'intraday-signal', 'manual'])
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scope === 'stock' && input.stockId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['stockId'], message: 'scope=stock 需要 stockId' });
    }
    if (input.scope === 'strategy-candidate') {
      for (const [field, value] of [
        ['strategyId', input.strategyId],
        ['runId', input.runId],
        ['stockId', input.stockId],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'scope=strategy-candidate 需要 strategyId/runId/stockId',
          });
        }
      }
    }
  });

export const AnalyzeStockOutput = z.union([
  z.object({
    advice: AdviceSchema,
    evidence: AdviceDataSnapshotSchema,
  }),
  MarketOutlookOutput,
]);

const resolveStock = async (input: string, ctx: ToolContext): Promise<Stock | null> => {
  const byId = await ctx.repos.stock.findById(input);
  if (byId !== null) return byId;
  return ctx.repos.stock.findByCode(input.trim().toUpperCase());
};

export const analyzeStockTool = defineTool({
  name: 'analyze_stock',
  description: '对指定股票做综合分析（行情 + 指标 + 持仓上下文 → LLM → 结构化 Advice）并持久化',
  sideEffect: 'advice',
  input: AnalyzeStockInput,
  output: AnalyzeStockOutput,
  handler: async (input, ctx) => {
    if (input.scope === 'market') {
      const result = await marketOutlookTool.execute(
        {
          ...(input.theme === undefined ? {} : { theme: input.theme }),
          ...(input.watchlistIds === undefined ? {} : { watchlistIds: input.watchlistIds }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return result.data;
    }
    if (input.scope === 'strategy-candidate') {
      const result = await analyzeStrategyCandidateTool.execute(
        {
          strategyId: input.strategyId as string,
          runId: input.runId as string,
          stockId: input.stockId as string,
          ...(input.recommendationTrigger === undefined
            ? {}
            : { recommendationTrigger: input.recommendationTrigger }),
        },
        ctx,
      );
      if (!result.ok) return result;
      return result.data;
    }
    const stock = await resolveStock(input.stockId as string, ctx);
    if (stock === null) return errNotFound('Stock', input.stockId as string);

    // ARCHITECTURE §6.3：拉行情 + 指标 → 持仓上下文 → LLM 推理 → 组装 → 校验 → 持久化。
    // 行情走统一 resolveQuote：实时拉取，上游缺席回退本地最近快照。
    const now = ctx.clock();
    const [quoteItem, bars, position] = await Promise.all([
      resolveQuote(ctx, stock.id, { context: 'display' }),
      ctx.adapters.market.fetchDailyBars(stock.id, {
        start: new Date(now.getTime() - BARS_LOOKBACK_DAYS * DAY_MS),
        end: now,
      }),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
    ]);
    if (quoteItem === undefined || quoteItem.status !== 'ok') {
      return errAdapterError(
        ctx.adapters.market.name,
        quoteItem !== undefined && quoteItem.status === 'unavailable'
          ? quoteItem.reason
          : 'quote_unavailable',
        true,
      );
    }
    const quote = quoteItem.quote;
    const indicators = computeSimpleIndicators(bars);

    const llmOutput = await ctx.adapters.llm.generate<AdviceLLMOutput>({
      system: 'analyze_stock',
      schema: AdviceLLMSchema,
      data: {
        stockId: stock.id,
        code: stock.code,
        name: stock.name,
        quote,
        indicators,
        ...(position !== null
          ? { position: { avgCost: position.avgCost, quantity: position.quantity } }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    const llmRaw = extractLlmRaw(llmOutput);

    const advice: Advice = {
      id: globalThis.crypto.randomUUID(),
      subjectKind: 'stock',
      subjectId: stock.id,
      stockName: stock.name,
      decision: llmOutput.decision,
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      ...(llmOutput.entryPrice === undefined ? {} : { entryPrice: money(llmOutput.entryPrice) }),
      ...(llmOutput.entryPriceLow === undefined
        ? {}
        : { entryPriceLow: money(llmOutput.entryPriceLow) }),
      ...(llmOutput.entryPriceHigh === undefined
        ? {}
        : { entryPriceHigh: money(llmOutput.entryPriceHigh) }),
      ...(llmOutput.targetPositionPct === undefined
        ? {}
        : { targetPositionPct: llmOutput.targetPositionPct }),
      ...(llmOutput.targetPrice === undefined ? {} : { targetPrice: money(llmOutput.targetPrice) }),
      ...(llmOutput.stopLoss === undefined ? {} : { stopLoss: money(llmOutput.stopLoss) }),
      reasoning: sanitizeAdviceReasoning(llmOutput.reasoning),
      risks: sanitizeAdviceRisks(llmOutput.risks),
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_stock',
      basedOn: {
        quotes: { [stock.id]: quote },
        indicators: { [stock.id]: indicators },
        ...(llmRaw !== undefined ? { llmReasoning: llmRaw } : {}),
        dataAsOf: now,
      },
      validFrom: now,
      validUntil: computeValidUntil(llmOutput.horizon, now),
      createdAt: now,
    };

    assertAdviceInvariants(advice);
    await ctx.repos.advice.save(advice);

    // 经 schema parse 返回输出类型（运行时幂等，类型层把 readonly 数组转成输出形状）。
    return {
      advice: AdviceSchema.parse(advice),
      evidence: AdviceDataSnapshotSchema.parse(advice.basedOn),
    };
  },
});
