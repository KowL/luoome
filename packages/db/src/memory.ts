// @luoome/db 的子路径入口（`@luoome/db/memory`）。
//
// 内存 Repository 已退役：测试与导入流程统一使用 bun:sqlite `:memory:` + Drizzle
// 实现，不再维护第二套手写 JS Map 语义。node 运行时（vitest）没有 bun:sqlite，
// 根目录 vitest.config.ts 把它 alias 到 packages/db/src/testing/node-sqlite.ts，
// 因此本入口在 Bun 与 node 测试进程下都可用。

import type { RepositoryRegistry } from '@luoome/core';

import { createDrizzleRepos } from './client.js';

export { type SeedData, seedData } from './seed.js';

/** 每次调用创建独立的 :memory: 数据库（表结构由 ensureSchema 建好）。 */
export const createMemoryRepositories = (): RepositoryRegistry =>
  createDrizzleRepos(':memory:').repos;
