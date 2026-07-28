import type { WatchRuleState, WatchRuleStateRepository } from '@luoome/core';
import { asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, watchRuleStates } from '../../schema/index.js';

type Row = typeof watchRuleStates.$inferSelect;

const toDomain = (row: Row): WatchRuleState => ({
  poolId: row.poolId,
  stockId: row.stockId,
  ruleId: row.ruleId,
  active: row.active,
  ...(row.firstTriggeredAt !== null ? { firstTriggeredAt: row.firstTriggeredAt } : {}),
  lastEvaluatedAt: row.lastEvaluatedAt,
  ...(row.lastValue !== null ? { lastValue: row.lastValue } : {}),
  ...(row.lastRecoveredAt !== null ? { lastRecoveredAt: row.lastRecoveredAt } : {}),
});

const fromDomain = (s: WatchRuleState): Row => ({
  poolId: s.poolId,
  stockId: s.stockId,
  ruleId: s.ruleId,
  active: s.active,
  firstTriggeredAt: s.firstTriggeredAt ?? null,
  lastEvaluatedAt: s.lastEvaluatedAt,
  lastValue: s.lastValue ?? null,
  lastRecoveredAt: s.lastRecoveredAt ?? null,
});

/** WatchRuleState Drizzle 实现（docs/ddd/strategy-alert-detailed-design.md §3.5 / §9.3）。 */
export class DrizzleWatchRuleStateRepository implements WatchRuleStateRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async listByPool(poolId: string): Promise<readonly WatchRuleState[]> {
    return this.db
      .select()
      .from(watchRuleStates)
      .where(eq(watchRuleStates.poolId, poolId))
      .orderBy(asc(watchRuleStates.stockId), asc(watchRuleStates.ruleId))
      .all()
      .map(toDomain);
  }

  async upsert(state: WatchRuleState): Promise<void> {
    this.db
      .insert(watchRuleStates)
      .values(fromDomain(state))
      .onConflictDoUpdate({
        target: [watchRuleStates.poolId, watchRuleStates.stockId, watchRuleStates.ruleId],
        set: {
          active: state.active,
          firstTriggeredAt: state.firstTriggeredAt ?? null,
          lastEvaluatedAt: state.lastEvaluatedAt,
          lastValue: state.lastValue ?? null,
          lastRecoveredAt: state.lastRecoveredAt ?? null,
        },
      })
      .run();
  }

  async upsertMany(states: readonly WatchRuleState[]): Promise<void> {
    if (states.length === 0) return;
    this.db.transaction((tx) => {
      for (const s of states) {
        tx.insert(watchRuleStates)
          .values(fromDomain(s))
          .onConflictDoUpdate({
            target: [watchRuleStates.poolId, watchRuleStates.stockId, watchRuleStates.ruleId],
            set: {
              active: s.active,
              firstTriggeredAt: s.firstTriggeredAt ?? null,
              lastEvaluatedAt: s.lastEvaluatedAt,
              lastValue: s.lastValue ?? null,
              lastRecoveredAt: s.lastRecoveredAt ?? null,
            },
          })
          .run();
      }
    });
  }

  async removeByPool(poolId: string): Promise<void> {
    this.db.delete(watchRuleStates).where(eq(watchRuleStates.poolId, poolId)).run();
  }
}
