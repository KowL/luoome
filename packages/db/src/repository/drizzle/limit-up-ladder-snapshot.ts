import {
  type LimitUpLadder,
  LimitUpLadderSchema,
  type LimitUpLadderSnapshotRepository,
  type LimitUpLadderSource,
} from '@luoome/core';
import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { limitUpLadderSnapshots, type Schema } from '../../schema/index.js';

type SnapshotRow = typeof limitUpLadderSnapshots.$inferSelect;

const toSnapshot = (row: SnapshotRow): LimitUpLadder =>
  LimitUpLadderSchema.parse({
    date: row.date,
    source: row.source,
    total: row.total,
    maxLevel: row.maxLevel,
    levels: row.levels,
    warnings: row.warnings,
    asOf: row.asOf,
  });

export class DrizzleLimitUpLadderSnapshotRepository implements LimitUpLadderSnapshotRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(snapshot: LimitUpLadder): Promise<void> {
    const parsed = LimitUpLadderSchema.parse(snapshot);
    this.db
      .insert(limitUpLadderSnapshots)
      .values({
        date: parsed.date,
        source: parsed.source,
        total: parsed.total,
        maxLevel: parsed.maxLevel,
        levels: parsed.levels,
        warnings: parsed.warnings,
        asOf: parsed.asOf,
      })
      .onConflictDoUpdate({
        target: [limitUpLadderSnapshots.date, limitUpLadderSnapshots.source],
        set: {
          total: parsed.total,
          maxLevel: parsed.maxLevel,
          levels: parsed.levels,
          warnings: parsed.warnings,
          asOf: parsed.asOf,
        },
      })
      .run();
  }

  async findByDate(input: {
    readonly date: string;
    readonly source: LimitUpLadderSource;
  }): Promise<LimitUpLadder | null> {
    const row = this.db
      .select()
      .from(limitUpLadderSnapshots)
      .where(
        and(
          eq(limitUpLadderSnapshots.date, input.date),
          eq(limitUpLadderSnapshots.source, input.source),
        ),
      )
      .get();
    return row === undefined ? null : toSnapshot(row);
  }
}
