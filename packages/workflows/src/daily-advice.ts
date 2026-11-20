import { AdviceSchema } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';

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

export const DailyAdviceInput = z.object({
  /** 账户 id（uuid）；缺省为当前用户默认账户。 */
  accountId: z.uuid().optional(),
});
export type DailyAdviceInput = z.infer<typeof DailyAdviceInput>;

const ActionableSchema = z.object({
  stockId: z.string().min(1),
  name: z.string().min(1),
  decision: z.enum(['buy', 'sell']),
  confidence: z.number().int().min(0).max(100),
  horizon: z.string().min(1),
});

export const DailyAdviceSummary = z.object({
  /** 成功生成建议的条数（单票失败会被跳过）。 */
  total: z.number().int().nonnegative(),
  /** 其中高信心度（confidence ≥ HIGH_CONFIDENCE_THRESHOLD）条数。 */
  highConfidence: z.number().int().nonnegative(),
  /** 持仓数量。 */
  holdings: z.number().int().nonnegative(),
  /** 候选池实际参与判断的数量（≤ DAILY_CANDIDATE_LIMIT）。 */
  candidates: z.number().int().nonnegative(),
  /** 需要今天动手的条数（decision ∈ buy/sell）。 */
  actionable: z.number().int().nonnegative(),
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
type WatchlistRow = { watchlist: { id: string; kind: string } };
type MemberRow = { member: { stockId: string }; stockName?: string };
type SignalRow = { stockId: string; score: number; direction: 'bullish' | 'bearish' | 'neutral' };

const summaryOf = (
  advices: readonly AnalyzedAdvice[],
  holdingsCount: number,
  candidatesCount: number,
): DailyAdviceSummary => ({
  total: advices.length,
  highConfidence: advices.filter((advice) => advice.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
  holdings: holdingsCount,
  candidates: candidatesCount,
  actionable: advices.filter((advice) => advice.decision === 'buy' || advice.decision === 'sell')
    .length,
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

/**
 * daily-advice（v0.2，ARCHITECTURE §8.1 / 每日判断单元）：
 * 活跃持仓 + 候选池（手动关注池 ≤ DAILY_CANDIDATE_LIMIT）→ 逐只 analyze_stock →
 * 汇总为「今日不动 / 今日可动」结论 + 按 confidence 降序的 advices。
 *
 * 判断单元是「持仓 + 少量候选」，不是全市场：候选池来自用户维护的 Watchlist，
 * 因此建议数量天然有界（历史上 952 条建议里 87% 是无法执行的 watch，就是因为没有这个边界）。
 */
export const dailyAdviceWorkflow = defineWorkflow<DailyAdviceInput, DailyAdviceOutput>({
  name: 'daily-advice',
  description: '盘后判断：活跃持仓 + 候选池（≤10 只）逐只生成建议，输出「今日不动/今日可动」结论',
  input: DailyAdviceInput,
  steps: [
    // 1) 拉活跃持仓（含 PnL 汇总）；accountId 缺省走 ctx.user.defaultAccountId。
    (prev, ctx) => {
      const input = prev as DailyAdviceInput;
      return ctx.tools.list_holdings.execute(
        input.accountId === undefined ? {} : { accountId: input.accountId },
      );
    },
    // 2) 持仓 + 启用中的关注池清单。
    async (prev, ctx) => {
      const { holdings } = prev as { holdings: HoldingRow[] };
      const watchlists = await ctx.tools.list_watchlists.execute({ enabledOnly: true });
      if (!watchlists.ok) return watchlists;
      return { holdings, watchlists: watchlists.data.items as WatchlistRow[] };
    },
    // 3) 策略补位：跑少量 active Strategy 的当日信号，取高分 bullish 标的。
    async (prev, ctx) => {
      const { holdings, watchlists } = prev as {
        holdings: HoldingRow[];
        watchlists: WatchlistRow[];
      };
      const listed = await ctx.tools.list_strategies.execute({ filter: { status: 'active' } });
      if (!listed.ok) {
        ctx.logger.warn('daily-advice: 策略清单不可用，跳过补位', { cause: listed.error });
        return { holdings, watchlists, signals: [] as SignalRow[] };
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
      return { holdings, watchlists, signals };
    },
    // 4) 展开候选池：关注池成员 + 策略补位，剔除持仓、去重、截断到上限。
    async (prev, ctx) => {
      const { holdings, watchlists, signals } = prev as {
        holdings: HoldingRow[];
        watchlists: WatchlistRow[];
        signals: SignalRow[];
      };
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
        holdingIds: [...held],
        candidateIds: candidates,
        strategyCandidates: added,
        names: Object.fromEntries(names),
      };
    },
    // 4) 逐只判断。单只失败不拖垮整批：记录后继续，最终由 summary 计数反映。
    async (prev, ctx) => {
      const { holdingIds, candidateIds, names } = prev as {
        holdingIds: string[];
        candidateIds: string[];
        names: Record<string, string>;
      };
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
      return { advices, holdingIds, candidateIds, names };
    },
    // 5) 顺带结算已过期建议（T+1/T+3/T+5）。结算失败不影响当日判断。
    async (prev, ctx) => {
      const settled = await ctx.tools.settle_advices.execute({});
      if (!settled.ok) {
        ctx.logger.warn('daily-advice: 结算过期建议失败', { cause: settled.error });
      }
      return prev;
    },
    // 6) 汇总：confidence 降序 + 「今日不动/今日可动」结论。
    (prev) => {
      const { advices, holdingIds, candidateIds, names } = prev as {
        advices: AnalyzedAdvice[];
        holdingIds: string[];
        candidateIds: string[];
        names: Record<string, string>;
      };
      const sorted = [...advices].sort((a, b) => b.confidence - a.confidence);
      const stockNames = new Map<string, string>(Object.entries(names));
      return DailyAdviceOutput.parse({
        advices: sorted,
        judgment: judgmentOf(sorted, stockNames),
        summary: summaryOf(sorted, holdingIds.length, candidateIds.length),
      });
    },
  ],
});
