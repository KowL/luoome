import { createHash, randomUUID } from 'node:crypto';
import {
  type AnalysisContext,
  AnalysisContextSchema,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  analysisContextTiming,
  BUILTIN_HOLIDAYS,
  dateInShanghai,
  isHoliday,
  isPublishableOperationalRun,
  isWeekend,
  type LimitUpLadder,
  type Quote,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import { collectStrategyInsightFacts } from '../tools/strategy-insight.js';
import { computeRelevantStockIds } from '../tools/sync-stock-events.js';

export const canonicalAnalysisJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalAnalysisJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalAnalysisJson(item)}`)
    .join(',')}}`;
};
export const analysisHash = (value: unknown): string =>
  createHash('sha256').update(canonicalAnalysisJson(value)).digest('hex');
export const AnalysisContextRequest = z.object({
  kind: AnalysisKindSchema,
  subject: AnalysisSubjectSchema,
  accountId: z.string().min(1).optional(),
  options: z.record(z.string(), z.json()).default({}),
});

const DAY_MS = 86_400_000;
/** 公司事件作为「未来已知事实」的观察窗口；与涨停天梯一致受市场 7 天数据有效期约束。 */
const MARKET_EVENT_WINDOW_DAYS = 7;
/** 回查 PIT 快照的交易日上限；超过 7 天的市场事实已超出 advice_market 数据有效期。 */
const MARKET_SNAPSHOT_LOOKBACK_DAYS = 7;

