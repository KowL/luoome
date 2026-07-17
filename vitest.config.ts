// vitest（node 运行时）配置：db 的 driver 相关测试依赖 bun:sqlite，
// node 下无法解析，这里 exclude；这些测试改由 Bun 运行时执行：
//   bun run test:db   （= bun test packages/db，含 driver + memory 全部 65 个）
// 或直接 bun test（仓库根，Bun 自带 vitest 兼容层，209 个全量）。
// 详见 package.json scripts 与 docs/MVP-TASK.md §6 验收口径。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/db/src/client.test.ts',
      'packages/db/src/seed.test.ts',
      'packages/db/src/repository/drizzle/**',
    ],
  },
});
