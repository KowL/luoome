import {
  computeMarketSession,
  dateInShanghai,
  type Money,
  MoneySchema,
  PercentageSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import {
  enrichHolding,
  HOLDING_PRICE_STALE,
  HoldingPnlSchema,
  summarizePnl,
} from '../internal/holding-pnl.js';
import { derivePreviousClose, normalizeDailyBars } from '../internal/market-view.js';

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

/**
 * 持仓列表输出。**形状变更（REQ-M3-09 / D2）**：缺价时 `totalValue` / `totalPnL` / `totalPnLPct`
 * 字段缺席（而不是 0），`unpricedCount > 0`。这是破坏性变更，已在 `docs/ARCHITECTURE.md` 记录；
 * 消费方必须渲染「缺价」而不是 0。
 */
export const ListHoldingsOutput = z
  .object({
    accountId: z.string().min(1),
    status: HoldingStatusSchema,
    holdings: z.array(HoldingPnlSchema),
    totalValue: MoneySchema.optional(),
    totalCost: MoneySchema,
    totalPnL: MoneySchema.optional(),
    totalPnLPct: PercentageSchema.optional(),
    /**
     * 报价时效的顶层聚合（task-30）：**取最旧**，与 `panel-health` 的聚合 `asOf` 同口径。
     *
     * 档位：**缺席** = 没有任何持仓带报价时间（无法给出上界时不给数字）。
     */
    quoteAsOf: z.coerce.date().optional(),
    /**
     * 落在 `stale` / `unknown` 档的持仓数——用户不该为了知道「有没有陈旧数据」而逐行扫。
     *
     * 档位：`0` = **确定结论**「没有陈旧数据」，不是缺失。
     */
    staleCount: z.number().int().nonnegative(),
    /**
     * 缺价持仓数；>0 时上面三个合计字段**缺席**。
     *
     * 档位：`0`（真值 = 没有缺价持仓，合计字段因此可用）。
     */
    unpricedCount: z.number().int().nonnegative(),
    /** 今日盈亏合计；任一持仓缺昨收或缺价时为 null。 */
    totalTodayPnl: MoneySchema.nullable(),
    totalTodayPnlPct: PercentageSchema.nullable(),
  })
  .strict();

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
    /**
     * **纯读（task-14）**：只读已落库报价，不回源、不写库。
     *
     * 这里曾是 `resolveQuotes(...)`——它会访问外部行情源并 `quote.save` 落库，
     * 而工具声明是 `sideEffect: 'read'`。名实不符等于给模型一个**错误的安全担保**
     * （模型据此认为「调用它没有副作用」）。拆分后：本工具只读，刷新走
     * `refresh_holdings_quotes`（external），由明确意图触发。
     */
    const quotes = await ctx.repos.quote.latestByStocks(stockIds);
    const previousCloses = await resolvePreviousCloses(ctx, stockIds);
    // 时效分档的参照时刻与交易时段（task-30）：阈值在 core，这里只取事实。
    const now = ctx.clock();
    const session = computeMarketSession(now);
    const items = await Promise.all(
      holdings.map(async (holding) => {
        const stock = await ctx.repos.stock.findById(holding.stockId);
        const stored = quotes.get(holding.stockId);
        return enrichHolding(
          holding,
          stored,
          stock?.name ?? holding.stockId,
          previousCloses.get(holding.stockId) ?? null,
          // 缺价原因按库内事实区分：库里有行但不在当日 = 过期；一行都没有 = 从未有过。
          // （`latestByStocks` 返回的是**最新一行**，所以「有行」⇔「历史上有过报价」。）
          HOLDING_PRICE_STALE,
          { now, session },
        );
      }),
    );

    // 经 schema parse：把「字段缺席」落到输出类型上，避免可选字段被推断成全量。
    // 顶层聚合（task-30）：取最旧报价时点（与 panel-health 同口径）+ 陈旧计数（0 是确定结论）。
    const observedTimes = items.flatMap((item) =>
      item.quoteObservedAt === undefined ? [] : [item.quoteObservedAt.getTime()],
    );
    const staleCount = items.filter(
      (item) =>
        item.quoteFreshness === undefined ||
        item.quoteFreshness.tier === 'stale' ||
        item.quoteFreshness.tier === 'unknown',
    ).length;
    return ListHoldingsOutput.parse({
      accountId,
      status: input.status,
      holdings: items,
      ...summarizePnl(items),
      ...(observedTimes.length === 0 ? {} : { quoteAsOf: new Date(Math.min(...observedTimes)) }),
      staleCount,
    });
  },
});

/** 逐股取昨收：**只读已落库日线**；取不到为 null（今日盈亏留空，不伪造基准）。 */
const resolvePreviousCloses = async (
  ctx: ToolContext,
  stockIds: readonly string[],
): Promise<Map<string, Money | null>> => {
  const todayStart = new Date(`${dateInShanghai(ctx.clock())}T00:00:00.000Z`);
  const start = new Date(todayStart.getTime() - PREVIOUS_CLOSE_LOOKBACK_DAYS * DAY_MS);
  const uniqueIds = [...new Set(stockIds)];
  const entries = await Promise.all(
    uniqueIds.map(async (stockId): Promise<readonly [string, Money | null]> => {
      // 纯读：只读已落库日线，不回源（原实现在这里 `ctx.adapters.market.fetchDailyBars`）。
      const cached = await ctx.repos.dailyBar.findInRange(stockId, start, todayStart);
      return [
        stockId,
        derivePreviousClose(normalizeDailyBars(cached, start, todayStart).bars, todayStart),
      ];
    }),
  );
  return new Map(entries);
};
