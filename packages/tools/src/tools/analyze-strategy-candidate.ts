import {
  ActiveStrategyRecommendationTriggerSchema,
  type Advice,
  AdviceDataSnapshotSchema,
  type AdviceDecision,
  type AdviceReasoning,
  AdviceSchema,
  assertAdviceInvariants,
  type DailyBar,
  isPublishableOperationalRun,
  type MarketDataAdapterLike,
  type Quote,
  type SignalObservation,
  STANDARD_DISCLAIMERS,
  type StrategyResult,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
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

const STRATEGY_ADVICE_SYSTEM = `analyze_stock:strategy_candidate
你只能依据输入 JSON 中的 StrategyResult、StrategySignal、SignalObservation、quote 和 indicators 生成 Advice。
- 逐项核对数字和大小关系；不得声称输入中不存在或与输入数值矛盾的事实。
- reasoning.evidence 只写可由输入直接复核的事实，避免重复。
- pending/unavailable 的 SignalObservation 表示尚无事后结果，不是反证，不是回测，也不得据此判断策略有效或无效。
- confidence 是主观信心度，不是收益概率；Advice 不代表交易，也不得声称会自动下单。
- position 缺省时没有持仓，只能输出 buy/watch/avoid，不能输出 hold/sell。
- 信号看多（signal.direction=bullish）且 quote 未明确违背信号前提时，应明确输出 buy，
  并在 premise 给出买入理由、risks 给出主要风险；不要因细微波动就退回 watch。
- watch 仅用于存在明确风险信号（显著回落/破位、冲高回落派发、量价背离等）或信息不足以判断时，
  并说明观察什么条件可转为买入。
- avoid 用于明确利空或信号前提已被破坏时。
- 不得为策略添加输入 JSON 中不存在的名称、类型或历史表现。
- indicators 可能因可选日线 enrichment 不可用而为空；不得补造缺失指标。
- 反证和风险必须明确使用“可能、若、需验证”等不确定措辞，不能伪装成已发生事实。`;

export const AnalyzeStrategyCandidateInput = z.object({
  strategyId: z.string().min(1),
  runId: z.string().min(1),
  stockId: z.string().min(1),
  recommendationTrigger: ActiveStrategyRecommendationTriggerSchema.default('run'),
});

export const AnalyzeStrategyCandidateOutput = z.object({
  advice: AdviceSchema,
  evidence: AdviceDataSnapshotSchema,
});

const selectedResult = async (runId: string, stockId: string, ctx: ToolContext) =>
  (await ctx.repos.strategyRun.listResults(runId)).find((item) => item.stockId === stockId);

export const quoteFromLatestStrategyBar = (
  bars: readonly DailyBar[],
  fetchedAt: Date,
): Quote | undefined => {
  const latest = bars.reduce<DailyBar | undefined>(
    (current, bar) => (current === undefined || bar.date > current.date ? bar : current),
    undefined,
  );
  if (latest === undefined) return undefined;
  return {
    stockId: latest.stockId,
    observedAt: latest.date,
    fetchedAt,
    timestampSource: 'upstream',
    ts: latest.date,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    volume: latest.volume,
    source: `daily-bar-fallback:${latest.source}`,
  };
};

export const normalizeStrategyCandidateDecision = (
  decision: AdviceDecision,
  hasPosition: boolean,
): AdviceDecision => {
  if (hasPosition || (decision !== 'hold' && decision !== 'sell')) return decision;
  return decision === 'hold' ? 'watch' : 'avoid';
};

export const fetchStrategyCandidateBars = async (
  market: Pick<MarketDataAdapterLike, 'fetchDailyBars'>,
  stockId: string,
  now: Date,
): Promise<DailyBar[]> => {
  try {
    return await market.fetchDailyBars(stockId, {
      start: new Date(now.getTime() - 120 * DAY_MS),
      end: now,
    });
  } catch {
    return [];
  }
};

const GENERATED_STRATEGY_FACT_REJECTION = /更正|回测/;

export const groundStrategyAdviceReasoning = (
  reasoning: AdviceReasoning,
  result: StrategyResult,
  signals: readonly StrategySignal[],
  observations: readonly SignalObservation[],
): AdviceReasoning => {
  const sanitized = sanitizeAdviceReasoning(reasoning);
  const resultScore = result.score === undefined ? '' : `; score=${result.score}`;
  const resultRank = result.rank === undefined ? '' : `; rank=${result.rank}`;
  return {
    premise: GENERATED_STRATEGY_FACT_REJECTION.test(sanitized.premise)
      ? `策略运行已入选 ${result.stockId}；Advice 基于已持久化策略事实，事后观察状态单独列示。`
      : sanitized.premise,
    evidence: [
      `StrategyResult ${result.runId}:${result.stockId}: selected=${result.selected}${resultScore}${resultRank}`,
      ...result.evidence.map((item) => `StrategyResult evidence: ${item}`),
      ...signals.map(
        (signal) =>
          `StrategySignal ${signal.id}: direction=${signal.direction}; score=${signal.score}; evidence=${signal.evidence.join('；')}`,
      ),
      ...observations.map(
        (observation) =>
          `SignalObservation ${observation.id}: ${observation.horizon}=${observation.status}`,
      ),
    ],
    counterEvidence: sanitized.counterEvidence.filter(
      (item) => !GENERATED_STRATEGY_FACT_REJECTION.test(item),
    ),
  };
};

export const groundStrategyAdviceRisks = (risks: readonly string[]): readonly string[] =>
  sanitizeAdviceRisks(risks).filter((item) => !GENERATED_STRATEGY_FACT_REJECTION.test(item));

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
    if (!isPublishableOperationalRun(run)) {
      return errInvalidInput('只能为 published operational StrategyRun 生成推荐');
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
    // 行情走统一 resolveQuote：实时拉取，上游缺席回退本地最近快照。
    const [quoteItem, bars, position] = await Promise.all([
      resolveQuote(ctx, stock.id, { context: 'display' }),
      fetchStrategyCandidateBars(ctx.adapters.market, stock.id, now),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
    ]);
    const quote =
      quoteItem !== undefined && quoteItem.status === 'ok'
        ? quoteItem.quote
        : quoteFromLatestStrategyBar(bars, now);
    if (quote === undefined) {
      return errAdapterError(
        ctx.adapters.market.name,
        quoteItem !== undefined && quoteItem.status === 'unavailable'
          ? quoteItem.reason
          : 'quote_unavailable',
        true,
      );
    }
    const indicators = computeSimpleIndicators(bars);
    const groundedResult = { ...result, evidence: [...new Set(result.evidence)] };
    const observationsForPrompt = observations.map((observation) =>
      observation.status === 'pending'
        ? {
            id: observation.id,
            horizon: observation.horizon,
            status: observation.status,
            dueAt: observation.dueAt,
            meaning: '确定性事后观察尚未完成；不是反证，也不是回测结果',
          }
        : observation,
    );
    const llmOutput = await ctx.adapters.llm.generate<AdviceLLMOutput>({
      system: STRATEGY_ADVICE_SYSTEM,
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
          result: groundedResult,
          signals,
          observations: observationsForPrompt,
        },
        ...(position === null
          ? {}
          : { position: { avgCost: position.avgCost, quantity: position.quantity } }),
      },
    });
    const llmRaw = extractLlmRaw(llmOutput);
    const reasoning = groundStrategyAdviceReasoning(
      llmOutput.reasoning,
      groundedResult,
      signals,
      observations,
    );
    const strategyEvidence = {
      strategyId: run.strategyId,
      strategyVersionId: run.strategyVersionId,
      runId: run.id,
      stockId: stock.id,
      accountId: ctx.user.defaultAccountId,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.rank === undefined ? {} : { rank: result.rank }),
      resultEvidence: groundedResult.evidence,
      signalIds: signals.map((signal) => signal.id),
      observationIds: observations.map((observation) => observation.id),
      recommendationTrigger: input.recommendationTrigger,
    };
    const advice: Advice = {
      id: globalThis.crypto.randomUUID(),
      subjectKind: 'stock',
      subjectId: stock.id,
      stockName: stock.name,
      decision: normalizeStrategyCandidateDecision(llmOutput.decision, position !== null),
      confidence: llmOutput.confidence,
      horizon: llmOutput.horizon,
      reasoning,
      risks: groundStrategyAdviceRisks(llmOutput.risks),
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
