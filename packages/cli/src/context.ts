// @luoome/cli —— 共享 ToolContext 构造（tools call / advice 子命令使用）。
//
// 组装路径（plan.md 依赖表：surface → tools → core，及 db/adapters）：
//   LUOOME_HOME（默认 ~/.luoome）/luoome.db
//   → createDrizzleRepos（bun:sqlite driver，仅 Bun 运行时可加载本模块）
//   → 空库保持为空
//   → 真实行情 adapter + 真实 LLM（均要求显式 env 配置）
//   → buildContext

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createMarketAdapterFromEnv, LLMManager } from '@luoome/adapters';
import type { Logger, ToolContext } from '@luoome/core';
import { BUILTIN_TACTICS } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';

import { luoomeHome } from './paths.js';

/** CLI 持有的 ctx 句柄：ToolContext + 底层资源释放。 */
export interface CliContextHandle {
  readonly ctx: ToolContext;
  /** SQLite 文件路径（输出提示用）。 */
  readonly dbPath: string;
  /** 关闭底层数据库连接；短生命周期子命令退出前必须调用。 */
  readonly close: () => void;
}

/** LUOOME_HOME：默认 ~/.luoome（AGENTS.md 快速接入口径）。委托 ./paths.ts 解析。 */
export { luoomeHome };

/** warn / error 打到 stderr，避免污染 --json 的 stdout。 */
const createStderrLogger = (): Logger => {
  const write =
    (level: 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      console.error(`${level}: ${message}${suffix}`);
    };
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: write('warn'), error: write('error') };
};

/**
 * 构造 CLI 共享 ctx。
 *
 * 空数据库保持为空；本函数不会自动写入账户、股票、持仓、交易、建议或盯盘配置。
 */
export const createCliContext = async (): Promise<CliContextHandle> => {
  const home = luoomeHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, 'luoome.db');

  const { repos, close } = createDrizzleRepos(dbPath);
  // v0.3 起：注入 5 个内置战法（首次运行或空库）
  for (const t of BUILTIN_TACTICS) {
    if ((await repos.tactic.findById(t.id)) === null) {
      await repos.tactic.save(t);
    }
  }

  const now = (): Date => new Date();
  const accounts = await repos.account.list();
  const defaultAccountId = process.env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';

  const logger = createStderrLogger();
  const ctx = buildContext({
    repos,
    adapters: {
      market: createMarketAdapterFromEnv(process.env, { clock: now, logger }),
      llm: new LLMManager({ logger }),
    },
    user: { id: 'local-user', defaultAccountId },
    clock: now,
    logger,
  });

  return { ctx, dbPath, close };
};
