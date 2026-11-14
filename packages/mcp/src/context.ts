// @luoome/mcp —— MCP server 的 ToolContext 组装（docs/archive/plan.md 跨包契约 + docs/archive/MVP-TASK.md §2.6）。
//
// 数据路径：LUOOME_HOME 环境变量（默认 ~/.luoome）下的 luoome.db。
// 空库保持为空；未配置外部 provider 时只提供本地能力。
//
// 运行时约束：本模块 import @luoome/db 桶导出（传递引用 bun:sqlite driver），
// 只允许在纯 Bun 运行时下加载（MCP server 正是如此）。

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createDragonTigerFlowManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createFileAuditLogger,
  createLimitUpLadderManagerFromEnv,
  createLimitUpMarketManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createResearchVaultAdapterFromEnv,
  createSectorCatalogFromEnv,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
} from '@luoome/adapters';
import {
  DEFAULT_PORTFOLIO_BENCHMARK_NAME,
  DEFAULT_PORTFOLIO_BENCHMARK_STOCK_ID,
  type Logger,
  type MarketDataAdapterLike,
  type ToolContext,
} from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '@luoome/db';
import { buildContext } from '@luoome/tools';
import type { McpDependency } from './exposure.js';

/** createServerContext 的返回句柄：ctx + close()（进程退出时关闭 SQLite）。 */
export interface ServerContextHandle {
  readonly ctx: ToolContext;
  readonly readyDependencies: ReadonlySet<McpDependency>;
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
 * → 真实行情 factory + LLMManager → buildContext（from @luoome/tools）。
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
  try {
    const readyDependencies = new Set<McpDependency>();
    let ai: ReturnType<typeof createAIStackFromEnv> | undefined;
    try {
      ai = createAIStackFromEnv(env, { logger });
      readyDependencies.add('llm');
    } catch {
      logger.warn('AI 配置未就绪；MCP 不暴露需要模型的工具');
    }
    const unavailable = async (): Promise<never> => {
      throw new Error('MCP 外部依赖未配置');
    };
    const localMarket: MarketDataAdapterLike = {
      name: 'market-unconfigured',
      fetchQuote: unavailable,
      batchQuote: unavailable,
      fetchDailyBars: unavailable,
      searchStocks: unavailable,
      fetchIndexQuotes: unavailable,
      fetchIntradayMinutes: unavailable,
      fetchMinuteBars: unavailable,
      fetchMarketSnapshot: unavailable,
      marketSourceStatus: () => [],
    };
    const accounts = await handle.repos.account.list();
    const defaultAccountId = env.LUOOME_DEFAULT_ACCOUNT_ID?.trim() || accounts[0]?.id || '';
    const now = (): Date => new Date();
    const researchVault = createResearchVaultAdapterFromEnv(env);
    // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与 sentiment factory（§4.6）
    const sources = { eastmoney: new EastmoneySource({ clock: now }) };
    const market = env.LUOOME_MARKET_PROVIDER?.trim()
      ? createMarketAdapterFromEnv(env, { clock: now, logger, sources })
      : localMarket;
    for (const status of market.marketSourceStatus()) {
      if (status.capabilityEnabled && status.configurationReady) {
        readyDependencies.add(`market:${status.dataset}`);
      }
    }
    const deps = { clock: now, logger, sources };
    const limitUpMarket =
      market === localMarket ? undefined : createLimitUpMarketManagerFromEnv(env, deps);
    const dragonTigerFlow =
      market === localMarket ? undefined : createDragonTigerFlowManagerFromEnv(env, deps);
    const marketIntel: NonNullable<ToolContext['adapters']['marketIntel']> =
      market === localMarket
        ? {}
        : {
            ashareSentiment: createAShareSentimentManagerFromEnv(env, { ...deps, market }),
            limitUpLadder: createLimitUpLadderManagerFromEnv(env, deps),
            ...(limitUpMarket === undefined ? {} : { limitUpMarket }),
            dragonTiger: createDragonTigerManagerFromEnv(env, deps),
            ...(dragonTigerFlow === undefined ? {} : { dragonTigerFlow }),
            northboundFlow: createNorthboundFlowManagerFromEnv(env, deps),
            news: createNewsManagerFromEnv(env, deps),
            sectorQuote: createSectorQuoteManagerFromEnv(env, deps),
          };
    for (const key of Object.keys(marketIntel) as (keyof typeof marketIntel)[]) {
      if (marketIntel[key] !== undefined) readyDependencies.add(key);
    }
    if (researchVault) readyDependencies.add('researchVault');
    const sectorCatalog =
      market === localMarket ? undefined : createSectorCatalogFromEnv(env, deps);
    if (sectorCatalog) readyDependencies.add('sectorCatalog');
    const ctx = buildContext({
      repos: handle.repos,
      adapters: {
        market,
        llm: ai?.llm ?? { name: 'ai-unconfigured', generate: unavailable },
        ...(market === localMarket
          ? {}
          : {
              stockUniverse: createStockUniverseManagerFromEnv(env, {
                clock: now,
                logger,
              }),
            }),
        ...(researchVault ? { researchVault } : {}),
        marketIntel,
        ...(sectorCatalog === undefined ? {} : { sectorCatalog }),
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
    });

    return { ctx, readyDependencies, close: handle.close };
  } catch (error) {
    handle.close();
    throw error;
  }
};
