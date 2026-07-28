import {
  BUILTIN_TACTICS,
  type DailyBar,
  money,
  type Quote,
  runTacticForStock,
  type Stock,
  stockCode,
  type Tactic,
  TacticSignalSchema,
  type TechnicalIndicators,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 120;
const DEFAULT_MAX_SIGNALS = 200;

const TacticScopeSchema = z.enum(['holdings', 'watchlist', 'all-stocks', 'tactic']);

export const RunTacticInput = z.object({
  tacticId: z.string().min(1),
  scope: TacticScopeSchema.default('holdings'),
  /** scope=watchlist / scope=tactic 时必填。 */
  stockIds: z.array(z.string().min(1)).optional(),
  lookbackDays: z.number().int().positive().max(365).default(DEFAULT_LOOKBACK_DAYS),
  /** 是否把命中的 signal 写入 tactic_signals 表。默认 true；watch 高频轮询传 false 避免打爆表。 */
  persistSignals: z.boolean().default(true),
});

export const RunTacticOutput = z.object({
  tacticId: z.string(),
  signals: z.array(TacticSignalSchema),
  /** 评估的股票总数（含未命中的）。 */
  evaluatedStocks: z.number().int().nonnegative(),
  /** 命中（triggered=true）的股票数。 */
  triggeredCount: z.number().int().nonnegative(),
});

/** 评估目标：stock + 可选的全市场快照价（快照路径下可免逐股 fetchQuote）。 */
interface EvalTarget {
  readonly stock: Stock;
  readonly snapshotClose?: number;
}

const resolveStock = async (
  input: string,
  ctx: {
    repos: {
      stock: {
        findById(id: string): Promise<Stock | null>;
        findByCode(code: string): Promise<Stock | null>;
      };
    };
  },
): Promise<Stock | null> => {
  const byId = await ctx.repos.stock.findById(input);
  if (byId !== null) return byId;
  return ctx.repos.stock.findByCode(input.trim().toUpperCase());
};

/**
 * 全市场候选全集：adapter 实现了 fetchMarketSnapshot 就用全市场快照；
 * 未实现或失败时降级本地 stocks 表（v0.8 前的行为）。
 */
const collectUniverse = async (c: ToolContext): Promise<EvalTarget[]> => {
  if (typeof c.adapters.market.fetchMarketSnapshot === 'function') {
    try {
      const items = await c.adapters.market.fetchMarketSnapshot();
      return items.map((item) => ({
        stock: {
          id: item.id,
          code: stockCode(item.code),
          exchange: item.exchange,
          name: item.name,
        },
        ...(item.close !== undefined ? { snapshotClose: item.close } : {}),
      }));
    } catch (e) {
      c.logger.warn('[run_tactic] fetchMarketSnapshot 失败，降级本地股票库', { err: String(e) });
    }
  }
  return [...(await c.repos.stock.search(''))].map((stock) => ({ stock }));
};

const collectScopeStocks = async (
  scope: 'holdings' | 'watchlist' | 'all-stocks' | 'tactic',
  explicitIds: readonly string[] | undefined,
  ctx: ToolContext,
): Promise<readonly EvalTarget[]> => {
  if (scope === 'watchlist') {
    if (explicitIds === undefined || explicitIds.length === 0) {
      return [];
    }
    const stocks: EvalTarget[] = [];
    for (const id of explicitIds) {
      const s = await resolveStock(id, ctx);
      if (s !== null) stocks.push({ stock: s });
    }
    return stocks;
  }
  if (scope === 'all-stocks') {
    return collectUniverse(ctx);
  }
  // holdings（scope='tactic' 也走该路径）
  const holdings = await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId);
  const stockIds =
    explicitIds !== undefined && explicitIds.length > 0
      ? explicitIds
      : holdings.map((h) => h.stockId);
  const uniq = Array.from(new Set(stockIds));
  const stocks: EvalTarget[] = [];
  for (const id of uniq) {
    const s = await resolveStock(id, ctx);
    if (s !== null) stocks.push({ stock: s });
  }
  return stocks;
};

/** 战法 DSL 是否引用 quote.open/high/low/volume（引用则不能用快照价合成 quote）。 */
const FULL_QUOTE_FIELD_RE = /quote\.(open|high|low|volume)\b/;
const tacticNeedsFullQuote = (tactic: Tactic): boolean =>
  FULL_QUOTE_FIELD_RE.test(
    [tactic.triggerWhen, tactic.scoreExpression, ...tactic.evidenceTemplate].join('\n'),
  );

