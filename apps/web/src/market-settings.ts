import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MARKET_SOURCE_MANIFEST,
  type MarketCapability,
  type MarketSourceId,
  MarketSourceOrderSchema,
  marketSourceOrderFromEnv,
} from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';

export const SaveMarketSettingsSchema = z.object({
  sources: MarketSourceOrderSchema,
});
export type SaveMarketSettings = z.infer<typeof SaveMarketSettingsSchema>;

/** capability 运行态（§4.3 状态机产物，由 get_market_data_status 的 datasets 提供）。 */
export type MarketCapabilityState = 'fresh' | 'stale' | 'unavailable' | 'unknown';

export interface MarketCapabilityStatusView {
  readonly capability: MarketCapability;
  readonly label: string;
  /** manifest 声明该源支持此能力；false 表示能力边界之外，不展示运行态。 */
  readonly bound: boolean;
  /** 运行态，仅 enabled 源由 server 聚合填入；未填充表示读模型不可用。 */
  readonly state?: MarketCapabilityState;
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly dataAsOf?: string;
  readonly lastErrorKind?: string;
}

export type MarketSourceHealth = MarketCapabilityState | 'off';

export interface MarketSourceSettingsView {
  readonly id: MarketSourceId;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly configured: boolean;
  readonly configurationHint?: string;
  /** 全部 10 种行情能力的静态清单（bound 标记支持与否），server 侧叠加运行态。 */
  readonly capabilities: readonly MarketCapabilityStatusView[];
  /** 行级摘要：enabled 时取各 bound capability 最差状态；disabled 为 'off'。 */
  readonly health: MarketSourceHealth;
}

export interface MarketSettingsView {
  readonly sources: readonly MarketSourceSettingsView[];
  readonly activeOrder: readonly MarketSourceId[];
  readonly secretPath: string;
  readonly configError?: string;
}

/** 设置页能力词表（web 层投影，与 market-sync.js 的 DATASET_LABELS 同口径）。 */
const CAPABILITY_LABELS: Readonly<Record<MarketCapability, string>> = {
  quote: '实时快照',
  'batch-quote': '批量快照',
  'daily-bars': '日 K',
  search: '搜索',
  'market-snapshot': '全市场快照',
  'market-snapshot-envelope': '快照完整性',
  'realtime-index': '实时指数',
  'delayed-index': '延时指数',
  'intraday-minutes': '当日分时',
  'minute-bars': '分钟 K',
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS) as MarketCapability[];

/** 健康度严重次序：索引越小越差，行级摘要取最差。 */
const HEALTH_RANK: Readonly<Record<MarketSourceHealth, number>> = {
  unavailable: 0,
  stale: 1,
  unknown: 2,
  fresh: 3,
  off: 4,
};

/** get_market_data_status datasets 中与本视图相关行的最小形状。 */
export interface MarketDatasetStatusRow {
  readonly dataset: string;
  readonly source: string;
  readonly freshness: MarketCapabilityState;
  readonly lastAttemptAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly dataAsOf?: Date;
  readonly lastErrorKind?: string;
}

/**
 * 把 get_market_data_status 的 datasets 叠加到配置态视图上（§5 组装）。
 * 只消费五个行情源、10 种 capability 的行；enabled 源缺失观测 → 'unknown'。
 */
export const withRuntimeStatus = (
  view: MarketSettingsView,
  datasets: readonly MarketDatasetStatusRow[],
): MarketSettingsView => {
  const marketSourceIds = new Set(view.sources.map((source) => source.id));
  const byKey = new Map<string, MarketDatasetStatusRow>();
  for (const row of datasets) {
    if (marketSourceIds.has(row.source as MarketSourceId)) {
      byKey.set(`${row.source}:${row.dataset}`, row);
    }
  }
  const sources = view.sources.map((source) => {
    if (!source.enabled) return source;
    const capabilities = source.capabilities.map((capability) => {
      if (!capability.bound) return capability;
      const row = byKey.get(`${source.id}:${capability.capability}`);
      if (row === undefined) return { ...capability, state: 'unknown' as const };
      return {
        ...capability,
        state: row.freshness,
        ...(row.lastAttemptAt === undefined
          ? {}
          : { lastAttemptAt: row.lastAttemptAt.toISOString() }),
        ...(row.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: row.lastSuccessAt.toISOString() }),
        ...(row.dataAsOf === undefined ? {} : { dataAsOf: row.dataAsOf.toISOString() }),
        ...(row.lastErrorKind === undefined ? {} : { lastErrorKind: row.lastErrorKind }),
      };
    });
    const health = capabilities
      .filter((capability) => capability.bound)
      .reduce<MarketSourceHealth>(
        (worst, capability) =>
          HEALTH_RANK[capability.state ?? 'unknown'] < HEALTH_RANK[worst]
            ? (capability.state ?? 'unknown')
            : worst,
        'fresh',
      );
    return { ...source, capabilities, health };
  });
  return { ...view, sources };
};

