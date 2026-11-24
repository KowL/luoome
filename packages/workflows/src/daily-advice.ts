import { AdviceSchema, dateInShanghai, isRuleFallbackAdvice } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';

/** 高信心度阈值（AGENTS.md「Advice 输出的关键字段」：confidence ≥ 70 为高信心）。 */
export const HIGH_CONFIDENCE_THRESHOLD = 70;

/** 候选池上限：持仓之外每天最多看这么多只（含手动关注池与策略补位）。 */
export const DAILY_CANDIDATE_LIMIT = 10;

/** 策略信号补位上限：手动关注池之外，策略每天最多补这么多只。 */
export const STRATEGY_CANDIDATE_LIMIT = 3;

/** 参与补位的策略数量上限（Q7：策略引擎降级为信号事实源，只留少量策略）。 */
export const STRATEGY_SIGNAL_SOURCE_LIMIT = 2;

/** 只有 score 达到该值的 bullish 信号才进入候选池。 */
export const STRATEGY_SIGNAL_MIN_SCORE = 60;

/** 与 daily-stock-briefs 同风格的自身运行审计名。 */
export const DAILY_ADVICE_WORKFLOW_NAME = 'daily-advice';

export const DailyAdviceInput = z.object({
  /** 账户 id（uuid）；缺省为当前用户默认账户。 */
  accountId: z.uuid().optional(),
  /**
   * true 时不调用 analyze_stock / generate_stock_briefs，只读当日 stock_briefs 组装结论。
   * 17:30 调度默认走这条路径；false 保留旧生成路径（回退开关 / CLI 显式调用）。
   */
  briefsOnly: z.boolean().default(false),
  /** 运行来源：scheduled 时写 workflow_runs 审计；manual 不落审计。 */
  mode: z.enum(['manual', 'scheduled', 'daemon']).default('manual'),
});
export type DailyAdviceInput = z.infer<typeof DailyAdviceInput>;

const ActionableSchema = z.object({
  stockId: z.string().min(1),
  name: z.string().min(1),
  decision: z.enum(['buy', 'sell']),
  confidence: z.number().int().min(0).max(100),
  horizon: z.string().min(1),
});

const QualityCountsSchema = z.object({
  /** 当日 quality='ai' 的观察条数。 */
  ai: z.number().int().nonnegative(),
  /** 规则观察 / LLM 降级条数（不含 unavailable）。 */
  ruleOnly: z.number().int().nonnegative(),
  /** 部分维度缺失但仍带 AI 结论的观察条数（预留给后续阶段）。 */
  partial: z.number().int().nonnegative(),
  /** 行情等关键维度不可用的条数。 */
  unavailable: z.number().int().nonnegative(),
});
export type DailyAdviceQualityCounts = z.infer<typeof QualityCountsSchema>;

export const DailyAdviceSummary = z.object({
  /** 成功生成建议的条数（单票失败会被跳过）。 */
  total: z.number().int().nonnegative(),
  /** 其中高信心度（confidence ≥ HIGH_CONFIDENCE_THRESHOLD）条数。 */
  highConfidence: z.number().int().nonnegative(),
  /** 持仓数量。 */
  holdings: z.number().int().nonnegative(),
  /** 候选池实际参与判断的数量（≤ DAILY_CANDIDATE_LIMIT）。 */
  candidates: z.number().int().nonnegative(),
  /** `judgment.items` 条数（只计 quality='ai' 且 decision ∈ buy/sell）。 */
  actionable: z.number().int().nonnegative(),
  /** 当日观察质量分布；规则观察 / unavailable 不得冒充 AI 信号。 */
  quality: QualityCountsSchema,
});
export type DailyAdviceSummary = z.infer<typeof DailyAdviceSummary>;

/**
 * 当日结论。每天必须给出一句话结论：
 * 「今日不动」是正式结论（没有值得做的标的），不是没跑出结果。
 */
const JudgmentSchema = z.object({
  action: z.enum(['今日不动', '今日可动']),
  reason: z.string().min(1),
  items: z.array(ActionableSchema),
});

export const DailyAdviceOutput = z.object({
  advices: z.array(AdviceSchema),
  judgment: JudgmentSchema,
  summary: DailyAdviceSummary,
});
export type DailyAdviceOutput = z.infer<typeof DailyAdviceOutput>;

type AnalyzedAdvice = z.output<typeof AdviceSchema>;
type HoldingRow = { holding: { stockId: string } };

interface AdviceAudit {
  readonly workflowRunId: string;
  readonly mode: DailyAdviceInput['mode'];
  readonly startedAt: Date;
  readonly briefsOnly: boolean;
}

