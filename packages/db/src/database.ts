// driver-neutral 的 SQLite/Drizzle 类型，Bun（bun:sqlite）与 Node（node:sqlite）两个入口共用。
//
// repository 实现与共享 DDL 只依赖这些类型，不依赖具体 driver 包；因此 Node 入口的
// 依赖图不会经 barrel 引入 bun:sqlite。
import type { SQLWrapper } from 'drizzle-orm/sql/sql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core/db';

/** 两个 driver 的同步 run() 结果归一后同形（node 的 changes 可能是 bigint，统一收敛为 number）。 */
export interface SQLiteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** 绑定本包 schema 的 driver-neutral 数据库句柄。 */
export type DrizzleDatabase<T extends Record<string, unknown> = Record<string, never>> =
  BaseSQLiteDatabase<'sync', SQLiteRunResult, T>;

/**
 * 共享 DDL/ensure 函数只需要 run/all。
 *
 * drizzle 的 bun-sqlite driver 把 run() 结果类型标成 void，这里用鸭子类型接收，
 * 让两个 driver 的 db 句柄都能直接传给 ensure* 函数。
 */
export interface DdlExecutor {
  run(query: SQLWrapper | string): unknown;
  all<T = unknown>(query: SQLWrapper | string): T[];
}
