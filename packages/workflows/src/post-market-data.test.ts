import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MarketDumpKind, StockUniverseManagerLike } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { Table, writeParquet } from 'parquet-wasm';
import { describe, expect, it } from 'vitest';

import { postMarketDataWorkflow } from './post-market-data.js';

/** 生成一份最小 daily-k dump（schema 与 fuyao 一致）。 */
const writeDailyKDump = (
  path: string,
  rows: readonly { stockId: string; dateMs: number }[],
): void => {
  const table = tableFromArrays({
    thscode: rows.map((row) => row.stockId),
    currency: rows.map(() => 'CNY'),
    interval: rows.map(() => '1d'),
    adjusted: rows.map(() => 'none'),
    date_ms: rows.map((row) => BigInt(row.dateMs)),
    open_price: rows.map(() => 10),
    high_price: rows.map(() => 11),
    low_price: rows.map(() => 9),
    close_price: rows.map(() => 10.5),
    volume: rows.map(() => 1_000_000),
    turnover: rows.map(() => 10_500_000),
  });
  writeFileSync(path, writeParquet(Table.fromIPCStream(tableToIPC(table))));
};

const writeAdjustmentFactorDump = (
  path: string,
  rows: readonly { stockId: string; exDateMs: number }[],
): void => {
  const table = tableFromArrays({
    thscode: rows.map((row) => row.stockId),
    ticker: rows.map((row) => row.stockId.slice(0, 6)),
    ex_date_ms: rows.map((row) => BigInt(row.exDateMs)),
    dividend_per_share: rows.map(() => 0.5),
    per_share_bonus: rows.map(() => 0),
    allotment_ratio: rows.map(() => 0),
    allotment_price: rows.map(() => 0),
    currency: rows.map(() => 'CNY'),
  });
  writeFileSync(path, writeParquet(Table.fromIPCStream(tableToIPC(table))));
};

const dumpAdapter = (dailyPath: string, factorPath: string) => ({
  download: async (kind: MarketDumpKind) => ({
    kind,
    dumpId: `test-${kind}`,
    localPath: kind === 'adjustment-factors' ? factorPath : dailyPath,
    bytes: 1,
  }),
});

describe('workflow/post-market-data', () => {
  it('非交易日直接 skipped，不访问股票目录数据源', async () => {
    let universeCalls = 0;
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test'],
      fetchStockUniverse: async () => {
        universeCalls += 1;
        throw new Error('must not run');
      },
    };
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-01T08:30:00.000Z'),
      stockUniverse: manager,
    });

    const result = await postMarketDataWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('skipped');
    expect(universeCalls).toBe(0);
  });

  it('目录失败但 dump 日线成功 → partial，不阻断日线归档', async () => {
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test'],
      fetchStockUniverse: () => Promise.reject(new Error('directory down')),
    };
    const dir = mkdtempSync(join(tmpdir(), 'luoome-dump-'));
    const dailyPath = join(dir, 'daily-k.parquet');
    const factorPath = join(dir, 'factors.parquet');
    writeDailyKDump(dailyPath, [
      { stockId: '600519.SH', dateMs: Date.UTC(2026, 6, 24) },
      { stockId: '600519.SH', dateMs: Date.UTC(2026, 6, 27) },
    ]);
    writeAdjustmentFactorDump(factorPath, []);
    try {
      const ctx = await buildTestContext({
        clock: () => new Date('2026-07-27T08:30:00.000Z'),
        stockUniverse: manager,
        marketDump: dumpAdapter(dailyPath, factorPath),
      });

      const result = await postMarketDataWorkflow.run({ forceUniverse: true }, ctx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe('partial');
      expect(result.data.universe.status).toBe('failed');
      expect(result.data.dailyBars.status).toBe('succeeded');
      expect(result.data.dailyBars.bars).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
