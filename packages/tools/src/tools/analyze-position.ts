import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  money,
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
    // 持仓来自账本（当前持仓即权威）；不再支持由账户快照派生的持仓引用。
    const holding = await ctx.repos.holding.findById(input.holdingId);
    if (holding === null) return errNotFound('Holding', input.holdingId);
    const { stockId, quantity, availableQuantity, avgCost, openedAt } = holding;
    const stock = await ctx.repos.stock.findById(stockId);
    if (stock === null) return errNotFound('Stock', stockId);

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

    const promptData = {
      stockId: stock.id,
      code: stock.code,
      name: stock.name,
      holding: {
        ...(avgCost === undefined ? {} : { avgCost }),
        quantity,
        availableQuantity,
        ...(openedAt === undefined ? {} : { openedAt }),
      },
      quote,
      indicators,
    };
    const buildAdvice = (output: AdviceLLMOutput, llmRaw: string | undefined): Advice => ({
      id: globalThis.crypto.randomUUID(),
      subjectKind: 'position',
      subjectId: holding.id,
      stockName: stock.name,
      decision: output.decision,
      confidence: output.confidence,
      horizon: output.horizon,
      ...(output.entryPrice === undefined ? {} : { entryPrice: money(output.entryPrice) }),
      ...(output.entryPriceLow === undefined ? {} : { entryPriceLow: money(output.entryPriceLow) }),
      ...(output.entryPriceHigh === undefined
        ? {}
        : { entryPriceHigh: money(output.entryPriceHigh) }),
      ...(output.targetPositionPct === undefined
        ? {}
        : { targetPositionPct: output.targetPositionPct }),
      ...(output.targetPrice === undefined ? {} : { targetPrice: money(output.targetPrice) }),
      ...(output.stopLoss === undefined ? {} : { stopLoss: money(output.stopLoss) }),
      reasoning: sanitizeAdviceReasoning(output.reasoning),
      risks: sanitizeAdviceRisks(output.risks),
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_position',
      basedOn: {
        quotes: { [stock.id]: quote },
        indicators: { [stock.id]: indicators },
        ...(llmRaw !== undefined ? { llmReasoning: llmRaw } : {}),
        dataAsOf: now,
      },
      validFrom: now,
      validUntil: computeValidUntil(output.horizon, now),
      createdAt: now,
    });

    // 价格结构（止损 < 买点 < 目标价、买点落在区间内）由不变量校验；上游模型经常给出
    // 自相矛盾的价位，这里把具体违规原因回灌给它再试一次，避免整只持仓当天没有结论。
    let advice: Advice | undefined;
    let failure = 'AI 输出未通过建议约束';
    for (let attempt = 0; attempt < 2 && advice === undefined; attempt += 1) {
      const generated = await ctx.adapters.llm.generate<AdviceLLMOutput>({
        system:
          attempt === 0 ? 'analyze_position' : `analyze_position\n\n[修复上次输出] ${failure}`,
        schema: AdviceLLMSchema,
        data: promptData,
      });
      const parsed = AdviceLLMSchema.safeParse(generated);
      if (!parsed.success) {
        failure = parsed.error.issues.map((issue) => issue.message).join('；');
        continue;
      }
      const candidate = buildAdvice(parsed.data, extractLlmRaw(generated));
      try {
        assertAdviceInvariants(candidate);
        advice = candidate;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (advice === undefined) {
      return {
        ok: false as const,
        error: {
          kind: 'llm_error' as const,
          provider: ctx.adapters.llm.name,
          cause: failure,
          retryable: true,
        },
      };
    }
    await ctx.repos.advice.save(advice);

    return {
      advice: AdviceSchema.parse(advice),
      evidence: AdviceDataSnapshotSchema.parse(advice.basedOn),
    };
  },
});
