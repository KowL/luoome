import { openAsBlob } from 'node:fs';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

import { tableFromIPC } from 'apache-arrow';
import { ParquetFile, type RecordBatch } from 'parquet-wasm/node';

import { invalidPayloadError } from '../source-error.js';

/**
 * parquet-wasm 流式行迭代（设计 §5.2.5/5.2.6，Phase 0 证据 §2/§5）。
 *
 * - ParquetFile.fromFile(Blob) + .stream({batchSize}) 逐 RecordBatch 读取，不整文件载入内存；
 * - 每个 batch 经 intoIPCStream → tableFromIPC 转 apache-arrow 后按行产出；
 * - 读取前按 kind 校验精确列集合（schema 漂移整批失败）；行级不变量（interval=1d /
 *   adjusted=none / CNY）逐行校验，任一行违例整批失败；
 * - offset 用于 checkpoint 恢复：跳过前 offset 行后继续产出（行号为全文件 0 基行序）。
 *
 * 列集合以真实 artifact 取证为准（Phase 0 契约记录 §2.2/§2.3）：
 * - daily-k / daily-k-10d：11 列（thscode/date_ms/OHLC/volume/turnover/currency/interval/adjusted），
 *   OHLC 列名是 open_price/high_price/low_price/close_price；
 * - adjustment-factors：8 列（ticker/ex_date_ms/dividend_per_share/per_share_bonus/
 *   allotment_ratio/allotment_price/currency），股票标识列名是 ticker（6 位数字，无后缀）。
 */

/** dump 日 K 行（raw，未复权）。 */
export interface DumpDailyKRow {
  readonly rowIndex: number;
  readonly thscode: string;
  readonly dateMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly turnover: number | null;
}

/** dump 复权事件行（含配股字段；在线端点没有这两列）。ticker 为 6 位数字代码。 */
export interface DumpAdjustmentFactorRow {
  readonly rowIndex: number;
  readonly thscode: string;
  readonly ticker: string;
  readonly exDateMs: number;
  readonly dividendPerShare: number;
  readonly perShareBonus: number;
  readonly allotmentRatio: number | null;
  readonly allotmentPrice: number | null;
}

export type DumpRow = DumpDailyKRow | DumpAdjustmentFactorRow;

const DAILY_K_COLUMNS = [
  'thscode',
  'date_ms',
  'open_price',
  'high_price',
  'low_price',
  'close_price',
  'volume',
  'turnover',
  'currency',
  'interval',
  'adjusted',
] as const;

/**
 * adjustment-factors dump 精确列集合（Phase 0 契约记录 §2.3：8 列，含 ticker 与
 * allotment_ratio/allotment_price）。
 */
const ADJUSTMENT_FACTOR_COLUMNS = [
  'thscode',
  'ticker',
  'ex_date_ms',
  'dividend_per_share',
  'per_share_bonus',
  'allotment_ratio',
  'allotment_price',
  'currency',
] as const;

const fail = (message: string): never => {
  throw invalidPayloadError(`market-dump parquet: ${message}`);
};

const requireColumns = (actual: readonly string[], expected: readonly string[]): void => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((column) => !actualSet.has(column));
  const extra = actual.filter((column) => !expectedSet.has(column));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `schema 漂移：缺失列 [${missing.join(',') || '无'}]，多余列 [${extra.join(',') || '无'}]（实际列：${actual.join(',')}）`,
    );
  }
};

const asString = (value: unknown, column: string, rowIndex: number): string => {
  if (typeof value !== 'string') {
    return fail(`行 ${rowIndex} 列 ${column} 期望 Utf8，实际 ${typeof value}`);
  }
  return value;
};

