import {
  dateInShanghai,
  type Money,
  MoneySchema,
  PercentageSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { enrichHolding, HoldingPnlSchema, summarizePnl } from '../internal/holding-pnl.js';
import { derivePreviousClose, normalizeDailyBars } from '../internal/market-view.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';

const HoldingStatusSchema = z.enum(['active', 'closed', 'all']);

/** 昨收回看窗口：覆盖长假（春节 / 国庆）足够。 */
const PREVIOUS_CLOSE_LOOKBACK_DAYS = 15;
const DAY_MS = 86_400_000;

export const ListHoldingsInput = z.object({
  /** 账户 id；缺省为当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
  /** active=仅未平仓（默认） / closed=仅已平仓 / all=全部。 */
  status: HoldingStatusSchema.default('active'),
});

export const ListHoldingsOutput = z.object({
  accountId: z.string().min(1),
  status: HoldingStatusSchema,
  holdings: z.array(HoldingPnlSchema),
  totalValue: MoneySchema,
  totalCost: MoneySchema,
  totalPnL: MoneySchema,
  totalPnLPct: PercentageSchema,
  /** 今日盈亏合计；任一持仓缺昨收时为 null。 */
  totalTodayPnl: MoneySchema.nullable(),
  totalTodayPnlPct: PercentageSchema.nullable(),
});

export const listHoldingsTool = defineTool({
  name: 'list_holdings',
  description: '列出指定账户下的当前持仓（含现价与 PnL 汇总）',
  sideEffect: 'read',
  input: ListHoldingsInput,
  output: ListHoldingsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const all = await ctx.repos.holding.listByAccount(accountId);
    const holdings = all.filter((h) => {
      if (input.status === 'all') return true;
      return input.status === 'active' ? h.closedAt === null : h.closedAt !== null;
    });

    const stockIds = holdings.map((h) => h.stockId);
    // 统一行情获取：实时优先，实时缺席回退本地最近快照（resolveQuotes 内部落库）。
    const resolvedQuotes = await resolveQuotes(ctx, stockIds, { context: 'display' });
    const quotes = new Map(
      resolvedQuotes.flatMap((item) =>
        item.status === 'ok' ? [[item.stockId, item.quote] as const] : [],
      ),
    );
    const previousCloses = await resolvePreviousCloses(ctx, stockIds);
    const items = await Promise.all(
      holdings.map(async (holding) => {
        const stock = await ctx.repos.stock.findById(holding.stockId);
        return enrichHolding(
          holding,
          quotes.get(holding.stockId),
          stock?.name ?? holding.stockId,
          previousCloses.get(holding.stockId) ?? null,
        );
      }),
    );

    return { accountId, status: input.status, holdings: items, ...summarizePnl(items) };
  },
});

/** 逐股取昨收：实时日线优先，失败回退本地缓存；都取不到为 null（今日盈亏留空）。 */
const resolvePreviousCloses = async (
  ctx: ToolContext,
  stockIds: readonly string[],
): Promise<Map<string, Money | null>> => {
  const todayStart = new Date(`${dateInShanghai(ctx.clock())}T00:00:00.000Z`);
  const start = new Date(todayStart.getTime() - PREVIOUS_CLOSE_LOOKBACK_DAYS * DAY_MS);
  const uniqueIds = [...new Set(stockIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (stockId): Promise<readonly [string, Money | null]> => {
      try {
        const bars = await ctx.adapters.market.fetchDailyBars(stockId, {
          start,
          end: todayStart,
        });
        const close = derivePreviousClose(
          normalizeDailyBars(bars, start, todayStart).bars,
          todayStart,
        );
        if (close !== null) return [stockId, close];
      } catch (error) {
        ctx.logger.warn('list_holdings live daily bars unavailable, using stored bars', {
          stockId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const cached = await ctx.repos.dailyBar.findInRange(stockId, start, todayStart);
      return [
        stockId,
        derivePreviousClose(normalizeDailyBars(cached, start, todayStart).bars, todayStart),
      ];
    }),
  );
  return new Map(entries);
};
