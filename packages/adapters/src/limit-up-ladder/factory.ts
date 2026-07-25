import { AdshareClient } from '@luoome/adshare-sdk';
import type { LimitUpLadderManagerLike, Logger } from '@luoome/core';

import { AdshareLimitUpLadderAdapter } from './adshare.js';
import { AmazingdataLimitUpLadderAdapter } from './amazingdata.js';
import { LimitUpLadderManager } from './manager.js';

/**
 * 连板天梯 manager 装配根（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §5）。
 *
 * 仿 `createMarketAdapterFromEnv`（market/factory.ts）的位置与签名风格。
 * - 不引入新环境变量：沿用 adshare-sdk 的 `ADSHARE_URL` / `ADSHARE_API_KEY` / `ADSHARE_TIMEOUT_MS` / `ADSHARE_MAX_RETRIES`
 * - 主源 adshare 写死；fallback 通过 `LUOOME_LIMIT_UP_LADDER_FALLBACK=amazingdata` 显式 opt-in
 *   启用（Phase 1 amazingdata 仅 throw 占位；开了就报错以避免 silent 失败）
 * - 返回的 manager 同时满足 core `LimitUpLadderManagerLike` 接口（structural typing）
 */

export interface CreateLimitUpLadderManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createLimitUpLadderManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpLadderManagerDeps,
): LimitUpLadderManagerLike => {
  // 主源：adshare-sdk fromEnv() 不接受 fetchImpl 注入；测试场景需走构造器
  const config = {
    url: env.ADSHARE_URL ?? '',
    apiKey: env.ADSHARE_API_KEY ?? '',
    timeoutMs: Number(env.ADSHARE_TIMEOUT_MS ?? 10_000),
    retries: Number(env.ADSHARE_MAX_RETRIES ?? 2),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  if (config.url.length === 0) {
    throw new Error('ADSHARE_URL 未配置（limit-up-ladder 需要 adshare 主源）');
  }
  const adshareClient = new AdshareClient(config);

  const primaryAdapter = new AdshareLimitUpLadderAdapter(adshareClient, deps.fetchImpl);

  let fallback: ConstructorParameters<typeof LimitUpLadderManager>[0]['fallback'];
  if (env.LUOOME_LIMIT_UP_LADDER_FALLBACK === 'amazingdata') {
    fallback = new AmazingdataLimitUpLadderAdapter() as unknown as ConstructorParameters<
      typeof LimitUpLadderManager
    >[0]['fallback'];
  }

  const clock = deps.clock ?? (() => new Date());

  return new LimitUpLadderManager({
    primary: primaryAdapter as unknown as ConstructorParameters<
      typeof LimitUpLadderManager
    >[0]['primary'],
    ...(fallback !== undefined ? { fallback } : {}),
    logger: deps.logger,
    clock,
  });
};
