import type { Logger, MarketCoverage, MarketDataAdapterLike } from '@luoome/core';
import { parseMarketProviderConfigFromEnv } from '@luoome/core';
import { z } from 'zod';

import { tushareConfigFromEnv } from '../tushare/client.js';
import { QuoteCache } from './cache.js';
import { EastmoneyAdapter } from './eastmoney.js';
import { MarketDataManager } from './manager.js';
import { SinaAdapter } from './sina.js';
import { type AnyMarketCapabilityBinding, MarketSourceRegistry } from './source-registry.js';
import { TencentAdapter } from './tencent.js';
import { TushareMarketAdapter } from './tushare.js';

/**
 * 行情适配器装配（v0.5 起，surface 组装根统一入口）。
 *
 * 设计要点：
 * - provider 解析委托 core 的 parseMarketProviderConfigFromEnv（非法值启动期抛错）。
 * - 返回 MarketDataManager，缓存 / 限速 / 30 分钟抑制窗口全部由 Manager
 *   既有实现承担，此处只做组装。
 * - LUOOME_MARKET_SOURCES 定义启用状态和优先级；未配置时使用 Eastmoney → Tencent → Sina。
 */

export interface CreateMarketAdapterDeps {
  /** 业务时钟；缺省时使用系统时间。 */
  readonly clock?: () => Date;
  /** real 模式 Manager 的降级日志。 */
  readonly logger: Logger;
  /** 测试用：替换 real 链路的 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 显式覆盖行情源顺序；省略时从 LUOOME_MARKET_SOURCES 解析。 */
  readonly sourceOrder?: readonly MarketSourceId[];
  /** 覆盖 QuoteCache TTL（默认 60s）；盘中高频刷新的 surface（如 Web）可调小。 */
  readonly quoteCacheTtlMs?: number;
}

export const MarketSourceIdSchema = z.enum(['eastmoney', 'sina', 'tencent', 'tushare']);
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

/** 未配置 LUOOME_MARKET_SOURCES 时使用 Eastmoney → Tencent → Sina。 */
export const marketSourceOrderFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): MarketSourceId[] => {
  const raw = env.LUOOME_MARKET_SOURCES?.trim();
  if (raw !== undefined && raw.length > 0) {
    return MarketSourceOrderSchema.parse(
      raw.split(',').map((source) => source.trim().toLowerCase()),
    );
  }
  return MarketSourceOrderSchema.parse(['eastmoney', 'tencent', 'sina']);
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
      ? marketSourceOrderFromEnv(env)
      : MarketSourceOrderSchema.parse(deps.sourceOrder);
  const bindings = sourceOrder.flatMap((source) => {
    switch (source) {
      case 'eastmoney': {
        const adapter = new EastmoneyAdapter(sourceOpts);
        return eastmoneyBindings(adapter);
      }
      case 'tencent': {
        const adapter = new TencentAdapter(sourceOpts);
        return tencentBindings(adapter);
      }
      case 'sina': {
        const adapter = new SinaAdapter(sourceOpts);
        return sinaBindings(adapter);
      }
      case 'tushare': {
        const adapter = buildTushare(env, sourceOpts, deps.logger);
        return tushareBindings(adapter);
      }
      default:
        throw new Error(`不支持的行情数据源：${String(source satisfies never)}`);
    }
  });
  const clock = deps.clock ?? ((): Date => new Date());
  const registry = new MarketSourceRegistry(bindings, clock);

  return new MarketDataManager({
    registry,
    ...(deps.quoteCacheTtlMs === undefined
      ? {}
      : { quoteCache: new QuoteCache(1024, deps.quoteCacheTtlMs) }),
    logger: deps.logger,
    clock,
  });
};

/** Tushare 被显式排入路由时要求配置完整，避免 UI 显示已启用但运行时静默跳过。 */
const buildTushare = (
  env: Readonly<Record<string, string | undefined>>,
  sourceOpts: { clock?: () => Date; fetchImpl?: typeof fetch },
  logger: Logger,
): TushareMarketAdapter => {
  const token = env.TUSHARE_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    throw new Error('Tushare 已启用，但 TUSHARE_TOKEN 未配置');
  }
  const config = tushareConfigFromEnv(env);
  return new TushareMarketAdapter({ ...sourceOpts, config, logger });
};

