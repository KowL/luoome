import type { AShareSentimentManagerLike, Logger, MarketDataAdapterLike } from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { FuyaoAShareSentimentSource } from './fuyao.js';
import { AShareSentimentManager } from './manager.js';
import type { AShareSentimentCapabilityMap, AShareSentimentRawPool } from './types.js';

/**
 * A 股情绪 manager 装配根。
 *
 * - LUOOME_ASHARE_SENTIMENT_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 封板 / 炸板注册为两个独立 capability（§4.3），manager 池级路由与 fallback
 * - fuyao 显式排入路由时要求 FUYAO_API_KEY 完整（§4.3），缺省启动期快速失败
 * - 返回的 manager 同时满足 core `AShareSentimentManagerLike` 接口（structural typing）
 */

export interface CreateAShareSentimentManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly market?: MarketDataAdapterLike;
  /**
   * 组装根共享的供应商实例；注入时不再自构（§4.6）。
   * fuyao 是进程级共享 FuyaoClient（设计 §4.1：所有 Fuyao REST 请求共享同一协调器）。
   */
  readonly sources?: {
    readonly eastmoney?: EastmoneySource;
    readonly fuyao?: FuyaoClient;
  };
}

/** 已注册的情绪数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const AShareSentimentSourcesSchema = z
  .array(z.enum(['eastmoney', 'fuyao']))
  .min(1, '至少启用一个 A 股情绪数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: 'A 股情绪数据源不能重复' });
    }
  });

const ashareSentimentSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly ('eastmoney' | 'fuyao')[] => {
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
      case 'fuyao':
        return fuyaoBindings(buildFuyao(env, deps, clock));
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
 * fuyao 显式排入路由时要求配置完整（§4.3）：缺 FUYAO_API_KEY 启动期快速失败。
 * 优先复用组装根共享的 FuyaoClient；未注入时按 env 自构（测试便利）。
 */
const buildFuyao = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateAShareSentimentManagerDeps,
  clock: () => Date,
): FuyaoAShareSentimentSource => {
  if (deps.sources?.fuyao !== undefined) {
    return new FuyaoAShareSentimentSource({ client: deps.sources.fuyao, clock });
  }
  const apiKey = env.FUYAO_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('fuyao 已启用，但 FUYAO_API_KEY 未配置');
  }
  const config = fuyaoConfigFromEnv(env);
  return new FuyaoAShareSentimentSource({
    client: new FuyaoClient(
      config,
      deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
    ),
    clock,
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

/**
 * fuyao 绑定（§7.1）：封板 / 炸板两个独立 capability，池级路由与 fallback。
 * 权限错误（2003 → permission）只将当前 (source, capability) 标为不可用（§4.3），
 * 不影响另一池或其它已授权 Fuyao 能力。
 */
const fuyaoBindings = (
  source: FuyaoAShareSentimentSource,
): AnyBinding<AShareSentimentCapabilityMap>[] => [
  {
    capability: 'sentiment-sealed-pool',
    source: 'fuyao',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: (input) => source.fetchSealedPool(input),
    observationOf: observationOfPool,
  },
  {
    capability: 'sentiment-broken-pool',
    source: 'fuyao',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: (input) => source.fetchBrokenPool(input),
    observationOf: observationOfPool,
  },
];
