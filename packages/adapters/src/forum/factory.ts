import type { ForumManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';

import { EastmoneySource } from '../eastmoney/source.js';
import type { ProviderGuard, ProviderRuntime } from '../plugins/provider-runtime.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { ForumManager } from './manager.js';
import type { ForumCapabilityMap } from './types.js';

/**
 * 股吧讨论 manager 装配根（仿 news/factory.ts）。
 *
 * - `LUOOME_FORUM_SOURCES`：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 * - 三个 capability 都绑定到同一个 EastmoneySource 实例（仓库单一 source 约束）
 */

export interface CreateForumManagerDeps {
  readonly providerRuntime?: ProviderRuntime;
  readonly guard?: ProviderGuard;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly sources?: { readonly eastmoney?: EastmoneySource };
}

const ForumSourcesSchema = z
  .array(z.enum(['eastmoney']))
  .min(1, '至少启用一个股吧数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '股吧数据源不能重复' });
    }
  });

const forumSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'eastmoney'[] => {
  const raw = env.LUOOME_FORUM_SOURCES?.trim();
  return ForumSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export const createForumManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateForumManagerDeps,
): ForumManagerLike => {
  const runtime = deps.providerRuntime;
  if (runtime !== undefined) {
    return runtime.wrap('forum', forumSourcesFromEnv(env), (active, guard) =>
      buildForumManager(
        { ...env, LUOOME_FORUM_SOURCES: active.join(',') },
        { ...deps, guard, fetchImpl: runtime.fetchFor('eastmoney', deps.fetchImpl) },
      ),
    );
  }
  return buildForumManager(env, deps);
};

const buildForumManager = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateForumManagerDeps,
): ForumManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = forumSourcesFromEnv(env);
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
        throw new Error(`不支持的股吧数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<ForumCapabilityMap>(bindings, clock, deps.guard);
  return new ForumManager({ registry, logger: deps.logger });
};

const eastmoneyBindings = (source: EastmoneySource): AnyBinding<ForumCapabilityMap>[] => [
  {
    capability: 'forum-posts',
    source: 'eastmoney',
    coverage: ['CN_A_SHARE_GB'],
    configurationReady: true,
    execute: ({ code, pages }) => source.fetchForumPosts({ code, pages }),
    observationOf: (result) => ({
      outcome: 'success',
      dataAsOf: result.fetchedAt,
    }),
  },
  {
    capability: 'forum-popularity',
    source: 'eastmoney',
    coverage: ['CN_A_SHARE_GB'],
    configurationReady: true,
    execute: ({ code }) => source.fetchForumPopularity(code),
    observationOf: (result) => ({
      outcome: 'success',
      dataAsOf: result.calcTime ?? result.fetchedAt,
    }),
  },
  {
    capability: 'forum-hot-list',
    source: 'eastmoney',
    coverage: ['CN_A_SHARE_GB'],
    configurationReady: true,
    execute: ({ limit }) => source.fetchForumHotList(limit),
    observationOf: (result) =>
      result.rows.length === 0
        ? { outcome: 'failure', kind: 'invalid_payload' as const }
        : // 榜单接口不返回计算时间；dataAsOf 只能退回本次采集时刻，避免冒充更早快照。
          { outcome: 'success' as const, dataAsOf: result.fetchedAt },
  },
];
