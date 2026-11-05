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
      // 嵌套 git worktree 是其它分支的工作副本，不参与本树测试。
      '.claude/**',
      '.agents/**',
      // 本地临时目录（构建/发布中间产物），不是仓库内容。
      '.tmp/**',
      // dsh-authority e2e 需要 Node 24 的完整宿主装配，由 bun 运行：
      //   bun run test:dsh-luoome:e2e
      'packages/dsh-luoome/src/host/dsh-authority.e2e.test.ts',
      'packages/db/src/client.test.ts',
      'packages/db/src/seed.test.ts',
      'packages/db/src/repository/drizzle/**',
      'packages/db/src/repository/decision-review.contract.test.ts',
      'packages/db/src/repository/data-import.contract.test.ts',
      // T21 旧行迁移用例走 bun:sqlite（createDrizzleRepos），由 test:db 执行。
      'packages/db/src/repository/trading-plan-legacy.test.ts',
      // T35 旧 snapshot 迁移用例走 bun:sqlite，由 test:db 执行。
      'packages/db/src/repository/stock-universe-legacy.test.ts',
      // Bun 运行时的只读迁移契约（bun:test），Node/vitest 解析不到该内置模块。
      'packages/db/src/repository/schema-migration.contract.test.ts',
      // schema ↔ 表列集对账守卫：顶层 import bun:test（与上面同理），由 test:db 执行。
      'packages/db/src/repository/schema-parity.contract.test.ts',
      'packages/db/src/personal/**',
    ],
  },
});
