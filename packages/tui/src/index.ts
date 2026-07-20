// @luoome/tui 入口：startTuiApp(ctx?)（CLI 懒加载调用的契约名，startTui 为别名）+ 直接运行启动。
// ctx 缺省构造与其他 surface 一致：LUOOME_HOME/luoome.db（默认 ~/.luoome）+
// createDrizzleRepos + seedMockData（upsert 幂等）+ 行情 factory + LLMManager（均 env 路由，默认 mock）+ buildContext。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createMarketAdapterFromEnv,
  LLMManager,
  MOCK_ACCOUNT,
  MOCK_HOLDINGS,
  MOCK_STOCKS,
  MOCK_TRADES,
} from '@luoome/adapters';
import type { Logger, ToolContext } from '@luoome/core';
// 纯 Bun 运行时入口：@luoome/db 桶导出依赖 bun:sqlite driver，禁止在 node 下 import 本包。
import { createDrizzleRepos, seedMockData } from '@luoome/db';
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
 * 默认 ctx：真实 SQLite（LUOOME_HOME/luoome.db）+ 行情/LLM（均默认 mock，LUOOME_MARKET_PROVIDER / LUOOME_LLM_PROVIDER 可切真实源）。
 * seedMockData 的 save 均为 upsert（onConflictDoUpdate），重复启动幂等。
 * 首次启动库内无建议，app 会对每个持仓调 analyze_stock 生成并持久化；
 * 后续启动 get_advice 直接读到未过期建议。
 */
const buildDefaultContext = async (): Promise<DefaultContextHandle> => {
  const home = process.env.LUOOME_HOME ?? join(homedir(), '.luoome');
  mkdirSync(home, { recursive: true });
  const handle = createDrizzleRepos(join(home, 'luoome.db'));
  await seedMockData(handle.repos, {
    accounts: [MOCK_ACCOUNT],
    stocks: MOCK_STOCKS,
    holdings: MOCK_HOLDINGS,
    trades: MOCK_TRADES,
  });
  const logger = createSilentLogger();
  const ctx = buildContext({
    repos: handle.repos,
    adapters: {
      // 行情源由 LUOOME_MARKET_PROVIDER 路由（默认 mock；real = Eastmoney→Tencent→Mock）
      market: createMarketAdapterFromEnv(process.env, { logger }),
      // LLM 由 LUOOME_LLM_PROVIDER 路由（默认 mock；real 缺 key 启动期报错）
      llm: new LLMManager({ logger }),
    },
    user: { id: 'local-user', defaultAccountId: MOCK_ACCOUNT.id },
    logger,
  });
  return { ctx, close: handle.close };
};

/**
 * 启动 TUI（阻塞至用户按 q / Ctrl+C 退出）。
 * CLI `luoome tui` 懒加载本包后调用的入口名（跨包契约）。
 * @param ctx 可选；缺省时按上注构造默认 ctx，退出时自动关闭数据库。
 */
export const startTuiApp = async (ctx?: ToolContext): Promise<void> => {
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
