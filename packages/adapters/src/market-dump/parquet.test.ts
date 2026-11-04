import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tableFromArrays, tableToIPC } from 'apache-arrow';
import {
  Compression,
  ParquetFile,
  Table,
  WriterPropertiesBuilder,
  writeParquet,
} from 'parquet-wasm/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { iterateAdjustmentFactorRows, iterateDailyKRows } from './parquet.js';

/**
 * parquet cursor 测试：小型生成 fixture（parquet-wasm 写入，ZSTD），不走网络下载。
 * 列集合对齐真实 artifact 取证（Phase 0 契约记录 §2.3）：
 * - daily-k 11 列（open_price/high_price/low_price/close_price）；
 * - adjustment-factors 8 列（ticker + allotment_*）；
 * - 同日多事件（契约记录 §2.2 三个重复 (thscode, ex_date_ms) 键）逐行保留。
 */

const DAY_MS = 1793635200000; // 2026-11-03 上海零点

let dir: string;

const writeParquetFixture = async (
  name: string,
  columns: Parameters<typeof tableFromArrays>[0],
): Promise<string> => {
  const table = tableFromArrays(columns);
  const wasmTable = Table.fromIPCStream(tableToIPC(table, 'stream'));
  const props = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
  const path = join(dir, name);
  await writeFile(path, writeParquet(wasmTable, props));
  return path;
};

const dailyKColumns = (
  overrides: Partial<Record<string, readonly unknown[]>> = {},
): Parameters<typeof tableFromArrays>[0] => ({
  thscode: ['600519.SH', '000001.SZ'],
  date_ms: [BigInt(DAY_MS), BigInt(DAY_MS)],
  open_price: [1450.0, 10.5],
  high_price: [1480.0, 10.8],
  low_price: [1435.1, 10.2],
  close_price: [1480.0, 10.6],
  volume: [7412056, 12345678],
  turnover: [10825780462.63, null],
  currency: ['CNY', 'CNY'],
  interval: ['1d', '1d'],
  adjusted: ['none', 'none'],
  ...overrides,
});

