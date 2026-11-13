import type { LimitUpMarketManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoLimitUpMarketSource } from '../fuyao/limit-up-market.js';
import { LimitUpMarketManager } from './manager.js';

/**
 * 涨停市场看板 manager 装配根。
 *
 * 仿 `createLimitUpBoardAdapterFromEnv`（limit-up/factory.ts）：
 * - 未配置 FUYAO_API_KEY 时不注入（tool 显式报未配置，页面显示不可用而不是空看板）
 * - `LUOOME_LIMIT_UP_MARKET_SOURCES` 目前只接受 fuyao（涨停池 + 统计 + 30 日天梯同一上游）
 */

export interface CreateLimitUpMarketManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的 fuyao client；注入时不再自构。 */
  readonly fuyao?: FuyaoClient;
  readonly cacheTtlMs?: number;
}

const SourcesSchema = z.tuple([z.literal('fuyao')], {
  error: '涨停市场看板当前必须且只能启用 fuyao',
});

export const createLimitUpMarketManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpMarketManagerDeps,
): LimitUpMarketManagerLike | undefined => {
  const raw = env.LUOOME_LIMIT_UP_MARKET_SOURCES?.trim();
  SourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['fuyao']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );

  const clock = deps.clock ?? (() => new Date());
  const client = deps.fuyao ?? buildClient(env, deps.fetchImpl);
  if (client === undefined) return undefined;

  return new LimitUpMarketManager({
    primary: new FuyaoLimitUpMarketSource(client),
    logger: deps.logger,
    clock,
    ...(deps.cacheTtlMs === undefined ? {} : { cacheTtlMs: deps.cacheTtlMs }),
  });
};

function buildClient(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
): FuyaoClient | undefined {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return new FuyaoClient(fuyaoConfigFromEnv(env), {
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}
