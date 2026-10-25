// vitest（node 运行时）配置：db 的 driver 相关测试依赖 bun:sqlite，
// node 下无法解析，这里 exclude；这些测试改由 Bun 运行时执行：
//   bun run test:db   （= bun test packages/db，含 driver + memory 全部 65 个）
// 或直接 bun test（仓库根，Bun 自带 vitest 兼容层，209 个全量）。
// 详见 package.json scripts 与 docs/archive/MVP-TASK.md §6 验收口径。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // @luoome/db/node 的合约文件不以 .test.ts 结尾（避免 bun test 在 Bun 运行时
    // 加载 node:sqlite），默认 include 匹配不到，这里显式补入。
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', 'packages/db/src/node.contract.node.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // 嵌套 git worktree（.claude/worktrees/*）是其它分支的工作副本，不参与本树测试。
      '.claude/**',
      // 本地临时目录（构建/发布中间产物），不是仓库内容。
      '.tmp/**',
      'packages/dsh-luoome/src/host/dsh-authority.e2e.test.ts',
      // MCP 分析面 e2e spawn bun 子进程并直接加载 bun:sqlite，由 bun 运行：
      //   bun run test:analysis-surface
      'packages/mcp/src/analysis-surface.e2e.test.ts',
      'packages/db/src/client.test.ts',
      'packages/db/src/seed.test.ts',
      'packages/db/src/repository/drizzle/**',
      'packages/db/src/repository/decision-review.contract.test.ts',
      'packages/db/src/personal/**',
      // apps/web 的 server 测试顶层 import @luoome/db（bun:sqlite），由 bun runner 执行；
      // public/js 的 DOM-free 单测也复用 bun:test，由 test:web 一并执行。
      'apps/web/src/server.test.ts',
      'apps/web/src/workspace.test.ts',
      'apps/web/src/local-start.test.ts',
      'apps/web/src/data-transfer.test.ts',
      'apps/web/public/js/**/*.test.js',
    ],
  },
});
