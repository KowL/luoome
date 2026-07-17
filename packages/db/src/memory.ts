// @luoome/db 的 driver-free 子路径入口（`@luoome/db/memory`）。
//
// 桶导出（index.ts）传递引用 client.ts（bun:sqlite driver），只能在 Bun 运行时
// 加载；node 运行的 vitest 无法解析 'bun:sqlite'。本入口只导出不依赖 driver 的
// 公共 API（in-memory repos + seedMockData），供 @luoome/tools 的 buildMockContext
// 等纯内存组装路径使用，使其单测可在 node/vitest 下运行。

export * from './repository/memory/index.js';
export * from './seed.js';
