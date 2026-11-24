import {
  AdviceDecisionSchema,
  dateInShanghai,
  type StockBriefMissing,
  type StockBriefMissingDimension,
  StockBriefMissingSchema,
  type StockBriefPhase,
  StockBriefPhaseSchema,
  type StockBriefQuality,
  StockBriefQualitySchema,
  type StockBriefSource,
  StockBriefSourceSchema,
  type ToolContext,
  type WatchlistMember,
} from '@luoome/core';
import { defineTool } from '@luoome/toolkit';
import {
  type BriefPreScreenResult,
  type BriefRuleFacts,
  briefRuleFactsFromFactPack,
  buildRuleOnlyDraft,
  DEFAULT_BRIEF_PRESCREEN_OPTIONS,
  preScreenStockBrief,
  RULE_INCLUDE_SIGNAL_SCORE,
} from '@luoome/toolkit/internal/brief-rules.js';
import {
  type BriefBudgetLimits,
  type BriefBudgetSnapshot,
  checkBriefBudget,
  DEFAULT_BRIEF_BUDGET_LIMITS,
  DEFAULT_TICKET_TOKEN_ESTIMATE,
  readBriefBudget,
} from '@luoome/toolkit/internal/llm-budget.js';
import {
  buildStockFactPack,
  summarizeFactPackForBrief,
} from '@luoome/toolkit/internal/stock-facts.js';
import { filterStrategySignalsByScope } from '@luoome/toolkit/internal/strategy-signal-scope.js';
import { z } from 'zod';

import { ANALYZE_STOCK_MAX_ATTEMPTS, analyzeStockTool } from './analyze-stock.js';

/**
 * 每日个股观察批次（design.md §5.1 / §6）。
 *
 * 候选集（持仓 ∪ 关注池 ∪ 当日策略信号，上限默认 8 票）→ 事实包 → 规则预筛 →
 * LLM（`analyze_stock` brief 路径，并发 2、预算双轨）→ 校验（在 analyze_stock 内）→
 * 落库（`stock_briefs`）→ 汇总。advices 只由 `analyze_stock` 写，本工具不直接落建议。
 *
 * 批次 P95 目标 ≤ 6 min（8 票 / 并发 2 / 每票 1.2 次调用）；单票 P95 ≤ 90 s
 * 由 analyze_stock 的「60 s × 最多 2 次尝试」守住。
 */

/** 批次内 LLM 并发。 */
export const DAILY_STOCK_BRIEFS_CONCURRENCY = 2;
/** 关注池中进入候选集的阶段（watching 只出规则观察，confirmed/researching 进入 LLM）。 */
const CANDIDATE_STAGES: readonly WatchlistMember['stage'][] = [
  'watching',
  'researching',
  'confirmed',
];
const STAGE_RANK: Readonly<Record<string, number>> = {
  discovered: 0,
  watching: 1,
  researching: 2,
  confirmed: 3,
};

export const GenerateStockBriefsInput = z.object({
  /** holdings=只跑持仓；watchlist=只跑关注池；signals=只跑当日策略信号；stock=指定股票。 */
  scope: z.enum(['all', 'holdings', 'watchlist', 'signals', 'stock']).default('all'),
  stockIds: z.array(z.string().min(1)).max(50).optional(),
  phase: StockBriefPhaseSchema.default('post-market'),
  accountId: z.string().min(1).optional(),
  /** Asia/Shanghai 交易日；缺省用当前时钟。 */
  tradingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  source: StockBriefSourceSchema.default('scheduled'),
  /** true 时忽略同日同 digest 与连续无新事实的跳过规则。 */
  force: z.boolean().default(false),
  /** 预筛可调口径（默认按设计：同日同 digest 跳过、连续 3 日无新事实跳过）。 */
  skipUnchangedDigest: z.boolean().optional(),
  staleAfterDays: z.number().int().positive().max(30).optional(),
  /** 预算可调口径（默认 8 票 / 16 次 HTTP / 90k token）。 */
  maxBriefs: z.number().int().positive().max(50).optional(),
  maxHttpCalls: z.number().int().positive().max(200).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  /** 策略信号补位上限。 */
  maxSignalCandidates: z.number().int().positive().max(20).default(3),
});
export type GenerateStockBriefsInput = z.infer<typeof GenerateStockBriefsInput>;

