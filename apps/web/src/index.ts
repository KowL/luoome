// @luoome/web 入口：直接运行（bun apps/web/src/index.ts）即启动 web server。
// import.meta.main 守卫：被 CLI `web serve` 懒加载 import 时不会自动起服务。
// 桶导出 server.ts（startWeb 等）：CLI `web serve` 以 `@luoome/web` → startWeb({ port }) 契约调用。

import { loadProjectEnv } from './env.js';
import { resolveRuntimeMode } from './hosted-config.js';
import { startWeb } from './server.js';

export * from './server.js';
export * from './strategy-scheduler.js';

if (import.meta.main) {
  const mode = resolveRuntimeMode();
  if (mode === 'local') loadProjectEnv();
  if (mode === 'local' && resolveRuntimeMode() === 'hosted') {
    throw new Error('hosted mode must be selected before loading local project environment');
  }
  const server = await startWeb({ port: Number(process.env.PORT ?? 5173) });
  process.once('SIGINT', () => {
    void server.stop();
  });
  process.once('SIGTERM', () => {
    void server.stop();
  });
}
