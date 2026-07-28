import { DailyBarSchema, type ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_LOOKBACK_DAYS = 370;

export const SyncDailyBarsInput = z
  .object({
    stockIds: z.array(z.string().trim().min(1)).max(1000).optional(),
    scope: z.enum(['relevant', 'explicit']).default('relevant'),
    correctionWindowDays: z.number().int().min(5).max(60).default(15),
  })
  .superRefine((input, issue) => {
    if (
      input.scope === 'explicit' &&
      (input.stockIds === undefined || input.stockIds.length === 0)
    ) {
      issue.addIssue({
        code: 'custom',
        path: ['stockIds'],
        message: 'scope=explicit requires stockIds',
      });
    }
  });

const SyncDailyBarsItemSchema = z.discriminatedUnion('status', [
  z.object({
    stockId: z.string(),
    status: z.literal('synced'),
    barCount: z.number().int().nonnegative(),
    from: z.coerce.date(),
    to: z.coerce.date(),
    sources: z.array(z.string()),
  }),
  z.object({
    stockId: z.string(),
    status: z.literal('failed'),
    reason: z.string(),
  }),
]);

export const SyncDailyBarsOutput = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'skipped']),
  totalRequested: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(SyncDailyBarsItemSchema),
});

const activeHoldingIds = async (accountId: string, ctx: ToolContext): Promise<string[]> =>
  (await ctx.repos.holding.listByAccount(accountId))
    .filter(
      (holding) =>
        (holding.closedAt === undefined || holding.closedAt === null) && holding.quantity > 0,
    )
    .map((holding) => holding.stockId);

async function syncRelevantStockIds(ctx: ToolContext): Promise<string[]> {
  const result = new Set<string>();
  const accounts = await ctx.repos.account.list();
  for (const account of accounts) {
    for (const stockId of await activeHoldingIds(account.id, ctx)) result.add(stockId);
  }

  const groups = await ctx.repos.stockGroup.list(true);
  for (const group of groups) {
    if (group.resolver.kind === 'manual') {
      for (const stockId of group.resolver.stockIds) result.add(stockId);
    } else if (group.resolver.kind === 'holdings') {
      for (const stockId of await activeHoldingIds(group.resolver.accountId, ctx)) {
        result.add(stockId);
      }
    } else {
      for (const member of await ctx.repos.groupMember.currentMembers(group.id)) {
        result.add(member.stockId);
      }
    }
  }

  for (const stockId of await ctx.repos.stockEvent.listStockIdsWithEvents()) result.add(stockId);
  for (const stockId of await ctx.repos.researchNote.listStockIdsWithNotes()) result.add(stockId);
  return [...result].sort();
}

export const syncDailyBarsTool = defineTool({
  name: 'sync_daily_bars',
  description: '为显式或相关股票同步规范前复权日线，逐股报告结果并保留成功项',
  sideEffect: 'external',
  input: SyncDailyBarsInput,
  output: SyncDailyBarsOutput,
  handler: async (input, ctx) => {
    const stockIds =
      input.scope === 'explicit'
        ? [...new Set(input.stockIds ?? [])]
        : await syncRelevantStockIds(ctx);
    if (stockIds.length === 0) {
      return {
        status: 'skipped' as const,
        totalRequested: 0,
        synced: 0,
        failed: 0,
        items: [],
      };
    }

    const now = ctx.clock();
    const items = await Promise.all(
      stockIds.map(async (stockId) => {
        try {
          const latest = (await ctx.repos.dailyBar.latestBefore(stockId, now, 1)).at(-1);
          const lookbackDays =
            latest === undefined ? INITIAL_LOOKBACK_DAYS : input.correctionWindowDays;
          const startFrom = latest?.date ?? now;
          const from = new Date(startFrom.getTime() - lookbackDays * DAY_MS);
          const bars = (
            await ctx.adapters.market.fetchDailyBars(stockId, {
              start: from,
              end: now,
            })
          ).map((bar) => DailyBarSchema.parse(bar));
          if (bars.length === 0) throw new Error('no_data: no qfq daily bars returned');
          await ctx.repos.dailyBar.saveMany(bars);
          return {
            stockId,
            status: 'synced' as const,
            barCount: bars.length,
            from,
            to: now,
            sources: [...new Set(bars.map((bar) => bar.source))],
          };
        } catch (error) {
          return {
            stockId,
            status: 'failed' as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const synced = items.filter((item) => item.status === 'synced').length;
    const failed = items.length - synced;
    return {
      status:
        failed === 0
          ? ('succeeded' as const)
          : synced === 0
            ? ('failed' as const)
            : ('partial' as const),
      totalRequested: items.length,
      synced,
      failed,
      items,
    };
  },
});
