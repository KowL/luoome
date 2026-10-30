import type { Logger, StockProfileManagerLike } from '@luoome/core';
import { z } from 'zod';

import { getJson } from '../eastmoney/client.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import {
  parseStockProfileBoards,
  parseStockProfileHolder,
  stockProfileBoardUrl,
  stockProfileHolderUrl,
} from './eastmoney.js';
import { StockProfileManager } from './manager.js';
import type { StockProfileCapabilityMap } from './types.js';

/**
 * 个股档案 manager 装配根。
 *
 * 仿 `createDragonTigerManagerFromEnv`（dragon-tiger/factory.ts）的位置与签名风格：
 * - LUOOME_STOCK_PROFILE_SOURCES：逗号分隔、有序、去重；未知源启动期抛错；缺省 eastmoney
 *   （docs/ddd/source-pluggability-and-observation-design.md §4.6）
 * - 返回的 manager 同时满足 core `StockProfileManagerLike` 接口（structural typing）
 */

export interface CreateStockProfileManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** 上游请求超时（毫秒）。 */
  readonly timeoutMs?: number;
}

/** 已注册的个股档案数据源（封闭启动校验；core 端口侧是开放 SourceIdSchema）。 */
const StockProfileSourcesSchema = z
  .array(z.literal('eastmoney'))
  .min(1, '至少启用一个个股档案数据源')
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '个股档案数据源不能重复' });
    }
  });

const stockProfileSourcesFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): readonly 'eastmoney'[] => {
  const raw = env.LUOOME_STOCK_PROFILE_SOURCES?.trim();
  return StockProfileSourcesSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

const DEFAULT_TIMEOUT_MS = 15_000;

export const createStockProfileManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateStockProfileManagerDeps,
): StockProfileManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const order = stockProfileSourcesFromEnv(env);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const bindings = order.flatMap((source) => {
    switch (source) {
      case 'eastmoney':
        return eastmoneyBindings({
          timeoutMs,
          clock,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
      default:
        throw new Error(`不支持的数据源：${String(source satisfies never)}`);
    }
  });
  const registry = new SourceRegistry<StockProfileCapabilityMap>(bindings, clock);

  return new StockProfileManager({ registry, logger: deps.logger, clock });
};

/**
 * 股东户数与所属板块分两次请求：两者互不依赖，板块为空仍返回股东户数。
 * 统计截止日保留在 holders.endDate；抓取时间不冒充上游事实时间。
 */
const eastmoneyBindings = (options: {
  readonly timeoutMs: number;
  readonly clock: () => Date;
  readonly fetchImpl?: typeof fetch;
}): AnyBinding<StockProfileCapabilityMap>[] => [
  {
    capability: 'stock-profile',
    source: 'eastmoney',
    coverage: ['CN_A_SHARES_SH_SZ'],
    configurationReady: true,
    execute: async ({ stockId }) => {
      const [holderRaw, boardRaw] = await Promise.all([
        getJson(stockProfileHolderUrl(stockId), options),
        getJson(stockProfileBoardUrl(stockId), options),
      ]);
      const holder = parseStockProfileHolder(holderRaw, stockId);
      const boards = parseStockProfileBoards(boardRaw, stockId);
      return {
        observedAt: options.clock(),
        holders: holder === null ? [] : [holder],
        concepts: boards,
      };
    },
    observationOf: () => ({ outcome: 'success' }),
  },
];
