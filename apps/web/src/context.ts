import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
  createSectorCatalogFromEnv,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type ToolContext,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';

/** 缺省数据库路径：$LUOOME_HOME/luoome.db（LUOOME_HOME 缺省 ~/.luoome）。 */
/**
 * 进程级共享数据源实例集（docs/ddd/source-pluggability-and-observation-design.md §4.6/§4.7）。
 * EastmoneySource 由组装根创建一次后分发给 market 与五个非行情 factory，
 * 行情源热更新复用同一实例；其它域专属来源由对应 factory 管理。
 */
export interface WebSourceSet {
  readonly eastmoney?: EastmoneySource;
}

export const resolveDbPath = (): string => {
  const home = process.env.LUOOME_HOME ?? join(homedir(), '.luoome');
  return join(home, 'luoome.db');
};

/**
 * 组装 web 端 ToolContext（与其他 surface 同一模式）：
 * LUOOME_HOME 下的 luoome.db + createDrizzleRepos + 真实行情/LLM + buildContext。
 * 空数据库保持为空，不自动插入任何业务记录。
 */
export const buildWebContext = async (
  dbPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: { readonly sources?: WebSourceSet } = {},
): Promise<ToolContext> => {
  const now = (): Date => new Date();
  mkdirSync(dirname(dbPath), { recursive: true });
  const handle = createDrizzleRepos(dbPath);
  const accounts = await handle.repos.account.list();
  const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
  let ai: ReturnType<typeof createAIStackFromEnv> | undefined;
  try {
    ai = createAIStackFromEnv(env, { logger: console });
  } catch (error) {
    console.warn('AI 模型尚未配置；Web 将以配置模式启动', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const unavailableLLM = {
    name: 'ai-unconfigured',
    generate: async (): Promise<never> => {
      throw new Error('AI 模型尚未配置，请前往设置页完成 LLM 设置');
    },
  };
  let researchVault: ReturnType<typeof createResearchVaultAdapterFromEnv>;
  try {
    researchVault = createResearchVaultAdapterFromEnv(env);
  } catch (error) {
    console.warn('Research Vault 配置无效；Web 将以未挂载状态启动', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与五个非行情 factory（§4.6）
  const eastmoney = deps.sources?.eastmoney ?? new EastmoneySource({ clock: now });
  const sources = { eastmoney };
  const market = createMarketAdapterFromEnv(env, {
    clock: now,
    logger: console,
    // Web 持仓与 Watchlist 盘中轮询；TTL 不调小的话拿到的都是缓存
    quoteCacheTtlMs: 10_000,
    sources,
  });
  const ashareSentiment = createAShareSentimentManagerFromEnv(env, {
    clock: now,
    logger: console,
    market,
    sources,
  });
  const dragonTigerFlow = createDragonTigerFlowManagerFromEnv(env, { clock: now, logger: console });
  const marketIntel = {
    limitUpLadder: createLimitUpLadderManagerFromEnv(env, { clock: now, logger: console, sources }),
    dragonTiger: createDragonTigerManagerFromEnv(env, { clock: now, logger: console, sources }),
    ...(dragonTigerFlow === undefined ? {} : { dragonTigerFlow }),
    northboundFlow: createNorthboundFlowManagerFromEnv(env, {
      clock: now,
      logger: console,
      sources,
    }),
    news: createNewsManagerFromEnv(env, { clock: now, logger: console, sources }),
    sectorQuote: createSectorQuoteManagerFromEnv(env, { clock: now, logger: console }),
    ...(ashareSentiment === undefined ? {} : { ashareSentiment }),
  };
  const sectorCatalog = createSectorCatalogFromEnv(env, { clock: now, logger: console });
  return buildContext({
    repos: handle.repos,
    adapters: {
      market,
      llm: ai?.llm ?? unavailableLLM,
      stockUniverse: createStockUniverseManagerFromEnv(env, {
        clock: now,
        logger: console,
      }),
      ...(sectorCatalog === undefined ? {} : { sectorCatalog }),
      notification: createNotificationManagerFromEnv(env, {
        repos: handle.repos,
        logger: console,
        clock: now,
      }),
      ...(researchVault ? { researchVault } : {}),
      marketIntel,
    },
    clock: now,
    auditLog: createFileAuditLogger(join(dirname(dbPath), 'logs', 'audit.log')),
    auditCaller: 'web',
    user: { id: 'local-web-user', defaultAccountId },
    portfolioBenchmark: {
      stockId:
        env.LUOOME_PORTFOLIO_BENCHMARK_STOCK_ID?.trim() || DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
      name: DEFAULT_PORTFOLIO_BENCHMARK_NAME,
    },
  });
};
