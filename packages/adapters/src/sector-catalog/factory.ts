import type { Logger, SectorCatalogAdapterLike } from '@luoome/core';

import { fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoSource } from '../fuyao/source.js';

/**
 * 行业 / 概念目录与成分数据源装配。
 *
 * 与行情源一致：只有显式配置 FUYAO_API_KEY 才启用；未配置时返回 undefined，
 * 同步 tool 明确失败而不是静默联网或返回空事实。
 */
export interface CreateSectorCatalogDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createSectorCatalogFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorCatalogDeps,
): SectorCatalogAdapterLike | undefined => {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return new FuyaoSource({
    config: fuyaoConfigFromEnv(env),
    logger: deps.logger,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
};