export const GenerateStockBriefsItem = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  action: z.enum(['llm', 'rule-only', 'unavailable', 'skip', 'budget-stopped']),
  quality: StockBriefQualitySchema.optional(),
  decision: AdviceDecisionSchema.optional(),
  confidence: z.number().min(0).max(100).optional(),
  adviceId: z.string().min(1).optional(),
  factDigest: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  missing: z.array(StockBriefMissingSchema),
});
export type GenerateStockBriefsItem = z.infer<typeof GenerateStockBriefsItem>;

export const GenerateStockBriefsOutput = z.object({
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phase: StockBriefPhaseSchema,
  items: z.array(GenerateStockBriefsItem),
  summary: z.object({
    llmHttpCalls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    llmBriefs: z.number().int().nonnegative(),
    ruleOnlyBriefs: z.number().int().nonnegative(),
    unavailableBriefs: z.number().int().nonnegative(),
    skippedByDigest: z.number().int().nonnegative(),
    budgetStopped: z.number().int().nonnegative(),
    degraded: z.boolean(),
  }),
  coverage: z.object({
    holdings: z.number().int().nonnegative(),
    watchlist: z.number().int().nonnegative(),
    signals: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
  }),
  budget: z.object({
    date: z.string(),
    httpCalls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    limit: z.object({
      maxBriefs: z.number().int().positive(),
      maxHttpCalls: z.number().int().positive(),
      maxTokens: z.number().int().positive(),
    }),
  }),
  degradation: z
    .object({
      reason: z.enum(['rate_limited']),
      message: z.string().min(1),
    })
    .optional(),
});
export type GenerateStockBriefsOutput = z.infer<typeof GenerateStockBriefsOutput>;

interface Candidate {
  readonly stockId: string;
  readonly held: boolean;
  readonly watchlistStage?: WatchlistMember['stage'];
}

const stageOrder = (stage: string | undefined): number =>
  stage === undefined ? -1 : (STAGE_RANK[stage] ?? 0);

const uniqueById = (candidates: readonly Candidate[]): Candidate[] => {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.stockId);
    if (existing === undefined) {
      byId.set(candidate.stockId, candidate);
      continue;
    }
    const stage =
      stageOrder(existing.watchlistStage) >= stageOrder(candidate.watchlistStage)
        ? existing.watchlistStage
        : candidate.watchlistStage;
    byId.set(candidate.stockId, {
      stockId: candidate.stockId,
      held: existing.held || candidate.held,
      ...(stage === undefined ? {} : { watchlistStage: stage }),
    });
  }
  return [...byId.values()];
};

const heldStockIds = async (ctx: ToolContext, accountId: string): Promise<string[]> =>
  (await ctx.repos.holding.listByAccount(accountId))
    .filter((holding) => holding.closedAt === null && holding.quantity > 0)
    .map((holding) => holding.stockId);

const watchlistCandidates = async (ctx: ToolContext): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const watchlist of await ctx.repos.watchlist.list({ enabledOnly: true })) {
    for (const member of await ctx.repos.watchlistMember.listMembers(watchlist.id)) {
      if (member.archivedAt !== undefined) continue;
      if (!CANDIDATE_STAGES.includes(member.stage)) continue;
      candidates.push({ stockId: member.stockId, held: false, watchlistStage: member.stage });
    }
  }
  return candidates;
};

/** 当日 score≥60 的非中性策略信号（运营口径 run）。 */
const signalCandidates = async (
  ctx: ToolContext,
  tradingDate: string,
  limit: number,
): Promise<Candidate[]> => {
  const dayStart = new Date(`${tradingDate}T00:00:00+08:00`);
  const runs = await ctx.repos.strategyRun.listRuns({ since: dayStart, limit: 50 });
  if (runs.length === 0) return [];
  const signals = await ctx.repos.strategyRun.signalsByRuns(runs.map((run) => run.id));
  const operational = await filterStrategySignalsByScope(signals, ctx, { scope: 'operational' });
  const seen = new Set<string>();
  return [...operational]
    .filter(
      (signal) =>
        dateInShanghai(signal.ts) === tradingDate &&
        signal.score >= RULE_INCLUDE_SIGNAL_SCORE &&
        signal.direction !== 'neutral',
    )
    .sort((left, right) => right.score - left.score)
    .filter((signal) => {
      if (seen.has(signal.stockId)) return false;
      seen.add(signal.stockId);
      return true;
    })
    .slice(0, limit)
    .map((signal) => ({ stockId: signal.stockId, held: false }));
};

