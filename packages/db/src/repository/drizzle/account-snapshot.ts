import {
  type AccountSnapshot,
  type AccountSnapshotRepository,
  AccountSnapshotSchema,
  assertAccountSnapshotInvariants,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { accountSnapshots, type Schema } from '../../schema/index.js';

type AccountSnapshotRow = typeof accountSnapshots.$inferSelect;

const toSnapshot = (row: AccountSnapshotRow): AccountSnapshot => {
  const { note, ...rest } = row;
  const snapshot = AccountSnapshotSchema.parse({
    ...rest,
    ...(note === null ? {} : { note }),
  });
  assertAccountSnapshotInvariants(snapshot);
  return snapshot;
};

export class DrizzleAccountSnapshotRepository implements AccountSnapshotRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(snapshot: AccountSnapshot): Promise<void> {
    const parsed = AccountSnapshotSchema.parse(snapshot);
    assertAccountSnapshotInvariants(parsed);
    this.db
      .insert(accountSnapshots)
      .values({
        id: parsed.id,
        accountId: parsed.accountId,
        version: parsed.version,
        asOf: parsed.asOf,
        cashBalance: parsed.cashBalance,
        stockMarketValue: parsed.stockMarketValue,
        totalAssets: parsed.totalAssets,
        status: parsed.status,
        positions: parsed.positions,
        source: parsed.source,
        note: parsed.note,
        createdAt: parsed.createdAt,
      })
      .onConflictDoUpdate({
        target: accountSnapshots.id,
        set: {
          accountId: parsed.accountId,
          version: parsed.version,
          asOf: parsed.asOf,
          cashBalance: parsed.cashBalance,
          stockMarketValue: parsed.stockMarketValue,
          totalAssets: parsed.totalAssets,
          status: parsed.status,
          positions: parsed.positions,
          source: parsed.source,
          note: parsed.note,
          createdAt: parsed.createdAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<AccountSnapshot | null> {
    const row = this.db.select().from(accountSnapshots).where(eq(accountSnapshots.id, id)).get();
    return row === undefined ? null : toSnapshot(row);
  }

  async latestByAccount(accountId: string): Promise<AccountSnapshot | null> {
    const row = this.db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId))
      .orderBy(desc(accountSnapshots.version), desc(accountSnapshots.asOf))
      .limit(1)
      .get();
    return row === undefined ? null : toSnapshot(row);
  }

  async listByAccount(accountId: string, limit = 100): Promise<readonly AccountSnapshot[]> {
    return this.db
      .select()
      .from(accountSnapshots)
      .where(eq(accountSnapshots.accountId, accountId))
      .orderBy(desc(accountSnapshots.version), desc(accountSnapshots.asOf))
      .limit(limit)
      .all()
      .map(toSnapshot);
  }

  async remove(id: string): Promise<void> {
    this.db
      .delete(accountSnapshots)
      .where(and(eq(accountSnapshots.id, id)))
      .run();
  }
}
