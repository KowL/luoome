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
    // 软失败 manager：不抛错崩 surface 启动，所有调用直接返回 adapter_error。
    // 这样 web / CLI / TUI 启动时即使没配 adshare 也能正常起来；调用方会得到「upstream-unavailable」。
    deps.logger.warn('limit-up-ladder: ADSHARE_URL 未配置，所有调用将返回 adapter_error', {
      envKeys: 'ADSHARE_URL',
    });
    return createUnavailableManager();
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

/**
 * 软失败 manager：所有 fetchLadder / compareLadder 调用直接返回 adapter_error，
 * 不发起任何网络请求。供 ADSHARE_URL 未配置或链路上游不可达时使用。
 */
const createUnavailableManager = (): LimitUpLadderManagerLike => {
  const errResult = () => ({
    ok: false as const,
    error: {
      kind: 'adapter_error' as const,
      adapter: 'limit-up-ladder' as const,
      message: 'upstream-unavailable: ADSHARE_URL 未配置',
      recoverable: true,
    },
  });
  return {
    name: 'limit-up-ladder',
    fetchLadder: async () => errResult(),
    compareLadder: async () => ({
      ok: false as const,
      error: {
        kind: 'adapter_error',
        adapter: 'limit-up-ladder',
        message: 'upstream-unavailable: ADSHARE_URL 未配置',
        recoverable: true,
      },
    }),
  };
};
