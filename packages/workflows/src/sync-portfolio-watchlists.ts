import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const SyncPortfolioWatchlistsInput = z.object({
  accountId: z.string().min(1).optional(),
  watchlistIds: z.array(z.string().min(1)).optional(),
});
export type SyncPortfolioWatchlistsInputT = z.infer<typeof SyncPortfolioWatchlistsInput>;

const SyncPortfolioWatchlistItemSchema = z.object({
  watchlistId: z.string().min(1),
  status: z.enum(['complete', 'failed']),
  syncRunId: z.string().optional(),
  entered: z.number().int().nonnegative(),
  exited: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export const SyncPortfolioWatchlistsOutput = z.object({
  accountId: z.string().min(1),
  items: z.array(SyncPortfolioWatchlistItemSchema),
  complete: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SyncPortfolioWatchlistsOutputT = z.infer<typeof SyncPortfolioWatchlistsOutput>;

const errorMessage = (error: {
  readonly kind: string;
  readonly message?: string;
  readonly cause?: string;
  readonly entity?: string;
  readonly id?: string;
  readonly required?: string;
}): string =>
  error.message ??
  error.cause ??
  (error.entity === undefined ? undefined : `${error.entity} not found: ${error.id ?? ''}`) ??
  (error.required === undefined ? undefined : `permission required: ${error.required}`) ??
  error.kind;

const syncPortfolioWatchlists: WorkflowStep = async (previous, ctx) => {
  const input = previous as SyncPortfolioWatchlistsInputT;
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const [listed, holdings] = await Promise.all([
    ctx.tools.list_watchlists.execute({}),
    ctx.tools.list_holdings.execute({ accountId, status: 'active' }),
  ]);
  if (!listed.ok) return listed;
  if (!holdings.ok) return holdings;

  const byId = new Map(listed.data.items.map((item) => [item.watchlist.id, item.watchlist]));
  const targetIds =
    input.watchlistIds === undefined
      ? listed.data.items
          .filter((item) => item.watchlist.kind === 'portfolio' && item.watchlist.enabled)
          .map((item) => item.watchlist.id)
      : [...new Set(input.watchlistIds)];
  const candidates = holdings.data.holdings.map((item) => ({
    stockId: item.holding.stockId,
    reason: `账户 ${accountId} 当前持仓`,
    evidence: [`持仓数量 ${item.holding.quantity}`],
  }));
  const items: z.infer<typeof SyncPortfolioWatchlistItemSchema>[] = [];

  for (const watchlistId of targetIds) {
    const watchlist = byId.get(watchlistId);
    if (watchlist === undefined) {
      items.push({
        watchlistId,
        status: 'failed',
        entered: 0,
        exited: 0,
        unchanged: 0,
        error: `Watchlist not found: ${watchlistId}`,
      });
      continue;
    }
    if (watchlist.kind !== 'portfolio' || watchlist.membershipPolicy !== 'synced') {
      items.push({
        watchlistId,
        status: 'failed',
        entered: 0,
        exited: 0,
        unchanged: 0,
        error: '目标必须是 portfolio/synced Watchlist',
      });
      continue;
    }
    const result = await ctx.tools.sync_watchlist_source.execute({
      watchlistId,
      sourceKind: 'portfolio',
      sourceKey: `portfolio:${accountId}`,
      sourceId: accountId,
      status: 'complete',
      candidates,
    });
    if (!result.ok) {
      items.push({
        watchlistId,
        status: 'failed',
        entered: 0,
        exited: 0,
        unchanged: 0,
        error: errorMessage(result.error),
      });
      continue;
    }
    items.push({
      watchlistId,
      status: 'complete',
      syncRunId: result.data.run.id,
      entered: result.data.run.enteredCount,
      exited: result.data.run.exitedCount,
      unchanged: result.data.run.unchangedCount,
    });
  }

  return SyncPortfolioWatchlistsOutput.parse({
    accountId,
    items,
    complete: items.filter((item) => item.status === 'complete').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const syncPortfolioWatchlistsWorkflow = defineWorkflow<
  SyncPortfolioWatchlistsInputT,
  SyncPortfolioWatchlistsOutputT
>({
  name: 'sync-portfolio-watchlists',
  description: '通过账户与持仓 tools 完整同步 portfolio Watchlists',
  input: SyncPortfolioWatchlistsInput,
  steps: [syncPortfolioWatchlists],
});
