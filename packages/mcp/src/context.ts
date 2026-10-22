// @luoome/mcp —— MCP server 的 ToolContext 组装（docs/archive/plan.md 跨包契约 + docs/archive/MVP-TASK.md §2.6）。
//
// 数据路径：LUOOME_HOME 环境变量（默认 ~/.luoome）下的 luoome.db。
// 空库保持为空；行情要求显式配置真实 provider。
// DSH 改造后单机不再内置模型推理：llm 为明确失败的 stub，MCP 可在零 AI 配置下启动
// （docs/ddd/luoome-dsh-transformation-detailed-design.md §4.3 只读面）。
//
// 运行时约束：本模块 import @luoome/db 桶导出（传递引用 bun:sqlite driver），
// 只允许在纯 Bun 运行时下加载（MCP server 正是如此）。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createAShareSentimentManagerFromEnv,
  createFileAuditLogger,
  createMarketAdapterFromEnv,
  createResearchEmbeddingAdapterFromEnv,
  createResearchRemoteDocumentAdapter,
  createResearchVaultAdapterFromEnv,
  createResearchVaultGitSyncAdapterFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type ToolContext,
} from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '@luoome/db';
import { buildContext } from '@luoome/tools';

/** createServerContext 的返回句柄：ctx + close()（进程退出时关闭 SQLite）。 */
export interface ServerContextHandle {
  readonly ctx: ToolContext;
  readonly close: () => void;
}

/**
 * stderr logger：MCP stdio 传输独占 stdout（NDJSON 协议帧），
 * 任何日志都不得写 stdout，否则污染协议。
 */
const createStderrLogger = (): Logger => {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      process.stderr.write(`[luoome-mcp][${level}] ${message}${suffix}\n`);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
};

/**
 * 组装 server 用 ToolContext：
 * createDrizzleRepos（内部已 ensureSchema，这里再显式调一次保持幂等可见）
 * → 真实行情 factory + LLM stub → buildContext（from @luoome/tools）。
 */
export const createServerContext = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerContextHandle> => {
  const home = env.LUOOME_HOME ?? join(homedir(), '.luoome');
  mkdirSync(home, { recursive: true });

  const handle = createDrizzleRepos(join(home, 'luoome.db'));
  // 幂等（CREATE TABLE IF NOT EXISTS）；createDrizzleRepos 内部已调一次，重复调用安全。
  ensureSchema(handle.db);
  const logger = createStderrLogger();
  // DSH 改造线 B：单机不再内置模型推理；MCP 只读面不依赖 AI 配置即可启动。
  const unavailableLLM = {
    name: 'local-ai-removed',
    generate: async (): Promise<never> => {
      throw new Error(
        '单机不再内置模型推理（DSH 改造）：请通过 DSH 会话/待分析队列执行分析，本 tool 仅提供事实与写回',
      );
    },
  };
  const accounts = await handle.repos.account.list();
  const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  const now = (): Date => new Date();
  const researchVault = createResearchVaultAdapterFromEnv(env);
  let researchEmbedding: ReturnType<typeof createResearchEmbeddingAdapterFromEnv>;
  try {
    researchEmbedding = createResearchEmbeddingAdapterFromEnv(env);
  } catch {
    logger.warn('Research embedding 配置无效；MCP 将以 capability 未挂载状态继续');
  }
  let researchVaultGitSync: ReturnType<typeof createResearchVaultGitSyncAdapterFromEnv>;
  try {
    researchVaultGitSync = createResearchVaultGitSyncAdapterFromEnv(env, {
      backupRoot: join(home, 'backups', 'research-vault'),
    });
  } catch {
    logger.warn('Research Vault 远端同步配置无效；MCP 将以未挂载状态继续');
  }
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与 sentiment factory（§4.6）
  const sources = { eastmoney: new EastmoneySource({ clock: now }) };
  const market = createMarketAdapterFromEnv(env, {
    clock: now,
    logger,
    sources,
  });
  const ctx = buildContext({
    repos: handle.repos,
    adapters: {
      market,
      stockUniverse: createStockUniverseManagerFromEnv(env, {
        clock: now,
        logger,
      }),
      llm: unavailableLLM,
    },
    portfolioBenchmark: {
      stockId:
        env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() || DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
    },
    user: { id: 'local-user', defaultAccountId },
    clock: now,
    logger,
    auditLog: createFileAuditLogger(join(home, 'logs', 'audit.log')),
    auditCaller: 'mcp',
    ashareSentiment: createAShareSentimentManagerFromEnv(env, {
      clock: now,
      logger,
      market,
      sources,
    }),
    ...(researchVault ? { researchVault } : {}),
    ...(researchEmbedding ? { researchEmbedding } : {}),
    ...(researchVaultGitSync ? { researchVaultGitSync } : {}),
    researchRemote: createResearchRemoteDocumentAdapter(),
  });

  return { ctx, close: handle.close };
};