/** 最近 N 个交易日（Asia/Shanghai，降序）；用于回查已持久化的 PIT 快照。 */
const recentTradingDates = (now: Date, count: number): string[] => {
  const dates: string[] = [];
  let cursor = new Date(`${dateInShanghai(now)}T00:00:00+08:00`);
  while (dates.length < count) {
    if (!isWeekend(cursor) && !isHoliday(cursor, BUILTIN_HOLIDAYS)) {
      dates.push(dateInShanghai(cursor));
    }
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return dates;
};

/** 涨停天梯快照的可验证截止：拉取时刻与当日收盘取较早者，不把 15:00 之后的事实当成盘中数据。 */
const limitUpSnapshotCutoff = (snapshot: LimitUpLadder): Date => {
  const close = new Date(`${snapshot.date}T15:00:00+08:00`);
  return snapshot.asOf.getTime() < close.getTime() ? snapshot.asOf : close;
};

/** 只读已持久化的 PIT 快照；不现场回拉远端，也不把当前快照倒推成历史事实。 */
const loadLatestLimitUpLadder = async (
  ctx: ToolContext,
  now: Date,
): Promise<LimitUpLadder | null> => {
  for (const date of recentTradingDates(now, MARKET_SNAPSHOT_LOOKBACK_DAYS)) {
    const snapshot = await ctx.repos.limitUpLadderSnapshot.findByDate({
      date,
      source: 'eastmoney',
    });
    if (snapshot !== null && limitUpSnapshotCutoff(snapshot).getTime() <= now.getTime()) {
      return snapshot;
    }
  }
  return null;
};

/** 行情事实的紧凑投影；上一收盘缺失时不计算涨跌幅，用缺省表达 unknown。 */
const quoteFactValue = (quote: Quote) => {
  const base = {
    stockId: quote.stockId,
    close: quote.close,
    volume: quote.volume,
    source: quote.source,
    observedAt: quote.observedAt.toISOString(),
  };
  if (quote.prevClose === undefined) return base;
  return {
    ...base,
    prevClose: quote.prevClose,
    changePct: (quote.close - quote.prevClose) / quote.prevClose,
  };
};

interface MarketFactPack {
  readonly facts: AnalysisContext['facts'];
  readonly limitations: string[];
  /** 每个事实自身的可验证时点；`dataAsOf` 取其中最新一个（最新可验证时点）。 */
  readonly verifiedAt: Date[];
}

/**
 * advice_market 的冻结事实包：只用本地已持久化事实（涨停天梯 PIT 快照、持仓/关注股票
 * 已保存行情、相关公司事件），不调用 adapter、不刷新外部数据、也不用 `now` 伪造 `dataAsOf`。
 * 新闻/宽度/指数/财报不在本地事实内，保留 limitations，不从模型记忆补齐。
 */
const collectMarketFacts = async (
  ctx: ToolContext,
  now: Date,
  accountId: string,
): Promise<MarketFactPack> => {
  const facts: AnalysisContext['facts'] = [];
  const limitations: string[] = [];
  const verifiedAt: Date[] = [];

  const ladder = await loadLatestLimitUpLadder(ctx, now);
  if (ladder === null) {
    limitations.push('缺少已保存的涨停天梯快照；市场情绪与涨停结构维度 unavailable。');
  } else {
    const cutoff = limitUpSnapshotCutoff(ladder);
    const entries = ladder.levels.flatMap((level) => level.stocks);
    facts.push({
      id: `market:limit-up:${ladder.date}`,
      label: '已保存涨停天梯快照（市场情绪与涨停结构）',
      value: {
        date: ladder.date,
        source: ladder.source,
        asOf: ladder.asOf.toISOString(),
        dataAsOf: cutoff.toISOString(),
        total: ladder.total,
        maxLevel: ladder.maxLevel,
        levels: ladder.levels.map((level) => ({ level: level.level, count: level.stocks.length })),
        top: entries.slice(0, 10).map((entry) => ({
          code: entry.code,
          name: entry.name,
          industry: entry.industry,
          ladderLevel: entry.ladderLevel,
          reason: entry.reason,
          firstTime: entry.firstTime,
          finalTime: entry.finalTime,
        })),
        warnings: [...ladder.warnings],
      },
      evidenceIds: [],
    });
    verifiedAt.push(cutoff);
  }

  const stockIds = await computeRelevantStockIds(ctx, { accountId, includeEventStocks: false });
  if (stockIds.length === 0) {
    limitations.push('当前账户没有持仓或启用的关注列表，个人上下文为空。');
  }
  const quotes = stockIds.length === 0 ? new Map() : await ctx.repos.quote.latestByStocks(stockIds);
  const currentQuotes = [...quotes.values()]
    .filter((quote) => quote.observedAt.getTime() <= now.getTime())
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime());
  const [latestQuote] = currentQuotes;
  if (latestQuote === undefined) {
    limitations.push('持仓与关注股票没有可用的本地已保存行情；个股层面事实 unavailable。');
  } else {
    facts.push({
      id: 'market:local-quotes',
      label: '持仓与关注股票的本地已保存行情',
      value: {
        accountId,
        count: currentQuotes.length,
        latestObservedAt: latestQuote.observedAt.toISOString(),
        quotes: currentQuotes.slice(0, 20).map(quoteFactValue),
      },
      evidenceIds: [],
    });
    verifiedAt.push(latestQuote.observedAt);
  }

  const relevant = new Set(stockIds);
  const events =
    stockIds.length === 0
      ? []
      : (
          await ctx.repos.stockEvent.list({
            from: now,
            to: new Date(now.getTime() + MARKET_EVENT_WINDOW_DAYS * DAY_MS),
            status: 'scheduled',
            limit: 200,
          })
        )
          .filter((event) => relevant.has(event.stockId))
          .map((event) => ({
            event,
            verifiedAt: event.observedAt ?? event.fetchedAt ?? event.updatedAt,
          }))
          .filter(({ verifiedAt: at }) => at.getTime() <= now.getTime())
          .sort((left, right) => left.event.occursAt.getTime() - right.event.occursAt.getTime());
  if (events.length > 0) {
    let latestVerifiedAt = new Date(0);
    for (const { verifiedAt: at } of events) {
      if (at.getTime() > latestVerifiedAt.getTime()) latestVerifiedAt = at;
    }
    facts.push({
      id: 'market:upcoming-events',
      label: '持仓与关注股票未来 7 天已持久化公司事件',
      value: {
        windowDays: MARKET_EVENT_WINDOW_DAYS,
        count: events.length,
        events: events.slice(0, 20).map(({ event }) => ({
          stockId: event.stockId,
          kind: event.kind,
          title: event.title,
          occursAt: event.occursAt.toISOString(),
          importance: event.importance,
          status: event.status,
          source: event.source,
          ...(event.stale ? { stale: true } : {}),
        })),
      },
      evidenceIds: [],
    });
    verifiedAt.push(latestVerifiedAt);
  }

  limitations.push(
    '市场事实只来自本地已持久化数据（涨停天梯快照、持仓/关注行情、相关公司事件）；' +
      '未包含实时指数、市场宽度、情绪指标、新闻与完整财报，这些维度 unavailable，不能从模型记忆补齐。' +
      '各事实自身时点见对应 fact，context.dataAsOf 是其中最新的可验证时点。',
  );
  return { facts, limitations, verifiedAt };
};

