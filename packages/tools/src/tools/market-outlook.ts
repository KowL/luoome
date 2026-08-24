import {
  type Advice,
  AdviceLadderSnapshotSchema,
  AdviceReasoningSchema,
  dateInShanghai,
  STANDARD_DISCLAIMERS,
  type Stock,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  type AdviceLLMOutput,
  AdviceLLMSchema,
  computeValidUntil,
  sanitizeAdviceReasoning,
  sanitizeAdviceRisks,
} from '../internal/build-advice.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 60;

export const MarketOutlookInput = z.object({
  /** 关注板块 / 主题（如 '新能源' / 'AI'）；不填走全市场。 */
  theme: z.string().max(50).optional(),
  /** 自选股代码列表（用于加权板块指数）。 */
  watchlistIds: z.array(z.string().min(1)).max(50).optional(),
  notes: z.string().max(2000).optional(),
});

export const MarketOutlookOutput = z.object({
  advice: z.any().refine((v) => v !== undefined && v !== null),
  /** 评估的股票数。 */
  evaluatedStocks: z.number().int().nonnegative(),
  ladder: z.object({
    status: z.enum(['available', 'unavailable']),
    snapshot: AdviceLadderSnapshotSchema.optional(),
    warnings: z.array(z.string()),
  }),
});

const loadLadderSnapshot = async (
  ctx: ToolContext,
): Promise<z.infer<typeof MarketOutlookOutput>['ladder']> => {
  if (ctx.limitUpLadder === undefined) {
    return { status: 'unavailable', warnings: ['limit-up-ladder-manager-unavailable'] };
  }
  const date = dateInShanghai(ctx.clock());
  const result = await ctx.limitUpLadder.fetchLadder({
    date,
    source: 'eastmoney',
    days: 15,
    includeUncategorized: false,
    includeStar: false,
    includeBse: false,
    includeST: false,
  });
  if (!result.ok || result.data === undefined) {
    return {
      status: 'unavailable',
      warnings: [result.error?.message ?? 'limit-up-ladder-unavailable'],
    };
  }
  const snapshot = {
    date: result.data.date,
    total: result.data.total,
    maxLevel: result.data.maxLevel,
    source: result.data.source,
    levels: result.data.levels.map((level) => ({ level: level.level, count: level.count })),
    warnings: [...result.data.warnings],
  };
  return { status: 'available', snapshot, warnings: [...result.data.warnings] };
};

interface QuoteLike {
  readonly stockId: string;
  readonly ts: Date;
  readonly close: number;
  readonly changePct: number;
  readonly open: number;
}

const resolveStock = async (input: string, ctx: ToolContext): Promise<Stock | null> => {
  const byId = await ctx.repos.stock.findById(input);
  if (byId !== null) return byId;
  return ctx.repos.stock.findByCode(input.trim().toUpperCase());
};

const collectQuotes = async (
  theme: string | undefined,
  watchlist: readonly string[] | undefined,
  ctx: ToolContext,
): Promise<readonly QuoteLike[]> => {
  let stocks: readonly Stock[];
  if (watchlist !== undefined && watchlist.length > 0) {
    const xs: Stock[] = [];
    for (const id of watchlist) {
      const s = await resolveStock(id, ctx);
      if (s !== null) xs.push(s);
    }
    stocks = xs;
  } else {
    stocks = await ctx.repos.stock.search('');
  }
  // theme 过滤（简易：industry 包含关键词）
  const filtered =
    theme !== undefined && theme.length > 0
      ? stocks.filter((s) => s.industry?.includes(theme) || s.name.includes(theme))
      : stocks;
  // 统一行情获取（批量 + 落库 + 缓存兜底）；涨幅统计只用实时行情，
  // 本地快照可能是旧交易日的，混入会扭曲全市场平均涨幅。
  const resolved = await resolveQuotes(
    ctx,
    filtered.slice(0, 50).map((s) => s.id),
    { context: 'display' },
  );
  const quotes: QuoteLike[] = [];
  for (const item of resolved) {
    if (item.status !== 'ok' || item.retrieval !== 'live') continue;
    const q = item.quote;
    const changePct = q.open === 0 ? 0 : (q.close - q.open) / q.open;
    quotes.push({ stockId: item.stockId, ts: q.ts, close: q.close, open: q.open, changePct });
  }
  return quotes;
};

/**
 * 大盘 / 板块观点（v0.3 起，advice）。
 * 拉一批股票行情 → 计算板块 / 全市场平均涨幅 → 调 LLM 出结构化 Advice。
 */
export const marketOutlookTool = defineTool({
  name: 'market_outlook',
  description: '大盘 / 板块观点（基于最近 N 日涨幅 + LLM 推理），输出结构化 Advice 持久化',
  sideEffect: 'advice',
  input: MarketOutlookInput,
  output: MarketOutlookOutput,
  handler: async (input, ctx) => {
    const quotes = await collectQuotes(input.theme, input.watchlistIds, ctx);
    const avgChangePct =
      quotes.length === 0 ? 0 : quotes.reduce((s, q) => s + q.changePct, 0) / quotes.length;
    const advancers = quotes.filter((q) => q.changePct > 0).length;
    const decliners = quotes.filter((q) => q.changePct < 0).length;
    const ladder = await loadLadderSnapshot(ctx);

    const llm = await ctx.adapters.llm.generate<AdviceLLMOutput>({
      system: 'market_outlook',
      schema: AdviceLLMSchema,
      data: {
        theme: input.theme ?? '全市场',
        evaluatedStocks: quotes.length,
        advancers,
        decliners,
        avgChangePct,
        ladder,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });

    const now = ctx.clock();
    const id = `mkt-${now.getTime().toString(36)}`;
    const validUntil = computeValidUntil(llm.horizon, now);
    const reasoning = AdviceReasoningSchema.parse({
      ...sanitizeAdviceReasoning(llm.reasoning),
      premise: `${input.theme ?? '全市场'} 平均涨跌 ${(avgChangePct * 100).toFixed(2)}% / 涨 ${advancers} / 跌 ${decliners}`,
    });
    const advice: Advice = {
      id,
      subjectKind: 'market',
      subjectId: input.theme ?? 'all',
      decision: llm.decision,
      confidence: llm.confidence,
      horizon: llm.horizon,
      reasoning,
      risks: sanitizeAdviceRisks(llm.risks),
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'market_outlook',
      basedOn: {
        dataAsOf: now,
        ...(ladder.snapshot === undefined ? {} : { ladder: ladder.snapshot }),
      },
      validFrom: now,
      validUntil,
      createdAt: now,
    };
    await ctx.repos.advice.save(advice);
    return { advice, evaluatedStocks: quotes.length, ladder };
  },
});

// Note: default lookback kept as constant for caller symmetry; not used in v0.3 (we read current quote only).
export const MARKET_OUTLOOK_DEFAULT_LOOKBACK_DAYS = DEFAULT_LOOKBACK_DAYS;
export const _DAY_MS = DAY_MS;
