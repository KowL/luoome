import {
  assertStrategyWatchlistSubscriptionInvariants,
  InvariantError,
  type StrategyWatchlistSubscription,
  type StrategyWatchlistSubscriptionRepository,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, strategyWatchlistSubscriptions } from '../../schema/index.js';

type Row = typeof strategyWatchlistSubscriptions.$inferSelect;

const toSubscription = (row: Row): StrategyWatchlistSubscription => ({
  id: row.id,
  strategyId: row.strategyId,
  watchlistId: row.watchlistId,
  sourceKey: row.sourceKey,
  status: row.status,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt }),
  ...(row.cancelledBy === null ? {} : { cancelledBy: row.cancelledBy }),
});

const values = (subscription: StrategyWatchlistSubscription) => ({
  id: subscription.id,
  strategyId: subscription.strategyId,
  watchlistId: subscription.watchlistId,
  sourceKey: subscription.sourceKey,
  status: subscription.status,
  createdBy: subscription.createdBy,
  createdAt: subscription.createdAt,
  updatedAt: subscription.updatedAt,
  cancelledAt: subscription.cancelledAt ?? null,
  cancelledBy: subscription.cancelledBy ?? null,
});

export class DrizzleStrategyWatchlistSubscriptionRepository
  implements StrategyWatchlistSubscriptionRepository
{
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(subscription: StrategyWatchlistSubscription): Promise<void> {
    assertStrategyWatchlistSubscriptionInvariants(subscription);
    const duplicate = this.db
      .select()
      .from(strategyWatchlistSubscriptions)
      .where(
        and(
          eq(strategyWatchlistSubscriptions.strategyId, subscription.strategyId),
          eq(strategyWatchlistSubscriptions.watchlistId, subscription.watchlistId),
          eq(strategyWatchlistSubscriptions.status, 'active'),
        ),
      )
      .get();
    if (
      duplicate !== undefined &&
      duplicate.id !== subscription.id &&
      subscription.status === 'active'
    ) {
      throw new InvariantError('同一 Strategy 与 Watchlist 只能有一个 active 订阅');
    }
    this.db
      .insert(strategyWatchlistSubscriptions)
      .values(values(subscription))
      .onConflictDoUpdate({ target: strategyWatchlistSubscriptions.id, set: values(subscription) })
      .run();
  }

  async findById(id: string): Promise<StrategyWatchlistSubscription | null> {
    const row = this.db
      .select()
      .from(strategyWatchlistSubscriptions)
      .where(eq(strategyWatchlistSubscriptions.id, id))
      .get();
    return row === undefined ? null : toSubscription(row);
  }

  async findActive(input: {
    readonly strategyId: string;
    readonly watchlistId: string;
  }): Promise<StrategyWatchlistSubscription | null> {
    const row = this.db
      .select()
      .from(strategyWatchlistSubscriptions)
      .where(
        and(
          eq(strategyWatchlistSubscriptions.strategyId, input.strategyId),
          eq(strategyWatchlistSubscriptions.watchlistId, input.watchlistId),
          eq(strategyWatchlistSubscriptions.status, 'active'),
        ),
      )
      .get();
    return row === undefined ? null : toSubscription(row);
  }

  async list(
    filter: {
      readonly strategyId?: string;
      readonly watchlistId?: string;
      readonly status?: StrategyWatchlistSubscription['status'];
    } = {},
  ): Promise<readonly StrategyWatchlistSubscription[]> {
    const rows = this.db
      .select()
      .from(strategyWatchlistSubscriptions)
      .where(
        and(
          ...(filter.strategyId === undefined
            ? []
            : [eq(strategyWatchlistSubscriptions.strategyId, filter.strategyId)]),
          ...(filter.watchlistId === undefined
            ? []
            : [eq(strategyWatchlistSubscriptions.watchlistId, filter.watchlistId)]),
          ...(filter.status === undefined
            ? []
            : [eq(strategyWatchlistSubscriptions.status, filter.status)]),
        ),
      )
      .orderBy(
        desc(strategyWatchlistSubscriptions.createdAt),
        desc(strategyWatchlistSubscriptions.id),
      )
      .all();
    return rows.map(toSubscription);
  }
}
