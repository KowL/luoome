import { describe, expect, it } from 'vitest';

import { createMarketDumpManagerFromEnv } from './factory.js';
import type { MarketDumpStores } from './types.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 最小仓储替身：factory 只接线，不调用。 */
const stubStores = (): MarketDumpStores => {
  const notCalled = (): never => {
    throw new Error('not called in factory test');
  };
  return {
    runs: {
      saveStarted: notCalled,
      findById: notCalled,
      listRecent: notCalled,
      findResumable: notCalled,
      advanceCheckpoint: notCalled,
      markDownloaded: notCalled,
      finish: notCalled,
    },
    rawDailyBars: {
      saveMany: notCalled,
      listRevisions: notCalled,
      listRevisionsForStocks: notCalled,
      summarizeArtifact: notCalled,
    },
    corporateActionEvents: {
      saveMany: notCalled,
      listRevisions: notCalled,
      listRevisionsForStocks: notCalled,
      summarizeArtifact: notCalled,
    },
  };
};

describe('createMarketDumpManagerFromEnv', () => {
  it('缺省不装配（返回 undefined）：dump 端口默认关闭，显式写 fuyao 才启用', () => {
    expect(
      createMarketDumpManagerFromEnv({}, { logger: noopLogger, stores: stubStores() }),
    ).toBeUndefined();
    expect(
      createMarketDumpManagerFromEnv(
        { LUOOME_MARKET_DUMP_SOURCES: '  ' },
        { logger: noopLogger, stores: stubStores() },
      ),
    ).toBeUndefined();
  });

  it('显式启用 fuyao 但 FUYAO_API_KEY 缺失 → 启动期失败（§4.3）', () => {
    expect(() =>
      createMarketDumpManagerFromEnv(
        { LUOOME_MARKET_DUMP_SOURCES: 'fuyao' },
        { logger: noopLogger, stores: stubStores() },
      ),
    ).toThrow(/FUYAO_API_KEY/);
  });

  it.each(['unknown', 'fuyao,unknown', 'fuyao,fuyao', 'fuyao,FUYAO', 'fuyao,', ','])(
    '非法来源配置 %s 启动期失败',
    (sources) => {
      expect(() =>
        createMarketDumpManagerFromEnv(
          { LUOOME_MARKET_DUMP_SOURCES: sources, FUYAO_API_KEY: 'k' },
          { logger: noopLogger, stores: stubStores() },
        ),
      ).toThrow(/LUOOME_MARKET_DUMP_SOURCES/);
    },
  );

  it('来源名称允许首尾空格和大小写规范化', () => {
    expect(
      createMarketDumpManagerFromEnv(
        { LUOOME_MARKET_DUMP_SOURCES: ' FUYAO ', FUYAO_API_KEY: 'k' },
        { logger: noopLogger, stores: stubStores() },
      )?.name,
    ).toBe('market-dump');
  });

  it('配置齐全时装配成功，manager.name = market-dump', () => {
    const manager = createMarketDumpManagerFromEnv(
      {
        LUOOME_MARKET_DUMP_SOURCES: 'fuyao',
        FUYAO_API_KEY: 'k',
        LUOOME_HOME: '/tmp/luoome-test-home',
      },
      { logger: noopLogger, stores: stubStores() },
    );
    expect(manager).toBeDefined();
    expect(manager?.name).toBe('market-dump');
  });

  it('注入共享 fuyaoClient 时不重复构造（§4.1）', () => {
    const manager = createMarketDumpManagerFromEnv(
      { LUOOME_MARKET_DUMP_SOURCES: 'fuyao', LUOOME_HOME: '/tmp/luoome-test-home' },
      {
        logger: noopLogger,
        stores: stubStores(),
        fuyaoClient: {} as never,
      },
    );
    expect(manager).toBeDefined();
  });
});
