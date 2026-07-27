import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MarketSettingsStore, SaveMarketSettingsSchema } from './market-settings.js';

const temporaryDirectories: string[] = [];

const createStore = (env: Record<string, string | undefined> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-market-settings-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    store: new MarketSettingsStore(
      { LUOOME_HOME: directory, ...env },
      { secretPath: join(directory, '.env') },
    ),
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MarketSettingsStore', () => {
  it('默认启用 Eastmoney → Tencent，并标记未配置的 Tushare', () => {
    const { store } = createStore();
    expect(store.read()).toMatchObject({
      activeOrder: ['eastmoney', 'tencent'],
      sources: [
        { id: 'eastmoney', enabled: true, priority: 1, configured: true },
        { id: 'tencent', enabled: true, priority: 2, configured: true },
        {
          id: 'tushare',
          enabled: false,
          priority: null,
          configured: false,
          configurationHint: '需要先配置 TUSHARE_TOKEN',
        },
      ],
    });
  });

  it('保存开关与优先级到 .env，保留其它变量并立即更新 runtime env', () => {
    const { store } = createStore({ TUSHARE_TOKEN: 'test-tushare-token' });
    writeFileSync(store.secretPath, 'MINIMAX_API_KEY=keep\n');
    const view = store.save({ sources: ['tushare', 'tencent'] });
    expect(view.activeOrder).toEqual(['tushare', 'tencent']);
    expect(store.runtimeEnv().LUOOME_MARKET_SOURCES).toBe('tushare,tencent');
    const content = readFileSync(store.secretPath, 'utf8');
    expect(content).toBe('MINIMAX_API_KEY=keep\nLUOOME_MARKET_SOURCES=tushare,tencent\n');
    expect(content).not.toContain('LUOOME_MARKET_ADSHARE');
    expect(statSync(store.secretPath).mode & 0o777).toBe(0o600);
  });

  it('未配置 TUSHARE_TOKEN 时拒绝启用 Tushare；不能关闭全部源或重复源', () => {
    const { store } = createStore();
    expect(() => store.save({ sources: ['tushare'] })).toThrow(
      '启用 Tushare 前必须配置 TUSHARE_TOKEN',
    );
    expect(() => SaveMarketSettingsSchema.parse({ sources: [] })).toThrow(/至少启用一个/);
    expect(() => SaveMarketSettingsSchema.parse({ sources: ['eastmoney', 'eastmoney'] })).toThrow(
      /不能重复/,
    );
  });
});