const SOURCE_META: Readonly<
  Record<MarketSourceId, { readonly label: string; readonly description: string }>
> = {
  eastmoney: { label: '东方财富', description: '公开实时行情与日线，默认主源' },
  tencent: { label: '腾讯行情', description: '公开行情备源，覆盖沪深 A 股' },
  sina: { label: '新浪行情', description: '公开沪深目录与复权日线备源' },
  tushare: { label: 'Tushare', description: 'tushare.pro 数据服务，支持实时快照、日线与复权因子' },
  fuyao: {
    label: '同花顺 fuyao',
    description: '同花顺金融数据 API，支持快照、前复权日线、检索与指数',
  },
};

/** 需要额外凭证的行情源由 MARKET_SOURCE_MANIFEST 声明（adapters 层单一事实来源）。 */
const requiredEnvOf = (id: MarketSourceId) => MARKET_SOURCE_MANIFEST[id].requiredEnv;

const readText = (path: string): string => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

const atomicWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const updateEnvContent = (content: string, key: string, value: string): string => {
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  const lines = content.split('\n').filter((line) => !pattern.test(line.trim()));
  while (lines.at(-1) === '') lines.pop();
  lines.push(`${key}=${value}`);
  return `${lines.join('\n')}\n`;
};

export class MarketSettingsStore {
  readonly secretPath: string;
  private readonly sessionEnv: Record<string, string | undefined> = {};

  constructor(
    private readonly baseEnv: Readonly<Record<string, string | undefined>>,
    paths: { readonly secretPath?: string } = {},
  ) {
    const home = baseEnv.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
    this.secretPath = paths.secretPath ?? join(home, '.env');
  }

  runtimeEnv(): Record<string, string | undefined> {
    // secret 文件里是用户在设置页显式保存的值，必须优先于启动环境（baseEnv）：
    // 否则项目 .env 被 Bun 加载进 process.env 后，同名键会让 UI 保存静默失效。
    return {
      ...this.baseEnv,
      ...parseEnvFile(readText(this.secretPath)),
      ...this.sessionEnv,
    };
  }

  read(): MarketSettingsView {
    const env = this.runtimeEnv();
    let activeOrder: MarketSourceId[] = ['eastmoney', 'tencent', 'sina'];
    let configError: string | undefined;
    try {
      activeOrder = marketSourceOrderFromEnv(env);
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    const sources = (Object.keys(SOURCE_META) as MarketSourceId[]).map((id) => {
      const priorityIndex = activeOrder.indexOf(id);
      const required = requiredEnvOf(id);
      const configured = required === undefined || (env[required.key]?.trim().length ?? 0) > 0;
      const enabled = priorityIndex >= 0;
      const manifestCapabilities = new Set(MARKET_SOURCE_MANIFEST[id].capabilities);
      const capabilities = ALL_CAPABILITIES.map((capability) => ({
        capability,
        label: CAPABILITY_LABELS[capability],
        bound: manifestCapabilities.has(capability),
      }));
      return {
        id,
        label: SOURCE_META[id].label,
        description: SOURCE_META[id].description,
        enabled,
        priority: enabled ? priorityIndex + 1 : null,
        configured,
        ...(configured ? {} : { configurationHint: `需要先配置 ${required?.key ?? ''}` }),
        capabilities,
        // 运行态由 server 叠加（withRuntimeStatus）；store 视角下 enabled 源一律 unknown
        health: enabled ? ('unknown' as const) : ('off' as const),
      };
    });
    return {
      sources,
      activeOrder,
      secretPath: this.secretPath,
      ...(configError === undefined ? {} : { configError }),
    };
  }

  save(input: SaveMarketSettings): MarketSettingsView {
    const settings = SaveMarketSettingsSchema.parse(input);
    const env = this.runtimeEnv();
    for (const id of settings.sources) {
      const required = requiredEnvOf(id);
      if (required !== undefined && (env[required.key]?.trim().length ?? 0) === 0) {
        throw new Error(`启用 ${required.label} 前必须配置 ${required.key}`);
      }
    }
    const serialized = settings.sources.join(',');
    this.sessionEnv.LUOOME_MARKET_SOURCES = serialized;
    const content = updateEnvContent(
      readText(this.secretPath),
      'LUOOME_MARKET_SOURCES',
      serialized,
    );
    atomicWrite(this.secretPath, content);
    return this.read();
  }
}