/** 连续多少个自然日（不含当日）的事实指纹与本次相同。 */
const consecutiveSameDigestDays = async (
  ctx: ToolContext,
  input: {
    readonly stockId: string;
    readonly accountId: string;
    readonly tradingDate: string;
    readonly factDigest: string;
  },
): Promise<number> => {
  const history = await ctx.repos.stockBrief.findByStock({
    stockId: input.stockId,
    accountId: input.accountId,
    limit: 10,
  });
  let days = 0;
  for (const brief of history) {
    if (brief.tradingDate >= input.tradingDate) continue;
    if (brief.factDigest !== input.factDigest) break;
    days += 1;
  }
  return days;
};

const dedupeMissing = (missing: readonly StockBriefMissing[]): StockBriefMissing[] => {
  const seen = new Set<StockBriefMissingDimension>();
  const out: StockBriefMissing[] = [];
  for (const item of missing) {
    if (seen.has(item.dimension)) continue;
    seen.add(item.dimension);
    out.push(item);
  }
  return out;
};

const writeNonAiBrief = async (
  ctx: ToolContext,
  input: {
    readonly stockId: string;
    readonly tradingDate: string;
    readonly phase: StockBriefPhase;
    readonly accountId: string;
    readonly source: StockBriefSource;
    readonly quality: Extract<StockBriefQuality, 'rule-only' | 'unavailable'>;
    readonly decision: 'hold' | 'watch' | 'avoid';
    readonly confidence: number;
    readonly factDigest: string;
    readonly factsAsOf: Date;
    readonly missing: readonly StockBriefMissing[];
    readonly dataSources: readonly string[];
  },
): Promise<void> => {
  const now = ctx.clock();
  await ctx.repos.stockBrief.upsert({
    id: globalThis.crypto.randomUUID(),
    tradingDate: input.tradingDate,
    phase: input.phase,
    accountId: input.accountId,
    stockId: input.stockId,
    source: input.source,
    decision: input.decision,
    confidence: input.confidence,
    horizon: 'short',
    quality: input.quality,
    factDigest: input.factDigest,
    factsAsOf: input.factsAsOf,
    missing: dedupeMissing(input.missing),
    dataSources: [...input.dataSources],
    llmHttpCalls: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmReasoningTokens: 0,
    llmCostUsd: 0,
    validUntil: new Date(now.getTime() + 86_400_000),
    createdAt: now,
    updatedAt: now,
  });
};

/** 并发上限内执行，保持结果顺序。 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()),
  );
  return results;
};

/** 单票 HTTP 上限（1 次 + 1 次修复重试）：预算按它预留。 */
const TICKET_MAX_HTTP = ANALYZE_STOCK_MAX_ATTEMPTS;

const candidateRank = (candidate: Candidate): number => {
  if (candidate.held) return 0;
  if (candidate.watchlistStage === 'confirmed' || candidate.watchlistStage === 'researching')
    return 1;
  if (candidate.watchlistStage === 'watching') return 3;
  return 2;
};

const buildCandidates = async (
  ctx: ToolContext,
  input: GenerateStockBriefsInput,
  accountId: string,
  tradingDate: string,
  limit: number,
): Promise<{ candidates: Candidate[]; coverage: GenerateStockBriefsOutput['coverage'] }> => {
  // 持仓标记对 stock 作用域也要用（决定 P0 / 持仓上下文），但候选集只取显式传入的股票。
  const heldAll = await heldStockIds(ctx, accountId);
  const wantsHoldings =
    input.scope === 'all' || input.scope === 'holdings' || input.scope === 'stock';
  const held = wantsHoldings ? heldAll : [];
  const watchlist =
    input.scope === 'all' || input.scope === 'watchlist' ? await watchlistCandidates(ctx) : [];
  const signals =
    input.scope === 'all' || input.scope === 'signals'
      ? await signalCandidates(ctx, tradingDate, input.maxSignalCandidates)
      : [];
  const manual: Candidate[] =
    input.scope === 'stock'
      ? (input.stockIds ?? []).map((stockId) => ({ stockId, held: heldAll.includes(stockId) }))
      : [];
  const heldCandidates: Candidate[] =
    input.scope === 'stock' ? [] : held.map((stockId) => ({ stockId, held: true }));
  const ordered = uniqueById([...manual, ...heldCandidates, ...watchlist, ...signals]).sort(
    (left, right) => candidateRank(left) - candidateRank(right),
  );
  return {
    candidates: ordered.slice(0, limit),
    coverage: {
      holdings: input.scope === 'stock' ? 0 : held.length,
      watchlist: watchlist.length,
      signals: signals.length,
      candidates: Math.min(ordered.length, limit),
    },
  };
};

