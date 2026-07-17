import { MOCK_LLM_SYSTEM_ANALYZE_STOCK } from '@luoome/adapters';
import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  STANDARD_DISCLAIMERS,
  type Stock,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import {
  type AdviceLLMOutput,
  AdviceLLMSchema,
  computeValidUntil,
  extractLlmRaw,
} from '../internal/build-advice.js';
import { computeSimpleIndicators } from '../internal/indicators.js';

const DAY_MS = 86_400_000;
/** 拉日线的回看窗口（MockMarketAdapter 固定返回 60 根，端点对齐 range.end）。 */
const BARS_LOOKBACK_DAYS = 120;

export const AnalyzeStockInput = z.object({
  /** Stock.id（如 '002594.SZ'）或纯代码（如 '002594'）。 */
  stockId: z.string().min(1),
  /** 附加备注（会进入 LLM 上下文，可选）。 */
  notes: z.string().max(2000).optional(),
});

export const AnalyzeStockOutput = z.object({
  advice: AdviceSchema,
  evidence: AdviceDataSnapshotSchema,
});

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
    const stock = await resolveStock(input.stockId, ctx);
    if (stock === null) return errNotFound('Stock', input.stockId);

    // ARCHITECTURE §6.3：拉行情 + 指标 → 持仓上下文 → LLM 推理 → 组装 → 校验 → 持久化。
    const now = ctx.clock();
    const [quote, bars, position] = await Promise.all([
      ctx.adapters.market.fetchQuote(stock.id),
      ctx.adapters.market.fetchDailyBars(stock.id, {
        start: new Date(now.getTime() - BARS_LOOKBACK_DAYS * DAY_MS),
        end: now,
      }),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
    ]);
    const indicators = computeSimpleIndicators(bars);

    const llmOutput = await ctx.adapters.llm.generate<AdviceLLMOutput>({
      system: MOCK_LLM_SYSTEM_ANALYZE_STOCK,
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
      decision: llmOutput.decision,
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      reasoning: llmOutput.reasoning,
      risks: llmOutput.risks,
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
