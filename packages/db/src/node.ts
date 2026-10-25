// @luoome/db 的 Node 入口（`@luoome/db/node`）：node:sqlite driver + 共享 DDL/repository。
//
// 本入口的依赖图不得引入 bun:sqlite：本文件不 import client.ts/index.ts，driver 细节
// 全部收敛在 node-sqlite-driver.ts。
import { DatabaseSync } from 'node:sqlite';
import type { RepositoryRegistry } from '@luoome/core';
import type { DrizzleDatabase } from './database.js';
import { ensureSchema } from './migrations.js';
import { applyNodePragmas, drizzleNodeSqlite } from './node-sqlite-driver.js';
import { createReposFromDatabase } from './repositories.js';
import { type Schema, schema } from './schema/index.js';

export { ensureSchema };

/** Node 入口的数据库句柄类型（绑定本包 schema）。 */
export type NodeDrizzleDb = DrizzleDatabase<Schema>;

/** createNodeDrizzleRepos 的返回句柄：与 Bun 入口的 DrizzleReposHandle 同形。 */
export interface NodeDrizzleReposHandle {
  readonly repos: RepositoryRegistry;
  readonly db: NodeDrizzleDb;
  readonly close: () => void;
}

/**
 * 打开（必要时创建）SQLite 数据库，建表，并返回全部 Drizzle repository。
 *
 * 与 Bun 入口 createDrizzleRepos 同形；连接使用 node:sqlite，pragma 与迁移顺序一致。
 *
 * @param dbPath SQLite 文件路径；传 ':memory:' 用内存库（测试）。
 */
export const createNodeDrizzleRepos = (
  dbPath: string,
  options: { readonly migrate?: boolean } = {},
): NodeDrizzleReposHandle => {
  const sqlite = new DatabaseSync(dbPath);
  applyNodePragmas(sqlite, { wal: dbPath !== ':memory:' });
  const db = drizzleNodeSqlite(sqlite, { schema });
  try {
    if (options.migrate !== false) ensureSchema(db);
  } catch (error) {
    // 迁移失败时释放句柄，避免调用方重试时泄漏文件锁。
    sqlite.close();
    throw error;
  }
  return { repos: createReposFromDatabase(db), db, close: () => sqlite.close() };
};
