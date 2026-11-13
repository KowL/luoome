import type { DragonTigerFlowManagerLike, Logger } from '@luoome/core';

import { FuyaoClient, fuyaoConfigFromEnv } from '../fuyao/client.js';
import { DragonTigerFlowManager } from './flow-manager.js';
import { FuyaoDragonTigerFlowSource } from './fuyao.js';

/**
 * 龙虎榜资金流向拓扑 manager 装配根。
 *
 * 只有配置 FUYAO_API_KEY 才装配：概念 / 机构 / 游资拆解是同花顺龙虎榜接口的字段，
 * 东方财富源没有等价数据，缺 key 时 Web 页面显示「未配置」而不是伪造轨迹。
 * FUYAO_BASE_URL 可选（默认 https://fuyao.aicubes.cn），与行情源共用同一套配置解析。
 */

export interface CreateDragonTigerFlowManagerDeps {
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** 测试用：替换 fetch（不联网跑装配与解析）。 */
  readonly fetchImpl?: typeof fetch;
}

export const createDragonTigerFlowManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateDragonTigerFlowManagerDeps,
): DragonTigerFlowManagerLike | undefined => {
  const apiKey = env.FUYAO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const client = new FuyaoClient(
    fuyaoConfigFromEnv(env),
    deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl },
  );
  return new DragonTigerFlowManager({
    source: new FuyaoDragonTigerFlowSource({ client }),
    logger: deps.logger,
    clock: deps.clock ?? (() => new Date()),
  });
};
