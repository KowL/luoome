import { createHash, randomUUID } from 'node:crypto';
import {
  ANALYSIS_CONTEXT_HASH_VERSION,
  type AnalysisContext,
  AnalysisContextSchema,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  analysisContextHashPayload,
  analysisContextTiming,
  BUILTIN_HOLIDAYS,
  classifyMarketObservation,
  dateInShanghai,
  isHoliday,
  isPublishableOperationalRun,
  isWeekend,
  type LimitUpLadder,
  MARKET_ADVICE_SAME_DAY_ONLY,
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
/** 公司事件作为「未来已知事实」的观察窗口（未来 7 天内已排定的日程）。 */
const MARKET_EVENT_WINDOW_DAYS = 7;
/**
 * 回查 PIT 快照的交易日上限。市场级只接受当日快照（REQ-M3-20），这个回查窗口不是有效期，
 * 而是用来判断「有没有更早的快照被当日口径排除」——排除要留原因码，不能静默当成没有事实。
 */
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
  readonly missingFacts: AnalysisContext['missingFacts'];
  /** 每个事实自身的可验证时点；`dataAsOf` 取其中最新一个（最新可验证时点）。 */
  readonly verifiedAt: Date[];
}

/**
 * advice_market 的冻结事实包：只用本地已持久化事实（涨停天梯 PIT 快照、持仓/关注股票
 * 已保存行情、相关公司事件），不调用 adapter、不刷新外部数据、也不用 `now` 伪造 `dataAsOf`。
 * 新闻/宽度/指数/财报不在本地事实内，保留 limitations，不从模型记忆补齐。
 *
 * 市场级当日口径（REQ-M3-20）：跨日事实**不进可用事实**，只留下
 * `market-advice-same-day-only` 这条 blocking 缺口；当日但在 15:00 收盘之后的观察
 * 保留在事实包里，但标成 `historical` 降级——降级不等于删除。
 * 公司事件不套这条口径：它是「未来已知事实」，验证时点不是市场状态观察。
 */
/** 新闻事实回看窗口（自然日）：只读已落库事实，不回源。 */
const NEWS_LOOKBACK_DAYS = 30;
/** 单次最多取多少条已落库新闻事实（10 条进 payload，全部进 evidenceIds）。 */
const NEWS_FACT_LIMIT = 50;

