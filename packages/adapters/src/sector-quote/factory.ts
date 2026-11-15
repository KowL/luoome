import type { Logger, SectorQuoteManagerLike } from '@luoome/core';
import { z } from 'zod';
import type { ProviderRuntime } from '../plugins/provider-runtime.js';

import { EastmoneySectorQuoteAdapter } from './eastmoney.js';
import { SectorQuoteManager } from './manager.js';

/**
 * 行业板块行情 manager 装配根。
 *
 * 仿 `createNewsManagerFromEnv`（news/factory.ts）的位置与签名风格。
 * - 当前只支持东方财富板块公开 API，无鉴权
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - 返回的 manager 同时满足 core `SectorQuoteManagerLike` 接口（structural typing）
 */

export interface CreateSectorQuoteManagerDeps {
  readonly providerRuntime?: ProviderRuntime;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createSectorQuoteManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorQuoteManagerDeps,
): SectorQuoteManagerLike => {
  const runtime = deps.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap('sector-quote', ['eastmoney'], () =>
      buildCreateSectorQuoteManagerFromEnv(env, {
        ...deps,
        fetchImpl: runtime.fetchFor('eastmoney', deps.fetchImpl),
      }),
    );
  return buildCreateSectorQuoteManagerFromEnv(env, deps);
};

const buildCreateSectorQuoteManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorQuoteManagerDeps,
): SectorQuoteManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const raw = env.LUOOME_SECTOR_QUOTE_SOURCES?.trim();
  const [source] = z
    .tuple([z.literal('eastmoney')], {
      error: '行业板块行情当前必须且只能启用 eastmoney',
    })
    .parse(
      raw === undefined || raw.length === 0
        ? ['eastmoney']
        : raw.split(',').map((source) => source.trim().toLowerCase()),
    );

  return new SectorQuoteManager({
    primary: buildSectorQuoteSource(source, deps.fetchImpl),
    logger: deps.logger,
    clock,
  });
};

const buildSectorQuoteSource = (
  source: 'eastmoney',
  fetchImpl: typeof fetch | undefined,
): EastmoneySectorQuoteAdapter => {
  switch (source) {
    case 'eastmoney':
      return new EastmoneySectorQuoteAdapter(fetchImpl);
  }
};
