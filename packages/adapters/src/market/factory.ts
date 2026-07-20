import type { Logger, MarketDataAdapterLike } from '@luoome/core';
import { parseMarketProviderConfigFromEnv } from '@luoome/core';

import { EastmoneyAdapter } from './eastmoney.js';
import { MarketDataManager } from './manager.js';
import { MockMarketAdapter } from './mock.js';
import { TencentAdapter } from './tencent.js';

/**
 * 行情适配器装配（v0.5 起，surface 组装根统一入口）。
 *
 * 设计要点：
 * - provider 解析委托 core 的 parseMarketProviderConfigFromEnv（非法值启动期抛错）。
 * - mock（默认）：返回 MockMarketAdapter，clock 缺省时沿用 Mock 自身默认
 *   （defaultMockClock），与 v0.4 各 surface 硬编码 new MockMarketAdapter(...) 的行为
 *   完全一致——接线本身是零行为变化重构。
 * - real：返回 MarketDataManager（Eastmoney 主 → Tencent 备 → Mock 兜底，A 股），
 *   缓存 / 限速 / 30 分钟抑制窗口全部由 Manager 既有实现承担，此处只做组装。
 */

export interface CreateMarketAdapterDeps {
  /** 业务时钟；缺省时各适配器用自身默认（Mock=defaultMockClock，real=系统时间）。 */
  readonly clock?: () => Date;
  /** real 模式 Manager 的降级日志；mock 模式不使用。 */
  readonly logger: Logger;
  /** 测试用：替换 real 链路的 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

export const createMarketAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateMarketAdapterDeps,
): MarketDataAdapterLike => {
  const { provider } = parseMarketProviderConfigFromEnv(env);

  const clockOpt = deps.clock === undefined ? {} : { clock: deps.clock };

  if (provider === 'mock') {
    return new MockMarketAdapter(clockOpt);
  }

  const sourceOpts = {
    ...clockOpt,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
  return new MarketDataManager({
    primary: new EastmoneyAdapter(sourceOpts),
    fallback: new TencentAdapter(sourceOpts),
    finalFallback: new MockMarketAdapter(clockOpt),
    logger: deps.logger,
    ...clockOpt,
  });
};
