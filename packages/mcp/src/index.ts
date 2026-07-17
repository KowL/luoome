// @luoome/mcp —— bin 入口（plan.md 跨包契约：startMcpServer，stdio）。
//
// 直接运行（bun packages/mcp/src/index.ts，或 CLI `luoome mcp serve` spawn 本文件）时
// 启动 stdio server；被 import（如 CLI 懒加载 startMcpServer）时不自动启动。

import { startMcpServer } from './server.js';

export * from './context.js';
export * from './server.js';

if (import.meta.main) {
  try {
    const handle = await startMcpServer();
    // stdio server 常驻：stdin 活跃 reader 保持事件循环；收到信号时优雅关闭。
    const shutdown = (): void => {
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    // 启动失败（含 LUOOME_EXPOSE_TRADE=true 硬卡）：非零退出，错误走 stderr。
    process.stderr.write(
      `[luoome-mcp][fatal] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  }
}