/** 17:30 调度接入后的最小审计：只对 scheduled/daemon 运行落 workflow_runs。 */
const startAudit = async (
  ctx: WorkflowContext,
  input: DailyAdviceInput,
): Promise<AdviceAudit | undefined> => {
  if (input.mode === 'manual') return undefined;
  const startedAt = ctx.clock();
  const workflowRunId = `workflow-${DAILY_ADVICE_WORKFLOW_NAME}-${globalThis.crypto.randomUUID()}`;
  const recorded = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: DAILY_ADVICE_WORKFLOW_NAME,
      mode: input.mode,
      status: 'running',
      startedAt,
      inputSummary: {
        briefsOnly: input.briefsOnly,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      },
      providerStatuses: [],
    },
  });
  if (!recorded.ok) {
    ctx.logger.warn('daily-advice: workflow_runs 审计写入失败，继续生成结论', {
      cause: recorded.error,
    });
    return undefined;
  }
  return { workflowRunId, mode: input.mode, startedAt, briefsOnly: input.briefsOnly };
};

const finishAudit = async (
  ctx: WorkflowContext,
  audit: AdviceAudit | undefined,
  output: DailyAdviceOutput,
): Promise<void> => {
  if (audit === undefined) return;
  const recorded = await ctx.tools.record_workflow_run.execute({
    run: {
      id: audit.workflowRunId,
      workflowName: DAILY_ADVICE_WORKFLOW_NAME,
      mode: audit.mode,
      status: 'succeeded',
      startedAt: audit.startedAt,
      finishedAt: ctx.clock(),
      outputSummary: {
        briefsOnly: audit.briefsOnly,
        judgment: output.judgment.action,
        total: output.summary.total,
        actionable: output.summary.actionable,
        quality: output.summary.quality,
        // briefsOnly 自身不调用 LLM；唯一计量在当日 daily-stock-briefs 那条 run 上。
        ...(audit.briefsOnly ? { llmHttpCalls: 0 } : {}),
      },
      providerStatuses: [],
    },
  });
  if (!recorded.ok) {
    ctx.logger.warn('daily-advice: workflow_runs 审计收尾失败', { cause: recorded.error });
  }
};
type WatchlistRow = { watchlist: { id: string; kind: string } };
type MemberRow = { member: { stockId: string }; stockName?: string };
type SignalRow = { stockId: string; score: number; direction: 'bullish' | 'bearish' | 'neutral' };

const emptyQuality = (): DailyAdviceQualityCounts => ({
  ai: 0,
  ruleOnly: 0,
  partial: 0,
  unavailable: 0,
});

const qualityOfAdvices = (advices: readonly AnalyzedAdvice[]): DailyAdviceQualityCounts => {
  const quality = emptyQuality();
  for (const advice of advices) {
    if (isRuleFallbackAdvice(advice)) quality.ruleOnly += 1;
    else quality.ai += 1;
  }
  return quality;
};

