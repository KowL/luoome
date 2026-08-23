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
    ],
  },
  sina: { capabilities: ['daily-bars'] },
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
      'delayed-index',
    ],
    requiredEnv: { key: 'FUYAO_API_KEY', label: 'fuyao' },
  },
};
