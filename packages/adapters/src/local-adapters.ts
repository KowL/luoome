// @luoome/adapters —— 单机形态的适配器装配。
//
// CLI、MCP 与 Web 三个入口都要按 env 装配同一套市场/研究/情绪适配器。
// 装配逻辑放在这里，入口只负责注入仓储、用户身份与审计 sink；
// 托管形态另有自己的 provider 组合根（原 `apps/web/src/hosted-composition.ts`，已随 M3-01 删除），与此无关。

import type { Logger } from '@luoome/core';

import { createAShareSentimentManagerFromEnv } from './ashare-sentiment/factory.js';
import { createDragonTigerManagerFromEnv } from './dragon-tiger/factory.js';
import { EastmoneySource } from './eastmoney/source.js';
import { createFinancialSnapshotManagerFromEnv } from './financial-snapshot/factory.js';
import { createFundamentalDataAdapterFromEnv } from './fundamental/factory.js';
import { FuyaoClient, fuyaoConfigFromEnv } from './fuyao/client.js';
import {
  FuyaoRequestCoordinator,
  fuyaoRequestCoordinatorConfigFromEnv,
} from './fuyao/request-coordinator.js';
import { createLimitUpLadderManagerFromEnv } from './limit-up-ladder/factory.js';
import { createMarketAdapterFromEnv } from './market/factory.js';
import { createMarketDumpManagerFromEnv } from './market-dump/factory.js';
import type { MarketDumpStores } from './market-dump/types.js';
import { createNewsManagerFromEnv } from './news/factory.js';
import { createNorthboundFlowManagerFromEnv } from './northbound-flow/factory.js';
import { createResearchEmbeddingAdapterFromEnv } from './research-embedding/openai-compatible.js';
import {
  createResearchRemoteDocumentAdapter,
  createResearchVaultAdapterFromEnv,
  createResearchVaultGitSyncAdapterFromEnv,
} from './research-vault/factory.js';
import { createSectorMembershipManagerFromEnv } from './sector-membership/factory.js';
import { createSectorQuoteManagerFromEnv } from './sector-quote/factory.js';
import { createStockProfileManagerFromEnv } from './stock-profile/factory.js';
import { createStockUniverseManagerFromEnv } from './stock-universe/factory.js';

export interface LocalAdapterOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly logger: Logger;
  /** 研究库 git 同步的备份根目录；不传则该能力不挂载。 */
  readonly researchVaultBackupRoot?: string;
  /**
   * dump 事实链仓储组（drizzle 或 in-memory 实现；由入口从 RepositoryRegistry 注入）。
   * 缺省时 market-dump 能力不装配（LUOOME_MARKET_DUMP_SOURCES 显式启用也需要仓储）。
   */
  readonly marketDumpStores?: MarketDumpStores;
}

export interface LocalAdapters {
  readonly sources: { readonly eastmoney: EastmoneySource; readonly fuyao?: FuyaoClient };
  readonly market: ReturnType<typeof createMarketAdapterFromEnv>;
  readonly stockUniverse: ReturnType<typeof createStockUniverseManagerFromEnv>;
  readonly limitUpLadder: ReturnType<typeof createLimitUpLadderManagerFromEnv>;
  readonly dragonTiger: ReturnType<typeof createDragonTigerManagerFromEnv>;
  readonly stockProfile: ReturnType<typeof createStockProfileManagerFromEnv>;
  readonly northboundFlow: ReturnType<typeof createNorthboundFlowManagerFromEnv>;
  readonly news: ReturnType<typeof createNewsManagerFromEnv>;
  readonly sectorQuote: ReturnType<typeof createSectorQuoteManagerFromEnv>;
  readonly sectorMembership?: ReturnType<typeof createSectorMembershipManagerFromEnv>;
  readonly financialSnapshot?: ReturnType<typeof createFinancialSnapshotManagerFromEnv>;
  readonly marketDump?: ReturnType<typeof createMarketDumpManagerFromEnv>;
  readonly ashareSentiment: ReturnType<typeof createAShareSentimentManagerFromEnv>;
  readonly fundamentalData?: ReturnType<typeof createFundamentalDataAdapterFromEnv>;
  readonly researchVault?: ReturnType<typeof createResearchVaultAdapterFromEnv>;
  readonly researchEmbedding?: ReturnType<typeof createResearchEmbeddingAdapterFromEnv>;
  readonly researchVaultGitSync?: ReturnType<typeof createResearchVaultGitSyncAdapterFromEnv>;
  readonly researchRemote: ReturnType<typeof createResearchRemoteDocumentAdapter>;
}

/**
 * 按 env 装配单机适配器。
 *
 * 研究库、embedding、git 同步是可选能力：配置无效时记录告警并以未挂载状态继续，
 * 不让一个可选集成的坏配置挡住服务启动。
 */
/**
 * 判断本进程是否有任何 fuyao 能力被显式启用（决定共享 FuyaoClient 是否创建）。
 * 缺省来源（eastmoney 等）不算启用；只有 env 显式列出 fuyao 才创建共享客户端。
 */
