import type { LimitUpBoardAdapterLike } from '@luoome/core';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoLimitUpAdapter } from '../fuyao/limit-up.js';

export interface LimitUpBoardFactoryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
}

/** 未配置 FUYAO_API_KEY 时不注入炸板/断板数据源（同步 tool 会显式报未配置）。 */
export const createLimitUpBoardAdapterFromEnv = (
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
