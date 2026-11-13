import { readFileSync } from 'node:fs';

import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';

import { SourceExecutionError } from '../source-error.js';

/**
 * 市场 dump 的 Parquet 读取。
 *
 * 列名与类型由 fuyao 固定（见 docs/api-reference/market-dumps）：
 * - 日 K：`thscode / date_ms / open_price / high_price / low_price / close_price / volume / turnover`
 * - 复权因子：`thscode / ex_date_ms / dividend_per_share / per_share_bonus / allotment_ratio / allotment_price`
 *
 * int64 列在 Arrow 里是 BigInt，统一转 number（毫秒时间戳在安全整数范围内）。
 */

export interface DailyKDumpRow {
  readonly stockId: string;
  readonly dateMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number;
}

export interface AdjustmentFactorDumpRow {
  readonly stockId: string;
  readonly exDateMs: number;
  readonly dividendPerShare: number;
  readonly perShareBonus: number;
  readonly allotmentRatio: number;
  readonly allotmentPrice: number;
}

const loadTable = (path: string) => {
  try {
    const bytes = readFileSync(path);
    return tableFromIPC(readParquet(new Uint8Array(bytes)).intoIPCStream());
  } catch (error) {
    throw new SourceExecutionError(
      'invalid_payload',
      `market-dump: 读取 Parquet 失败（${error instanceof Error ? error.message : String(error)}）`,
      error,
    );
  }
};

const toNumber = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(value);
};

/** 按 batch 流式读取日 K，避免 10 年全量（千万行）一次性物化。 */
export function* iterateDailyKDumpRows(path: string): Generator<DailyKDumpRow> {
  const table = loadTable(path);
  for (const batch of table.batches) {
    for (let index = 0; index < batch.numRows; index += 1) {
      const row = batch.get(index);
      if (row === null) continue;
      yield {
        stockId: String(row.thscode),
        dateMs: toNumber(row.date_ms),
        open: toNumber(row.open_price),
        high: toNumber(row.high_price),
        low: toNumber(row.low_price),
        close: toNumber(row.close_price),
        volume: toNumber(row.volume),
        turnover: toNumber(row.turnover),
      };
    }
  }
}

export const readAdjustmentFactorDumpRows = (path: string): AdjustmentFactorDumpRow[] => {
  const table = loadTable(path);
  const rows: AdjustmentFactorDumpRow[] = [];
  for (const batch of table.batches) {
    for (let index = 0; index < batch.numRows; index += 1) {
      const row = batch.get(index);
      if (row === null) continue;
      rows.push({
        stockId: String(row.thscode),
        exDateMs: toNumber(row.ex_date_ms),
        dividendPerShare: toNumber(row.dividend_per_share),
        perShareBonus: toNumber(row.per_share_bonus),
        allotmentRatio: toNumber(row.allotment_ratio),
        allotmentPrice: toNumber(row.allotment_price),
      });
    }
  }
  return rows;
};
