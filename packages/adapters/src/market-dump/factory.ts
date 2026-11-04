import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@luoome/core';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoMarketDumpAdapter } from './fuyao.js';
import { MarketDumpManager } from './manager.js';
import type { MarketDumpManagerLike, MarketDumpStores } from './types.js';

/**
 * market-dump manager 装配根（fuyao-data-expansion §5 / §13.1）。
 *
 * - dump 通过 Tool 显式执行，不增加常驻调度开关；但 manager 需要显式启用才装配：
 *   `LUOOME_MARKET_DUMP_SOURCES=fuyao`（缺省不装配，与其它新端口同一纪律）；
 * - 显式启用时要求 FUYAO_API_KEY 齐全，缺即启动期失败（§4.3）；
 * - artifact 根目录：`$LUOOME_HOME/market-dumps`（缺省 ~/.luoome/market-dumps）；
 * - 仓储组由装配侧注入（db 包 Drizzle 或 in-memory）；adapters 不反向依赖 db。
 */

export interface CreateMarketDumpManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** dump 事实链仓储组（drizzle 或 in-memory 实现）。 */
  readonly stores: MarketDumpStores;
  /** 组装根共享的 Fuyao client；注入时不再自构（§4.1 共享传输实例）。 */
  readonly fuyaoClient?: FuyaoClient;
}

const marketDumpEnabledFromEnv = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const raw = env.LUOOME_MARKET_DUMP_SOURCES?.trim();
  if (raw === undefined || raw.length === 0) return false;
  const sources = raw.split(',').map((source) => source.trim().toLowerCase());
  if (sources.some((source) => source !== 'fuyao') || new Set(sources).size !== sources.length) {
    throw new Error('LUOOME_MARKET_DUMP_SOURCES 仅支持 fuyao，且来源不得重复');
  }
  return true;
};

/**
 * 按 env 装配；未显式启用时返回 undefined（新端口默认不装配，调用方按未配置处理）。
 */
export const createMarketDumpManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateMarketDumpManagerDeps,
): MarketDumpManagerLike | undefined => {
  if (!marketDumpEnabledFromEnv(env)) return undefined;
  const clock = deps.clock ?? ((): Date => new Date());
  const client =
    deps.fuyaoClient ??
    new FuyaoClient(fuyaoConfigFromEnv(env), {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
  const adapter = new FuyaoMarketDumpAdapter(client);
  const home = env.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
  return new MarketDumpManager({
    stores: deps.stores,
    artifactDir: join(home, 'market-dumps'),
    logger: deps.logger,
    clock,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    fetchTicket: (kind) => adapter.fetchDownloadTicket(kind),
  });
};
