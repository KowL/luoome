import { homedir } from 'node:os';
import { join } from 'node:path';
import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoMarketDumpAdapter } from '../fuyao/market-dump.js';
import type { ProviderRuntime } from '../plugins/provider-runtime.js';

export interface MarketDumpFactoryOptions {
  readonly providerRuntime?: ProviderRuntime;
  readonly beforePublish?: () => void;
  /** 默认 $LUOOME_HOME 或 ~/.luoome；dump 落在 <home>/market-dumps。 */
  readonly home?: string;
  readonly fetchImpl?: typeof fetch;
}

/** 未配置 FUYAO_API_KEY 时不注入 dump 适配器（工具会显式报未配置）。 */
export const createMarketDumpAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: MarketDumpFactoryOptions = {},
): FuyaoMarketDumpAdapter | undefined => {
  const runtime = options.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap('market-dump', ['fuyao'], (_active, guard) =>
      buildCreateMarketDumpAdapterFromEnv(env, {
        ...options,
        beforePublish: () => guard.check(),
        fetchImpl: runtime.fetchFor('fuyao', options.fetchImpl),
      }),
    );
  return buildCreateMarketDumpAdapterFromEnv(env, options);
};

const buildCreateMarketDumpAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: MarketDumpFactoryOptions = {},
): FuyaoMarketDumpAdapter | undefined => {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const home = options.home ?? (env.LUOOME_HOME?.trim() || join(homedir(), '.luoome'));
  const client = new FuyaoClient(fuyaoConfigFromEnv(env), {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return new FuyaoMarketDumpAdapter(client, {
    dir: join(home, 'market-dumps'),
    ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
};
