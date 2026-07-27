import { fromEnv as adshareFromEnv } from '@luoome/adshare-sdk';
import type { Logger, MarketDataAdapterLike } from '@luoome/core';
import { parseMarketProviderConfigFromEnv } from '@luoome/core';
import { z } from 'zod';

import { AdshareMarketAdapter } from './adshare.js';
import { QuoteCache } from './cache.js';
import { EastmoneyAdapter } from './eastmoney.js';
import { MarketDataManager } from './manager.js';
import { TencentAdapter } from './tencent.js';

/**
 * 行情适配器装配（v0.5 起，surface 组装根统一入口）。
 *
 * 设计要点：
 * - provider 解析委托 core 的 parseMarketProviderConfigFromEnv（非法值启动期抛错）。
 * - 返回 MarketDataManager，缓存 / 限速 / 30 分钟抑制窗口全部由 Manager
 *   既有实现承担，此处只做组装。
 * - LUOOME_MARKET_SOURCES 定义启用状态和优先级；未配置时保持
 *   Eastmoney → Tencent，并兼容旧 LUOOME_MARKET_ADSHARE 开关。
 */

export interface CreateMarketAdapterDeps {
  /** 业务时钟；缺省时使用系统时间。 */
  readonly clock?: () => Date;
  /** real 模式 Manager 的降级日志。 */
  readonly logger: Logger;
  /** 测试用：替换 real 链路的 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 兼容旧 assembly root；新代码应使用 LUOOME_MARKET_SOURCES / sourceOrder。 */
  readonly enableAdshare?: boolean;
  /** 显式覆盖行情源顺序；省略时从 LUOOME_MARKET_SOURCES / 旧开关解析。 */
  readonly sourceOrder?: readonly MarketSourceId[];
  /** 覆盖 QuoteCache TTL（默认 60s）；盘中高频刷新的 surface（如 Web）可调小。 */
  readonly quoteCacheTtlMs?: number;
}

export const MarketSourceIdSchema = z.enum(['eastmoney', 'tencent', 'adshare']);
export type MarketSourceId = z.infer<typeof MarketSourceIdSchema>;

export const MarketSourceOrderSchema = z
  .array(MarketSourceIdSchema)
  .min(1, '至少启用一个行情数据源')
  .max(3)
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: 'custom', message: '行情数据源不能重复' });
    }
  });

/** 新配置优先；未配置时兼容原有 Eastmoney → Tencent + 可选 Adshare。 */
export const marketSourceOrderFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  legacyEnableAdshare = false,
): MarketSourceId[] => {
  const raw = env.LUOOME_MARKET_SOURCES?.trim();
  if (raw !== undefined && raw.length > 0) {
    return MarketSourceOrderSchema.parse(
      raw.split(',').map((source) => source.trim().toLowerCase()),
    );
  }
  return MarketSourceOrderSchema.parse([
    'eastmoney',
    'tencent',
    ...(legacyEnableAdshare || env.LUOOME_MARKET_ADSHARE === 'true' ? ['adshare' as const] : []),
  ]);
};

export const createMarketAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  deps: CreateMarketAdapterDeps,
): MarketDataAdapterLike => {
  parseMarketProviderConfigFromEnv(env);

  const clockOpt = deps.clock === undefined ? {} : { clock: deps.clock };

  const sourceOpts = {
    ...clockOpt,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  const sourceOrder =
    deps.sourceOrder === undefined
      ? marketSourceOrderFromEnv(env, deps.enableAdshare ?? false)
      : MarketSourceOrderSchema.parse(deps.sourceOrder);
  const sources = sourceOrder.map((source) => {
    switch (source) {
      case 'eastmoney':
        return new EastmoneyAdapter(sourceOpts);
      case 'tencent':
        return new TencentAdapter(sourceOpts);
      case 'adshare':
        return buildAdshare(env, sourceOpts, deps.logger);
      default:
        throw new Error(`不支持的行情数据源：${String(source satisfies never)}`);
    }
  });
  const primary = sources[0];
  if (primary === undefined) throw new Error('至少启用一个行情数据源');
  const fallback = sources[1] ?? unavailableMarketSource;
  const finalFallback = sources[2];

  return new MarketDataManager({
    primary,
    fallback,
    ...(finalFallback === undefined ? {} : { finalFallback }),
    ...(deps.quoteCacheTtlMs === undefined
      ? {}
      : { quoteCache: new QuoteCache(1024, deps.quoteCacheTtlMs) }),
    logger: deps.logger,
    ...clockOpt,
  });
};

const unavailableMarketSource: MarketDataAdapterLike = {
  name: 'disabled',
  fetchQuote: () => Promise.reject(new Error('no secondary market source enabled')),
  batchQuote: () => Promise.resolve(new Map()),
  fetchDailyBars: () => Promise.reject(new Error('no secondary market source enabled')),
  searchStocks: () => Promise.reject(new Error('no secondary market source enabled')),
};

/** Adshare 被显式排入路由时要求配置完整，避免 UI 显示已启用但运行时静默跳过。 */
const buildAdshare = (
  env: Readonly<Record<string, string | undefined>>,
  sourceOpts: { clock?: () => Date; fetchImpl?: typeof fetch },
  logger: Logger,
): AdshareMarketAdapter => {
  const url = env.ADSHARE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('Adshare 已启用，但 ADSHARE_URL 未配置');
  }
  const config = adshareFromEnv(env);
  return new AdshareMarketAdapter({ ...sourceOpts, config, logger });
};
