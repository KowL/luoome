import type { AShareSentimentManagerLike, Logger, MarketDataAdapterLike } from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { AShareSentimentManager } from './manager.js';
import type { AShareSentimentCapabilityMap, AShareSentimentRawPool } from './types.js';

/**
 * A 股情绪 manager 装配根。
 *
 * - LUOOME_ASHARE_SENTIMENT_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 封板 / 炸板注册为两个独立 capability（§4.3），manager 池级路由与 fallback
 * - 返回的 manager 同时满足 core `AShareSentimentManagerLike` 接口（structural typing）
 */

export interface CreateAShareSentimentManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly market?: MarketDataAdapterLike;
  /** 组装根共享的供应商实例；注入时不再自构（§4.6）。 */
  readonly sources?: { readonly eastmoney?: EastmoneySource };
}

/** 已注册的情绪数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const AShareSentimentSourcesSchema = z
  .array(z.literal('eastmoney'))
  .min(1, '至少启用一个 A 股情绪数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: 'A 股情绪数据源不能重复' });
    }
  });

const ashareSentimentSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'eastmoney'[] => {
  const configured = env.LUOOME_ASHARE_SENTIMENT_SOURCES?.trim();
  return AShareSentimentSourcesSchema.parse(
    configured === undefined || configured.length === 0
      ? ['eastmoney']
      : configured.split(',').map((value) => value.trim().toLowerCase()),
  );
};

export const createAShareSentimentManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateAShareSentimentManagerDeps,
): AShareSentimentManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = ashareSentimentSourcesFromEnv(env);
  const eastmoney =
    deps.sources?.eastmoney ??
    new EastmoneySource({
      clock,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'eastmoney':
        return eastmoneyBindings(eastmoney);
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<AShareSentimentCapabilityMap>(bindings, clock);

  return new AShareSentimentManager({
    registry,
    clock,
    logger: deps.logger,
    ...(deps.market === undefined ? {} : { market: deps.market }),
  });
};

/**
 * 池观测口径（§6.2）：ok:true → success + observedAt；unsupported_date → ignored
 * （该源明确不支持的历史窗口，继续尝试其它源）；其余 ok:false 按存量词表映射记 failure。
 */
const observationOfPool = (pool: AShareSentimentRawPool) => {
  if (pool.ok) return { outcome: 'success', dataAsOf: pool.observedAt } as const;
  if (pool.errorKind === 'unsupported_date') return { outcome: 'ignored' } as const;
  // 存量映射（§4.4）：network_error / http_error → network；invalid_response → invalid_payload
  const kind = pool.errorKind === 'invalid_response' ? 'invalid_payload' : 'network';
  return { outcome: 'failure', kind } as const;
};

const eastmoneyBindings = (source: EastmoneySource): AnyBinding<AShareSentimentCapabilityMap>[] => [
  {
    capability: 'sentiment-sealed-pool',
    source: 'eastmoney',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: (input) => source.fetchSealedPool(input),
    observationOf: observationOfPool,
  },
  {
    capability: 'sentiment-broken-pool',
    source: 'eastmoney',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: (input) => source.fetchBrokenPool(input),
    observationOf: observationOfPool,
  },
];
