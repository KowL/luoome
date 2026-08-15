import {
  assertStrategyWatchlistSubscriptionInvariants,
  getStrategyRunDataHealth,
  isPublishableOperationalRun,
  type StrategyWatchlistSubscription,
  StrategyWatchlistSubscriptionSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import { syncWatchlistSourceTool } from './watchlist.js';

export const ListStrategyWatchlistSubscriptionsInput = z
  .object({
    strategyId: z.string().min(1).optional(),
    watchlistId: z.string().min(1).optional(),
    status: StrategyWatchlistSubscriptionSchema.shape.status.optional(),
  })
  .refine((input) => input.strategyId !== undefined || input.watchlistId !== undefined, {
    message: 'strategyId 或 watchlistId 至少提供一个',
  });
export const ListStrategyWatchlistSubscriptionsOutput = z.object({
  subscriptions: z.array(StrategyWatchlistSubscriptionSchema),
  total: z.number().int().nonnegative(),
});

export const listStrategyWatchlistSubscriptionsTool = defineTool({
  name: 'list_strategy_watchlist_subscriptions',
  description: '查询 Strategy 与 Watchlist 的持久订阅契约及取消历史',
  sideEffect: 'read',
  input: ListStrategyWatchlistSubscriptionsInput,
  output: ListStrategyWatchlistSubscriptionsOutput,
  handler: async (input, ctx) => {
    const subscriptions = await ctx.repos.strategyWatchlistSubscription.list({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.watchlistId === undefined ? {} : { watchlistId: input.watchlistId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return { subscriptions, total: subscriptions.length };
  },
});

export const SubscribeStrategyToWatchlistInput = z.object({
  strategyId: z.string().min(1),
  watchlistId: z.string().min(1),
});
export const SubscribeStrategyToWatchlistOutput = z.object({
  subscription: StrategyWatchlistSubscriptionSchema,
  idempotent: z.boolean(),
});

export const subscribeStrategyToWatchlistTool = defineTool({
  name: 'subscribe_strategy_to_watchlist',
  description: '显式创建 Strategy 到目标 Watchlist 的持久订阅；重复订阅幂等返回原契约',
  sideEffect: 'write',
  input: SubscribeStrategyToWatchlistInput,
  output: SubscribeStrategyToWatchlistOutput,
  handler: async (input, ctx) => {
    if ((await ctx.repos.strategy.findById(input.strategyId)) === null) {
      return errNotFound('Strategy', input.strategyId);
    }
    const watchlist = await ctx.repos.watchlist.findById(input.watchlistId);
    if (watchlist === null) return errNotFound('Watchlist', input.watchlistId);
    if (watchlist.kind === 'system') return errInvalidInput('system Watchlist 不允许订阅');
    if (!watchlist.enabled) return errInvalidInput('已归档 Watchlist 不允许新建订阅');
    const existing = await ctx.repos.strategyWatchlistSubscription.findActive(input);
    if (existing !== null) return { subscription: existing, idempotent: true };
    const now = ctx.clock();
    const subscription = StrategyWatchlistSubscriptionSchema.parse({
      id: `strategy-watchlist-subscription-${globalThis.crypto.randomUUID()}`,
      strategyId: input.strategyId,
      watchlistId: input.watchlistId,
      sourceKey: `strategy:${input.strategyId}`,
      status: 'active',
      createdBy: ctx.user.id,
      createdAt: now,
      updatedAt: now,
    });
    assertStrategyWatchlistSubscriptionInvariants(subscription);
    await ctx.repos.strategyWatchlistSubscription.save(subscription);
    return { subscription, idempotent: false };
  },
});

export const UnsubscribeStrategyFromWatchlistInput = z
  .object({
    subscriptionId: z.string().min(1).optional(),
    strategyId: z.string().min(1).optional(),
    watchlistId: z.string().min(1).optional(),
  })
  .refine(
    (input) =>
      input.subscriptionId !== undefined ||
      (input.strategyId !== undefined && input.watchlistId !== undefined),
    { message: 'subscriptionId 或 strategyId + watchlistId 必须提供' },
  );
export const UnsubscribeStrategyFromWatchlistOutput = z.object({
  subscription: StrategyWatchlistSubscriptionSchema,
  idempotent: z.boolean(),
});

export const unsubscribeStrategyFromWatchlistTool = defineTool({
  name: 'unsubscribe_strategy_from_watchlist',
  description: '显式取消 Strategy 到 Watchlist 的订阅；保留取消记录供审计',
  sideEffect: 'write',
  input: UnsubscribeStrategyFromWatchlistInput,
  output: UnsubscribeStrategyFromWatchlistOutput,
  handler: async (input, ctx) => {
    const current =
      input.subscriptionId === undefined
        ? await ctx.repos.strategyWatchlistSubscription.findActive({
            strategyId: input.strategyId as string,
            watchlistId: input.watchlistId as string,
          })
        : await ctx.repos.strategyWatchlistSubscription.findById(input.subscriptionId);
    if (current === null) {
      return errNotFound(
        'StrategyWatchlistSubscription',
        input.subscriptionId ?? `${input.strategyId}:${input.watchlistId}`,
      );
    }
    if (
      (input.strategyId !== undefined && current.strategyId !== input.strategyId) ||
      (input.watchlistId !== undefined && current.watchlistId !== input.watchlistId)
    ) {
      return errInvalidInput('subscription 与 strategyId/watchlistId 不匹配');
    }
    if (current.status === 'cancelled') return { subscription: current, idempotent: true };
    const now = ctx.clock();
    const subscription: StrategyWatchlistSubscription = {
      ...current,
      status: 'cancelled',
      updatedAt: now,
      cancelledAt: now,
      cancelledBy: ctx.user.id,
    };
    assertStrategyWatchlistSubscriptionInvariants(subscription);
    await ctx.repos.strategyWatchlistSubscription.save(subscription);
    return { subscription, idempotent: false };
  },
});

export const SyncStrategyWatchlistSubscriptionsInput = z.object({
  strategyId: z.string().min(1),
  producerRunId: z.string().min(1),
});

const StrategyWatchlistSyncItemSchema = z.object({
  subscription: StrategyWatchlistSubscriptionSchema,
  status: z.enum(['complete', 'partial', 'failed', 'skipped']),
  syncRunId: z.string().optional(),
  entered: z.number().int().nonnegative().default(0),
  exited: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
});
export const SyncStrategyWatchlistSubscriptionsOutput = z.object({
  strategyId: z.string(),
  producerRunId: z.string(),
  status: z.enum(['complete', 'partial', 'failed', 'skipped']),
  reason: z.string().optional(),
  items: z.array(StrategyWatchlistSyncItemSchema),
  complete: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type SyncStrategyWatchlistSubscriptionsOutputT = z.infer<
  typeof SyncStrategyWatchlistSubscriptionsOutput
>;

const errorText = (error: {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

/**
 * Internal orchestration bridge: only a persisted, published operational run can reach
 * sync_watchlist_source. The public run_strategy tool deliberately does not call this directly.
 */
export const syncStrategyWatchlistSubscriptionsTool = defineTool({
  name: 'sync_strategy_watchlist_subscriptions',
  description: '内部编排按已发布 StrategyRun 将所有 active 订阅同步到目标 Watchlist',
  sideEffect: 'write',
  input: SyncStrategyWatchlistSubscriptionsInput,
  output: SyncStrategyWatchlistSubscriptionsOutput,
  handler: async (input, ctx) => {
    const run = await ctx.repos.strategyRun.findRunById(input.producerRunId);
    if (run === null) return errNotFound('StrategyRun', input.producerRunId);
    if (run.strategyId !== input.strategyId) {
      return errInvalidInput('producerRunId 不属于 strategyId');
    }
    const subscriptions = await ctx.repos.strategyWatchlistSubscription.list({
      strategyId: input.strategyId,
      status: 'active',
    });
    const skippedForRun = !isPublishableOperationalRun(run);
    if (subscriptions.length === 0 || skippedForRun) {
      return {
        strategyId: input.strategyId,
        producerRunId: input.producerRunId,
        status: 'skipped',
        reason:
          subscriptions.length === 0
            ? '没有 active Strategy→Watchlist 订阅'
            : 'StrategyRun 不是可发布的 operational published run',
        items: subscriptions.map((subscription) => ({
          subscription,
          status: 'skipped' as const,
          entered: 0,
          exited: 0,
          unchanged: 0,
        })),
        complete: 0,
        partial: 0,
        failed: 0,
        skipped: subscriptions.length,
      } satisfies SyncStrategyWatchlistSubscriptionsOutputT;
    }

    const health = getStrategyRunDataHealth(run);
    const syncStatus = health === 'complete' ? 'complete' : health === 'partial' ? 'partial' : null;
    if (syncStatus === null) {
      return {
        strategyId: input.strategyId,
        producerRunId: input.producerRunId,
        status: 'skipped',
        reason: 'StrategyRun 数据不可用，不改变 Watchlist',
        items: subscriptions.map((subscription) => ({
          subscription,
          status: 'skipped' as const,
          entered: 0,
          exited: 0,
          unchanged: 0,
        })),
        complete: 0,
        partial: 0,
        failed: 0,
        skipped: subscriptions.length,
      } satisfies SyncStrategyWatchlistSubscriptionsOutputT;
    }

    const results = await ctx.repos.strategyRun.listResults(run.id);
    const candidates = results
      .filter((result) => result.selected)
      .map((result) => ({
        stockId: result.stockId,
        reason: `Strategy ${input.strategyId} 在 run ${run.id} 中入选`,
        ...(result.score === undefined ? {} : { score: result.score }),
        ...(result.rank === undefined ? {} : { rank: result.rank }),
        evidence: result.evidence,
        dataAsOf: result.dataAsOf,
      }));
    const items: z.infer<typeof StrategyWatchlistSyncItemSchema>[] = [];
    for (const subscription of subscriptions) {
      const synced = await ctx.repos.watchlist.findById(subscription.watchlistId);
      if (synced === null) {
        items.push({
          subscription,
          status: 'failed',
          entered: 0,
          exited: 0,
          unchanged: 0,
          error: '目标 Watchlist 不存在',
        });
        continue;
      }
      if (!synced.enabled) {
        items.push({
          subscription,
          status: 'failed',
          entered: 0,
          exited: 0,
          unchanged: 0,
          error: '目标 Watchlist 已停用',
        });
        continue;
      }
      const result = await syncWatchlistSourceTool.execute(
        {
          watchlistId: subscription.watchlistId,
          sourceKind: 'strategy',
          sourceKey: subscription.sourceKey,
          sourceId: input.strategyId,
          sourceVersionId: run.strategyVersionId,
          producerRunId: run.id,
          status: syncStatus,
          candidates,
          dataAsOf: run.dataAsOf,
        },
        ctx,
      );
      if (!result.ok) {
        items.push({
          subscription,
          status: 'failed',
          entered: 0,
          exited: 0,
          unchanged: 0,
          error: errorText(result.error),
        });
        continue;
      }
      items.push({
        subscription,
        status: syncStatus,
        syncRunId: result.data.run.id,
        entered: result.data.run.enteredCount,
        exited: result.data.run.exitedCount,
        unchanged: result.data.run.unchangedCount,
      });
    }
    const failed = items.filter((item) => item.status === 'failed').length;
    const partial = items.filter((item) => item.status === 'partial').length;
    const complete = items.filter((item) => item.status === 'complete').length;
    return {
      strategyId: input.strategyId,
      producerRunId: input.producerRunId,
      status: failed > 0 ? 'failed' : partial > 0 ? 'partial' : 'complete',
      items,
      complete,
      partial,
      failed,
      skipped: items.filter((item) => item.status === 'skipped').length,
    } satisfies SyncStrategyWatchlistSubscriptionsOutputT;
  },
});
