import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MarketDumpKind } from '@luoome/core';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { Table, writeParquet } from 'parquet-wasm';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { syncMarketDumpTool } from './sync-market-dump.js';

const writeParquetFile = (path: string, columns: Record<string, unknown[]>): void => {
  const table = tableFromArrays(columns);
  writeFileSync(path, writeParquet(Table.fromIPCStream(tableToIPC(table))));
};

const writeDailyK = (
  path: string,
  rows: readonly { stockId: string; dateMs: number; close: number }[],
) =>
  writeParquetFile(path, {
    thscode: rows.map((row) => row.stockId),
    currency: rows.map(() => 'CNY'),
    interval: rows.map(() => '1d'),
    adjusted: rows.map(() => 'none'),
    date_ms: rows.map((row) => BigInt(row.dateMs)),
    open_price: rows.map((row) => row.close),
    high_price: rows.map((row) => row.close),
    low_price: rows.map((row) => row.close),
    close_price: rows.map((row) => row.close),
    volume: rows.map(() => 1_000_000),
    turnover: rows.map(() => 10_000_000),
  });

const writeFactors = (path: string, rows: readonly { stockId: string; exDateMs: number }[]) =>
  writeParquetFile(path, {
    thscode: rows.map((row) => row.stockId),
    ticker: rows.map((row) => row.stockId.slice(0, 6)),
    ex_date_ms: rows.map((row) => BigInt(row.exDateMs)),
    dividend_per_share: rows.map(() => 1),
    per_share_bonus: rows.map(() => 0),
    allotment_ratio: rows.map(() => 0),
    allotment_price: rows.map(() => 0),
    currency: rows.map(() => 'CNY'),
  });

const adapterFor = (dailyPath: string, factorPath: string) => ({
  download: async (kind: MarketDumpKind) => ({
    kind,
    dumpId: `test-${kind}`,
    localPath: kind === 'adjustment-factors' ? factorPath : dailyPath,
    bytes: 1,
  }),
});

describe('sync_market_dump', () => {
  it('auto：原始日线落库 + 按事件前收盘算出复权因子', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-dump-'));
    const dailyPath = join(dir, 'daily.parquet');
    const factorPath = join(dir, 'factors.parquet');
    // dump 的时间戳是北京时间零点（UTC 16:00 前一天）；导入后应归一化成 UTC 零点。
    const day1 = Date.UTC(2026, 6, 22, 16);
    const day2 = Date.UTC(2026, 6, 23, 16);
    writeDailyK(dailyPath, [
      { stockId: '600519.SH', dateMs: day1, close: 100 },
      { stockId: '600519.SH', dateMs: day2, close: 50 },
    ]);
    // 除权日 2026-07-24：前收 100，派息 1 → 除权价 99，factor = 0.99
    writeFactors(factorPath, [{ stockId: '600519.SH', exDateMs: day2 }]);
    try {
      const ctx = await buildTestContext({
        clock: () => new Date('2026-07-27T08:30:00.000Z'),
        marketDump: adapterFor(dailyPath, factorPath),
      });

      const result = await syncMarketDumpTool.execute({ kind: 'auto' }, ctx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.bars).toBe(2);
      expect(result.data.factors).toBe(1);

      // 原始价落库：day2（UTC 零点 2026-07-24）的 raw close 是 50，不是 qfq
      const day1Utc = new Date(Date.UTC(2026, 6, 23));
      const day2Utc = new Date(Date.UTC(2026, 6, 24));
      const raw = await ctx.repos.dailyBar.latestRawBefore('600519.SH', day2Utc);
      expect(raw?.date).toEqual(day2Utc);
      expect(raw?.close).toBeCloseTo(50, 6);

      // 读边界投影：day1 的 qfq = 100 × 0.99
      const bars = await ctx.repos.dailyBar.findInRange('600519.SH', day1Utc, day2Utc);
      expect(bars[0]?.close).toBeCloseTo(99, 6);
      expect(bars[1]?.close).toBeCloseTo(50, 6);

      const factors = await ctx.repos.adjustmentFactor.listAfter(
        '600519.SH',
        new Date(day1Utc.getTime() - 86_400_000),
      );
      expect(factors).toHaveLength(1);
      expect(factors[0]?.exDate).toEqual(day2Utc);
      expect(factors[0]?.factor).toBeCloseTo(0.99, 9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未配置 marketDump 时返回 invalid_input', async () => {
    const ctx = await buildTestContext();
    const result = await syncMarketDumpTool.execute({ kind: 'auto' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