const collectMarketFacts = async (
  ctx: ToolContext,
  now: Date,
  accountId: string,
): Promise<MarketFactPack> => {
  const facts: AnalysisContext['facts'] = [];
  const limitations: string[] = [];
  const missingFacts: AnalysisContext['missingFacts'] = [];
  const verifiedAt: Date[] = [];
  /** 被当日口径排除的跨日市场事实；存在即说明昨日结论想顶替今日市场状态。 */
  const crossDayFactIds: string[] = [];
  const today = dateInShanghai(now);

  const ladder = await loadLatestLimitUpLadder(ctx, now);
  if (ladder === null) {
    limitations.push('缺少已保存的涨停天梯快照；市场情绪与涨停结构维度 unavailable。');
  } else if (ladder.date !== today) {
    crossDayFactIds.push(`market:limit-up:${ladder.date}`);
    limitations.push(
      `已保存的涨停天梯快照属于 ${ladder.date}，不是当日（${today}）；` +
        '按市场级当日口径排除，不用昨日的涨停结构代表今日市场情绪。',
    );
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
        observationClass: classifyMarketObservation(cutoff, now),
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
  const visibleQuotes = [...quotes.values()].filter(
    (quote) => quote.observedAt.getTime() <= now.getTime(),
  );
  const currentQuotes = visibleQuotes.filter((quote) => dateInShanghai(quote.observedAt) === today);
  if (currentQuotes.length < visibleQuotes.length) {
    crossDayFactIds.push('market:local-quotes');
    limitations.push(
      `持仓与关注股票有 ${visibleQuotes.length - currentQuotes.length} 条行情不是当日（${today}）；` +
        '按市场级当日口径排除，不用昨日行情代表今日个股层面事实。',
    );
  }
  const [latestQuote] = currentQuotes.sort(
    (left, right) => right.observedAt.getTime() - left.observedAt.getTime(),
  );
  if (latestQuote === undefined) {
    limitations.push('持仓与关注股票没有可用的本地已保存行情；个股层面事实 unavailable。');
    missingFacts.push({
      kind: 'quote-unavailable',
      subjectId: accountId,
      reason: '持仓与关注股票没有可用的本地已保存行情',
      asOf: now,
    });
  } else {
    facts.push({
      id: 'market:local-quotes',
      label: '持仓与关注股票的本地已保存行情',
      value: {
        accountId,
        count: currentQuotes.length,
        latestObservedAt: latestQuote.observedAt.toISOString(),
        observationClass: classifyMarketObservation(latestQuote.observedAt, now),
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

  /**
   * 新闻类外部事实（REQ-M3-16 / S7）：**只读已落库事实表**，不再回退到 `fetch_*` 实时取。
   *
   * 「当日」判定沿用 core 的三档口径（`marketObservationScope` / `classifyMarketObservation`），
   * 与涨停天梯、持仓行情同一条纪律——用 `publishedAt` 做朴素日期比较会让 REQ-M3-20 回退。
   * - `historical`（更早，或当日 15:00 收盘之后被复用）：**保留在事实包里但显式降级**，
   *   不删除；并且**不进可用事实**（由跨日口径留痕）。
   * - `current`：当日未过收盘 → 当前依据。
   * - `prior-session`：上一交易日收盘观察 → 盘前常态数据，保留并标注。
   */
  const newsWindowStart = new Date(now.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000);
  const storedNews = await ctx.repos.externalMarketFact.listByKind({
    kind: 'news',
    from: newsWindowStart,
    to: now,
    limit: NEWS_FACT_LIMIT,
  });
  const usableNews: (typeof storedNews)[number][] = [];
  for (const fact of storedNews) {
    if (classifyMarketObservation(fact.observedAt, now) === 'current') {
      usableNews.push(fact);
      continue;
    }
    // 跨日（或当日盘后被复用）的新闻：不进可用事实，但**留痕**——降级不等于删除。
    crossDayFactIds.push(fact.id);
  }
  if (usableNews.length > 0) {
    const latestNewsAt = new Date(Math.max(...usableNews.map((fact) => fact.observedAt.getTime())));
    facts.push({
      id: `market:news:${dateInShanghai(latestNewsAt)}`,
      label: `已落库财经要闻（${String(usableNews.length)} 条）`,
      value: {
        // 每条都带**事实表主键**：Advice 引用它就必须逐条落库（L2 会查表）。
        items: usableNews.slice(0, 10).map((fact) => ({
          factId: fact.id,
          title: String(fact.payload.title ?? ''),
          summary: String(fact.payload.summary ?? ''),
          category: fact.category ?? '',
          media: String(fact.payload.media ?? ''),
          url: String(fact.payload.url ?? ''),
          observedAt: fact.observedAt.toISOString(),
          source: fact.source,
          observationClass: classifyMarketObservation(fact.observedAt, now),
        })),
        dataAsOf: latestNewsAt.toISOString(),
        observationClass: classifyMarketObservation(latestNewsAt, now),
        source: 'external_market_facts',
        factIds: usableNews.map((fact) => fact.id),
      },
      // 证据 id 就是事实表主键：Advice 引用它们时会被 L2 校验「表里查得到」。
      evidenceIds: usableNews.map((fact) => fact.id),
    });
    verifiedAt.push(latestNewsAt);
  }

  // 跨日市场事实被排除后必须留痕：这是 blocking 缺口（→ unavailable + 原因码），
  // 不是 degraded——否则模型会把「昨日市场结构」继续当成今日依据（REQ-M3-20）。
  if (crossDayFactIds.length > 0) {
    missingFacts.push({
      kind: MARKET_ADVICE_SAME_DAY_ONLY,
      subjectId: 'market',
      reason:
        `市场级分析只接受当日（Asia/Shanghai 自然日 ${today}）的事实；` +
        `已排除跨日事实：${crossDayFactIds.join('、')}`,
      asOf: now,
    });
  }

  missingFacts.push(
    {
      kind: 'market-breadth-unavailable',
      subjectId: 'market',
      reason: '未接入实时指数、市场宽度与情绪指标',
      asOf: now,
    },
    {
      kind: 'news-unavailable',
      subjectId: 'market',
      // 「表里没有」≠「不存在」：点名缺什么 + 怎么补（先抓取再落库），不回退到实时抓取。
      reason:
        usableNews.length === 0
          ? '已落库的财经要闻为空：外部事实未落库（先运行 fetch_news 抓取，再运行 persist_external_facts 落库）；本上下文只读已落库事实，不临时回退到实时抓取'
          : '已落库的财经要闻没有当日可用的条目（跨日条目按市场级当日口径排除，见跨日缺口）',
      asOf: now,
    },
    {
      kind: 'fundamental-unavailable',
      subjectId: 'market',
      reason: '未包含完整财报事实',
      asOf: now,
    },
  );
  limitations.push(
    '市场事实只来自本地已持久化数据（涨停天梯快照、持仓/关注行情、相关公司事件）；' +
      '未包含实时指数、市场宽度、情绪指标、新闻与完整财报，这些维度 unavailable，不能从模型记忆补齐。' +
      '各事实自身时点见对应 fact，context.dataAsOf 是其中最新的可验证时点。',
  );
  return { facts, limitations, missingFacts, verifiedAt };
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
  const missingFacts: AnalysisContext['missingFacts'] = [];
  const times: number[] = [];
  const market =
    input.subject.kind === 'market' ? await collectMarketFacts(ctx, now, accountId) : null;
  if (market !== null) {
    facts.push(...market.facts);
    limitations.push(...market.limitations);
    missingFacts.push(...market.missingFacts);
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
    } else {
      limitations.push('缺少已保存行情；请先显式刷新行情，当前事实包不能写回建议。');
      missingFacts.push({
        kind: 'quote-unavailable',
        subjectId: stockId,
        reason: '缺少已保存行情，当前事实包不能写回建议',
        asOf: now,
      });
    }
  }
  // 盘后策略候选建议：把「哪次已发布运行、哪只股票、什么分数排名」冻进事实包，
  // 供 record_advice 还原 basedOn.strategy；下游逐股计划据此判断建议来源账户。
  if (stockId !== undefined && typeof input.options.strategyRunId === 'string') {
    const run = await ctx.repos.strategyRun.findRunById(input.options.strategyRunId);
    if (run === null || !isPublishableOperationalRun(run)) return null;
    const results = await ctx.repos.strategyRun.listResults(run.id);
    const result = results.find((item) => item.stockId === stockId);
    if (result === undefined) return null;
    const signals = (await ctx.repos.strategyRun.signalsByRun(run.id)).filter(
      (signal) => signal.stockId === stockId,
    );
    facts.push({
      id: `strategy-run:${run.id}:${stockId}`,
      label: '已发布策略运行结果',
      value: {
        strategyId: run.strategyId,
        strategyVersionId: run.strategyVersionId,
        runId: run.id,
        stockId,
        accountId,
        ...(result.score === undefined ? {} : { score: result.score }),
        ...(result.rank === undefined ? {} : { rank: result.rank }),
        resultEvidence: [...result.evidence],
        signalIds: signals.map((signal) => signal.id),
        observationIds: [],
        recommendationTrigger: 'run' as const,
      },
      evidenceIds: [`run:${run.id}`],
    });
    times.push(run.dataAsOf.getTime());
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
  const timing = analysisContextTiming(input.kind, dataAsOf, now);
  if (input.kind === 'advice_market') {
    // 规则版本落进 limitations：它随 context 持久化，跨版本读回时能说清
    // 「这条市场级 context 是按当日口径还是旧 7 天口径判定的」（REQ-M3-20 / R2）。
    limitations.push(
      `时效规则 ${timing.ruleVersion}：市场级结论仅当日（Asia/Shanghai 自然日）有效，` +
        '跨日观察只能标为历史观察，不得作为当前依据进入建议链。',
    );
  }
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
    missingFacts,
    contextHashVersion: ANALYSIS_CONTEXT_HASH_VERSION,
    timingRuleVersion: timing.ruleVersion,
    contextHash: analysisHash(
      analysisContextHashPayload({
        version: ANALYSIS_CONTEXT_HASH_VERSION,
        facts,
        dataAsOf,
        missingFacts,
      }),
    ),
    writeUntil: timing.writeUntil,
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
