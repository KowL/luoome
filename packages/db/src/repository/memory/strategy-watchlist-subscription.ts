import {
  assertStrategyWatchlistSubscriptionInvariants,
  InvariantError,
  type StrategyWatchlistSubscription,
  type StrategyWatchlistSubscriptionRepository,
} from '@luoome/core';

export class InMemoryStrategyWatchlistSubscriptionRepository
  implements StrategyWatchlistSubscriptionRepository
{
  private readonly items = new Map<string, StrategyWatchlistSubscription>();

  async save(subscription: StrategyWatchlistSubscription): Promise<void> {
    assertStrategyWatchlistSubscriptionInvariants(subscription);
    const duplicate = [...this.items.values()].find(
      (item) =>
        item.status === 'active' &&
        subscription.status === 'active' &&
        item.strategyId === subscription.strategyId &&
        item.watchlistId === subscription.watchlistId &&
        item.id !== subscription.id,
    );
    if (duplicate !== undefined) {
      throw new InvariantError('同一 Strategy 与 Watchlist 只能有一个 active 订阅');
    }
    this.items.set(subscription.id, subscription);
  }

  async findById(id: string): Promise<StrategyWatchlistSubscription | null> {
    return this.items.get(id) ?? null;
  }

  async findActive(input: {
    readonly strategyId: string;
    readonly watchlistId: string;
  }): Promise<StrategyWatchlistSubscription | null> {
    return (
      [...this.items.values()].find(
        (item) =>
          item.status === 'active' &&
          item.strategyId === input.strategyId &&
          item.watchlistId === input.watchlistId,
      ) ?? null
    );
  }

  async list(
    filter: {
      readonly strategyId?: string;
      readonly watchlistId?: string;
      readonly status?: StrategyWatchlistSubscription['status'];
    } = {},
  ): Promise<readonly StrategyWatchlistSubscription[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (filter.strategyId === undefined || item.strategyId === filter.strategyId) &&
          (filter.watchlistId === undefined || item.watchlistId === filter.watchlistId) &&
          (filter.status === undefined || item.status === filter.status),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
      );
  }
}
