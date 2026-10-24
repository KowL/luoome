// @luoome/web —— 单机形态的 ToolContext 装配。
//
// 与 CLI 同一套适配器装配（@luoome/adapters 的 createLocalAdapters），差别只在入口语义：
// Web 面向浏览器，需要账号选择、审计落盘与通知管理器。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createFileAuditLogger,
  createLocalAdapters,
  createNotificationManagerFromEnv,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type ToolContext,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';

export interface LocalWebContextHandle {
  readonly ctx: ToolContext;
  readonly dbPath: string;
  readonly home: string;
  close(): void;
}

const createConsoleLogger = (): Logger => ({
  debug: (message, meta) => console.debug(message, meta ?? ''),
  info: (message, meta) => console.info(message, meta ?? ''),
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
});

/** 单机数据目录：LUOOME_HOME 优先，其次 ~/.luoome。 */
export const localWebHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LUOOME_HOME?.trim() || join(homedir(), '.luoome');

/**
 * 构造单机 Web 的 ToolContext。
 *
 * 空库保持为空：不自动写账户、持仓或建议；默认账户由调用方通过
 * ensureDefaultAccountTool 决定，与 CLI 口径一致。
 */
export const createLocalWebContext = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalWebContextHandle> => {
  const home = localWebHome(env);
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, 'luoome.db');
  const { repos, close } = createDrizzleRepos(dbPath);

  const clock = (): Date => new Date();
  const logger = createConsoleLogger();
  const accounts = await repos.account.list();
  const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';

  const {
    market,
    stockUniverse,
    limitUpLadder,
    dragonTiger,
    northboundFlow,
    news,
    sectorQuote,
    ashareSentiment,
    fundamentalData,
    researchVault,
    researchEmbedding,
    researchVaultGitSync,
    researchRemote,
  } = createLocalAdapters({
    env,
    clock,
    logger,
    researchVaultBackupRoot: join(home, 'backups', 'research-vault'),
  });

  const ctx = buildContext({
    repos,
    adapters: { market, stockUniverse },
    portfolioBenchmark: {
      stockId:
        env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() || DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
    },
    user: { id: 'local-user', defaultAccountId },
    clock,
    logger,
    auditLog: createFileAuditLogger(join(home, 'logs', 'audit.log')),
    auditCaller: 'web',
    limitUpLadder,
    dragonTiger,
    northboundFlow,
    news,
    sectorQuote,
    ashareSentiment,
    ...(researchVault ? { researchVault } : {}),
    ...(researchEmbedding ? { researchEmbedding } : {}),
    ...(researchVaultGitSync ? { researchVaultGitSync } : {}),
    ...(fundamentalData === undefined ? {} : { fundamentalData }),
    researchRemote,
    notification: createNotificationManagerFromEnv(env, { repos, logger, clock }),
  });

  return { ctx, dbPath, home, close };
};