const asNumber = (value: unknown, column: string, rowIndex: number): number => {
  if (typeof value !== 'bigint' && typeof value !== 'number') {
    return fail(`行 ${rowIndex} 列 ${column} 期望数值，实际 ${typeof value}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (typeof value === 'bigint' && !Number.isSafeInteger(number))) {
    return fail(`行 ${rowIndex} 列 ${column} 数值非有限或超出精确整数范围`);
  }
  return number;
};

const asNonnegativeNumber = (value: unknown, column: string, rowIndex: number): number => {
  const number = asNumber(value, column, rowIndex);
  if (number < 0) return fail(`行 ${rowIndex} 列 ${column} 期望非负数`);
  return number;
};

const asPrice = (value: unknown, column: string, rowIndex: number): number => {
  const number = asNonnegativeNumber(value, column, rowIndex);
  if (number === 0) return fail(`行 ${rowIndex} 列 ${column} 期望正数`);
  return number;
};

const asDateMs = (value: unknown, column: string, rowIndex: number): number => {
  const ms = asNumber(value, column, rowIndex);
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms + 8 * 3_600_000).getTime())) {
    return fail(`行 ${rowIndex} 列 ${column} 日期毫秒无效`);
  }
  return ms;
};

const asNullableNumber = (value: unknown, column: string, rowIndex: number): number | null => {
  if (value === null || value === undefined) return null;
  return asNonnegativeNumber(value, column, rowIndex);
};

export interface ParquetRowCursorOptions {
  readonly batchSize?: number;
  /** 跳过前 N 行（checkpoint 恢复）。 */
  readonly offset?: number;
}

const DEFAULT_BATCH_SIZE = 8192;

/** intoIPCStream 会消费并释放 WASM schema/batch，转换后不得再次 free。 */
const schemaColumnNames = (file: ParquetFile): readonly string[] =>
  tableFromIPC(file.schema().intoIPCStream()).schema.fields.map((field) => field.name);

/** 流式迭代 dump 日 K 行；schema 或不变量违例抛 SourceExecutionError(invalid_payload)。 */
export async function* iterateDailyKRows(
  localPath: string,
  options: ParquetRowCursorOptions = {},
): AsyncGenerator<DumpDailyKRow> {
  const file = await ParquetFile.fromFile(await openAsBlob(localPath));
  let reader: ReadableStreamDefaultReader<RecordBatch> | undefined;
  try {
    requireColumns(schemaColumnNames(file), DAILY_K_COLUMNS);
    const stream = await file.stream({
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
    });
    let rowIndex = options.offset ?? 0;
    reader = stream.getReader();
    for (;;) {
      const { done, value: wasmBatch } = await reader.read();
      if (done) break;
      const table = tableFromIPC(wasmBatch.intoIPCStream());
      for (const row of table) {
        if (row === null) continue;
        const record: Record<string, unknown> = row;
        const interval = asString(record.interval, 'interval', rowIndex);
        const adjusted = asString(record.adjusted, 'adjusted', rowIndex);
        const currency = asString(record.currency, 'currency', rowIndex);
        if (interval !== '1d') fail(`行 ${rowIndex} interval=${interval}（期望 1d）`);
        if (adjusted !== 'none') fail(`行 ${rowIndex} adjusted=${adjusted}（期望 none）`);
        if (currency !== 'CNY') fail(`行 ${rowIndex} currency=${currency}（期望 CNY）`);
        yield {
          rowIndex,
          thscode: asString(record.thscode, 'thscode', rowIndex),
          dateMs: asDateMs(record.date_ms, 'date_ms', rowIndex),
          open: asPrice(record.open_price, 'open_price', rowIndex),
          high: asPrice(record.high_price, 'high_price', rowIndex),
          low: asPrice(record.low_price, 'low_price', rowIndex),
          close: asPrice(record.close_price, 'close_price', rowIndex),
          volume: asNonnegativeNumber(record.volume, 'volume', rowIndex),
          turnover: asNullableNumber(record.turnover, 'turnover', rowIndex),
        };
        rowIndex += 1;
      }
    }
  } finally {
    try {
      if (reader !== undefined) {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      file.free();
    }
  }
}

/** 流式迭代 dump 复权事件行。 */
export async function* iterateAdjustmentFactorRows(
  localPath: string,
  options: ParquetRowCursorOptions = {},
): AsyncGenerator<DumpAdjustmentFactorRow> {
  const file = await ParquetFile.fromFile(await openAsBlob(localPath));
  let reader: ReadableStreamDefaultReader<RecordBatch> | undefined;
  try {
    requireColumns(schemaColumnNames(file), ADJUSTMENT_FACTOR_COLUMNS);
    const stream = await file.stream({
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
    });
    let rowIndex = options.offset ?? 0;
    reader = stream.getReader();
    for (;;) {
      const { done, value: wasmBatch } = await reader.read();
      if (done) break;
      const table = tableFromIPC(wasmBatch.intoIPCStream());
      for (const row of table) {
        if (row === null) continue;
        const record: Record<string, unknown> = row;
        const currency = asString(record.currency, 'currency', rowIndex);
        if (currency !== 'CNY') fail(`行 ${rowIndex} currency=${currency}（期望 CNY）`);
        const perShareBonus = asNumber(record.per_share_bonus, 'per_share_bonus', rowIndex);
        if (perShareBonus <= -1) fail(`行 ${rowIndex} per_share_bonus 必须大于 -1`);
        yield {
          rowIndex,
          thscode: asString(record.thscode, 'thscode', rowIndex),
          ticker: asString(record.ticker, 'ticker', rowIndex),
          exDateMs: asDateMs(record.ex_date_ms, 'ex_date_ms', rowIndex),
          dividendPerShare: asNonnegativeNumber(
            record.dividend_per_share,
            'dividend_per_share',
            rowIndex,
          ),
          perShareBonus,
          allotmentRatio: asNullableNumber(record.allotment_ratio, 'allotment_ratio', rowIndex),
          allotmentPrice: asNullableNumber(record.allotment_price, 'allotment_price', rowIndex),
        };
        rowIndex += 1;
      }
    }
  } finally {
    try {
      if (reader !== undefined) {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      file.free();
    }
  }
}