const summaryOf = (
  advices: readonly AnalyzedAdvice[],
  holdingsCount: number,
  candidatesCount: number,
  quality: DailyAdviceQualityCounts,
  actionable: number,
): DailyAdviceSummary => ({
  total: advices.length,
  highConfidence: advices.filter((advice) => advice.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
  holdings: holdingsCount,
  candidates: candidatesCount,
  actionable,
  quality,
});

const judgmentOf = (
  advices: readonly AnalyzedAdvice[],
  stocks: ReadonlyMap<string, string>,
): z.infer<typeof JudgmentSchema> => {
  const items = advices
    .filter((advice) => advice.decision === 'buy' || advice.decision === 'sell')
    .map((advice) => ({
      stockId: advice.subjectId,
      name: stocks.get(advice.subjectId) ?? advice.subjectId,
      decision: advice.decision as 'buy' | 'sell',
      confidence: advice.confidence,
      horizon: advice.horizon,
    }));
  if (items.length === 0) {
    return {
      action: '今日不动',
      reason: '持仓与候选池今日均无可执行动作，维持原状态；下一交易日复核。',
      items: [],
    };
  }
  return {
    action: '今日可动',
    reason: `今日有 ${items.length} 个可执行动作，按 confidence 从高到低处理。`,
    items,
  };
};

/** 同日多 phase 时每票只取一条：盘后优先，其次盘中，最后盘前。 */
const PHASE_RANK: Readonly<Record<string, number>> = {
  'post-market': 0,
  intraday: 1,
  premarket: 2,
};

/** list_stock_briefs 的只读投影（workflow 不直接访问 repository）。 */
type BriefRow = {
  readonly stockId: string;
  readonly stockName?: string | undefined;
  readonly phase: 'premarket' | 'intraday' | 'post-market';
  readonly quality: 'ai' | 'rule-only' | 'partial' | 'unavailable';
  readonly decision: 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
  readonly confidence: number;
  readonly horizon: string;
  readonly adviceId?: string | undefined;
};

const selectBriefsForDay = (briefs: readonly BriefRow[]): BriefRow[] => {
  const byStock = new Map<string, BriefRow>();
  for (const brief of briefs) {
    const current = byStock.get(brief.stockId);
    if (current === undefined) {
      byStock.set(brief.stockId, brief);
      continue;
    }
    if ((PHASE_RANK[brief.phase] ?? 99) < (PHASE_RANK[current.phase] ?? 99)) {
      byStock.set(brief.stockId, brief);
    }
  }
  return [...byStock.values()];
};

interface BriefSignalItem {
  readonly stockId: string;
  readonly name: string;
  readonly decision: 'buy' | 'sell';
  readonly confidence: number;
  readonly horizon: string;
}

interface BriefsCollection {
  readonly advices: AnalyzedAdvice[];
  readonly items: BriefSignalItem[];
  readonly quality: DailyAdviceQualityCounts;
  readonly candidateIds: string[];
  readonly names: Record<string, string>;
  readonly briefCount: number;
}

/** briefsOnly 路径：只读当日 brief + adviceId 指向的已有 advice，不现造 advice。 */
const collectBriefs = async (
  ctx: WorkflowContext,
  input: DailyAdviceInput,
  holdings: readonly HoldingRow[],
): Promise<BriefsCollection> => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const tradingDate = dateInShanghai(ctx.clock());
  const listed = await ctx.tools.list_stock_briefs.execute({
    date: tradingDate,
    accountId,
    limit: 50,
  });
  if (!listed.ok) {
    ctx.logger.warn('daily-advice: 当日观察列表不可用', { cause: listed.error });
    return {
      advices: [],
      items: [],
      quality: emptyQuality(),
      candidateIds: [],
      names: {},
      briefCount: 0,
    };
  }
  const selected = selectBriefsForDay(listed.data.items);
  const held = new Set(holdings.map((row) => row.holding.stockId));
  const quality = emptyQuality();
  const advices: AnalyzedAdvice[] = [];
  const items: BriefSignalItem[] = [];
  const names: Record<string, string> = {};

  for (const brief of selected) {
    if (brief.quality === 'rule-only') quality.ruleOnly += 1;
    else quality[brief.quality] += 1;
    if (brief.stockName !== undefined) names[brief.stockId] = brief.stockName;
    if (brief.adviceId === undefined) continue;
    const found = await ctx.tools.get_advice.execute({
      accountId,
      subjectId: brief.stockId,
      includeExpired: true,
      limit: 200,
    });
    if (!found.ok) {
      ctx.logger.warn('daily-advice: brief 引用的 advice 查询失败，跳过', {
        stockId: brief.stockId,
        adviceId: brief.adviceId,
        cause: found.error,
      });
      continue;
    }
    const advice = found.data.advices.find((item) => item.id === brief.adviceId);
    if (advice === undefined) {
      ctx.logger.warn('daily-advice: brief 引用的 advice 已不存在，跳过', {
        stockId: brief.stockId,
        adviceId: brief.adviceId,
      });
      continue;
    }
    advices.push(advice);
    if (brief.quality === 'ai' && (brief.decision === 'buy' || brief.decision === 'sell')) {
      items.push({
        stockId: brief.stockId,
        name: brief.stockName ?? advice.stockName ?? brief.stockId,
        decision: brief.decision,
        confidence: brief.confidence,
        horizon: brief.horizon,
      });
    }
  }

  advices.sort((left, right) => right.confidence - left.confidence);
  items.sort((left, right) => right.confidence - left.confidence);
  return {
    advices,
    items,
    quality,
    candidateIds: selected
      .filter((brief) => !held.has(brief.stockId))
      .map((brief) => brief.stockId),
    names,
    briefCount: selected.length,
  };
};

