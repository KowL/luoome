// vitest（node 运行时）配置。
//
// 内存 Repository 退役后，`createInMemoryRepos` 与 :memory: SQLite 共用同一套
// Drizzle 实现；node 运行时没有 bun:sqlite，这里把它 alias 到 node:sqlite 的最小
// shim（packages/db/src/testing/node-sqlite.ts）。drizzle-orm 需要经 Vite 处理才能
// 命中该 alias，因此强制 inline。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const nodeSqliteShim = fileURLToPath(
  new URL('./packages/db/src/testing/node-sqlite.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^bun:sqlite$/, replacement: nodeSqliteShim }],
  },
  test: {
    // drizzle-orm 需经 Vite 处理才能命中上面的 bun:sqlite alias。
    server: {
      deps: {
        inline: [/drizzle-orm[\\/]bun-sqlite/],
      },
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // 嵌套 git worktree（.claude/worktrees/*、.agents/worktrees/*）是其它分支的工作副本，不参与本树测试。
      '.claude/**',
      '.agents/**',
      '.tmp/**',
      'packages/db/src/testing/**',
      'packages/db/src/client.test.ts',
      'packages/db/src/seed.test.ts',
      'packages/db/src/repository/drizzle/**',
      'packages/db/src/repository/decision-review.contract.test.ts',
      // apps/web 的 server 测试顶层 import @luoome/db（bun:sqlite），由 bun runner 执行；
      // public/js 的 DOM-free 单测也复用 bun:test，由 test:web 一并执行。
      'apps/web/src/server.test.ts',
      'apps/web/src/server-background-scheduler.test.ts',
      'apps/web/src/workspace.test.ts',
      'apps/web/src/data-transfer.test.ts',
      // DSH Web includes Bun listeners and SQLite fixtures; test:web owns this slice.
      'apps/web/src/dsh/**/*.test.ts',
      'apps/web/src/strategy-scheduler.test.ts',
      'apps/web/src/intraday-plan-scheduler.test.ts',
      'apps/web/src/market-batch-scheduler.test.ts',
      'apps/web/src/strategy-autonomy-scheduler.test.ts',
      'apps/web/src/portfolio-performance-scheduler.test.ts',
      'apps/web/public/js/**/*.test.js',
    ],
  },
});
