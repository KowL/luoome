import { type Account, type AccountRepository, assertAccountInvariants } from '@luoome/core';
import { asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { accounts, type Schema } from '../../schema/index.js';

/** Account 的 Drizzle 实现（ARCHITECTURE §4.3）。行结构与实体一致，无需 mapper。 */
export class DrizzleAccountRepository implements AccountRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(account: Account): Promise<void> {
    assertAccountInvariants(account);
    const row = {
      id: account.id,
      name: account.name,
      kind: account.kind,
      currency: account.currency,
      initialCapital: account.initialCapital,
      createdAt: account.createdAt,
    };
    this.db
      .insert(accounts)
      .values(row)
      .onConflictDoUpdate({ target: accounts.id, set: row })
      .run();
  }

  async findById(id: string): Promise<Account | null> {
    const row = this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    return row ?? null;
  }

  async list(): Promise<Account[]> {
    return this.db.select().from(accounts).orderBy(asc(accounts.id)).all();
  }

  async remove(id: string): Promise<void> {
    this.db.delete(accounts).where(eq(accounts.id, id)).run();
  }
}
