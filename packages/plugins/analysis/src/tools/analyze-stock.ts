import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  money,
  PluginExecutionDenied,
  STANDARD_DISCLAIMERS,
  type Stock,
  StrategyAdviceAnalysisSchema,
  summarizeIndicatorAvailability,
  type ToolContext,
} from '@luoome/core';
import { defineTool, errAdapterError, errNotFound } from '@luoome/toolkit';
import { computeSimpleIndicators } from '@luoome/toolkit/internal/indicators.js';
import { numericAuditViolations } from '@luoome/toolkit/internal/numeric-audit.js';
import { resolveQuote } from '@luoome/toolkit/internal/resolve-quotes.js';
import { deriveOpeningFact } from '@luoome/toolkit/internal/stock-facts.js';
import { z } from 'zod';
import {
  assertAdviceAnalysis,
  computeValidUntil,
  generateAdviceAnalysis,
  judgmentViolations,
  sanitizeAdviceReasoning,
  sanitizeAdviceRisks,
} from '../internal/build-advice.js';
import { buildJudgmentContext } from '../internal/market-context.js';
import { ANALYZE_STOCK_SYSTEM } from '../internal/prompts.js';
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
    assertAdviceAnalysis(ctx);
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
    const [quoteItem, bars, position, marketContext] = await Promise.all([
      resolveQuote(ctx, stock.id, { context: 'display' }),
      ctx.adapters.market.fetchDailyBars(stock.id, {
        start: new Date(now.getTime() - BARS_LOOKBACK_DAYS * DAY_MS),
        end: now,
      }),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
      buildJudgmentContext(ctx, stock),
    ]);
    assertAdviceAnalysis(ctx);
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
    const opening = deriveOpeningFact(quote);
    const indicatorAvailability = summarizeIndicatorAvailability(indicators, bars.length);

    const analysisData = {
      stockId: stock.id,
      code: stock.code,
      name: stock.name,
      quote,
      indicators,
      opening,
      barFacts: {
        actualCount: bars.length,
        requiredCount: BARS_LOOKBACK_DAYS,
        indicatorAvailability,
      },
      marketContext,
      ...(position !== null
        ? { position: { avgCost: position.avgCost, quantity: position.quantity } }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    let llmOutput: z.infer<typeof StrategyAdviceAnalysisSchema> | undefined;
    let failure = 'AI 输出未通过建议约束';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await generateAdviceAnalysis<
          z.infer<typeof StrategyAdviceAnalysisSchema>
        >(ctx, {
          system:
            attempt === 0
              ? ANALYZE_STOCK_SYSTEM
              : `${ANALYZE_STOCK_SYSTEM}\n请修复上次输出：${failure}\n若本次无法给出可信价位，就把价格字段全部留空并改判 hold/avoid，不要输出不一致的买点组合。`,
          schema: StrategyAdviceAnalysisSchema,
          data: analysisData,
          policy: { managerRetry: false, providerRetries: 0 },
        });
        const parsed = StrategyAdviceAnalysisSchema.safeParse(generated);
        if (!parsed.success) {
          failure = parsed.error.issues.map((issue) => issue.message).join('；');
          continue;
        }
        const violations = judgmentViolations(parsed.data);
        if (violations.length > 0) {
          failure = violations.join('；');
          continue;
        }
        const auditViolations = numericAuditViolations({
          output: parsed.data,
          facts: analysisData,
          availableFields: Object.keys(indicators),
        });
        if (auditViolations.length > 0) {
          failure = auditViolations.join('；');
          continue;
        }
        llmOutput = parsed.data;
        break;
      } catch (error) {
        if (error instanceof PluginExecutionDenied) throw error;
        // 把适配器/manager 的真实错误（预算耗尽、超时、schema 原文）带到下一次提示词。
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    if (llmOutput === undefined) {
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
