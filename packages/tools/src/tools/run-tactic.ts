import {
  BUILTIN_TACTICS,
  type DailyBar,
  type Quote,
  runTacticForStock,
  type Stock,
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
});

export const RunTacticOutput = z.object({
  tacticId: z.string(),
  signals: z.array(TacticSignalSchema),
  /** 评估的股票总数（含未命中的）。 */
  evaluatedStocks: z.number().int().nonnegative(),
  /** 命中（triggered=true）的股票数。 */
  triggeredCount: z.number().int().nonnegative(),
});

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

const collectScopeStocks = async (
  scope: 'holdings' | 'watchlist' | 'all-stocks' | 'tactic',
  explicitIds: readonly string[] | undefined,
  ctx: {
    repos: {
      stock: {
        findById(id: string): Promise<Stock | null>;
        findByCode(code: string): Promise<Stock | null>;
        search(q: string): Promise<readonly Stock[]>;
      };
      holding: { listByAccount(accountId: string): Promise<readonly { stockId: string }[]> };
    };
    user: { defaultAccountId: string };
  },
): Promise<readonly Stock[]> => {
  if (scope === 'watchlist') {
    if (explicitIds === undefined || explicitIds.length === 0) {
      return [];
    }
    const stocks: Stock[] = [];
    for (const id of explicitIds) {
      const s = await resolveStock(id, ctx);
      if (s !== null) stocks.push(s);
    }
    return stocks;
  }
  if (scope === 'all-stocks') {
    // repo.search 接受 query='' 返回全部
    return [...(await ctx.repos.stock.search(''))];
  }
  // holdings（scope='tactic' 也走该路径）
  const holdings = await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId);
  const stockIds =
    explicitIds !== undefined && explicitIds.length > 0
      ? explicitIds
      : holdings.map((h) => h.stockId);
  const uniq = Array.from(new Set(stockIds));
  const stocks: Stock[] = [];
  for (const id of uniq) {
    const s = await resolveStock(id, ctx);
    if (s !== null) stocks.push(s);
  }
  return stocks;
};

// 用 core ToolContext 的 narrow 投影（运行时分发由装配层保证）。

/**
 * 跑单个战法生成信号（v0.3 起，read）。
 *
 * scope:
 *   - holdings: 默认账户的所有活跃持仓（stockIds 可选 override）
 *   - watchlist: stockIds 必填
 *   - all-stocks: 数据库全量股票
 *
 * 对每只股票：fetchQuote + fetchDailyBars → 算 indicators → runTacticForStock。
 * 命中的 signal 落库（repos.tactic.saveSignal）。
 */
export const runTacticTool = defineTool({
  name: 'run_tactic',
  description: '跑单个战法生成信号（scope: holdings/watchlist/all-stocks），命中的 signal 自动落库',
  sideEffect: 'read',
  input: RunTacticInput,
  output: RunTacticOutput,
  handler: async (input, ctx) => {
    const c: ToolContext = ctx;
    const tactic = await c.repos.tactic.findById(input.tacticId);
    if (tactic === null) return errNotFound('Tactic', input.tacticId);

    const stocks = await collectScopeStocks(input.scope, input.stockIds, c);
    const now = c.clock();
    const range = {
      start: new Date(now.getTime() - input.lookbackDays * DAY_MS),
      end: now,
    };

    const signals: Array<z.infer<typeof TacticSignalSchema>> = [];
    let triggered = 0;
    for (const stock of stocks) {
      let quote: Quote | undefined;
      let bars: readonly DailyBar[] = [];
      try {
        quote = await c.adapters.market.fetchQuote(stock.id);
        bars = await c.adapters.market.fetchDailyBars(stock.id, range);
      } catch (e) {
        c.logger.warn('[run_tactic] fetch failed, skip', { stockId: stock.id, err: String(e) });
        continue;
      }
      const indicators: TechnicalIndicators = computeSimpleIndicators(bars);
      const outcome = runTacticForStock(tactic, stock.id, now, { quote, indicators });
      if (outcome.triggered) {
        signals.push(TacticSignalSchema.parse(outcome.signal));
        triggered++;
        try {
          await ctx.repos.tactic.saveSignal(outcome.signal);
        } catch (e) {
          c.logger.warn('[run_tactic] saveSignal failed', { stockId: stock.id, err: String(e) });
        }
      }
    }

    // score 倒序 + 截断（保留 top N；落库的 signal 列表已经过滤）
    signals.sort((a, b) => b.score - a.score);
    const truncated = signals.slice(0, DEFAULT_MAX_SIGNALS);

    return {
      tacticId: input.tacticId,
      signals: truncated,
      evaluatedStocks: stocks.length,
      triggeredCount: triggered,
    };
  },
});

// 暴露 BUILTIN_TACTICS 给 MCP server 与 workflow 用
export const runTacticBuiltinTactics = BUILTIN_TACTICS;