/** 快照价合成 quote：OHLC 同价、volume=0；仅在 DSL 不引用这些字段时使用。 */
const quoteFromSnapshot = (stockId: string, close: number, now: Date): Quote => ({
  stockId,
  ts: now,
  open: money(close),
  high: money(close),
  low: money(close),
  close: money(close),
  volume: 0,
  source: 'market-snapshot',
});

/**
 * 有界并发 map：全市场 ~5400 只逐股拉 K 线，顺序 await 吞吐远低于
 * Manager rate limiter（默认 10/s）上限；小并发池逼近上限。
 * 全量扫描预期分钟级耗时（rate limiter 仍是硬上限）。
 */
const EVAL_CONCURRENCY = 8;
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item !== undefined) {
        results[i] = await fn(item);
      }
    }
  });
  await Promise.all(workers);
  return results;
};

// 用 core ToolContext 的 narrow 投影（运行时分发由装配层保证）。

/**
 * 跑单个战法生成信号（v0.3 起，read）。
 *
 * scope:
 *   - holdings: 默认账户的所有活跃持仓（stockIds 可选 override）
 *   - watchlist: stockIds 必填
 *   - all-stocks: 全市场快照（adapter 未实现 fetchMarketSnapshot 时降级本地股票库）
 *
 * 对每只股票：quote（快照价可合成）+ fetchDailyBars → 算 indicators → runTacticForStock。
 * 命中的 signal 落库（repos.tactic.saveSignal）。
 */
export const runTacticTool = defineTool({
  name: 'run_tactic',
  description:
    '跑单个战法生成信号（scope: holdings/watchlist/all-stocks=全市场快照，降级本地库）；persistSignals=false 时不写 tactic_signals（watch 高频轮询用）',
  sideEffect: 'read',
  input: RunTacticInput,
  output: RunTacticOutput,
  handler: async (input, ctx) => {
    const c: ToolContext = ctx;
    const tactic = await c.repos.tactic.findById(input.tacticId);
    if (tactic === null) return errNotFound('Tactic', input.tacticId);

    const targets = await collectScopeStocks(input.scope, input.stockIds, c);
    const now = c.clock();
    const range = {
      start: new Date(now.getTime() - input.lookbackDays * DAY_MS),
      end: now,
    };
    const needsFullQuote = tacticNeedsFullQuote(tactic);

    const evalOne = async (
      target: EvalTarget,
    ): Promise<z.infer<typeof TacticSignalSchema> | null> => {
      const { stock } = target;
      let quote: Quote;
      let bars: readonly DailyBar[];
      try {
        quote =
          !needsFullQuote && target.snapshotClose !== undefined
            ? quoteFromSnapshot(stock.id, target.snapshotClose, now)
            : await c.adapters.market.fetchQuote(stock.id);
        bars = await c.adapters.market.fetchDailyBars(stock.id, range);
      } catch (e) {
        c.logger.warn('[run_tactic] fetch failed, skip', { stockId: stock.id, err: String(e) });
        return null;
      }
      const indicators: TechnicalIndicators = computeSimpleIndicators(bars);
      const outcome = runTacticForStock(tactic, stock.id, now, { quote, indicators });
      if (!outcome.triggered) return null;
      if (input.persistSignals) {
        try {
          await ctx.repos.tactic.saveSignal(outcome.signal);
        } catch (e) {
          c.logger.warn('[run_tactic] saveSignal failed', { stockId: stock.id, err: String(e) });
        }
      }
      return TacticSignalSchema.parse(outcome.signal);
    };

    const evaluated = await mapWithConcurrency(targets, EVAL_CONCURRENCY, evalOne);
    const signals = evaluated.filter((s): s is z.infer<typeof TacticSignalSchema> => s !== null);

    // score 倒序 + 截断（保留 top N；落库的 signal 列表已经过滤）
    signals.sort((a, b) => b.score - a.score);
    const truncated = signals.slice(0, DEFAULT_MAX_SIGNALS);

    return {
      tacticId: input.tacticId,
      signals: truncated,
      evaluatedStocks: targets.length,
      triggeredCount: signals.length,
    };
  },
});

// 暴露 BUILTIN_TACTICS 给 MCP server 与 workflow 用
export const runTacticBuiltinTactics = BUILTIN_TACTICS;
