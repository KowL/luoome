import type { LimitUpBoardAdapterLike } from '@luoome/core';
import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoLimitUpAdapter } from '../fuyao/limit-up.js';
import type { ProviderRuntime } from '../plugins/provider-runtime.js';

export interface LimitUpBoardFactoryOptions {
  readonly providerRuntime?: ProviderRuntime;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
}

/** 未配置 FUYAO_API_KEY 时不注入炸板/断板数据源（同步 tool 会显式报未配置）。 */
export const createLimitUpBoardAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: LimitUpBoardFactoryOptions = {},
): LimitUpBoardAdapterLike | undefined => {
  const runtime = options.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap('limit-up', ['fuyao'], () =>
      buildCreateLimitUpBoardAdapterFromEnv(env, {
        ...options,
        fetchImpl: runtime.fetchFor('fuyao', options.fetchImpl),
      }),
    );
  return buildCreateLimitUpBoardAdapterFromEnv(env, options);
};

const buildCreateLimitUpBoardAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: LimitUpBoardFactoryOptions = {},
): LimitUpBoardAdapterLike | undefined => {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const client = new FuyaoClient(fuyaoConfigFromEnv(env), {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return new FuyaoLimitUpAdapter(client, options.clock ?? (() => new Date()));
};
