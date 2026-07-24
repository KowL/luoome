import {
  type Account,
  type AccountRepository,
  AccountSchema,
  assertAccountInvariants,
} from '@luoome/core';
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
    // v0.8 起：repo 边界做 AccountSchema.safeParse 校验（防御性）。
    // 历史教训：v0.5 → MVP 升级时 ensureSchema 没做 accounts 数据迁移，
    // 残留的 kind='mock' 行让 list_accounts output zod 校验失败 → defineTool
    // 返回 internal → Web alert "激活失败"、TUI 静默死。把校验下沉到 repo 后，
    // 单条不合法行被跳过 + warn，不牵连全表 read（即便将来又收紧 schema 也不会
    // 再发生一炸全炸的事故）。strict invariants（assertAccountInvariants）
    // 是写路径，read 路径走 schema parse + warn 跳过。
    const rows = this.db.select().from(accounts).orderBy(asc(accounts.id)).all();
    const valid: Account[] = [];
    for (const row of rows) {
      const parsed = AccountSchema.safeParse(row);
      if (parsed.success) {
        valid.push(parsed.data);
      } else {
        const firstIssue = parsed.error.issues[0];
        console.warn(
          `[repo] accounts 跳过不合法行 id=${String(row.id)}: ${firstIssue?.message ?? 'unknown'}`,
        );
      }
    }
    return valid;
  }

  async remove(id: string): Promise<void> {
    this.db.delete(accounts).where(eq(accounts.id, id)).run();
  }
}