const judgmentFromBriefs = (
  items: readonly BriefSignalItem[],
  quality: DailyAdviceQualityCounts,
  briefCount: number,
): z.infer<typeof JudgmentSchema> => {
  if (items.length > 0) {
    return {
      action: '今日可动',
      reason: `今日有 ${items.length} 个信号（均来自当日 AI 观察），按 confidence 从高到低复核。`,
      items: [...items],
    };
  }
  if (briefCount === 0) {
    return {
      action: '今日不动',
      reason: '今日无新信号：当日尚无个股观察记录（未运行 AI 分析），维持原状态；下一交易日复核。',
      items: [],
    };
  }
  if (quality.ai === 0) {
    return {
      action: '今日不动',
      reason: `今日无新信号：当日 ${briefCount} 条观察均为规则观察或数据不可用，未形成 AI 信号。`,
      items: [],
    };
  }
  return {
    action: '今日不动',
    reason: `今日无新信号：当日 ${quality.ai} 条 AI 观察未出现偏多/偏空信号。`,
    items: [],
  };
};

/**
 * daily-advice（v0.2，ARCHITECTURE §8.1 / 每日判断单元）：
 * 活跃持仓 + 候选池（手动关注池 ≤ DAILY_CANDIDATE_LIMIT）→ 逐只 analyze_stock →
 * 汇总为「今日不动 / 今日可动」结论 + 按 confidence 降序的 advices。
 * `briefsOnly=true` 时不生成观察，只消费当日 `daily-stock-briefs` 已写下的结果
 * （17:30 调度默认路径）；旧的 analyze_stock 生成路径留给回退开关与 CLI 显式调用。
 *
 * 判断单元是「持仓 + 少量候选」，不是全市场：候选池来自用户维护的 Watchlist，
 * 因此建议数量天然有界（历史上 952 条建议里 87% 是无法执行的 watch，就是因为没有这个边界）。
 */