const fuyaoRequestedFromEnv = (env: NodeJS.ProcessEnv): boolean => {
  const lists = [
    env.LUOOME_MARKET_SOURCES,
    env.LUOOME_LIMIT_UP_LADDER_SOURCES,
    env.LUOOME_DRAGON_TIGER_SOURCES,
    env.LUOOME_ASHARE_SENTIMENT_SOURCES,
    env.LUOOME_NEWS_SOURCES,
    env.LUOOME_SECTOR_QUOTE_SOURCES,
    env.LUOOME_SECTOR_MEMBERSHIP_SOURCES,
    env.LUOOME_FINANCIAL_SNAPSHOT_SOURCES,
    env.LUOOME_MARKET_DUMP_SOURCES,
  ];
  return lists.some((raw) =>
    raw
      ?.split(',')
      .map((source) => source.trim().toLowerCase())
      .includes('fuyao'),
  );
};

export const createLocalAdapters = (options: LocalAdapterOptions): LocalAdapters => {
  const { env, clock, logger } = options;
  // 进程级共享 FuyaoClient（设计 §4.1）：所有 Fuyao REST 请求共享同一协调器。
  // 任一 fuyao 能力显式启用时创建一次，经 deps 分发给 market 与七个非行情 factory；
  // FUYAO_API_KEY 缺失即启动期失败（fuyaoConfigFromEnv 硬前置）。
  const fuyao = fuyaoRequestedFromEnv(env)
    ? new FuyaoClient(fuyaoConfigFromEnv(env), {
        coordinator: new FuyaoRequestCoordinator(fuyaoRequestCoordinatorConfigFromEnv(env)),
      })
    : undefined;
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与五个非行情 factory
  const sources = {
    eastmoney: new EastmoneySource({ clock }),
    ...(fuyao === undefined ? {} : { fuyao }),
  };
  const market = createMarketAdapterFromEnv(env, {
    clock,
    logger,
    sources: { eastmoney: sources.eastmoney },
    ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
  });
  const fundamentalData = createFundamentalDataAdapterFromEnv(env);

  const limitUpLadder = createLimitUpLadderManagerFromEnv(env, { clock, logger, sources });
  const dragonTiger = createDragonTigerManagerFromEnv(env, { clock, logger, sources });
  const stockProfile = createStockProfileManagerFromEnv(env, { clock, logger });
  const northboundFlow = createNorthboundFlowManagerFromEnv(env, { clock, logger, sources });
  const news = createNewsManagerFromEnv(env, {
    clock,
    logger,
    sources: { eastmoney: sources.eastmoney },
    ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
  });
  const sectorQuote = createSectorQuoteManagerFromEnv(env, {
    clock,
    logger,
    ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
  });
  const sectorMembership = createSectorMembershipManagerFromEnv(env, {
    clock,
    logger,
    ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
  });
  const financialSnapshot = createFinancialSnapshotManagerFromEnv(env, {
    clock,
    logger,
    ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
  });
  const marketDump =
    options.marketDumpStores === undefined
      ? undefined
      : createMarketDumpManagerFromEnv(env, {
          clock,
          logger,
          stores: options.marketDumpStores,
          ...(fuyao === undefined ? {} : { fuyaoClient: fuyao }),
        });
  const stockUniverse = createStockUniverseManagerFromEnv(env, { clock, logger });
  const ashareSentiment = createAShareSentimentManagerFromEnv(env, {
    clock,
    logger,
    market,
    sources,
  });

  let researchVault: LocalAdapters['researchVault'];
  try {
    researchVault = createResearchVaultAdapterFromEnv(env);
  } catch {
    logger.warn('Research Vault 配置无效；将以未挂载状态继续');
  }
  let researchEmbedding: LocalAdapters['researchEmbedding'];
  try {
    researchEmbedding = createResearchEmbeddingAdapterFromEnv(env);
  } catch {
    logger.warn('Research embedding 配置无效；将以 capability 未挂载状态继续');
  }
  let researchVaultGitSync: LocalAdapters['researchVaultGitSync'];
  if (options.researchVaultBackupRoot !== undefined) {
    try {
      researchVaultGitSync = createResearchVaultGitSyncAdapterFromEnv(env, {
        backupRoot: options.researchVaultBackupRoot,
      });
    } catch {
      logger.warn('Research Vault 远端同步配置无效；将以未挂载状态继续');
    }
  }

  return {
    sources,
    market,
    stockUniverse,
    limitUpLadder,
    dragonTiger,
    stockProfile,
    northboundFlow,
    news,
    sectorQuote,
    ...(sectorMembership === undefined ? {} : { sectorMembership }),
    ...(financialSnapshot === undefined ? {} : { financialSnapshot }),
    ...(marketDump === undefined ? {} : { marketDump }),
    ashareSentiment,
    ...(fundamentalData === undefined ? {} : { fundamentalData }),
    ...(researchVault === undefined ? {} : { researchVault }),
    ...(researchEmbedding === undefined ? {} : { researchEmbedding }),
    ...(researchVaultGitSync === undefined ? {} : { researchVaultGitSync }),
    researchRemote: createResearchRemoteDocumentAdapter(),
  };
};
