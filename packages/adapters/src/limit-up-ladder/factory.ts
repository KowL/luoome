import type { LimitUpLadderManagerLike, Logger } from '@luoome/core';

import { EastmoneyLimitUpLadderAdapter } from './eastmoney.js';
import { LimitUpLadderManager } from './manager.js';

/**
 * 连板天梯 manager 装配根（docs/ddd/limit-up-ladder-detailed-design.md §5）。
 *
 * 仿 `createMarketAdapterFromEnv`（market/factory.ts）的位置与签名风格。
 * - 主源为东方财富公开涨停池，无鉴权、不读环境变量（env 参数仅为对齐签名保留）
 * - 数据源单源写死（不接 fallback；上游不可达时返回 adapter_error）
 * - 返回的 manager 同时满足 core `LimitUpLadderManagerLike` 接口（structural typing）
 */

export interface CreateLimitUpLadderManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createLimitUpLadderManagerFromEnv = (
  _env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpLadderManagerDeps,
): LimitUpLadderManagerLike => {
  const clock = deps.clock ?? (() => new Date());

  return new LimitUpLadderManager({
    primary: new EastmoneyLimitUpLadderAdapter(deps.fetchImpl),
    logger: deps.logger,
    clock,
  });
};
