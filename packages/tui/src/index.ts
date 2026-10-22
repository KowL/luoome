// @luoome/tui 入口：startTuiApp(ctx?)（CLI 懒加载调用的契约名，startTui 为别名）+ 直接运行启动。
// ctx 缺省构造与其他 surface 一致：LUOOME_HOME/luoome.db（默认 ~/.luoome）+
// createDrizzleRepos（空库保持为空）+ 真实行情 factory + buildContext。
// DSH 改造后单机不再内置模型推理（llm 为明确失败的 stub）。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createFileAuditLogger,
  createMarketAdapterFromEnv,
  createResearchRemoteDocumentAdapter,
  createStockUniverseManagerFromEnv,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type ToolContext,
} from '@luoome/core';
// 纯 Bun 运行时入口：@luoome/db 桶导出依赖 bun:sqlite driver，禁止在 node 下 import 本包。
import { createDrizzleRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';

import { runTui } from './app.js';

export { createTuiApp, runTui } from './app.js';

/** TUI 全屏时 console logger 会污染界面，默认丢弃全部日志。 */
const createSilentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

interface DefaultContextHandle {
  readonly ctx: ToolContext;
  readonly close: () => void;
}

/**
 * 默认 ctx：真实 SQLite（LUOOME_HOME/luoome.db）+ 显式配置的真实行情。
 * 空数据库保持为空，不自动插入示例记录。
 * DSH 改造后单机不再内置模型推理：llm 为明确失败的 stub，分析交给 DSH 消费端。
 */
const buildDefaultContext = async (): Promise<DefaultContextHandle> => {
  const home = process.env.LUOOME_HOME ?? join(homedir(), '.luoome');
  mkdirSync(home, { recursive: true });
  const handle = createDrizzleRepos(join(home, 'luoome.db'));
  const logger = createSilentLogger();
  const unavailableLLM = {
    name: 'local-ai-removed',
    generate: async (): Promise<never> => {
      throw new Error(
        '单机不再内置模型推理（DSH 改造）：请通过 DSH 会话/待分析队列执行分析，本 tool 仅提供事实与写回',
      );
    },
  };
  const accounts = await handle.repos.account.list();
  const defaultAccountId = process.env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  const ctx = buildContext({
    repos: handle.repos,
    adapters: {
      market: createMarketAdapterFromEnv(process.env, {
        logger,
      }),
      stockUniverse: createStockUniverseManagerFromEnv(process.env, {
        logger,
      }),
      llm: unavailableLLM,
    },
    portfolioBenchmark: {
      stockId:
        process.env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() ||
        DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
    },
    user: { id: 'local-user', defaultAccountId },
    logger,
    auditLog: createFileAuditLogger(join(home, 'logs', 'audit.log')),
    auditCaller: 'tui',
    researchRemote: createResearchRemoteDocumentAdapter(),
  });
  return { ctx, close: handle.close };
};

/**
 * 启动 TUI（阻塞至用户按 q / Ctrl+C 退出）。
 * CLI `luoome tui` 懒加载本包后调用的入口名（跨包契约）。
 * @param ctx 可选；缺省时按上注构造默认 ctx，退出时自动关闭数据库。
 */
export const startTuiApp = async (ctx?: ToolContext): Promise<void> => {
  if (
    (process.env.LUOOME_MODE !== undefined && process.env.LUOOME_MODE !== 'local') ||
    ctx?.identity?.mode === 'hosted'
  ) {
    throw new Error('TUI is local-only');
  }
  if (ctx !== undefined) {
    await runTui(ctx);
    return;
  }
  const handle = await buildDefaultContext();
  try {
    await runTui(handle.ctx);
  } finally {
    handle.close();
  }
};

/** startTuiApp 的别名（等价语义，供其他 surface 选用）。 */
export const startTui = startTuiApp;

// 直接运行（bun packages/tui/src/index.ts / bin/luoome tui 懒加载）时启动。
if (import.meta.main) {
  startTuiApp().catch((error: unknown) => {
    // 非 TTY 或初始化失败：给出友好提示而不是堆栈刷屏。
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`luoome tui 启动失败：${message}\n`);
    process.exit(1);
  });
}
