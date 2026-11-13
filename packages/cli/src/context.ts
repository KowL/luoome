// @luoome/cli —— 共享 ToolContext 构造（tools call / advice 子命令使用）。
//
// 组装路径（docs/archive/plan.md 依赖表：surface → tools → core，及 db/adapters）：
//   LUOOME_HOME（默认 ~/.luoome）/luoome.db
//   → createDrizzleRepos（bun:sqlite driver，仅 Bun 运行时可加载本模块）
//   → 空库保持为空
//   → 真实行情 adapter + 真实 LLM（均要求显式 env 配置）
//   → buildContext

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createDragonTigerFlowManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createFileAuditLogger,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createNotificationManagerFromEnv,
  createResearchVaultAdapterFromEnv,
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
  let ai: ReturnType<typeof createAIStackFromEnv> | undefined;
  try {
    ai = createAIStackFromEnv(process.env, { logger });
  } catch (error) {
    logger.warn('AI 模型尚未配置；CLI 将以配置模式继续（需要 AI 的命令会明确失败）', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const unavailableLLM = {
    name: 'ai-unconfigured',
    generate: async (): Promise<never> => {
      throw new Error('AI 模型尚未配置，请先配置 LUOOME_AI_CONFIG 与对应密钥');
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
  const dragonTigerFlow = createDragonTigerFlowManagerFromEnv(process.env, { clock: now, logger });
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
  const ashareSentiment = createAShareSentimentManagerFromEnv(process.env, {
    clock: now,
    logger,
    market,
    sources,
  });
  const marketIntel = {
    ...(limitUpLadder === undefined ? {} : { limitUpLadder }),
    ...(dragonTiger === undefined ? {} : { dragonTiger }),
    ...(dragonTigerFlow === undefined ? {} : { dragonTigerFlow }),
    ...(northboundFlow === undefined ? {} : { northboundFlow }),
    ...(news === undefined ? {} : { news }),
    ...(sectorQuote === undefined ? {} : { sectorQuote }),
    ...(ashareSentiment === undefined ? {} : { ashareSentiment }),
  };
  const ctx = buildContext({
    repos,
    adapters: {
      market,
      llm: ai?.llm ?? unavailableLLM,
      stockUniverse: createStockUniverseManagerFromEnv(process.env, {
        clock: now,
        logger,
      }),
      notification: createNotificationManagerFromEnv(process.env, { repos, logger, clock: now }),
      ...(researchVault ? { researchVault } : {}),
      ...(Object.keys(marketIntel).length === 0 ? {} : { marketIntel }),
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
  });

  return { ctx, dbPath, close };
};