const adjustmentColumns = (
  overrides: Partial<Record<string, readonly unknown[]>> = {},
): Parameters<typeof tableFromArrays>[0] => ({
  thscode: ['600030.SH', '600030.SH', '600519.SH'],
  ticker: ['600030', '600030', '600519'],
  ex_date_ms: [1643212800000n, 1643212800000n, 1782403200000n],
  dividend_per_share: [0, 0.2, 28.02423],
  per_share_bonus: [0, 0.1, 0],
  allotment_ratio: [0.3, null, null],
  allotment_price: [5.5, null, null],
  currency: ['CNY', 'CNY', 'CNY'],
  ...overrides,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'market-dump-parquet-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parquet resource lifecycle', () => {
  it.each(['daily', 'adjustment'] as const)(
    '取消 %s 游标时 cancel/release reader 并 free file',
    async (kind) => {
      const path = await writeParquetFixture(
        `cancel-${kind}.parquet`,
        kind === 'daily' ? dailyKColumns() : adjustmentColumns(),
      );
      const free = vi.spyOn(ParquetFile.prototype, 'free');
      const streamImpl = ParquetFile.prototype.stream;
      const cancel = vi.fn();
      const release = vi.fn();
      const streamSpy = vi
        .spyOn(ParquetFile.prototype, 'stream')
        .mockImplementation(async function (this: ParquetFile, options) {
          const stream = await streamImpl.call(this, options);
          const reader = stream.getReader();
          const cancelImpl = reader.cancel.bind(reader);
          const releaseImpl = reader.releaseLock.bind(reader);
          vi.spyOn(reader, 'cancel').mockImplementation(async () => {
            cancel();
            await cancelImpl();
          });
          vi.spyOn(reader, 'releaseLock').mockImplementation(() => {
            release();
            releaseImpl();
          });
          vi.spyOn(stream, 'getReader').mockReturnValue(reader);
          return stream;
        });
      try {
        const rows =
          kind === 'daily'
            ? iterateDailyKRows(path, { batchSize: 1 })
            : iterateAdjustmentFactorRows(path, { batchSize: 1 });
        for await (const _ of rows) {
          void _;
          break;
        }
        expect(cancel).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(free).toHaveBeenCalledOnce();
      } finally {
        free.mockRestore();
        streamSpy.mockRestore();
      }
    },
  );

  it('schema 校验失败也 free file', async () => {
    const path = await writeParquetFixture('schema-free.parquet', { unexpected: [1] });
    const free = vi.spyOn(ParquetFile.prototype, 'free');
    try {
      await expect(async () => {
        for await (const _ of iterateDailyKRows(path)) void _;
      }).rejects.toThrow(/schema 漂移/);
      expect(free).toHaveBeenCalledOnce();
    } finally {
      free.mockRestore();
    }
  });
});

describe('iterateDailyKRows', () => {
  it.each([
    ['open_price', Number.NaN],
    ['close_price', Number.POSITIVE_INFINITY],
    ['volume', -1],
    ['open_price', 0],
    ['turnover', -1],
    ['date_ms', 9007199254740993n],
    ['date_ms', 8640000000000001n],
    ['date_ms', 1.5],
  ] as const)('非法数值 %s=%s 被行级边界拒绝', async (column, value) => {
    const path = await writeParquetFixture(
      `bad-number-${column}-${String(value)}.parquet`,
      dailyKColumns({ [column]: [value, value] }),
    );
    await expect(async () => {
      for await (const _ of iterateDailyKRows(path)) void _;
    }).rejects.toMatchObject({ kind: 'invalid_payload' });
  });
  it('按行产出 11 列日 K（含 null turnover），rowIndex 连续', async () => {
    const path = await writeParquetFixture('daily-k.parquet', dailyKColumns());
    const rows = [];
    for await (const row of iterateDailyKRows(path, { batchSize: 1 })) rows.push(row);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rowIndex: 0,
      thscode: '600519.SH',
      dateMs: DAY_MS,
      open: 1450.0,
      high: 1480.0,
      low: 1435.1,
      close: 1480.0,
      volume: 7412056,
      turnover: 10825780462.63,
    });
    expect(rows[1]?.rowIndex).toBe(1);
    expect(rows[1]?.turnover).toBeNull();
  });

  it('offset 跳过前 N 行（checkpoint 恢复），rowIndex 保持全文件行序', async () => {
    const path = await writeParquetFixture('daily-k-offset.parquet', dailyKColumns());
    const rows = [];
    for await (const row of iterateDailyKRows(path, { offset: 1 })) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rowIndex).toBe(1);
    expect(rows[0]?.thscode).toBe('000001.SZ');
  });

  it('schema 漂移（缺列/多列）整批失败并列出实际列', async () => {
    const drifted = dailyKColumns();
    delete (drifted as Record<string, unknown>).turnover;
    const path = await writeParquetFixture('daily-k-drift.parquet', {
      ...drifted,
      unexpected_col: [1, 2],
    });
    await expect(async () => {
      for await (const _ of iterateDailyKRows(path)) void _;
    }).rejects.toThrowError(/schema 漂移.*turnover.*unexpected_col/s);
  });

  it('行级不变量违例（interval != 1d）整批失败', async () => {
    const path = await writeParquetFixture(
      'daily-k-bad-interval.parquet',
      dailyKColumns({ interval: ['1d', '1m'] }),
    );
    const consume = async (): Promise<void> => {
      for await (const _ of iterateDailyKRows(path)) void _;
    };
    await expect(consume).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SourceExecutionError &&
        error.kind === 'invalid_payload' &&
        /行 1 interval=1m/.test(error.message),
    );
  });

  it('adjusted != none 与 currency != CNY 同样违例失败', async () => {
    const badAdjusted = await writeParquetFixture(
      'daily-k-bad-adjusted.parquet',
      dailyKColumns({ adjusted: ['none', 'forward'] }),
    );
    await expect(async () => {
      for await (const _ of iterateDailyKRows(badAdjusted)) void _;
    }).rejects.toThrowError(/行 1 adjusted=forward/);

    const badCurrency = await writeParquetFixture(
      'daily-k-bad-currency.parquet',
      dailyKColumns({ currency: ['CNY', 'USD'] }),
    );
    await expect(async () => {
      for await (const _ of iterateDailyKRows(badCurrency)) void _;
    }).rejects.toThrowError(/行 1 currency=USD/);
  });
});

