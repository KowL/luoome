import type { PublicMarketStore } from '@luoome/core';
import { eq, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { publicMarketEntries, type Schema } from '../../schema/index.js';

export class DrizzlePublicMarketStore implements PublicMarketStore {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  read(key: string, now: number): string | null {
    const row = this.db
      .select()
      .from(publicMarketEntries)
      .where(eq(publicMarketEntries.key, key))
      .get();
    return row !== undefined && row.retainUntil > now ? row.value : null;
  }

  update<T>(
    key: string,
    now: number,
    retainUntil: number,
    change: (value: string | null) => { readonly value: string; readonly result: T },
  ): T {
    return this.db.transaction(
      (tx) => {
        tx.delete(publicMarketEntries).where(lte(publicMarketEntries.retainUntil, now)).run();
        const row = tx
          .select()
          .from(publicMarketEntries)
          .where(eq(publicMarketEntries.key, key))
          .get();
        const next = change(row !== undefined && row.retainUntil > now ? row.value : null);
        tx.insert(publicMarketEntries)
          .values({ key, value: next.value, retainUntil })
          .onConflictDoUpdate({
            target: publicMarketEntries.key,
            set: { value: next.value, retainUntil },
          })
          .run();
        return next.result;
      },
      { behavior: 'immediate' },
    );
  }
}
