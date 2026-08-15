import { z } from 'zod';

import { InvariantError } from '../error/index.js';

export const StrategyWatchlistSubscriptionStatusSchema = z.enum(['active', 'cancelled']);
export type StrategyWatchlistSubscriptionStatus = z.infer<
  typeof StrategyWatchlistSubscriptionStatusSchema
>;

/**
 * Strategy 到 Watchlist 的持久订阅契约。
 *
 * sourceKey 固定由 strategyId 派生，避免同一 Strategy 在同一目标上产生两条
 * 可同时生效的 source。取消采用 tombstone，保留历史以便审计和重放。
 */
export const StrategyWatchlistSubscriptionSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  watchlistId: z.string().min(1),
  sourceKey: z.string().min(1),
  status: StrategyWatchlistSubscriptionStatusSchema,
  createdBy: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  cancelledAt: z.coerce.date().optional(),
  cancelledBy: z.string().min(1).optional(),
});
export type StrategyWatchlistSubscription = z.infer<typeof StrategyWatchlistSubscriptionSchema>;

export const assertStrategyWatchlistSubscriptionInvariants = (
  subscription: StrategyWatchlistSubscription,
): void => {
  StrategyWatchlistSubscriptionSchema.parse(subscription);
  if (subscription.sourceKey !== `strategy:${subscription.strategyId}`) {
    throw new InvariantError('StrategyWatchlistSubscription.sourceKey 必须由 strategyId 派生');
  }
  if (subscription.updatedAt < subscription.createdAt) {
    throw new InvariantError('StrategyWatchlistSubscription.updatedAt 不能早于 createdAt');
  }
  if ((subscription.status === 'cancelled') !== (subscription.cancelledAt !== undefined)) {
    throw new InvariantError('cancelled 订阅必须且只能有 cancelledAt');
  }
  if ((subscription.status === 'cancelled') !== (subscription.cancelledBy !== undefined)) {
    throw new InvariantError('cancelled 订阅必须且只能有 cancelledBy');
  }
  if (subscription.cancelledAt !== undefined && subscription.cancelledAt < subscription.createdAt) {
    throw new InvariantError('StrategyWatchlistSubscription.cancelledAt 不能早于 createdAt');
  }
};
