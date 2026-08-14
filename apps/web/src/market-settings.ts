import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
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

export interface MarketSourceSettingsView {
  readonly id: MarketSourceId;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly configured: boolean;
  readonly configurationHint?: string;
}

export interface MarketSettingsView {
  readonly sources: readonly MarketSourceSettingsView[];
  readonly activeOrder: readonly MarketSourceId[];
  readonly secretPath: string;
  readonly configError?: string;
}

const SOURCE_META: Readonly<
  Record<MarketSourceId, { readonly label: string; readonly description: string }>
> = {
  eastmoney: { label: '东方财富', description: '公开实时行情与日线，默认主源' },
  tencent: { label: '腾讯行情', description: '公开行情备源，覆盖沪深 A 股' },
  sina: { label: '新浪行情', description: '公开沪深目录与复权日线备源' },
  tushare: { label: 'Tushare', description: 'tushare.pro 数据服务，支持实时快照、日线与复权因子' },
};

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
    const tushareConfigured = (env.TUSHARE_TOKEN?.trim().length ?? 0) > 0;
    return {
      sources: (Object.keys(SOURCE_META) as MarketSourceId[]).map((id) => {
        const priorityIndex = activeOrder.indexOf(id);
        const configured = id !== 'tushare' || tushareConfigured;
        return {
          id,
          label: SOURCE_META[id].label,
          description: SOURCE_META[id].description,
          enabled: priorityIndex >= 0,
          priority: priorityIndex >= 0 ? priorityIndex + 1 : null,
          configured,
          ...(configured ? {} : { configurationHint: '需要先配置 TUSHARE_TOKEN' }),
        };
      }),
      activeOrder,
      secretPath: this.secretPath,
      ...(configError === undefined ? {} : { configError }),
    };
  }

  save(input: SaveMarketSettings): MarketSettingsView {
    const settings = SaveMarketSettingsSchema.parse(input);
    const env = this.runtimeEnv();
    if (settings.sources.includes('tushare') && (env.TUSHARE_TOKEN?.trim().length ?? 0) === 0) {
      throw new Error('启用 Tushare 前必须配置 TUSHARE_TOKEN');
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