describe('iterateAdjustmentFactorRows', () => {
  it('保留实测负股数变动比例，不当作负现金或负配股拒绝', async () => {
    const path = await writeParquetFixture(
      'negative-share-change.parquet',
      adjustmentColumns({ per_share_bonus: [-0.67335, -0.87581, 0] }),
    );
    const rows = [];
    for await (const row of iterateAdjustmentFactorRows(path)) rows.push(row);
    expect(rows.map((row) => row.perShareBonus)).toEqual([-0.67335, -0.87581, 0]);
  });
  it.each([
    ['ex_date_ms', 8640000000000001n],
    ['dividend_per_share', Number.NaN],
    ['per_share_bonus', -1],
    ['allotment_price', Number.POSITIVE_INFINITY],
    ['allotment_ratio', -1],
  ] as const)('非法事件数值 %s=%s 被拒绝', async (column, value) => {
    const path = await writeParquetFixture(
      `bad-event-${column}-${String(value)}.parquet`,
      adjustmentColumns({ [column]: [value, value, value] }),
    );
    await expect(async () => {
      for await (const _ of iterateAdjustmentFactorRows(path)) void _;
    }).rejects.toMatchObject({ kind: 'invalid_payload' });
  });
  it('按行产出 8 列复权事件；同日多事件逐行保留（契约记录 §2.2）', async () => {
    const path = await writeParquetFixture('adjustment.parquet', adjustmentColumns());
    const rows = [];
    for await (const row of iterateAdjustmentFactorRows(path, { batchSize: 2 })) rows.push(row);
    expect(rows).toHaveLength(3);
    // 600030 配股行：allotment 成对存在
    expect(rows[0]).toEqual({
      rowIndex: 0,
      thscode: '600030.SH',
      ticker: '600030',
      exDateMs: 1643212800000,
      dividendPerShare: 0,
      perShareBonus: 0,
      allotmentRatio: 0.3,
      allotmentPrice: 5.5,
    });
    // 同日第二事件（现金+送转拆行）：allotment 为 null
    expect(rows[1]?.exDateMs).toBe(1643212800000);
    expect(rows[1]?.dividendPerShare).toBe(0.2);
    expect(rows[1]?.perShareBonus).toBe(0.1);
    expect(rows[1]?.allotmentRatio).toBeNull();
    expect(rows[1]?.allotmentPrice).toBeNull();
    expect(rows[2]?.ticker).toBe('600519');
  });

  it('schema 漂移（缺 allotment_price）整批失败', async () => {
    const drifted = adjustmentColumns();
    delete (drifted as Record<string, unknown>).allotment_price;
    const path = await writeParquetFixture('adjustment-drift.parquet', drifted);
    await expect(async () => {
      for await (const _ of iterateAdjustmentFactorRows(path)) void _;
    }).rejects.toThrowError(/schema 漂移.*allotment_price/s);
  });

  it('currency != CNY 整批失败', async () => {
    const path = await writeParquetFixture(
      'adjustment-bad-currency.parquet',
      adjustmentColumns({ currency: ['CNY', 'CNY', 'HKD'] }),
    );
    await expect(async () => {
      for await (const _ of iterateAdjustmentFactorRows(path)) void _;
    }).rejects.toThrowError(/行 2 currency=HKD/);
  });
});
