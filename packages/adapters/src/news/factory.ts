import type { Logger, NewsManagerLike } from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { NewsManager } from './manager.js';
import type { NewsCapabilityMap } from './types.js';

/**
 * 财经要闻 manager 装配根。
 *
 * 仿 `createDragonTigerManagerFromEnv`（dragon-tiger/factory.ts）的位置与签名风格。
 * - LUOOME_NEWS_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - 返回的 manager 同时满足 core `NewsManagerLike` 接口（structural typing）
 */

export interface CreateNewsManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 组装根共享的供应商实例；注入时不再自构（§4.6）。 */
  readonly sources?: { readonly eastmoney?: EastmoneySource };
}

/** 已注册的财经要闻数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const NewsSourcesSchema = z
  .array(z.literal('eastmoney'))
  .min(1, '至少启用一个财经要闻数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '财经要闻数据源不能重复' });
    }
  });

const newsSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'eastmoney'[] => {
  const raw = env.LUOOME_NEWS_SOURCES?.trim();
  return NewsSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createNewsManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateNewsManagerDeps,
): NewsManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = newsSourcesFromEnv(env);
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
  const registry = new SourceRegistry<NewsCapabilityMap>(bindings, clock);

  return new NewsManager({
    registry,
    logger: deps.logger,
    clock,
  });
};

/**
 * dataAsOf = 返回 items 中最大的 published_at；空列表 success 但无 dataAsOf
 * （freshness 为 unknown，§6.2）。
 */
const eastmoneyBindings = (source: EastmoneySource): AnyBinding<NewsCapabilityMap>[] => [
  {
    capability: 'finance-news',
    source: 'eastmoney',
    coverage: ['CN_FINANCE_NEWS'],
    configurationReady: true,
    execute: ({ pageSize }) => source.fetchNews(pageSize),
    observationOf: (result) => {
      let latest: Date | undefined;
      for (const item of result.items) {
        const publishedAt = new Date(item.published_at);
        if (Number.isNaN(publishedAt.getTime())) continue;
        if (latest === undefined || publishedAt > latest) latest = publishedAt;
      }
      return latest === undefined
        ? { outcome: 'success' }
        : { outcome: 'success', dataAsOf: latest };
    },
  },
];
