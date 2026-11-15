import { AsyncLocalStorage } from 'node:async_hooks';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Schema } from './schema/index.js';

export class RepositoryWriteScope {
  private readonly checks = new AsyncLocalStorage<readonly (() => void)[]>();

  run<T>(check: () => void, operation: () => Promise<T>): Promise<T> {
    return this.checks.run([...(this.checks.getStore() ?? []), check], operation);
  }

  transaction<T>(
    db: BunSQLiteDatabase<Schema>,
    operation: (tx: Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0]) => T,
  ): T {
    return db.transaction(
      (tx) => {
        for (const check of this.checks.getStore() ?? []) check();
        return operation(tx);
      },
      { behavior: 'immediate' },
    );
  }
}
