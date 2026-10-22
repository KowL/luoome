// @luoome/cli —— 共享 ToolContext 构造（tools call / advice 子命令使用）。
//
// 组装路径（docs/archive/plan.md 依赖表：surface → tools → core，及 db/adapters）：
//   LUOOME_HOME（默认 ~/.luoome）/luoome.db
//   → createDrizzleRepos（bun:sqlite driver，仅 Bun 运行时可加载本模块）
//   → 空库保持为空
//   → 真实行情 adapter（要求显式 env 配置；LLM 已随 DSH 改造移出单机）
//   → buildContext

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createAShareSentimentManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createFileAuditLogger,
  createFundamentalDataAdapterFromEnv,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createNotificationManagerFromEnv,
  createResearchEmbeddingAdapterFromEnv,
  createResearchRemoteDocumentAdapter,
  createResearchVaultAdapterFromEnv,
  createResearchVaultGitSyncAdapterFromEnv,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type ToolContext,
} from '@luoome/core';
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
  if (
    process.env.HOSTED_DATA_ROOT !== undefined ||
    (process.env.LUOOME_MODE !== undefined && process.env.LUOOME_MODE !== 'local')
  ) {
    throw new Error('CLI business context is local-only');
  }
  const home = luoomeHome();
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, 'luoome.db');

  const { repos, close } = createDrizzleRepos(dbPath);

  const now = (): Date => new Date();
  const accounts = await repos.account.list();
  const defaultAccountId = process.env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  const logger = createStderrLogger();
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与五个非行情 factory（§4.6）
  const sources = { eastmoney: new EastmoneySource({ clock: now }) };
  const market = createMarketAdapterFromEnv(process.env, {
    clock: now,
    logger,
    sources,
  });
  const fundamentalData = createFundamentalDataAdapterFromEnv(process.env);
  // DSH 改造（docs/ddd/luoome-dsh-transformation-detailed-design.md 线 B）：单机不再内置
  // 模型推理，分析类 tool 在 CLI 明确失败；推理由 DSH 消费端经事实包契约执行。
  const unavailableLLM = {
    name: 'local-ai-removed',
    generate: async (): Promise<never> => {
      throw new Error(
        '单机不再内置模型推理（DSH 改造）：请通过 DSH 会话/待分析队列执行分析，本 tool 仅提供事实与写回',
      );
    },
  };
  const limitUpLadder = createLimitUpLadderManagerFromEnv(process.env, {
    clock: now,
    logger,
    sources,
  });
  const dragonTiger = createDragonTigerManagerFromEnv(process.env, {
    clock: now,
    logger,
    sources,
  });
  const northboundFlow = createNorthboundFlowManagerFromEnv(process.env, {
    clock: now,
    logger,
    sources,
  });
  const news = createNewsManagerFromEnv(process.env, {
    clock: now,
    logger,
    sources,
  });
  const sectorQuote = createSectorQuoteManagerFromEnv(process.env, {
    clock: now,
    logger,
  });
  let researchVault: ReturnType<typeof createResearchVaultAdapterFromEnv>;
  try {
    researchVault = createResearchVaultAdapterFromEnv(process.env);
  } catch {
    logger.warn('Research Vault 配置无效；CLI 将以未挂载状态继续');
  }
  let researchEmbedding: ReturnType<typeof createResearchEmbeddingAdapterFromEnv>;
  try {
    researchEmbedding = createResearchEmbeddingAdapterFromEnv(process.env);
  } catch {
    logger.warn('Research embedding 配置无效；CLI 将以 capability 未挂载状态继续');
  }
  let researchVaultGitSync: ReturnType<typeof createResearchVaultGitSyncAdapterFromEnv>;
  try {
    researchVaultGitSync = createResearchVaultGitSyncAdapterFromEnv(process.env, {
      backupRoot: join(home, 'backups', 'research-vault'),
    });
  } catch {
    logger.warn('Research Vault 远端同步配置无效；CLI 将以未挂载状态继续');
  }
  const ctx = buildContext({
    repos,
    adapters: {
      market,
      stockUniverse: createStockUniverseManagerFromEnv(process.env, {
        clock: now,
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
    clock: now,
    logger,
    auditLog: createFileAuditLogger(join(home, 'logs', 'audit.log')),
    auditCaller: 'cli',
    limitUpLadder,
    dragonTiger,
    northboundFlow,
    news,
    sectorQuote,
    ashareSentiment: createAShareSentimentManagerFromEnv(process.env, {
      clock: now,
      logger,
      market,
      sources,
    }),
    ...(researchVault ? { researchVault } : {}),
    ...(researchEmbedding ? { researchEmbedding } : {}),
    ...(researchVaultGitSync ? { researchVaultGitSync } : {}),
    ...(fundamentalData === undefined ? {} : { fundamentalData }),
    researchRemote: createResearchRemoteDocumentAdapter(),
    notification: createNotificationManagerFromEnv(process.env, { repos, logger, clock: now }),
  });

  return { ctx, dbPath, close };
};
