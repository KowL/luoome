import type { Logger, SectorQuoteManagerLike } from '@luoome/core';
import { z } from 'zod';
import type { ProviderRuntime } from '../plugins/provider-runtime.js';

import { EastmoneySectorQuoteAdapter } from './eastmoney.js';
import { SectorQuoteManager } from './manager.js';
import { SinaSectorQuoteAdapter } from './sina.js';
import type { SectorQuoteAdapterLike } from './types.js';

/**
 * 行业板块行情 manager 装配根。
 *
 * 仿 `createNewsManagerFromEnv`（news/factory.ts）的位置与签名风格。
 * - LUOOME_SECTOR_QUOTE_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；
 *   缺省 eastmoney,sina（东财 push2 不可达时回退免费的新浪行业板块）
 * - 两个源都免费、无需 key，但仍受 plugins.json 的 source.* 开关约束
 * - 返回的 manager 同时满足 core `SectorQuoteManagerLike` 接口（structural typing）
 */

export interface CreateSectorQuoteManagerDeps {
  readonly providerRuntime?: ProviderRuntime;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

/** 已注册的板块行情数据源（封闭启动校验；core 端口侧是同值枚举）。 */
const REGISTERED_SOURCES = ['eastmoney', 'sina'] as const;
type RegisteredSource = (typeof REGISTERED_SOURCES)[number];

const SourcesSchema = z
  .array(z.enum(REGISTERED_SOURCES))
  .min(1, '至少启用一个板块行情数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '板块行情数据源不能重复' });
    }
  });

const sourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly RegisteredSource[] => {
  const raw = env.LUOOME_SECTOR_QUOTE_SOURCES?.trim();
  return SourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney', 'sina']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

const UNAVAILABLE_MESSAGE =
  '板块行情没有可用数据源：已注册东方财富（source.eastmoney）与新浪财经（source.sina）两个免费源，' +
  '请在 plugins.json 中至少启用一个 source.* 开关';

export const createSectorQuoteManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorQuoteManagerDeps,
): SectorQuoteManagerLike => {
  const runtime = deps.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap(
      'sector-quote',
      sourcesFromEnv(env),
      (active) =>
        buildCreateSectorQuoteManagerFromEnv(
          { ...env, LUOOME_SECTOR_QUOTE_SOURCES: active.join(',') },
          { ...deps, fetchImpl: runtime.fetchFor('eastmoney', deps.fetchImpl) },
        ),
      [],
      UNAVAILABLE_MESSAGE,
    );
  return buildCreateSectorQuoteManagerFromEnv(env, deps);
};

const buildCreateSectorQuoteManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateSectorQuoteManagerDeps,
): SectorQuoteManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const adapters = sourcesFromEnv(env).map((source) =>
    buildSectorQuoteSource(source, deps.fetchImpl),
  );

  return new SectorQuoteManager({
    adapters,
    logger: deps.logger,
    clock,
  });
};

const buildSectorQuoteSource = (
  source: RegisteredSource,
  fetchImpl: typeof fetch | undefined,
): SectorQuoteAdapterLike => {
  switch (source) {
    case 'eastmoney':
      return new EastmoneySectorQuoteAdapter(fetchImpl);
    case 'sina':
      return new SinaSectorQuoteAdapter(fetchImpl ?? fetch);
    default:
      throw new Error(`不支持的数据源：${String(source satisfies never)}`);
  }
};
