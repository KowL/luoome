import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import type { PublicMarketStore } from '@luoome/core';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const publicMarketEntries = sqliteTable('public_market_entries', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  retainUntil: integer('retain_until').notNull(),
});

type PublicMarketDb = BunSQLiteDatabase<Record<string, unknown>>;

export const ensurePublicMarketSchema = (db: PublicMarketDb): void => {
  db.run(sql`CREATE TABLE IF NOT EXISTS public_market_entries (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, retain_until INTEGER NOT NULL
  )`);
};

export const createDrizzlePublicMarketStore = (path: string): PublicMarketStore => {
  // Provider 装配早于 service 生命周期；短连接避免增加一套悬挂句柄及关闭协议。
  const connect = <T>(run: (db: ReturnType<typeof drizzle>) => T): T => {
    const sqlite = new Database(path, { create: true, strict: true });
    try {
      chmodSync(path, 0o600);
      sqlite.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      const db = drizzle(sqlite);
      ensurePublicMarketSchema(db);
      return run(db);
    } finally {
      sqlite.close();
    }
  };
  const read = (db: PublicMarketDb, key: string, now: number): string | null =>
    db
      .select()
      .from(publicMarketEntries)
      .where(and(eq(publicMarketEntries.key, key), gt(publicMarketEntries.retainUntil, now)))
      .get()?.value ?? null;
  return {
    read: (key, now) => connect((db) => read(db, key, now)),
    update: (key, now, retainUntil, change) =>
      connect((db) =>
        db.transaction(
          (tx) => {
            const next = change(read(tx, key, now));
            tx.delete(publicMarketEntries).where(lte(publicMarketEntries.retainUntil, now)).run();
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
        ),
      ),
  };
};
