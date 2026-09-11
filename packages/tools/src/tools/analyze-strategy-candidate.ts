import {
  ActiveStrategyRecommendationTriggerSchema,
  type Advice,
  AdviceDataSnapshotSchema,
  type AdviceDecision,
  type AdviceReasoning,
  AdviceSchema,
  assertAdviceInvariants,
  type DailyBar,
  isActiveSignalObservationHorizon,
  isAdviceQuoteCurrent,
  isPublishableOperationalRun,
  type MarketDataAdapterLike,
  money,
  type Quote,
  type SignalObservation,
  STANDARD_DISCLAIMERS,
  StrategyAdviceAnalysisSchema,
  type StrategyResult,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
import {
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
- 看多信号仅是研究线索。只有当前证据足以支持、风险和反证已核对且价格计划合理时才输出 buy。
- 证据不足或条件尚未满足时输出 watch，并说明需要观察的条件；不能为了给出行动而预设买入。
- avoid 用于明确利空或信号前提已被破坏时。
- buy 必须输出 entryPriceLow、entryPriceHigh（参考 quote.close 与均线/支撑位，形成入场区间）、
  entryPrice（区间内的代表性买点）、targetPositionPct（按账户总资产的目标仓位百分比）、
  targetPrice（目标卖点）和 stopLoss（止损，须低于 entryPriceLow）；价格均与 quote.close 同单位。
- watch 可缺省价位；若给出价位，在 premise 说明触发买入的条件与对应价位。
- 入场区间必须满足 0 < stopLoss < entryPriceLow <= entryPrice <= entryPriceHigh < targetPrice，
  targetPositionPct 必须在 0 到 100 之间。
- 不得为策略添加输入 JSON 中不存在的名称、类型或历史表现。
- indicators 可能因可选日线 enrichment 不可用而为空；不得补造缺失指标。
- 必须提供非空反证和风险；有价位时必须满足 0 < stopLoss < entryPrice < targetPrice。
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
    const observations = (
      await ctx.repos.signalObservation.list({
        sourceKind: 'strategy-signal',
        sourceIds: signals.map((signal) => signal.id),
        limit: 200,
      })
    ).filter((item) => isActiveSignalObservationHorizon(item.horizon));
    const now = ctx.clock();
    // 行情走统一 resolveQuote：实时拉取，上游缺席回退本地最近快照。
    const [quoteItem, bars, position] = await Promise.all([
      resolveQuote(ctx, stock.id, { context: 'display' }),
      fetchStrategyCandidateBars(ctx.adapters.market, stock.id, now),
      ctx.repos.holding.findByAccountAndStock(ctx.user.defaultAccountId, stock.id),
    ]);
    const quote = [
      quoteItem?.status === 'ok' ? quoteItem.quote : undefined,
      quoteFromLatestStrategyBar(bars, now),
    ].find((item) => item !== undefined && isAdviceQuoteCurrent(item, now));
    if (quote === undefined) {
      return errAdapterError(
        ctx.adapters.market.name,
        quoteItem !== undefined && quoteItem.status === 'unavailable'
          ? quoteItem.reason
          : 'quote_stale_or_unavailable',
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
    const analysisData = {
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
      ...(position === null || position.quantity === 0 || position.closedAt !== null
        ? {}
        : { position: { avgCost: position.avgCost, quantity: position.quantity } }),
    };
    let llmOutput: z.infer<typeof StrategyAdviceAnalysisSchema> | undefined;
    let llmRaw: string | undefined;
    let failure = 'AI 输出未通过建议约束';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const generated = await ctx.adapters.llm.generate<
          z.infer<typeof StrategyAdviceAnalysisSchema>
        >({
          system: `${STRATEGY_ADVICE_SYSTEM}${attempt === 0 ? '' : `\n请修复上次输出：${failure}`}`,
          schema: StrategyAdviceAnalysisSchema,
          data: analysisData,
        });
        const parsed = StrategyAdviceAnalysisSchema.safeParse(generated);
        if (!parsed.success) {
          failure = parsed.error.issues.map((issue) => issue.message).join('；');
          continue;
        }
        const grounded = StrategyAdviceAnalysisSchema.safeParse({
          ...parsed.data,
          reasoning: groundStrategyAdviceReasoning(
            parsed.data.reasoning,
            groundedResult,
            signals,
            observations,
          ),
          risks: groundStrategyAdviceRisks(parsed.data.risks),
        });
        if (!grounded.success) {
          failure = '事实校验后反证或风险为空，请补充具体且可核对的限制';
          continue;
        }
        llmOutput = grounded.data;
        llmRaw = extractLlmRaw(generated);
        break;
      } catch {
        failure = 'AI 调用失败或输出无效';
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
    const reasoning = llmOutput.reasoning;
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
      decision: normalizeStrategyCandidateDecision(
        llmOutput.decision,
        position !== null && position.quantity > 0 && position.closedAt === null,
      ),
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
      reasoning,
      risks: llmOutput.risks,
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      sourceWorkflow: 'strategy-recommendations',
      basedOn: {
        quotes: { [stock.id]: quote },
        indicators: { [stock.id]: indicators },
        strategy: strategyEvidence,
        ...(llmRaw === undefined ? {} : { llmReasoning: llmRaw }),
        dataAsOf: quote.observedAt,
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