export const dailyAdviceWorkflow = defineWorkflow<DailyAdviceInput, DailyAdviceOutput>({
  name: DAILY_ADVICE_WORKFLOW_NAME,
  description: '盘后判断：活跃持仓 + 候选池（≤10 只）逐只生成建议，输出「今日不动/今日可动」结论',
  input: DailyAdviceInput,
  steps: [
    // 1) 拉活跃持仓（含 PnL 汇总）；accountId 缺省走 ctx.user.defaultAccountId。
    async (prev, ctx) => {
      const input = prev as DailyAdviceInput;
      const listed = await ctx.tools.list_holdings.execute(
        input.accountId === undefined ? {} : { accountId: input.accountId },
      );
      if (!listed.ok) return listed;
      const audit = await startAudit(ctx, input);
      return {
        input,
        holdings: listed.data.holdings as HoldingRow[],
        mode: 'full' as const,
        ...(audit === undefined ? {} : { audit }),
      };
    },
    // 2) briefsOnly：只读当日 brief；否则取启用中的关注池清单。
    async (prev, ctx) => {
      const state = prev as {
        input: DailyAdviceInput;
        holdings: HoldingRow[];
        mode: 'full';
      };
      if (state.input.briefsOnly) {
        const collected = await collectBriefs(ctx, state.input, state.holdings);
        return {
          ...state,
          ...collected,
          mode: 'briefs' as const,
          holdingIds: state.holdings.map((row) => row.holding.stockId),
        };
      }
      const watchlists = await ctx.tools.list_watchlists.execute({ enabledOnly: true });
      if (!watchlists.ok) return watchlists;
      return { ...state, watchlists: watchlists.data.items as WatchlistRow[] };
    },
    // 3) 策略补位：跑少量 active Strategy 的当日信号，取高分 bullish 标的。
    async (prev, ctx) => {
      const state = prev as {
        mode: 'full' | 'briefs';
        holdings: HoldingRow[];
        watchlists: WatchlistRow[];
      };
      if (state.mode === 'briefs') return state;
      const listed = await ctx.tools.list_strategies.execute({ filter: { status: 'active' } });
      if (!listed.ok) {
        ctx.logger.warn('daily-advice: 策略清单不可用，跳过补位', { cause: listed.error });
        return { ...state, signals: [] as SignalRow[] };
      }
      const strategies = listed.data.strategies
        .filter((strategy) => strategy.currentVersionId !== undefined)
        .slice(0, STRATEGY_SIGNAL_SOURCE_LIMIT);
      const runs = await Promise.all(
        strategies.map((strategy) =>
          ctx.tools.run_strategy.execute({
            strategyId: strategy.id,
            mode: 'scan',
            persist: false,
            concurrency: 4,
          }),
        ),
      );
      const signals: SignalRow[] = [];
      for (const [index, result] of runs.entries()) {
        if (!result.ok) {
          ctx.logger.warn('daily-advice: 策略补位运行失败', {
            strategyId: strategies[index]?.id,
            cause: result.error,
          });
          continue;
        }
        for (const signal of result.data.signals as SignalRow[]) {
          if (signal.direction !== 'bullish' || signal.score < STRATEGY_SIGNAL_MIN_SCORE) continue;
          signals.push(signal);
        }
      }
      return { ...state, signals };
    },
    // 4) 展开候选池：关注池成员 + 策略补位，剔除持仓、去重、截断到上限。
    async (prev, ctx) => {
      const state = prev as {
        mode: 'full' | 'briefs';
        holdings: HoldingRow[];
        watchlists: WatchlistRow[];
        signals: SignalRow[];
      };
      if (state.mode === 'briefs') return state;
      const { holdings, watchlists, signals } = state;
      const held = new Set(holdings.map((row) => row.holding.stockId));
      const fetched = await Promise.all(
        watchlists.map((row) => ctx.tools.get_watchlist.execute({ watchlistId: row.watchlist.id })),
      );
      const candidates: string[] = [];
      const names = new Map<string, string>();
      for (const item of fetched) {
        if (!item.ok) continue;
        for (const member of item.data.members as MemberRow[]) {
          const stockId = member.member.stockId;
          if (held.has(stockId) || candidates.includes(stockId)) continue;
          if (member.stockName !== undefined) names.set(stockId, member.stockName);
          candidates.push(stockId);
          if (candidates.length >= DAILY_CANDIDATE_LIMIT) break;
        }
        if (candidates.length >= DAILY_CANDIDATE_LIMIT) break;
      }
      const added: string[] = [];
      for (const signal of [...signals].sort((a, b) => b.score - a.score)) {
        if (added.length >= STRATEGY_CANDIDATE_LIMIT) break;
        if (held.has(signal.stockId) || candidates.includes(signal.stockId)) continue;
        candidates.push(signal.stockId);
        added.push(signal.stockId);
      }
      return {
        ...state,
        holdingIds: [...held],
        candidateIds: candidates,
        strategyCandidates: added,
        names: Object.fromEntries(names),
      };
    },
    // 5) 逐只判断。单只失败不拖垮整批：记录后继续，最终由 summary 计数反映。
    async (prev, ctx) => {
      const state = prev as {
        mode: 'full' | 'briefs';
        holdingIds: string[];
        candidateIds: string[];
        names: Record<string, string>;
      };
      if (state.mode === 'briefs') return state;
      const { holdingIds, candidateIds } = state;
      const stockIds = [...holdingIds, ...candidateIds];
      const results = await Promise.all(
        stockIds.map((stockId) => ctx.tools.analyze_stock.execute({ stockId })),
      );
      const advices: AnalyzedAdvice[] = [];
      const failed: string[] = [];
      for (const [index, result] of results.entries()) {
        if (result.ok) advices.push(result.data.advice);
        else failed.push(stockIds[index] ?? 'unknown');
      }
      if (failed.length > 0) {
        ctx.logger.warn('daily-advice: 部分标的本日无法判断', { failed });
      }
      return { ...state, advices, quality: qualityOfAdvices(advices) };
    },
    // 6) 顺带结算已过期建议（T+1/T+3/T+5）。结算失败不影响当日判断。
    async (prev, ctx) => {
      const settled = await ctx.tools.settle_advices.execute({});
      if (!settled.ok) {
        ctx.logger.warn('daily-advice: 结算过期建议失败', { cause: settled.error });
      }
      return prev;
    },
    // 7) 汇总：confidence 降序 + 「今日不动/今日可动」结论；scheduled 运行收尾审计。
    async (prev, ctx) => {
      const state = prev as {
        mode: 'full' | 'briefs';
        advices: AnalyzedAdvice[];
        holdingIds: string[];
        candidateIds: string[];
        names: Record<string, string>;
        quality: DailyAdviceQualityCounts;
        items?: BriefSignalItem[];
        briefCount?: number;
        audit?: AdviceAudit;
      };
      const sorted = [...state.advices].sort((a, b) => b.confidence - a.confidence);
      const judgment =
        state.mode === 'briefs'
          ? judgmentFromBriefs(state.items ?? [], state.quality, state.briefCount ?? 0)
          : judgmentOf(sorted, new Map(Object.entries(state.names)));
      const output = DailyAdviceOutput.parse({
        advices: sorted,
        judgment,
        summary: summaryOf(
          sorted,
          state.holdingIds.length,
          state.candidateIds.length,
          state.quality,
          judgment.items.length,
        ),
      });
      await finishAudit(ctx, state.audit, output);
      return output;
    },
  ],
});
