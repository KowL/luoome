import type { Logger, SectorQuoteManagerLike } from '@luoome/core';
import { z } from 'zod';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { EastmoneySectorQuoteAdapter } from './eastmoney.js';
import { FuyaoSectorQuoteAdapter } from './fuyao.js';
import { SectorQuoteManager } from './manager.js';
import type { SectorQuoteCapabilityMap } from './types.js';

/**
 * 行业板块行情 manager 装配根（fuyao-data-expansion §10.1：SourceRegistry 化）。
 *
 * 仿 `createNewsManagerFromEnv`（news/factory.ts）的位置与签名风格。
 * - LUOOME_SECTOR_QUOTE_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 * - 显式启用 fuyao 时要求 FUYAO_API_KEY 齐全，缺即启动期失败（§4.3）
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - 返回的 manager 同时满足 core `SectorQuoteManagerLike` 接口（structural typing）
 */

export interface CreateSectorQuoteManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的供应商实例；注入时不再自构（§4.6）。 */
  readonly sources?: {
    readonly eastmoney?: EastmoneySectorQuoteAdapter;
    readonly fuyao?: FuyaoSectorQuoteAdapter;
  };
  /**
   * 组装根共享的 FuyaoClient（设计 §4.1：进程级共享协调器）；
   * 注入时 fuyao 分支用它构造 FuyaoSectorQuoteAdapter，不再自构客户端。
   */
  readonly fuyaoClient?: FuyaoClient;
}

/** 已注册的板块行情数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const SectorQuoteSourcesSchema = z
  .array(z.enum(['eastmoney', 'fuyao']))
  .min(1, '至少启用一个板块行情数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '板块行情数据源不能重复' });
    }
  });

const sectorQuoteSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly ('eastmoney' | 'fuyao')[] => {
  const raw = env.LUOOME_SECTOR_QUOTE_SOURCES?.trim();
  return SectorQuoteSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createSectorQuoteManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorQuoteManagerDeps,
): SectorQuoteManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = sectorQuoteSourcesFromEnv(env);

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'eastmoney':
        return eastmoneyBindings(
          deps.sources?.eastmoney ?? new EastmoneySectorQuoteAdapter(deps.fetchImpl),
        );
      case 'fuyao':
        return fuyaoBindings(
          deps.sources?.fuyao ?? buildFuyaoSectorQuote(env, deps.fetchImpl, deps.fuyaoClient),
        );
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<SectorQuoteCapabilityMap>(bindings, clock);

  return new SectorQuoteManager({
    registry,
    logger: deps.logger,
    clock,
  });
};

/** fuyao 被显式排入路由时要求配置完整，避免 UI 显示已启用但运行时静默跳过（§4.3）。 */
const buildFuyaoSectorQuote = (
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch | undefined,
  sharedClient?: FuyaoClient,
): FuyaoSectorQuoteAdapter => {
  const client =
    sharedClient ??
    new FuyaoClient(fuyaoConfigFromEnv(env), {
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  return new FuyaoSectorQuoteAdapter(client);
};

/**
 * dataAsOf = undefined：板块行情只有 retrieval 语义（fuyao 采样时刻 / eastmoney 抓取时间），
 * 不把快照时间升级为盘中 observedAt；freshness 由 dataAsOf 缺省推导为 unknown（§6.2）。
 */
const observationOfSectorQuote = () => ({ outcome: 'success' }) as const;

const eastmoneyBindings = (
  adapter: EastmoneySectorQuoteAdapter,
): AnyBinding<SectorQuoteCapabilityMap>[] => [
  {
    capability: 'sector-quote',
    source: 'eastmoney',
    coverage: ['CN_SECTOR_QUOTE'],
    configurationReady: true,
    execute: ({ pageSize, fid }) => adapter.fetchList(pageSize, fid),
    observationOf: observationOfSectorQuote,
  },
];

const fuyaoBindings = (
  adapter: FuyaoSectorQuoteAdapter,
): AnyBinding<SectorQuoteCapabilityMap>[] => [
  {
    capability: 'sector-quote',
    source: 'fuyao',
    coverage: ['CN_SECTOR_QUOTE'],
    configurationReady: true,
    execute: ({ pageSize, fid }) => adapter.fetchList(pageSize, fid),
    observationOf: observationOfSectorQuote,
  },
];
