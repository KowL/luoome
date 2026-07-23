import { assertWatchRunInvariants, type WatchRun, type WatchRunRepository } from '@luoome/core';
import { desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, watchRuns } from '../../schema/index.js';

type WatchRunRow = typeof watchRuns.$inferSelect;

const toWatchRun = (row: WatchRunRow): WatchRun => ({
  id: row.id,
  mode: row.mode,
  status: row.status,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  evaluatedPools: row.evaluatedPools,
  evaluatedStocks: row.evaluatedStocks,
  triggered: row.triggered,
  notified: row.notified,
  suppressedByCooldown: row.suppressedByCooldown,
  ...(row.error !== null ? { error: row.error } : {}),
});

export class DrizzleWatchRunRepository implements WatchRunRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(run: WatchRun): Promise<void> {
    assertWatchRunInvariants(run);
    const row = {
      id: run.id,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      evaluatedPools: run.evaluatedPools,
      evaluatedStocks: run.evaluatedStocks,
      triggered: run.triggered,
      notified: run.notified,
      suppressedByCooldown: run.suppressedByCooldown,
      ...(run.error !== undefined ? { error: run.error } : { error: null }),
    };
    this.db
      .insert(watchRuns)
      .values(row)
      .onConflictDoUpdate({ target: watchRuns.id, set: row })
      .run();
  }

  async findById(id: string): Promise<WatchRun | null> {
    const row = this.db.select().from(watchRuns).where(eq(watchRuns.id, id)).get();
    return row === undefined ? null : toWatchRun(row);
  }

  async latest(): Promise<WatchRun | null> {
    const row = this.db.select().from(watchRuns).orderBy(desc(watchRuns.startedAt)).get();
    return row === undefined ? null : toWatchRun(row);
  }

  async listRecent(limit = 50): Promise<readonly WatchRun[]> {
    return this.db
      .select()
      .from(watchRuns)
      .orderBy(desc(watchRuns.startedAt))
      .limit(limit)
      .all()
      .map(toWatchRun);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(watchRuns).where(eq(watchRuns.id, id)).run();
  }
}
