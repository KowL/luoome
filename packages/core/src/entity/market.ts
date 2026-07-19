import { z } from 'zod';

import type { Exchange } from './stock.js';

/**
 * 市场分类（v0.2 起，ARCHITECTURE §5.1 扩字段）。
 *
 * 设计要点：
 * - `Market` 是适配器路由的最小粒度（Eastmoney 覆盖 cn-a + cn-hk，v0.5 起 US），
 *   比 `Exchange`（5 个交易所）粗，但比直接用 `Exchange` 路由更稳——同一市场的
 *   多个交易所走同一组适配器。
 * - `Stock` 仍以 `Exchange` 为权威字段（v0.1 已落地，fixtures 不动）；
 *   `Market` 通过 `marketFromExchange()` 派生，避免冗余存储与双源不一致。
 * - `cn-a` 涵盖 SH / SZ / BJ 三个交易所（v0.2 主力覆盖，ROADMAP v0.2）。
 *
 * exhaustiveness 约定：`marketFromExchange` 的 switch case 由 Exchange 联合类型
 * 守门；Exchange 加新成员时 TS 编译会在这里报「not exhaustive」。
 */
export type Market = 'cn-a' | 'cn-hk' | 'us';

export const MarketSchema = z.enum(['cn-a', 'cn-hk', 'us']);

/** 顺序固定，遍历/日志时稳定。 */
export const ALL_MARKETS: readonly Market[] = ['cn-a', 'cn-hk', 'us'] as const;

/** Market → 默认人类可读标签（CLI / TUI / Web 展示用，i18n key 不在此处维护）。 */
export const MARKET_LABEL: Readonly<Record<Market, string>> = {
  'cn-a': 'A 股',
  'cn-hk': '港股',
  us: '美股',
};

/** 把交易所归到市场分类。 */
export const marketFromExchange = (exchange: Exchange): Market => {
  switch (exchange) {
    case 'SH':
    case 'SZ':
    case 'BJ':
      return 'cn-a';
    case 'HK':
      return 'cn-hk';
    case 'US':
      return 'us';
  }
};

/** v0.2 真实行情适配器覆盖范围（ROADMAP v0.2：A股 + 港股，不接美股）。 */
export const V0_2_SUPPORTED_MARKETS: ReadonlySet<Market> = new Set<Market>(['cn-a', 'cn-hk']);
