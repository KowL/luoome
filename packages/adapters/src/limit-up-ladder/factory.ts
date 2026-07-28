import type { LimitUpLadderManagerLike, Logger } from '@luoome/core';
import { z } from 'zod';

import { EastmoneyLimitUpLadderAdapter } from './eastmoney.js';
import { LimitUpLadderManager } from './manager.js';

/**
 * 连板天梯 manager 装配根（docs/ddd/limit-up-ladder-detailed-design.md §5）。
 *
 * 仿 `createMarketAdapterFromEnv`（market/factory.ts）的位置与签名风格。
 * - 当前只支持东方财富公开涨停池，无鉴权
 * - 通过显式数据源配置装配；未知或重复来源在启动时失败
 * - 返回的 manager 同时满足 core `LimitUpLadderManagerLike` 接口（structural typing）
 */

export interface CreateLimitUpLadderManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

export const createLimitUpLadderManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateLimitUpLadderManagerDeps,
): LimitUpLadderManagerLike => {
  const clock = deps.clock ?? (() => new Date());
  const raw = env.LUOOME_LIMIT_UP_LADDER_SOURCES?.trim();
  const [source] = z
    .tuple([z.literal('eastmoney')], {
      error: '连板天梯当前必须且只能启用 eastmoney',
    })
    .parse(
      raw === undefined || raw.length === 0
        ? ['eastmoney']
        : raw.split(',').map((source) => source.trim().toLowerCase()),
    );

  return new LimitUpLadderManager({
    primary: buildLimitUpLadderSource(source, deps.fetchImpl),
    logger: deps.logger,
    clock,
  });
};

const buildLimitUpLadderSource = (
  source: 'eastmoney',
  fetchImpl: typeof fetch | undefined,
): EastmoneyLimitUpLadderAdapter => {
  switch (source) {
    case 'eastmoney':
      return new EastmoneyLimitUpLadderAdapter(fetchImpl);
  }
};
