// @luoome/web 入口：直接运行（bun --no-env-file apps/web/src/index.ts）即启动单机 Web 服务。
// import.meta.main 守卫：被 CLI `web serve` 懒加载 import 时不会自动起服务。
// 桶导出 server.ts（startWeb 等）：CLI `web serve` 以 `@luoome/web` → startWeb({ port }) 契约调用。

import { startWeb } from './server.js';

export * from './server.js';

if (import.meta.main) {
  const server = await startWeb({ port: Number(process.env.PORT ?? 5173) });
  process.once('SIGINT', () => {
    void server.stop();
  });
  process.once('SIGTERM', () => {
    void server.stop();
  });
}
