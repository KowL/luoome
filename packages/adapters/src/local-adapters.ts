// @luoome/adapters —— 单机形态的适配器装配。
//
// CLI、MCP 与 Web 三个入口都要按 env 装配同一套市场/研究/情绪适配器。
// 装配逻辑放在这里，入口只负责注入仓储、用户身份与审计 sink；
// 托管形态另有自己的 provider 组合根（apps/web/src/hosted-composition.ts），与此无关。

import type { Logger } from '@luoome/core';

import { createAShareSentimentManagerFromEnv } from './ashare-sentiment/factory.js';
import { createDragonTigerManagerFromEnv } from './dragon-tiger/factory.js';
import { EastmoneySource } from './eastmoney/source.js';
import { createFundamentalDataAdapterFromEnv } from './fundamental/factory.js';
import { createLimitUpLadderManagerFromEnv } from './limit-up-ladder/factory.js';
import { createMarketAdapterFromEnv } from './market/factory.js';
import { createNewsManagerFromEnv } from './news/factory.js';
import { createNorthboundFlowManagerFromEnv } from './northbound-flow/factory.js';
import { createResearchEmbeddingAdapterFromEnv } from './research-embedding/openai-compatible.js';
import {
  createResearchRemoteDocumentAdapter,
  createResearchVaultAdapterFromEnv,
  createResearchVaultGitSyncAdapterFromEnv,
} from './research-vault/factory.js';
import { createSectorQuoteManagerFromEnv } from './sector-quote/factory.js';
import { createStockUniverseManagerFromEnv } from './stock-universe/factory.js';

export interface LocalAdapterOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly clock: () => Date;
  readonly logger: Logger;
  /** 研究库 git 同步的备份根目录；不传则该能力不挂载。 */
  readonly researchVaultBackupRoot?: string;
}

export interface LocalAdapters {
  readonly sources: { readonly eastmoney: EastmoneySource };
  readonly market: ReturnType<typeof createMarketAdapterFromEnv>;
  readonly stockUniverse: ReturnType<typeof createStockUniverseManagerFromEnv>;
  readonly limitUpLadder: ReturnType<typeof createLimitUpLadderManagerFromEnv>;
  readonly dragonTiger: ReturnType<typeof createDragonTigerManagerFromEnv>;
  readonly northboundFlow: ReturnType<typeof createNorthboundFlowManagerFromEnv>;
  readonly news: ReturnType<typeof createNewsManagerFromEnv>;
  readonly sectorQuote: ReturnType<typeof createSectorQuoteManagerFromEnv>;
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
export const createLocalAdapters = (options: LocalAdapterOptions): LocalAdapters => {
  const { env, clock, logger } = options;
  // 进程级 SourceSet 先建一次，经 deps.sources 分发给 market 与五个非行情 factory
  const sources = { eastmoney: new EastmoneySource({ clock }) };
  const market = createMarketAdapterFromEnv(env, { clock, logger, sources });
  const fundamentalData = createFundamentalDataAdapterFromEnv(env);

  const limitUpLadder = createLimitUpLadderManagerFromEnv(env, { clock, logger, sources });
  const dragonTiger = createDragonTigerManagerFromEnv(env, { clock, logger, sources });
  const northboundFlow = createNorthboundFlowManagerFromEnv(env, { clock, logger, sources });
  const news = createNewsManagerFromEnv(env, { clock, logger, sources });
  const sectorQuote = createSectorQuoteManagerFromEnv(env, { clock, logger });
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
    northboundFlow,
    news,
    sectorQuote,
    ashareSentiment,
    ...(fundamentalData === undefined ? {} : { fundamentalData }),
    ...(researchVault === undefined ? {} : { researchVault }),
    ...(researchEmbedding === undefined ? {} : { researchEmbedding }),
    ...(researchVaultGitSync === undefined ? {} : { researchVaultGitSync }),
    researchRemote: createResearchRemoteDocumentAdapter(),
  };
};