const CN_SH_SZ = ['CN_A_SHARES_SH_SZ'] as const satisfies readonly MarketCoverage[];
const CN_ALL = ['CN_A_SHARES_SH_SZ', 'CN_A_SHARES_BJ'] as const satisfies readonly MarketCoverage[];

const commonBindings = (
  adapter: {
    readonly name: string;
    fetchQuote(stockId: string): ReturnType<EastmoneyAdapter['fetchQuote']>;
    fetchDailyBars(
      stockId: string,
      range: Parameters<EastmoneyAdapter['fetchDailyBars']>[1],
    ): ReturnType<EastmoneyAdapter['fetchDailyBars']>;
    searchStocks(query: string): ReturnType<EastmoneyAdapter['searchStocks']>;
  },
  coverage: readonly MarketCoverage[],
): AnyMarketCapabilityBinding[] => [
  {
    capability: 'quote',
    source: adapter.name,
    coverage,
    configurationReady: true,
    execute: ({ stockId }) => adapter.fetchQuote(stockId),
    dataAsOf: (quote) => quote.observedAt,
  },
  {
    capability: 'daily-bars',
    source: adapter.name,
    coverage,
    configurationReady: true,
    execute: ({ stockId, range }) => adapter.fetchDailyBars(stockId, range),
    dataAsOf: (bars) => bars.at(-1)?.date,
  },
  {
    capability: 'search',
    source: adapter.name,
    coverage,
    configurationReady: true,
    execute: ({ query }) => adapter.searchStocks(query),
  },
];

const eastmoneyBindings = (adapter: EastmoneyAdapter): AnyMarketCapabilityBinding[] => [
  ...commonBindings(adapter, CN_ALL),
  {
    capability: 'market-snapshot',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchMarketSnapshot(),
  },
  {
    capability: 'market-snapshot-envelope',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchMarketSnapshotEnvelope(),
    dataAsOf: (snapshot) => snapshot.dataAsOf,
  },
  {
    capability: 'realtime-index',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchIndexQuotes(),
    dataAsOf: (indices) =>
      indices.reduce<Date | undefined>(
        (latest, index) => (latest === undefined || index.ts > latest ? index.ts : latest),
        undefined,
      ),
  },
];

const tencentBindings = (adapter: TencentAdapter): AnyMarketCapabilityBinding[] => [
  ...commonBindings(adapter, CN_ALL),
  {
    capability: 'market-snapshot',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchMarketSnapshot(),
  },
  {
    capability: 'market-snapshot-envelope',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchMarketSnapshotEnvelope(),
    dataAsOf: (snapshot) => snapshot.dataAsOf,
  },
  {
    capability: 'intraday-minutes',
    source: adapter.name,
    coverage: CN_ALL,
    configurationReady: true,
    execute: ({ stockId }) => adapter.fetchIntradayMinutes(stockId),
    dataAsOf: (points) => points.at(-1)?.time,
  },
];

const sinaBindings = (adapter: SinaAdapter): AnyMarketCapabilityBinding[] => [
  {
    capability: 'daily-bars',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: ({ stockId, range }) => adapter.fetchDailyBars(stockId, range),
    dataAsOf: (bars) => bars.at(-1)?.date,
  },
];

const tushareBindings = (adapter: TushareMarketAdapter): AnyMarketCapabilityBinding[] => [
  ...commonBindings(adapter, CN_SH_SZ),
  {
    capability: 'delayed-index',
    source: adapter.name,
    coverage: CN_SH_SZ,
    configurationReady: true,
    execute: () => adapter.fetchIndexQuotes(),
    dataAsOf: (indices) =>
      indices.reduce<Date | undefined>(
        (latest, index) => (latest === undefined || index.ts > latest ? index.ts : latest),
        undefined,
      ),
  },
];
