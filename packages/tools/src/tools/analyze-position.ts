import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  STANDARD_DISCLAIMERS,
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

const DAY_MS = 86_400_000;
const BARS_LOOKBACK_DAYS = 120;

export const AnalyzePositionInput = z.object({
  holdingId: z.string().min(1),
});

export const AnalyzePositionOutput = z.object({
  advice: AdviceSchema,
  evidence: AdviceDataSnapshotSchema,
});

export const analyzePositionTool = defineTool({
  name: 'analyze_position',
  description:
    '对单个持仓给出继续持有 / 加仓 / 减仓 / 清仓建议（持仓上下文 → LLM → 结构化 Advice）并持久化',
  sideEffect: 'advice',
  input: AnalyzePositionInput,
  output: AnalyzePositionOutput,
  handler: async (input, ctx) => {
    const holding = await ctx.repos.holding.findById(input.holdingId);
    if (holding === null) return errNotFound('Holding', input.holdingId);
    const stock = await ctx.repos.stock.findById(holding.stockId);
    if (stock === null) return errNotFound('Stock', holding.stockId);

    const now = ctx.clock();
    // 行情走统一 resolveQuote：实时拉取，上游缺席回退本地最近快照。
    const [quoteItem, bars] = await Promise.all([
      resolveQuote(ctx, stock.id, { context: 'display' }),
      ctx.adapters.market.fetchDailyBars(stock.id, {
        start: new Date(now.getTime() - BARS_LOOKBACK_DAYS * DAY_MS),
        end: now,
      }),
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
      system: 'analyze_position',
      schema: AdviceLLMSchema,
      data: {
        stockId: stock.id,
        code: stock.code,
        name: stock.name,
        holding: {
          avgCost: holding.avgCost,
          quantity: holding.quantity,
          openedAt: holding.openedAt,
        },
        quote,
        indicators,
      },
    });
    const llmRaw = extractLlmRaw(llmOutput);

    const advice: Advice = {
      id: globalThis.crypto.randomUUID(),
      subjectKind: 'position',
      subjectId: holding.id,
      stockName: stock.name,
      decision: llmOutput.decision,
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      reasoning: sanitizeAdviceReasoning(llmOutput.reasoning),
      risks: sanitizeAdviceRisks(llmOutput.risks),
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_position',
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

    return {
      advice: AdviceSchema.parse(advice),
      evidence: AdviceDataSnapshotSchema.parse(advice.basedOn),
    };
  },
});