export const generateStockBriefsTool = defineTool({
  name: 'generate_stock_briefs',
  description:
    '按交易日阶段批量生成每日个股观察：候选集（持仓 ∪ 关注池 ∪ 当日策略信号）→ 事实包 → 规则预筛；' +
    '盘前（phase=premarket）只出研究名单，不调用 LLM、不写 advices；' +
    '盘后（phase=post-market）在每日预算内做 AI 技术研究与观察（并发 2）并允许规则观察/降级；均落库 stock_briefs。' +
    '仅技术研究，不构成投资建议；不产生交易动作，也不修改账户。',
  sideEffect: 'advice',
  input: GenerateStockBriefsInput,
  output: GenerateStockBriefsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const tradingDate = input.tradingDate ?? dateInShanghai(ctx.clock());
    const limits: BriefBudgetLimits = {
      maxBriefs: input.maxBriefs ?? DEFAULT_BRIEF_BUDGET_LIMITS.maxBriefs,
      maxHttpCalls: input.maxHttpCalls ?? DEFAULT_BRIEF_BUDGET_LIMITS.maxHttpCalls,
      maxTokens: input.maxTokens ?? DEFAULT_BRIEF_BUDGET_LIMITS.maxTokens,
    };
    const skipUnchangedDigest = input.force
      ? false
      : (input.skipUnchangedDigest ?? DEFAULT_BRIEF_PRESCREEN_OPTIONS.skipUnchangedDigest);
    const staleAfterDays = input.force
      ? Number.MAX_SAFE_INTEGER
      : (input.staleAfterDays ?? DEFAULT_BRIEF_PRESCREEN_OPTIONS.staleAfterDays);
    const source: StockBriefSource = input.source;

    const { candidates, coverage } = await buildCandidates(
      ctx,
      input,
      accountId,
      tradingDate,
      limits.maxBriefs,
    );

    const items: GenerateStockBriefsItem[] = [];
    let budget: BriefBudgetSnapshot = await readBriefBudget(ctx, tradingDate, limits);
    let llmDispatched = 0;
    let budgetStopped = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    // 并发下预算检查必须同步预留，否则两个 worker 会同时看到同一份旧用量。
    let reservedHttp = 0;
    let reservedTokens = 0;
    let maxTicketTokens = 0;

    await mapWithConcurrency(candidates, DAILY_STOCK_BRIEFS_CONCURRENCY, async (candidate) => {
      const stockName = (await ctx.repos.stock.findById(candidate.stockId))?.name;
      const pack = await buildStockFactPack(ctx, {
        stockId: candidate.stockId,
        asOf: ctx.clock(),
        include: [
          'quote',
          'bars',
          'indicators',
          'intraday',
          'news',
          'sectors',
          'signals',
          'account',
        ],
      });
      if (pack === null) {
        items.push({
          stockId: candidate.stockId,
          ...(stockName === undefined ? {} : { stockName }),
          action: 'unavailable',
          reason: '标的不存在',
          missing: [],
        });
        return;
      }
      const summary = summarizeFactPackForBrief(pack, ctx.clock());
      const facts: BriefRuleFacts = briefRuleFactsFromFactPack(pack);
      if (!summary.quoteAvailable) {
        // 行情全部不可用：不写 advice，只落 unavailable brief 并给原因（design §11）。
        const quoteReason =
          pack.quote?.status === 'unavailable' ? pack.quote.reason : 'quote_unavailable';
        await writeNonAiBrief(ctx, {
          stockId: candidate.stockId,
          tradingDate,
          phase: input.phase,
          accountId,
          source,
          quality: 'unavailable',
          decision: 'hold',
          confidence: 0,
          factDigest: summary.factDigest,
          factsAsOf: summary.factsAsOf,
          missing: [...summary.missing, { dimension: 'quote', reason: quoteReason }],
          dataSources: summary.dataSources,
        });
        items.push({
          stockId: candidate.stockId,
          ...(stockName === undefined ? {} : { stockName }),
          action: 'unavailable',
          quality: 'unavailable',
          factDigest: summary.factDigest,
          reason: quoteReason,
          missing: [...summary.missing],
        });
        return;
      }
      const existing = (
        await ctx.repos.stockBrief.findByStock({
          stockId: candidate.stockId,
          accountId,
          tradingDate,
          limit: 1,
        })
      )[0];
      const prescreen: BriefPreScreenResult = preScreenStockBrief({
        tradingDate,
        stockId: candidate.stockId,
        ...(stockName === undefined ? {} : { stockName }),
        held: candidate.held,
        ...(candidate.watchlistStage === undefined
          ? {}
          : { watchlistStage: candidate.watchlistStage }),
        facts,
        ...(existing === undefined
          ? {}
          : { existingBrief: { digest: existing.factDigest, decision: existing.decision } }),
        consecutiveNoNewFactDays: await consecutiveSameDigestDays(ctx, {
          stockId: candidate.stockId,
          accountId,
          tradingDate,
          factDigest: facts.factDigest,
        }),
        skipUnchangedDigest,
        staleAfterDays,
      });
      const base = {
        stockId: candidate.stockId,
        ...(stockName === undefined ? {} : { stockName }),
        factDigest: prescreen.factDigest,
        missing: [...summary.missing],
      };
      const draft =
        prescreen.ruleOnly ??
        buildRuleOnlyDraft(
          {
            tradingDate,
            stockId: candidate.stockId,
            held: candidate.held,
            ...(candidate.watchlistStage === undefined
              ? {}
              : { watchlistStage: candidate.watchlistStage }),
            facts,
          },
          [],
        );

      if (prescreen.action === 'skip') {
        items.push({ ...base, action: 'skip', reason: prescreen.reason });
        return;
      }
      if (prescreen.action === 'unavailable') {
        await writeNonAiBrief(ctx, {
          stockId: candidate.stockId,
          tradingDate,
          phase: input.phase,
          accountId,
          source,
          quality: 'unavailable',
          decision: 'hold',
          confidence: 0,
          factDigest: prescreen.factDigest,
          factsAsOf: summary.factsAsOf,
          missing: [...summary.missing, { dimension: 'quote', reason: prescreen.reason }],
          dataSources: summary.dataSources,
        });
        items.push({
          ...base,
          action: 'unavailable',
          quality: 'unavailable',
          reason: prescreen.reason,
        });
        return;
      }
      if (prescreen.action === 'rule-only') {
        await writeNonAiBrief(ctx, {
          stockId: candidate.stockId,
          tradingDate,
          phase: input.phase,
          accountId,
          source,
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          factDigest: prescreen.factDigest,
          factsAsOf: summary.factsAsOf,
          missing: summary.missing,
          dataSources: summary.dataSources,
        });
        items.push({
          ...base,
          action: 'rule-only',
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          reason: prescreen.reason,
        });
        return;
      }

      if (input.phase === 'premarket') {
        // 盘前禁止 LLM（design §9.1）：只落事实包 + 规则预筛的研究名单，0 次 HTTP、不写 advices。
        await writeNonAiBrief(ctx, {
          stockId: candidate.stockId,
          tradingDate,
          phase: input.phase,
          accountId,
          source,
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          factDigest: prescreen.factDigest,
          factsAsOf: summary.factsAsOf,
          missing: summary.missing,
          dataSources: summary.dataSources,
        });
        items.push({
          ...base,
          action: 'rule-only',
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          reason: '盘前批次只做事实包与规则预筛，不调用 AI',
        });
        return;
      }

      // include：先过预算守卫；任一硬限将触达则本票及后续全部按规则观察。
      const tokenEstimate = Math.max(maxTicketTokens, DEFAULT_TICKET_TOKEN_ESTIMATE);
      const decision = checkBriefBudget({
        snapshot: {
          ...budget,
          httpCalls: budget.httpCalls + reservedHttp,
          tokens: budget.tokens + reservedTokens,
        },
        plannedBriefs: llmDispatched + 1,
        plannedHttpCalls: TICKET_MAX_HTTP,
        plannedTokens: tokenEstimate,
      });
      if (decision.exhausted) {
        budgetStopped += 1;
        await writeNonAiBrief(ctx, {
          stockId: candidate.stockId,
          tradingDate,
          phase: input.phase,
          accountId,
          source,
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          factDigest: prescreen.factDigest,
          factsAsOf: summary.factsAsOf,
          missing: [
            ...summary.missing,
            { dimension: 'budget', reason: decision.reason ?? '今日 AI 分析额度已用完' },
          ],
          dataSources: summary.dataSources,
        });
        items.push({
          ...base,
          action: 'budget-stopped',
          quality: 'rule-only',
          decision: draft.decision,
          confidence: draft.confidence,
          reason: decision.reason ?? '今日 AI 分析额度已用完',
        });
        return;
      }
      llmDispatched += 1;
      // 同步预留：check + 预留之间不能有 await。
      reservedHttp += TICKET_MAX_HTTP;
      reservedTokens += tokenEstimate;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const tokensBefore = budget.tokens;
      let result: Awaited<ReturnType<typeof analyzeStockTool.execute>>;
      try {
        result = await analyzeStockTool.execute(
          {
            scope: 'stock',
            stockId: candidate.stockId,
            factPack: pack,
            brief: {
              tradingDate,
              phase: input.phase,
              accountId,
              source,
              ruleOnlyDraft: draft,
            },
          },
          ctx,
        );
      } finally {
        inFlight -= 1;
        reservedHttp -= TICKET_MAX_HTTP;
        reservedTokens -= tokenEstimate;
      }
      budget = await readBriefBudget(ctx, tradingDate, limits);
      maxTicketTokens = Math.max(maxTicketTokens, budget.tokens - tokensBefore);
      if (!result.ok) {
        if (result.error.kind === 'llm_error' || result.error.kind === 'adapter_error') {
          // analyze_stock 已按规则观察落库（brief 路径不写 advices）。
          const quality: StockBriefQuality =
            result.error.kind === 'llm_error' ? 'rule-only' : 'unavailable';
          items.push({
            ...base,
            action: result.error.kind === 'llm_error' ? 'rule-only' : 'unavailable',
            quality,
            decision: quality === 'rule-only' ? draft.decision : 'hold',
            ...(quality === 'rule-only' ? { confidence: draft.confidence } : {}),
            reason: result.error.cause,
          });
          return;
        }
        throw new Error(`generate_stock_briefs: analyze_stock 失败：${result.error.kind}`);
      }
      const data = result.data as {
        advice?: { id: string; decision: string; confidence: number };
        brief?: { quality: StockBriefQuality; factDigest: string };
      };
      items.push({
        ...base,
        action: 'llm',
        quality: data.brief?.quality ?? 'ai',
        ...(data.advice === undefined
          ? {}
          : {
              decision: data.advice.decision as GenerateStockBriefsItem['decision'],
              confidence: data.advice.confidence,
              adviceId: data.advice.id,
            }),
      });
    });

    if (maxInFlight > DAILY_STOCK_BRIEFS_CONCURRENCY) {
      throw new Error(`generate_stock_briefs: 并发超过 ${DAILY_STOCK_BRIEFS_CONCURRENCY}`);
    }

    const order = new Map(candidates.map((candidate, index) => [candidate.stockId, index]));
    const ordered = [...items].sort(
      (left, right) => (order.get(left.stockId) ?? 0) - (order.get(right.stockId) ?? 0),
    );
    const summary = {
      llmHttpCalls: budget.httpCalls,
      tokens: budget.tokens,
      llmBriefs: ordered.filter((item) => item.action === 'llm').length,
      ruleOnlyBriefs: ordered.filter(
        (item) => item.action === 'rule-only' || item.action === 'budget-stopped',
      ).length,
      unavailableBriefs: ordered.filter((item) => item.action === 'unavailable').length,
      skippedByDigest: ordered.filter((item) => item.action === 'skip').length,
      budgetStopped,
      degraded: budgetStopped > 0,
    };

    return {
      tradingDate,
      phase: input.phase,
      items: ordered,
      summary,
      coverage,
      budget: {
        date: budget.date,
        httpCalls: budget.httpCalls,
        tokens: budget.tokens,
        costUsd: budget.costUsd,
        limit: budget.limit,
      },
      ...(budgetStopped === 0
        ? {}
        : {
            degradation: {
              reason: 'rate_limited' as const,
              message: `今日 AI 分析预算已用尽（HTTP ${budget.httpCalls}/${limits.maxHttpCalls}，token ${budget.tokens}/${limits.maxTokens}），剩余标的按规则观察`,
            },
          }),
    };
  },
});
