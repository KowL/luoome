import {
  type Advice,
  AdviceDataSnapshotSchema,
  AdviceSchema,
  assertAdviceInvariants,
  STANDARD_DISCLAIMERS,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  type AdviceLLMOutput,
  AdviceLLMSchema,
  computeValidUntil,
  extractLlmRaw,
} from '../internal/build-advice.js';
import { computeSimpleIndicators } from '../internal/indicators.js';

const DAY_MS = 86_400_000;

export const AnalyzeStrategyCandidateInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  stockId: z.string().min(1),
  recommendationTrigger: z.enum(['run', 't1', 't3', 't5', 't20']).default('run'),
});

export const AnalyzeStrategyCandidateOutput = z.object({
  advice: AdviceSchema,
  evidence: AdviceDataSnapshotSchema,
});

const selectedResult = async (runId: string, stockId: string, ctx: ToolContext) =>
  (await ctx.repos.strategyRun.listResults(runId)).find((item) => item.stockId === stockId);

export const analyzeStrategyCandidateTool = defineTool({
  name: 'analyze_strategy_candidate',
  description:
    '对策略股票池中的已入选股票，结合 StrategyResult、StrategySignal 和 T+n 观察生成可追溯 Advice',
  sideEffect: 'advice',
  input: AnalyzeStrategyCandidateInput,
  output: AnalyzeStrategyCandidateOutput,
  handler: async (input, ctx) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    if (run.strategyId !== input.strategyId) {
      return errInvalidInput(`StrategyRun 不属于 Strategy: ${input.runId}`);
    }
    if (run.status !== 'complete' && run.status !== 'partial') {
      return errInvalidInput('只能为已完成且结果可用的 StrategyRun 生成推荐');
    }
    const result = await selectedResult(run.id, input.stockId, ctx);
    if (result === undefined) return errNotFound('StrategyResult', `${run.id}:${input.stockId}`);
    if (!result.selected) return errInvalidInput('只能为当次运行 selected=true 的股票生成推荐');
    const stock = await ctx.repos.stock.findById(input.stockId);
    if (stock === null) return errNotFound('Stock', input.stockId);

    const signals = (await ctx.repos.strategyRun.signalsByRun(run.id)).filter(
      (signal) => signal.stockId === stock.id,
    );
    const observations = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      sourceIds: signals.map((signal) => signal.id),
      limit: 200,
    });
    const now = ctx.clock();
    const [quote, bars, position] = await Promise.all([
      ctx.adapters.market.fetchQuote(stock.id),
      ctx.adapters.market.fetchDailyBars(stock.id, {
        start: new Date(now.getTime() - 120 * DAY_MS),
        end: now,
      }),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
    ]);
    const indicators = computeSimpleIndicators(bars);
    const llmOutput = await ctx.adapters.llm.generate<AdviceLLMOutput>({
      system: 'analyze_stock:strategy_candidate',
      schema: AdviceLLMSchema,
      data: {
        stockId: stock.id,
        code: stock.code,
        name: stock.name,
        quote,
        indicators,
        strategy: {
          strategyId: run.strategyId,
          strategyVersionId: run.strategyVersionId,
          runId: run.id,
          dataAsOf: run.dataAsOf,
          result,
          signals,
          observations,
        },
        ...(position === null
          ? {}
          : { position: { avgCost: position.avgCost, quantity: position.quantity } }),
      },
    });
    const llmRaw = extractLlmRaw(llmOutput);
    const strategyEvidence = {
      strategyId: run.strategyId,
      strategyVersionId: run.strategyVersionId,
      runId: run.id,
      stockId: stock.id,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.rank === undefined ? {} : { rank: result.rank }),
      resultEvidence: [...result.evidence],
      signalIds: signals.map((signal) => signal.id),
      observationIds: observations.map((observation) => observation.id),
      recommendationTrigger: input.recommendationTrigger,
    };
    const advice: Advice = {
      id: globalThis.crypto.randomUUID(),
      subjectKind: 'stock',
      subjectId: stock.id,
      stockName: stock.name,
      decision: llmOutput.decision,
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      reasoning: llmOutput.reasoning,
      risks: llmOutput.risks,
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      sourceWorkflow: 'strategy-recommendations',
      basedOn: {
        quotes: { [stock.id]: quote },
        indicators: { [stock.id]: indicators },
        strategy: strategyEvidence,
        ...(llmRaw === undefined ? {} : { llmReasoning: llmRaw }),
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
