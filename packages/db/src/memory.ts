// @luoome/db 的 driver-free 子路径入口（`@luoome/db/memory`）。
//
// 桶导出（index.ts）传递引用 client.ts（bun:sqlite driver），只能在 Bun 运行时
// 加载；node 运行的 vitest 无法解析 'bun:sqlite'。本入口只导出不依赖 driver 的
// 公共 API（in-memory repos + seedData），供纯内存测试组装路径使用。

// 数据导入 manifest 是纯常量契约（无 driver 依赖）：host 装配、验收脚本与测试
// 都需要同一份表分类，因此随 driver-free 入口一起导出。
export {
  DATA_IMPORT_BUSINESS_TABLES,
  DATA_IMPORT_FTS_SHADOW_TABLES,
  DATA_IMPORT_MANIFEST,
} from './data-import-manifest.js';
export * from './personal/memory.js';
export * from './repository/memory/index.js';
export * from './seed.js';
