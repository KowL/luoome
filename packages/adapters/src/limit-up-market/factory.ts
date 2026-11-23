import type { LimitUpMarketManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';
import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { FuyaoLimitUpMarketSource } from '../fuyao/limit-up-market.js';
import type { ProviderRuntime } from '../plugins/provider-runtime.js';
import { LimitUpMarketManager, type LimitUpMarketPrimarySource } from './manager.js';

/**
 * 涨停市场看板 manager 装配根。
 *
 * 仿 `createLimitUpBoardAdapterFromEnv`（limit-up/factory.ts）：
 * - `LUOOME_LIMIT_UP_MARKET_SOURCES` 按顺序回退，当前只注册 fuyao（涨停池 + 统计 + 30 日天梯
 *   同一上游，付费且需要 FUYAO_API_KEY）；未注册的免费源不能在这里静默冒充
 * - 未配置 FUYAO_API_KEY 时不注入（tool 显式报真实原因，页面显示不可用而不是空看板）
 */

export interface CreateLimitUpMarketManagerDeps {
  readonly providerRuntime?: ProviderRuntime;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的 fuyao client；注入时不再自构。 */
  readonly fuyao?: FuyaoClient;
  readonly cacheTtlMs?: number;
}

const REGISTERED_SOURCES = ['fuyao'] as const;
type RegisteredSource = (typeof REGISTERED_SOURCES)[number];

const SourcesSchema = z
  .array(z.enum(REGISTERED_SOURCES))
  .min(1, '至少启用一个涨停市场数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '涨停市场数据源不能重复' });
    }
  });

const sourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly RegisteredSource[] => {
  const raw = env.LUOOME_LIMIT_UP_MARKET_SOURCES?.trim();
  return SourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['fuyao']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

const UNAVAILABLE_MESSAGE =
  '涨停市场看板没有可用数据源：已注册来源只有付费的 fuyao（需要 FUYAO_API_KEY，且 source.fuyao 已启用）；' +
  '免费替代是东方财富连板天梯（limit_up_ladder tool），可查看当日涨停池与连板梯队，但没有封板率统计与 30 日矩阵';

export const createLimitUpMarketManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpMarketManagerDeps,
): LimitUpMarketManagerLike | undefined => {
  const runtime = deps.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap(
      'limit-up-market',
      sourcesFromEnv(env),
      (active) =>
        buildCreateLimitUpMarketManagerFromEnv(
          { ...env, LUOOME_LIMIT_UP_MARKET_SOURCES: active.join(',') },
          { ...deps, fetchImpl: runtime.fetchFor('fuyao', deps.fetchImpl) },
        ),
      [],
      UNAVAILABLE_MESSAGE,
    );
  return buildCreateLimitUpMarketManagerFromEnv(env, deps);
};

const buildCreateLimitUpMarketManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpMarketManagerDeps,
): LimitUpMarketManagerLike | undefined => {
  const clock = deps.clock ?? (() => new Date());
  const client = deps.fuyao ?? buildClient(env, deps.fetchImpl);
  const primaries = sourcesFromEnv(env).flatMap((source): LimitUpMarketPrimarySource[] => {
    switch (source) {
      case 'fuyao':
        return client === undefined ? [] : [new FuyaoLimitUpMarketSource(client)];
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  if (primaries.length === 0) return undefined;

  return new LimitUpMarketManager({
    primaries,
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
