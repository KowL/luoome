import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MarketSettingsStore,
  SaveMarketSettingsSchema,
  withRuntimeStatus,
} from './market-settings.js';

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
  it('默认启用 Eastmoney → Tencent → Sina，并标记未配置的 Tushare 与 fuyao', () => {
    const { store } = createStore();
    expect(store.read()).toMatchObject({
      activeOrder: ['eastmoney', 'tencent', 'sina'],
      sources: [
        { id: 'eastmoney', enabled: true, priority: 1, configured: true },
        { id: 'tencent', enabled: true, priority: 2, configured: true },
        { id: 'sina', enabled: true, priority: 3, configured: true },
        {
          id: 'tushare',
          enabled: false,
          priority: null,
          configured: false,
          configurationHint: '需要先配置 TUSHARE_TOKEN',
        },
        {
          id: 'fuyao',
          enabled: false,
          priority: null,
          configured: false,
          configurationHint: '需要先配置 FUYAO_API_KEY',
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
    expect(() =>
      SaveMarketSettingsSchema.parse({ sources: ['eastmoney', 'tencent', 'sina', 'tushare'] }),
    ).toThrow(/最多启用 3 个/);
    expect(() => SaveMarketSettingsSchema.parse({ sources: ['eastmoney', 'eastmoney'] })).toThrow(
      /不能重复/,
    );
  });

  it('secret 文件里已保存的设置优先于启动环境（项目 .env 残留同名键不影响生效）', () => {
    const { store } = createStore({
      LUOOME_MARKET_SOURCES: 'tushare,eastmoney,tencent',
      TUSHARE_TOKEN: 'test-tushare-token',
    });
    writeFileSync(store.secretPath, 'LUOOME_MARKET_SOURCES=tushare\n');
    expect(store.runtimeEnv().LUOOME_MARKET_SOURCES).toBe('tushare');
    expect(store.read().activeOrder).toEqual(['tushare']);
  });

  it('配置态视图带全部 10 种能力的静态清单，bound 与 manifest 一致', () => {
    const { store } = createStore();
    const view = store.read();
    const sina = view.sources.find((source) => source.id === 'sina');
    expect(sina?.capabilities).toHaveLength(10);
    expect(
      sina?.capabilities.find((capability) => capability.capability === 'daily-bars'),
    ).toMatchObject({ bound: true, label: '日 K' });
    expect(
      sina?.capabilities.find((capability) => capability.capability === 'quote'),
    ).toMatchObject({ bound: false });
    // 无运行态叠加时：enabled → unknown，disabled → off
    expect(sina?.health).toBe('unknown');
    expect(view.sources.find((source) => source.id === 'tushare')?.health).toBe('off');
  });
});

describe('withRuntimeStatus', () => {
  const baseView = () => {
    const { store } = createStore();
    return store.read();
  };

  it('按 source:capability 叠加运行态，行级健康取最差状态', () => {
    const view = withRuntimeStatus(baseView(), [
      {
        dataset: 'quote',
        source: 'eastmoney',
        freshness: 'fresh',
        lastSuccessAt: new Date('2026-08-22T01:00:00.000Z'),
        dataAsOf: new Date('2026-08-22T01:00:00.000Z'),
      },
      {
        dataset: 'daily-bars',
        source: 'eastmoney',
        freshness: 'unavailable',
        lastErrorKind: 'network',
      },
    ]);
    const eastmoney = view.sources.find((source) => source.id === 'eastmoney');
    expect(
      eastmoney?.capabilities.find((capability) => capability.capability === 'quote'),
    ).toMatchObject({
      state: 'fresh',
      lastSuccessAt: '2026-08-22T01:00:00.000Z',
      dataAsOf: '2026-08-22T01:00:00.000Z',
    });
    expect(
      eastmoney?.capabilities.find((capability) => capability.capability === 'daily-bars'),
    ).toMatchObject({ state: 'unavailable', lastErrorKind: 'network' });
    expect(eastmoney?.health).toBe('unavailable');
    // 未观测到的 bound capability 回 unknown
    expect(
      eastmoney?.capabilities.find((capability) => capability.capability === 'search')?.state,
    ).toBe('unknown');
  });

  it('disabled 源与非行情域 dataset 不叠加运行态', () => {
    const view = withRuntimeStatus(baseView(), [
      { dataset: 'daily-bars', source: 'tushare', freshness: 'fresh' },
      { dataset: 'news', source: 'eastmoney', freshness: 'fresh' },
    ]);
    const tushare = view.sources.find((source) => source.id === 'tushare');
    expect(tushare?.health).toBe('off');
    expect(tushare?.capabilities.every((capability) => capability.state === undefined)).toBe(true);
    // 'news' 不是行情 capability，eastmoney 的 capabilities 不受影响
    const eastmoney = view.sources.find((source) => source.id === 'eastmoney');
    expect(
      eastmoney?.capabilities.every((capability) =>
        capability.bound ? capability.state === 'unknown' : capability.state === undefined,
      ),
    ).toBe(true);
  });
});
