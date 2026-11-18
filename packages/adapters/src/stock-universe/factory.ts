import type { Logger, StockUniverseManagerLike, StockUniverseSourceLike } from '@luoome/core';
import { z } from 'zod';
import type { ProviderGuard, ProviderRuntime } from '../plugins/provider-runtime.js';

import { tushareConfigFromEnv } from '../tushare/client.js';
import { EastmoneyStockUniverseAdapter } from './eastmoney.js';
import { StockUniverseManager } from './manager.js';
import { SinaStockUniverseAdapter } from './sina.js';
import { TushareStockUniverseAdapter } from './tushare.js';

export const StockUniverseSourceIdSchema = z.enum(['eastmoney', 'sina', 'tushare']);
export type StockUniverseSourceId = z.infer<typeof StockUniverseSourceIdSchema>;

const StockUniverseSourceOrderSchema = z
  .array(StockUniverseSourceIdSchema)
  .min(1, '至少启用一个股票目录数据源')
  .max(3)
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '股票目录数据源不能重复' });
    }
  });

export const stockUniverseSourceOrderFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): StockUniverseSourceId[] => {
  const raw = env.LUOOME_STOCK_UNIVERSE_SOURCES?.trim();
  return StockUniverseSourceOrderSchema.parse(
    raw === undefined || raw.length === 0
      ? ['eastmoney', 'sina']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export interface CreateStockUniverseManagerDeps {
  readonly providerRuntime?: ProviderRuntime;
  readonly guard?: ProviderGuard;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly sourceOrder?: readonly StockUniverseSourceId[];
}

export const createStockUniverseManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateStockUniverseManagerDeps,
): StockUniverseManagerLike => {
  const runtime = deps.providerRuntime;
  if (runtime !== undefined)
    return runtime.wrap(
      'stock-universe',
      deps.sourceOrder ?? stockUniverseSourceOrderFromEnv(env),
      (active, guard) => {
        const ready = active.filter(
          (source) => source !== 'tushare' || Boolean(env.TUSHARE_TOKEN?.trim()),
        );
        if (ready.length === 0) return undefined;
        return buildCreateStockUniverseManagerFromEnv(
          { ...env, LUOOME_STOCK_UNIVERSE_SOURCES: ready.join(',') },
          {
            ...deps,
            guard,
            sourceOrder: ready,
          },
        );
      },
    );
  return buildCreateStockUniverseManagerFromEnv(env, deps);
};

const buildCreateStockUniverseManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateStockUniverseManagerDeps,
): StockUniverseManagerLike => {
  const order =
    deps.sourceOrder === undefined
      ? stockUniverseSourceOrderFromEnv(env)
      : StockUniverseSourceOrderSchema.parse(deps.sourceOrder);
  const common = {
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
  const sources: StockUniverseSourceLike[] = order.map((source) => {
    const options = {
      ...common,
      // 目录同步是整批翻页（sina 按 100 条/页约 55 个请求），走批量配额档。
      ...(deps.providerRuntime === undefined
        ? {}
        : {
            fetchImpl: deps.providerRuntime.fetchFor(source, deps.fetchImpl, { bulk: true }),
          }),
    };
    switch (source) {
      case 'eastmoney':
        return new EastmoneyStockUniverseAdapter(options);
      case 'sina':
        return new SinaStockUniverseAdapter(options);
      case 'tushare':
        return new TushareStockUniverseAdapter({
          ...options,
          config: tushareConfigFromEnv(env),
        });
      default:
        throw new Error(`不支持的股票目录数据源：${String(source satisfies never)}`);
    }
  });
  return new StockUniverseManager({ sources, logger: deps.logger });
};