export const assembleAnalysisContext = async (
  input: z.infer<typeof AnalysisContextRequest>,
  ctx: ToolContext,
): Promise<AnalysisContext | null> => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  if (!(await ctx.repos.account.findById(accountId))) return null;
  const now = ctx.clock();
  const facts: AnalysisContext['facts'] = [];
  const limitations: string[] = [];
  const times: number[] = [];
  const market =
    input.subject.kind === 'market' ? await collectMarketFacts(ctx, now, accountId) : null;
  if (market !== null) {
    facts.push(...market.facts);
    limitations.push(...market.limitations);
  }
  let stockId: string | undefined;
  if (input.subject.kind === 'stock') stockId = input.subject.id;
  if (input.subject.kind === 'position') {
    const holding = await ctx.repos.holding.findById(input.subject.id);
    if (!holding || holding.accountId !== accountId) return null;
    stockId = holding.stockId;
    facts.push({
      id: `position:${holding.id}`,
      label: '当前持仓',
      value: {
        stockId: holding.stockId,
        quantity: holding.quantity,
        availableQuantity: holding.availableQuantity,
        avgCost: holding.avgCost,
        closedAt: holding.closedAt?.toISOString() ?? null,
      },
      evidenceIds: [],
    });
  }
  if (stockId) {
    const quote = await ctx.repos.quote.latestByStock(stockId);
    if (quote) {
      facts.push({
        id: `quote:${stockId}`,
        label: '已保存行情',
        value: JSON.parse(JSON.stringify(quote)),
        evidenceIds: [],
      });
      times.push(quote.ts.getTime());
    } else limitations.push('缺少已保存行情；请先显式刷新行情，当前事实包不能写回建议。');
  }
  if (input.subject.kind === 'strategy') {
    const strategy = await ctx.repos.strategy.findById(input.subject.id);
    if (!strategy) return null;
    facts.push({
      id: `strategy:${strategy.id}`,
      label: '策略定义',
      value: JSON.parse(JSON.stringify(strategy)),
      evidenceIds: [],
    });
  }
  if (input.subject.kind === 'strategy') {
    const insight = await collectStrategyInsightFacts(input.subject.id, 30, ctx);
    if (insight) {
      for (const fact of insight.facts) facts.push({ ...fact });
      if (insight.dataAsOf) times.push(insight.dataAsOf.getTime());
      if (insight.observationAsOf) times.push(insight.observationAsOf.getTime());
    }
    if (input.kind === 'strategy_insight_narrative' && typeof input.options.actionId === 'string') {
      const action = await ctx.repos.strategyAutonomyAction.findById(input.options.actionId);
      if (!action || action.strategyId !== input.subject.id) return null;
      facts.push({
        id: `action:${action.id}`,
        label: '叙述目标版本',
        value: { id: action.id, updatedAt: action.updatedAt.toISOString() },
        evidenceIds: [],
      });
    }
  }
  if (input.kind === 'research_directions') {
    for (const strategy of await ctx.repos.strategy.list({ status: 'active' })) {
      const run = await ctx.repos.strategyRun.findLatestPublishedRun(strategy.id);
      if (
        !run ||
        !isPublishableOperationalRun(run) ||
        run.strategyVersionId !== strategy.currentVersionId
      )
        continue;
      const evidence = {
        id: `run:${run.id}:coverage`,
        strategyId: strategy.id,
        strategyVersionId: run.strategyVersionId,
        runId: run.id,
        dataAsOf: run.dataAsOf.toISOString(),
        kind: 'coverage',
        text: JSON.stringify({ coverage: run.coverage, summary: run.summary }),
      };
      facts.push({
        id: evidence.id,
        label: '已发布策略运行事实',
        value: evidence,
        evidenceIds: [],
      });
      times.push(run.dataAsOf.getTime());
    }
  }
  limitations.push(
    '仅使用已持久化事实，未刷新外部数据；不包含实时盘口、完整财报或未经核验的模型结论。',
  );
  if (times.length === 0 && (market === null || market.verifiedAt.length === 0))
    limitations.push('缺少可验证的数据截止时点，不具备生成投资建议的条件。');
  // 股票/策略事实取最早时点（conservative）；市场事实包只包含本地已验证事实，取最新可验证时点。
  const dataAsOf = new Date(
    market !== null && market.verifiedAt.length > 0
      ? Math.max(...market.verifiedAt.map((at) => at.getTime()))
      : times.length
        ? Math.min(...times)
        : 0,
  );
  const { writeUntil } = analysisContextTiming(input.kind, dataAsOf, now);
  return AnalysisContextSchema.parse({
    id: randomUUID(),
    jobId: null,
    kind: input.kind,
    accountId,
    subject: input.subject,
    dataAsOf,
    facts,
    factIds: facts.map((fact) => fact.id),
    limitations,
    contextHash: analysisHash({ facts, dataAsOf }),
    writeUntil,
    expiresAt: new Date(now.getTime() + 180 * 86400000),
    createdAt: now,
  });
};

export const getAnalysisContextTool = defineTool({
  name: 'get_analysis_context',
  description: '装配并保存确定性分析事实，或按 ID 读取审计快照；不调用模型。',
  sideEffect: 'read',
  input: AnalysisContextRequest.partial({ kind: true, subject: true })
    .extend({
      contextId: z.string().min(1).optional(),
    })
    .superRefine((input, ctx) => {
      if (
        input.contextId
          ? input.kind !== undefined || input.subject !== undefined
          : !input.kind || !input.subject
      ) {
        ctx.addIssue({ code: 'custom', message: 'Provide contextId or both kind and subject' });
      }
    }),
  output: AnalysisContextSchema,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (input.contextId !== undefined)
      return (
        (await ctx.repos.analysis.findContext(accountId, input.contextId)) ??
        errNotFound('AnalysisContext', input.contextId)
      );
    const request = AnalysisContextRequest.parse(input);
    const context = await assembleAnalysisContext(request, ctx);
    if (!context) return errNotFound('AnalysisSubject', request.subject.id);
    await ctx.repos.analysis.saveContext(context);
    return context;
  },
});
