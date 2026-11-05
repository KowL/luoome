import type { Logger, SectorMembershipManagerLike } from '@luoome/core';
import { z } from 'zod';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { FuyaoSectorMembershipAdapter } from './fuyao.js';
import { SectorMembershipManager } from './manager.js';
import type { SectorMembershipCapabilityMap } from './types.js';

/**
 * 个股板块关系 manager 装配根（fuyao-data-expansion §10.2）。
 *
 * 仿 `createNewsManagerFromEnv`（news/factory.ts）的位置与签名风格。
 * - LUOOME_SECTOR_MEMBERSHIP_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；
 *   **缺省不装配**（新端口默认关闭，显式写 fuyao 才启用，§13.1）
 * - 显式启用 fuyao 时要求 FUYAO_API_KEY 齐全，缺即启动期失败（§4.3）
 * - 返回的 manager 同时满足 core `SectorMembershipManagerLike` 接口（structural typing）
 */

export interface CreateSectorMembershipManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的供应商实例；注入时不再自构（§4.6）。 */
  readonly sources?: { readonly fuyao?: FuyaoSectorMembershipAdapter };
  /**
   * 组装根共享的 FuyaoClient（设计 §4.1：进程级共享协调器）；
   * 注入时 fuyao 分支用它构造 FuyaoSectorMembershipAdapter，不再自构客户端。
   */
  readonly fuyaoClient?: FuyaoClient;
}

/** 已注册的板块关系数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const SectorMembershipSourcesSchema = z
  .array(z.enum(['fuyao']))
  .min(1, '至少启用一个板块关系数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '板块关系数据源不能重复' });
    }
  });

const sectorMembershipSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'fuyao'[] | undefined => {
  const raw = env.LUOOME_SECTOR_MEMBERSHIP_SOURCES?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  return SectorMembershipSourcesSchema.parse(
    raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

/**
 * 按 env 装配；未显式启用时返回 undefined（新端口默认不装配，调用方按未配置处理）。
 */
export const createSectorMembershipManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorMembershipManagerDeps,
): SectorMembershipManagerLike | undefined => {
  const order = sectorMembershipSourcesFromEnv(env);
  if (order === undefined) return undefined;
  const clock = deps.clock ?? (() => new Date());

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'fuyao': {
        const adapter =
          deps.sources?.fuyao ?? buildFuyaoSectorMembership(env, deps.fetchImpl, deps.fuyaoClient);
        return fuyaoBindings(adapter);
      }
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<SectorMembershipCapabilityMap>(bindings, clock);

  return new SectorMembershipManager({
    registry,
    logger: deps.logger,
    clock,
  });
};

/** fuyao 被显式排入路由时要求配置完整，避免 UI 显示已启用但运行时静默跳过（§4.3）。 */
const buildFuyaoSectorMembership = (
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
  sharedClient?: FuyaoClient,
): FuyaoSectorMembershipAdapter => {
  const client =
    sharedClient ??
    new FuyaoClient(fuyaoConfigFromEnv(env), {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  return new FuyaoSectorMembershipAdapter(client);
};

const fuyaoBindings = (
  adapter: FuyaoSectorMembershipAdapter,
): AnyBinding<SectorMembershipCapabilityMap>[] => [
  {
    capability: 'sector-membership',
    source: 'fuyao',
    coverage: ['CN_SECTOR_MEMBERSHIP'],
    configurationReady: true,
    execute: ({ stockIds, type }) =>
      adapter.fetchMemberships(stockIds, ...(type === undefined ? [] : [type])),
    // 反查响应无数据时间（无 timestamp 字段）；fetchedAt 是本地获取时间，不作为 dataAsOf。
    observationOf: () => ({ outcome: 'success' }),
  },
  {
    capability: 'sector-catalog',
    source: 'fuyao',
    coverage: ['CN_SECTOR_MEMBERSHIP'],
    configurationReady: true,
    execute: () => adapter.fetchCatalog(),
    observationOf: () => ({ outcome: 'success' }),
  },
];
