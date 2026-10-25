import { Database } from 'bun:sqlite';
import type { RepositoryRegistry } from '@luoome/core';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { DrizzleDatabase } from './database.js';
import { ensureSchema } from './migrations.js';
import { createReposFromDatabase } from './repositories.js';
import { type Schema, schema } from './schema/index.js';

export { ensureSchema };

/** Bun 入口的数据库句柄类型（绑定本包 schema）。 */
export type DrizzleDb = DrizzleDatabase<Schema>;

/** createDrizzleRepos 的返回句柄：repos + db + close()。 */
export interface DrizzleReposHandle {
  readonly repos: RepositoryRegistry;
  readonly db: DrizzleDb;
  readonly close: () => void;
}

/**
 * 打开（必要时创建）SQLite 数据库，建表，并返回全部 Drizzle repository。
 *
 * @param dbPath SQLite 文件路径；传 ':memory:' 用内存库（测试）。
 *
 * 驱动为 Bun 内置 bun:sqlite（drizzle-orm/bun-sqlite），CLI/TUI/Web/MCP 均以
 * bun 启动时可直接加载；vitest 需跑在 Bun 运行时（`bun test` / `bun --bun run vitest`）。
 * Node 环境的对应入口是 `@luoome/db/node`（node.ts），两者共用 migrations/repositories。
 */
export const createDrizzleRepos = (
  dbPath: string,
  options: { readonly migrate?: boolean } = {},
): DrizzleReposHandle => {
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  // Web chat、策略调度器和确认面板会并发写同一文件。SQLite 默认遇到写锁立即失败；
  // 给短事务留出等待窗口，WAL 下读请求仍可并发。
  sqlite.exec('PRAGMA busy_timeout = 5000');
  // :memory: 不支持 WAL（pragma 会被静默忽略），文件库开 WAL 提升并发读体验。
  if (dbPath !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA synchronous = NORMAL');
  }
  // drizzle 的 bun-sqlite driver 把 run() 结果类型标成 void，与共享的 DrizzleDatabase
  // 只在类型上有差异；运行时仍是 bun-sqlite 的 Changes 对象（迁移按 changes 字段读取）。
  const db = drizzle(sqlite, { schema }) as unknown as DrizzleDatabase<Schema>;
  try {
    if (options.migrate !== false) ensureSchema(db);
  } catch (error) {
    // 迁移失败时释放 sqlite 句柄，避免调用方重试时泄漏文件锁。
    sqlite.close();
    throw error;
  }
  return { repos: createReposFromDatabase(db), db, close: () => sqlite.close() };
};
