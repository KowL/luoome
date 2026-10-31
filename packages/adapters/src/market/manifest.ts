import { FUYAO_DEFAULT_BASE_URL } from '../fuyao/client.js';
import type { MarketSourceId } from './factory.js';
import type { MarketCapability } from './source-registry.js';

/**
 * 行情源静态能力清单（docs/ddd/market-source-settings-status-design.md §4）。
 *
 * factory 只在源被启用时构建 binding，未启用源的能力边界无处可查；manifest
 * 把「该源实现了哪些 capability、是否需要凭证」声明为静态数据，供设置页等
 * 读模型在未启用状态下也能展示能力清单。manifest 与 factory 实际 binding 的
 * 一致性由 manifest.test.ts 逐源钉住——改 binding 必须同步改这里。
 */
export interface MarketSourceManifestEntry {
  readonly capabilities: readonly MarketCapability[];
  /** 启用该源前必须配置的凭证；无则开箱即用。 */
  readonly requiredEnv?: { readonly key: string; readonly label: string };
  /**
   * 设置页需要**额外**收集的非凭据配置（如自建服务地址）。
   *
   * 设置页的凭据分区**从 `requiredEnv` 派生**（M3-15：用户加一家源就自动多一格）；
   * 这里声明「除 API Key 之外还要收集什么」，避免把 FUYAO 这类特例硬编码进设置页。
   */
  readonly settingsFields?: readonly {
    readonly key: 'baseUrl';
    readonly label: string;
    readonly defaultValue: string;
  }[];
}

export const MARKET_SOURCE_MANIFEST: Readonly<Record<MarketSourceId, MarketSourceManifestEntry>> = {
  eastmoney: {
    capabilities: [
      'quote',
      'batch-quote',
      'daily-bars',
      'search',
      'market-snapshot',
      'market-snapshot-envelope',
      'intraday-minutes',
      'realtime-index',
    ],
  },
  tencent: {
    capabilities: [
      'quote',
      'batch-quote',
      'daily-bars',
      'search',
      'market-snapshot',
      'market-snapshot-envelope',
      'intraday-minutes',
      'realtime-index',
      'minute-bars',
    ],
  },
  sina: { capabilities: ['quote', 'batch-quote', 'daily-bars'] },
  xueqiu: { capabilities: ['quote', 'daily-bars'] },
  tushare: {
    capabilities: ['quote', 'daily-bars', 'search', 'minute-bars', 'delayed-index'],
    requiredEnv: { key: 'TUSHARE_TOKEN', label: 'Tushare' },
  },
  fuyao: {
    capabilities: [
      'quote',
      'batch-quote',
      'daily-bars',
      'search',
      'market-snapshot',
      'market-snapshot-envelope',
      'delayed-index',
    ],
    requiredEnv: { key: 'FUYAO_API_KEY', label: 'fuyao' },
    settingsFields: [
      { key: 'baseUrl', label: 'FUYAO 服务地址', defaultValue: FUYAO_DEFAULT_BASE_URL },
    ],
  },
};
