import type { Logger, StockUniverseManagerLike, StockUniverseSourceLike } from '@luoome/core';
import { z } from 'zod';

import { tushareConfigFromEnv } from '../tushare/client.js';
import { EastmoneyStockUniverseAdapter } from './eastmoney.js';
import { StockUniverseManager } from './manager.js';
import { TushareStockUniverseAdapter } from './tushare.js';

export const StockUniverseSourceIdSchema = z.enum(['eastmoney', 'tushare']);
export type StockUniverseSourceId = z.infer<typeof StockUniverseSourceIdSchema>;

const StockUniverseSourceOrderSchema = z
  .array(StockUniverseSourceIdSchema)
  .min(1, '至少启用一个股票目录数据源')
  .max(2)
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
      ? ['eastmoney']
      : raw.split(',').map((source) => source.trim().toLowerCase()),
  );
};

export interface CreateStockUniverseManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly sourceOrder?: readonly StockUniverseSourceId[];
}

export const createStockUniverseManagerFromEnv = (
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
    switch (source) {
      case 'eastmoney':
        return new EastmoneyStockUniverseAdapter(common);
      case 'tushare':
        return new TushareStockUniverseAdapter({
          ...common,
          config: tushareConfigFromEnv(env),
        });
      default:
        throw new Error(`不支持的股票目录数据源：${String(source satisfies never)}`);
    }
  });
  return new StockUniverseManager({ sources, logger: deps.logger });
};
