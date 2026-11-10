// vitest（node 运行时）把 `bun:sqlite` 解析到本文件（见根目录 vitest.config.ts）。
//
// 生产运行时仍是 Bun 内置 `bun:sqlite`；这里只补实现 drizzle-orm/bun-sqlite 与
// packages/db/src/client.ts 实际用到的同步 API，让 `:memory:` 内存库在 node 测试
// 进程里可用（内存 Repository 退役后，node 侧单测也走 SQLite 实现）。
//
// 刻意不 import 'node:sqlite'：本仓库 tsconfig 只加载 bun 类型，且 bun 运行时下
// 不会加载本文件。改用 Node >= 22.3 提供的 process.getBuiltinModule。

interface NodeSqliteStatement {
  run(...params: readonly unknown[]): {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  };
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  all(...params: readonly unknown[]): Record<string, unknown>[];
  setReturnArrays(enabled: boolean): void;
  finalize?(): void;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  readonly DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

const loadNodeSqlite = (): NodeSqliteModule => {
  const getBuiltinModule = (
    globalThis as {
      process?: { getBuiltinModule?: (specifier: string) => unknown };
    }
  ).process?.getBuiltinModule;
  if (!getBuiltinModule) {
    throw new Error(
      'bun:sqlite shim requires Node >= 22.3 (process.getBuiltinModule) when running under node',
    );
  }
  return getBuiltinModule('node:sqlite') as NodeSqliteModule;
};

/** bun:sqlite 接受 boolean/undefined 绑定；node:sqlite 只接受 null/number/string/bigint/buffer。 */
const bind = (params: readonly unknown[]): unknown[] =>
  params.map((value) => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined) return null;
    return value;
  });

class Statement {
  readonly #statement: NodeSqliteStatement;

  constructor(statement: NodeSqliteStatement) {
    this.#statement = statement;
  }

  run(...params: readonly unknown[]): {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  } {
    return this.#statement.run(...bind(params));
  }

  get(...params: readonly unknown[]): Record<string, unknown> | undefined {
    return this.#statement.get(...bind(params));
  }

  all(...params: readonly unknown[]): Record<string, unknown>[] {
    return this.#statement.all(...bind(params));
  }

  /** drizzle-orm/bun-sqlite 的 get/values 路径要求按列序返回数组。 */
  values(...params: readonly unknown[]): unknown[][] {
    this.#statement.setReturnArrays(true);
    return this.#statement.all(...bind(params)) as unknown as unknown[][];
  }

  finalize(): void {
    this.#statement.finalize?.();
  }
}

export type SQLQueryBindings = string | number | bigint | boolean | null | Uint8Array;

/** bun:sqlite `Database` 的最小同步 shim。 */
export class Database {
  readonly #db: NodeSqliteDatabase;

  constructor(path: string) {
    this.#db = new (loadNodeSqlite().DatabaseSync)(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql));
  }

  close(): void {
    this.#db.close();
  }

  /** drizzle-orm/bun-sqlite 通过 `client.transaction(fn)` 拿原生事务包装器。 */
  transaction<Args extends readonly unknown[], Result>(
    fn: (...args: Args) => Result,
  ): ((...args: Args) => Result) & {
    deferred: (...args: Args) => Result;
    immediate: (...args: Args) => Result;
    exclusive: (...args: Args) => Result;
  } {
    const run =
      (begin: string) =>
      (...args: Args): Result => {
        this.#db.exec(begin);
        try {
          const result = fn(...args);
          this.#db.exec('COMMIT');
          return result;
        } catch (error) {
          this.#db.exec('ROLLBACK');
          throw error;
        }
      };
    const deferred = run('BEGIN');
    return Object.assign(deferred, {
      deferred,
      immediate: run('BEGIN IMMEDIATE'),
      exclusive: run('BEGIN EXCLUSIVE'),
    });
  }
}
