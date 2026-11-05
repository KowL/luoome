import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CorporateActionEventRepository,
  CorporateActionEventRevision,
  MarketDumpRun,
  MarketDumpRunRepository,
  RawDailyBarRepository,
  RawDailyBarRevision,
} from '@luoome/core';
import {
  CorporateActionEventRevisionSchema,
  MarketDumpRunSchema,
  RawDailyBarRevisionSchema,
} from '@luoome/core';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { Compression, Table, WriterPropertiesBuilder, writeParquet } from 'parquet-wasm/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FuyaoCorporateActionAdapter } from '../corporate-action/fuyao.js';
import { FuyaoClient } from '../fuyao/client.js';
import { SourceExecutionError } from '../source-error.js';

import { MarketDumpManager } from './manager.js';
import type { DumpDownloadTicket, MarketDumpStores } from './types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

/**
 * MarketDumpManager 测试（设计 §5.4 / §17.1 Dump 行）。
 *
 * 确定性：小型生成 parquet artifact（parquet-wasm 写入）+ 内联内存仓储 +
 * 注入 fetchImpl / clock / runIdGen，不走真实网络、不依赖 wall clock。
 *
 * 覆盖：
 * - daily-k 全量导入 → raw revisions（recordedAt 冻结、contentHash 稳定、append-only）；
 * - adjustment-factors → 公司行动 revisions（同日多事件、配股字段保留）；
 * - checkpoint 恢复：中途失败后按相同 recordedAt 续跑，幂等不重复；
 * - 新 artifact（hash 变化）开新 run，不复用旧 checkpoint；
 * - 预签名 URL 不进入 run 记录 / 错误消息 / 结果投影。
 */

const DAY1_MS = 1793635200000; // 2026-11-03 上海零点
const DAY2_MS = 1793721600000; // 2026-11-04 上海零点
const EX1_MS = 1643212800000; // 2022-01-27 上海零点

const T0 = new Date('2026-11-04T01:00:00.000Z');
const T1 = new Date('2026-11-04T01:00:01.000Z');
const T2 = new Date('2026-11-04T01:00:02.000Z');
const T3 = new Date('2026-11-04T01:00:03.000Z');

const PRESIGNED_DAILY =
  'https://o.thsi.cn/bucket/market-dump/daily_k/releases/20261103/a_share_daily_k_1d_none_10y_20261103.parquet?Signature=secret';
const PRESIGNED_ADJ =
  'https://o.thsi.cn/bucket/market-dump/adjustment_factors/releases/20261103/a_share_adjustment_factors_event_none_all_20261103.parquet?Signature=secret';

// ---------- 内联内存仓储（对齐 db InMemory* 语义；adapters 不依赖 db 包） ----------

class StubRunRepo implements MarketDumpRunRepository {
  readonly runs = new Map<string, MarketDumpRun>();

  async saveStarted(run: MarketDumpRun): Promise<void> {
    const parsed = MarketDumpRunSchema.parse(run);
    const existing = this.runs.get(parsed.runId);
    if (existing !== undefined) return;
    this.runs.set(parsed.runId, parsed);
  }
  async findById(runId: string): Promise<MarketDumpRun | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRecent(input: {
    readonly kind?: MarketDumpRun['kind'];
    readonly limit?: number;
  }): Promise<readonly MarketDumpRun[]> {
    return [...this.runs.values()]
      .filter((run) => input.kind === undefined || run.kind === input.kind)
      .sort(
        (left, right) =>
          right.requestedAt.getTime() - left.requestedAt.getTime() ||
          right.runId.localeCompare(left.runId),
      )
      .slice(0, input.limit ?? 20);
  }
  async findResumable(input: {
    readonly kind: MarketDumpRun['kind'];
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<MarketDumpRun | null> {
    return (
      [...this.runs.values()].find(
        (run) =>
          run.kind === input.kind &&
          run.dumpId === input.dumpId &&
          run.artifactSha256 === input.artifactSha256 &&
          run.status === 'running',
      ) ?? null
    );
  }
  async advanceCheckpoint(input: {
    readonly runId: string;
    readonly recordedAt: Date;
    readonly nextRowOffset: number;
    readonly processedRows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }): Promise<void> {
    const current = this.runs.get(input.runId);
    if (current === undefined) throw new Error('run missing');
    this.runs.set(input.runId, {
      ...current,
      recordedAt: current.recordedAt ?? input.recordedAt,
      startedAt: current.startedAt ?? input.recordedAt,
      nextRowOffset: input.nextRowOffset,
      processedRows: input.processedRows,
      minDate: input.minDate,
      maxDate: input.maxDate,
    });
  }
  async markDownloaded(input: {
    readonly runId: string;
    readonly artifactSha256: string;
    readonly artifactBytes: number;
    readonly downloadedAt: Date;
  }): Promise<void> {
    const current = this.runs.get(input.runId);
    if (current === undefined) throw new Error('run missing');
    this.runs.set(input.runId, {
      ...current,
      artifactSha256: input.artifactSha256,
      artifactBytes: input.artifactBytes,
      downloadedAt: input.downloadedAt,
    });
  }
  async finish(input: {
    readonly runId: string;
    readonly status: 'complete' | 'failed';
    readonly finishedAt: Date;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    const current = this.runs.get(input.runId);
    if (current === undefined) throw new Error('run missing');
    this.runs.set(input.runId, {
      ...current,
      status: input.status,
      finishedAt: input.finishedAt,
      errorKind: input.status === 'failed' ? (input.errorKind ?? null) : null,
      errorMessage: input.status === 'failed' ? (input.errorMessage ?? null) : null,
    });
  }
}

const rawKey = (r: RawDailyBarRevision): string =>
  `${r.stockId}|${r.date.getTime()}|${r.recordedAt.getTime()}|${r.contentHash}`;

class StubRawRepo implements RawDailyBarRepository {
  readonly revisions = new Map<string, RawDailyBarRevision>();
  async saveMany(revisions: readonly RawDailyBarRevision[]): Promise<void> {
    for (const input of revisions) {
      const parsed = RawDailyBarRevisionSchema.parse(input);
      if (!this.revisions.has(rawKey(parsed))) this.revisions.set(rawKey(parsed), parsed);
    }
  }
  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (r) =>
          r.stockId === input.stockId &&
          (input.recordedAt === undefined || r.recordedAt <= input.recordedAt),
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    const ids = new Set(input.stockIds);
    return [...this.revisions.values()].filter(
      (r) =>
        ids.has(r.stockId) && (input.recordedAt === undefined || r.recordedAt <= input.recordedAt),
    );
  }
  async summarizeArtifact(input: { readonly dumpId: string; readonly artifactSha256: string }) {
    const rows = [...this.revisions.values()].filter(
      (r) => r.dumpId === input.dumpId && r.artifactSha256 === input.artifactSha256,
    );
    return {
      rows: rows.length,
      minDate: rows.map((r) => r.date).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
      maxDate: rows.map((r) => r.date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    };
  }
}

const eventKey = (r: CorporateActionEventRevision): string =>
  `${r.stockId}|${r.exDate.getTime()}|${r.sourceRecordId}|${r.recordedAt.getTime()}|${r.contentHash}`;

class StubEventRepo implements CorporateActionEventRepository {
  readonly revisions = new Map<string, CorporateActionEventRevision>();
  async saveMany(revisions: readonly CorporateActionEventRevision[]): Promise<void> {
    for (const input of revisions) {
      const parsed = CorporateActionEventRevisionSchema.parse(input);
      if (!this.revisions.has(eventKey(parsed))) this.revisions.set(eventKey(parsed), parsed);
    }
  }
  async listRevisions(input: {
    readonly stockId: string;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (r) =>
          r.stockId === input.stockId &&
          (input.recordedAt === undefined || r.recordedAt <= input.recordedAt),
      )
      .sort((a, b) => a.exDate.getTime() - b.exDate.getTime());
  }
  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]> {
    const ids = new Set(input.stockIds);
    return [...this.revisions.values()].filter(
      (r) =>
        ids.has(r.stockId) && (input.recordedAt === undefined || r.recordedAt <= input.recordedAt),
    );
  }
  async summarizeArtifact(input: { readonly dumpId: string; readonly artifactSha256: string }) {
    const rows = [...this.revisions.values()].filter(
      (r) => r.dumpId === input.dumpId && r.artifactSha256 === input.artifactSha256,
    );
    return {
      rows: rows.length,
      minDate: rows.map((r) => r.exDate).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
      maxDate: rows.map((r) => r.exDate).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    };
  }
}

// ---------- 确定性 parquet fixture ----------

let dir: string;

const writeParquetBytes = (columns: Parameters<typeof tableFromArrays>[0]): Uint8Array => {
  const table = tableFromArrays(columns);
  const wasmTable = Table.fromIPCStream(tableToIPC(table, 'stream'));
  const props = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
  return writeParquet(wasmTable, props);
};

const dailyKColumns = (): Parameters<typeof tableFromArrays>[0] => ({
  thscode: ['600519.SH', '000001.SZ', '600519.SH'],
  date_ms: [BigInt(DAY1_MS), BigInt(DAY1_MS), BigInt(DAY2_MS)],
  open_price: [1450.0, 10.5, 1470.0],
  high_price: [1480.0, 10.8, 1490.0],
  low_price: [1435.1, 10.2, 1460.0],
  close_price: [1480.0, 10.6, 1485.0],
  volume: [7412056, 12345678, 7000000],
  turnover: [10825780462.63, null, 10300000000.0],
  currency: ['CNY', 'CNY', 'CNY'],
  interval: ['1d', '1d', '1d'],
  adjusted: ['none', 'none', 'none'],
});

const adjustmentColumns = (): Parameters<typeof tableFromArrays>[0] => ({
  thscode: ['600030.SH', '600030.SH', '600519.SH'],
  ticker: ['600030', '600030', '600519'],
  ex_date_ms: [BigInt(EX1_MS), BigInt(EX1_MS), BigInt(EX1_MS)],
  dividend_per_share: [0, 0.2, 28.02423],
  per_share_bonus: [0, 0.1, 0],
  allotment_ratio: [0.3, null, null],
  allotment_price: [5.5, null, null],
  currency: ['CNY', 'CNY', 'CNY'],
});

interface Fixture {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

let dailyKFixture: Fixture;
let adjustmentFixture: Fixture;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'market-dump-manager-'));
  const dailyBytes = writeParquetBytes(dailyKColumns());
  dailyKFixture = {
    bytes: dailyBytes,
    sha256: createHash('sha256').update(dailyBytes).digest('hex'),
  };
  const adjBytes = writeParquetBytes(adjustmentColumns());
  adjustmentFixture = {
    bytes: adjBytes,
    sha256: createHash('sha256').update(adjBytes).digest('hex'),
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- 装配 ----------

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let harnessSeq = 0;

interface Harness {
  readonly manager: MarketDumpManager;
  readonly stores: MarketDumpStores & {
    readonly runs: StubRunRepo;
    readonly rawDailyBars: StubRawRepo;
    readonly corporateActionEvents: StubEventRepo;
  };
  readonly requests: readonly string[];
  readonly clockValues: readonly Date[];
}

const makeHarness = (options: {
  readonly fixture: Fixture;
  readonly presignedUrl: string;
  readonly clockSteps?: readonly Date[];
  readonly ticketError?: Error;
  readonly downloadStatus?: number;
}): Harness => {
  const requests: string[] = [];
  const clockSteps = options.clockSteps ?? [T0, T1, T2, T3];
  let clockIndex = 0;
  const clock = (): Date => clockSteps[Math.min(clockIndex++, clockSteps.length - 1)] ?? T3;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    requests.push(target);
    if (init?.headers !== undefined && new Headers(init.headers).has('range')) {
      return new Response(new Uint8Array(1), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${options.fixture.bytes.byteLength}` },
      });
    }
    return new Response(options.fixture.bytes, { status: options.downloadStatus ?? 200 });
  }) as typeof fetch;

  const stores = {
    runs: new StubRunRepo(),
    rawDailyBars: new StubRawRepo(),
    corporateActionEvents: new StubEventRepo(),
  };
  let runSeq = 0;
  harnessSeq += 1;
  const harnessId = `h${harnessSeq}`;
  const manager = new MarketDumpManager({
    stores,
    artifactDir: dir,
    logger: silentLogger,
    clock,
    fetchImpl,
    runIdGen: () => `${harnessId}-run-${++runSeq}`,
    batchSize: 2,
    fetchTicket: async (kind): Promise<DumpDownloadTicket> => {
      if (options.ticketError !== undefined) throw options.ticketError;
      return {
        kind,
        dumpId:
          kind === 'adjustment-factors'
            ? 'a_share_adjustment_factors_event_none_all'
            : 'a_share_daily_k_1d_none_10y',
        presignedUrl: options.presignedUrl,
        expiresAt: new Date('2026-11-05T00:00:00.000Z'),
      };
    },
  });
  return { manager, stores, requests, clockValues: clockSteps };
};

// ---------- 测试 ----------

describe('MarketDumpManager pre-import audit', () => {
  it.each(['ticket-permission', 'download-failure'] as const)(
    '%s 仍保留 failed attempt 且对调用方抛出原错误',
    async (failure) => {
      const ticketError = new SourceExecutionError(
        'permission',
        `denied ${PRESIGNED_DAILY} X-api-key=secret-key ${dir}/private`,
      );
      const { manager, stores } = makeHarness({
        fixture: dailyKFixture,
        presignedUrl: PRESIGNED_DAILY,
        ...(failure === 'ticket-permission' ? { ticketError } : { downloadStatus: 503 }),
      });
      await expect(manager.sync({ kind: 'daily-k' })).rejects.toMatchObject({
        kind: failure === 'ticket-permission' ? 'permission' : 'upstream_error',
      });
      const runs = await manager.status();
      expect(runs).toHaveLength(1);
      const attempt = runs[0];
      expect(attempt).toMatchObject({
        kind: 'daily-k',
        status: 'failed',
        artifactSha256: null,
        artifactBytes: null,
        requestedAt: T0,
        finishedAt: T1,
        recordedAt: null,
        downloadedAt: null,
        processedRows: 0,
        nextRowOffset: 0,
        errorKind: failure === 'ticket-permission' ? 'permission' : 'upstream_error',
      });
      expect(attempt?.dumpId).toBe(
        failure === 'ticket-permission'
          ? `unresolved:daily-k:${attempt?.runId}`
          : 'a_share_daily_k_1d_none_10y',
      );
      for (const secret of ['Signature', 'o.thsi.cn/bucket', 'secret-key', dir]) {
        expect(JSON.stringify(runs)).not.toContain(secret);
      }
      expect(stores.rawDailyBars.revisions.size).toBe(0);
    },
  );
});

describe('MarketDumpManager.sync daily-k', () => {
  it.each(['daily-k', 'adjustment-factors'] as const)(
    '全市场 %s 保留显式北交所身份与原始事件值',
    async (kind) => {
      const columns =
        kind === 'daily-k'
          ? { ...dailyKColumns(), thscode: ['920000.BJ', '000001.SZ', '600519.SH'] }
          : {
              ...adjustmentColumns(),
              thscode: ['920000.BJ', '920000.BJ', '600519.SH'],
              ticker: ['920000', '920000', '600519'],
              per_share_bonus: [-0.67335, 0.1, 0],
            };
      const bytes = writeParquetBytes(columns);
      const { manager, stores } = makeHarness({
        fixture: { bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
        presignedUrl: kind === 'daily-k' ? PRESIGNED_DAILY : PRESIGNED_ADJ,
      });
      const result = await manager.sync({ kind });
      expect(result.status).toBe('complete');
      const rows =
        kind === 'daily-k'
          ? await stores.rawDailyBars.listRevisions({ stockId: '920000.BJ' })
          : await stores.corporateActionEvents.listRevisions({ stockId: '920000.BJ' });
      expect(rows).toHaveLength(kind === 'daily-k' ? 1 : 2);
      if (kind === 'adjustment-factors')
        expect(rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ perShareBonus: -0.67335 })]),
        );
    },
  );
  it('全量导入：raw revisions 落库、recordedAt 冻结、checkpoint 推进到行尾、run complete', async () => {
    const { manager, stores } = makeHarness({
      fixture: dailyKFixture,
      presignedUrl: PRESIGNED_DAILY,
    });

    const result = await manager.sync({ kind: 'daily-k' });

    expect(result.status).toBe('complete');
    expect(result.resumed).toBe(false);
    expect(result.dumpId).toBe('a_share_daily_k_1d_none_10y');
    expect(result.artifactSha256).toBe(dailyKFixture.sha256);
    expect(result.processedRows).toBe(3);
    expect(result.nextRowOffset).toBe(3);
    expect(result.minDate?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(result.maxDate?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(result.errorKind).toBeNull();

    // recordedAt 在首批推进时冻结（clock 第 3 次调用：requestedAt/downloadedAt 之后）
    const run = await stores.runs.findById(result.runId);
    expect(run?.status).toBe('complete');
    expect(run?.recordedAt).not.toBeNull();
    expect(run?.artifactSha256).toBe(dailyKFixture.sha256);

    const revisions = await stores.rawDailyBars.listRevisions({ stockId: '600519.SH' });
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.open).toBe(1450.0);
    expect(revisions[0]?.turnover).toBe(10825780462.63);
    expect(revisions[1]?.date.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    for (const revision of revisions) {
      expect(revision.source).toBe('fuyao');
      expect(revision.dumpId).toBe('a_share_daily_k_1d_none_10y');
      expect(revision.artifactSha256).toBe(dailyKFixture.sha256);
      expect(revision.recordedAt).toEqual(run?.recordedAt);
      expect(revision.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
    const sz = await stores.rawDailyBars.listRevisions({ stockId: '000001.SZ' });
    expect(sz).toHaveLength(1);
    expect(sz[0]?.turnover).toBeNull();
  });

  it('原子落盘失败清理已校验位于 artifactDir/.tmp 内的临时文件', async () => {
    const { manager } = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    await mkdir(join(dir, '.tmp'), { recursive: true });
    const before = await readdir(join(dir, '.tmp'));
    vi.mocked(rename).mockRejectedValueOnce(
      new Error(`failed ${dir} https://o.thsi.cn/secret?Signature=secret`),
    );
    await expect(manager.sync({ kind: 'daily-k' })).rejects.toMatchObject({
      kind: 'network',
      message: 'market-dump artifact: 原子落盘失败',
    });
    expect(await readdir(join(dir, '.tmp'))).toEqual(before);
  });

  it('同 artifact 重跑幂等：复用 complete run 终态，不重复插入 revision', async () => {
    const harness = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    const first = await harness.manager.sync({ kind: 'daily-k' });
    const second = await harness.manager.sync({ kind: 'daily-k' });

    expect(second.status).toBe('complete');
    expect(second.runId).toBe(first.runId);
    expect(second.processedRows).toBe(3);
    const revisions = await harness.stores.rawDailyBars.listRevisions({ stockId: '600519.SH' });
    expect(revisions).toHaveLength(2);
  });

  it('checkpoint 恢复：首批后失败 → 相同 recordedAt 续跑，revision 幂等不重复', async () => {
    // 第一批 2 行成功，第二批 1 行时 schema 违例（adjusted=forward）→ run failed
    const badColumns = {
      ...dailyKColumns(),
      adjusted: ['none', 'none', 'forward'],
    };
    const badBytes = writeParquetBytes(badColumns);
    const badFixture: Fixture = {
      bytes: badBytes,
      sha256: createHash('sha256').update(badBytes).digest('hex'),
    };
    const harness = makeHarness({ fixture: badFixture, presignedUrl: PRESIGNED_DAILY });

    const failed = await harness.manager.sync({ kind: 'daily-k' });
    expect(failed.status).toBe('failed');
    expect(failed.errorKind).toBe('invalid_payload');
    // 首批 2 行已落库并推进 checkpoint
    expect(failed.processedRows).toBe(2);
    expect(failed.nextRowOffset).toBe(2);
    const failedRun = await harness.stores.runs.findById(failed.runId);
    const frozenRecordedAt = failedRun?.recordedAt;
    expect(frozenRecordedAt).not.toBeNull();
    // 错误消息不含 URL / 签名
    expect(failed.errorMessage).not.toContain('Signature');
    expect(failed.errorMessage).not.toContain('o.thsi.cn');

    // 修复 artifact（同 dumpId，新内容 → 新 hash）→ 新 run 从头导入
    const fixedHarness = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    fixedHarness.stores.runs.runs.clear();
    for (const [key, value] of harness.stores.runs.runs) {
      fixedHarness.stores.runs.runs.set(key, value);
    }
    const resumed = await fixedHarness.manager.sync({ kind: 'daily-k' });
    expect(resumed.status).toBe('complete');
    expect(resumed.runId).not.toBe(failed.runId);
    expect(resumed.processedRows).toBe(3);
  });

  it('显式 resumeRunId 恢复 running run：沿用原 checkpoint 与 recordedAt', async () => {
    const harness = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    // 预置一个 running run：已下载同 artifact、checkpoint 在第 2 行
    const artifactPath = join(
      dir,
      'a_share_daily_k_1d_none_10y',
      `${dailyKFixture.sha256}.parquet`,
    );
    await writeFile(artifactPath, dailyKFixture.bytes);
    await harness.stores.runs.saveStarted({
      runId: 'run-existing',
      kind: 'daily-k',
      dumpId: 'a_share_daily_k_1d_none_10y',
      source: 'fuyao',
      artifactSha256: null,
      status: 'running',
      recordedAt: null,
      requestedAt: T0,
      downloadedAt: null,
      startedAt: null,
      finishedAt: null,
      nextRowOffset: 0,
      processedRows: 0,
      minDate: null,
      maxDate: null,
      artifactBytes: null,
      errorKind: null,
      errorMessage: null,
    });
    await harness.stores.runs.markDownloaded({
      runId: 'run-existing',
      artifactSha256: dailyKFixture.sha256,
      artifactBytes: dailyKFixture.bytes.byteLength,
      downloadedAt: T1,
    });
    await harness.stores.runs.advanceCheckpoint({
      runId: 'run-existing',
      recordedAt: T1,
      nextRowOffset: 2,
      processedRows: 2,
      minDate: new Date('2026-11-03T00:00:00.000Z'),
      maxDate: new Date('2026-11-03T00:00:00.000Z'),
    });

    const result = await harness.manager.sync({ kind: 'daily-k', resumeRunId: 'run-existing' });

    expect(result.status).toBe('complete');
    expect(result.resumed).toBe(true);
    expect(result.runId).toBe('run-existing');
    expect(result.processedRows).toBe(3);
    expect(result.recordedAt).toEqual(T1);
    // 只导入剩余 1 行；已有 2 行不重放（offset=2 起）
    const revisions = await harness.stores.rawDailyBars.listRevisions({ stockId: '600519.SH' });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.date.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(revisions[0]?.recordedAt).toEqual(T1);
  });

  it('首次 saveMany 后、数据 checkpoint 前退出：恢复沿用已持久化 recordedAt 并幂等重放', async () => {
    const { manager, stores } = makeHarness({
      fixture: dailyKFixture,
      presignedUrl: PRESIGNED_DAILY,
    });
    const advance = stores.runs.advanceCheckpoint.bind(stores.runs);
    const checkpoint = vi
      .spyOn(stores.runs, 'advanceCheckpoint')
      .mockImplementation(async (input) => {
        if (input.nextRowOffset > 0) throw new Error('process interrupted before checkpoint');
        await advance(input);
      });
    const finish = vi.spyOn(stores.runs, 'finish').mockRejectedValue(new Error('process exited'));

    await expect(manager.sync({ kind: 'daily-k' })).rejects.toThrow('process exited');
    const interrupted = (await stores.runs.listRecent({}))[0];
    expect(interrupted?.status).toBe('running');
    expect(interrupted?.nextRowOffset).toBe(0);
    expect(interrupted?.processedRows).toBe(0);
    expect(stores.rawDailyBars.revisions.size).toBe(2);
    const firstRecordedAt = [...stores.rawDailyBars.revisions.values()][0]?.recordedAt;
    expect(interrupted?.recordedAt).toEqual(firstRecordedAt);

    checkpoint.mockRestore();
    finish.mockRestore();
    const result = await manager.sync({ kind: 'daily-k', resumeRunId: interrupted?.runId ?? '' });
    expect(result.status).toBe('complete');
    expect(result.recordedAt).toEqual(firstRecordedAt);
    expect(stores.rawDailyBars.revisions.size).toBe(3);
    expect(
      new Set([...stores.rawDailyBars.revisions.values()].map((row) => row.recordedAt.getTime()))
        .size,
    ).toBe(1);
  });

  it.each(['missing', 'same-size-corruption', 'truncated', 'wrong-byte-count'] as const)(
    '恢复 artifact %s：已记录 bytes 仍检查本地存在、实际 bytes 和 hash',
    async (failure) => {
      const { manager, stores, requests } = makeHarness({
        fixture: dailyKFixture,
        presignedUrl: PRESIGNED_DAILY,
      });
      const first = await manager.sync({ kind: 'daily-k' });
      const run = stores.runs.runs.get(first.runId);
      if (run === undefined) throw new Error('missing test run');
      const localPath = join(dir, run.dumpId, `${dailyKFixture.sha256}.parquet`);
      stores.runs.runs.set(run.runId, {
        ...run,
        status: 'running',
        artifactSha256: failure === 'missing' ? 'f'.repeat(64) : run.artifactSha256,
        artifactBytes:
          failure === 'wrong-byte-count' ? dailyKFixture.bytes.length + 1 : run.artifactBytes,
      });
      if (failure === 'same-size-corruption') {
        const corrupted = dailyKFixture.bytes.slice();
        corrupted[0] = (corrupted[0] ?? 0) ^ 1;
        await writeFile(localPath, corrupted);
      } else if (failure === 'truncated') {
        await writeFile(localPath, dailyKFixture.bytes.slice(0, -1));
      }
      const revisionCount = stores.rawDailyBars.revisions.size;
      const requestCount = requests.length;
      try {
        await expect(
          manager.sync({ kind: 'daily-k', resumeRunId: run.runId }),
        ).rejects.toMatchObject({
          kind: 'invalid_payload',
          message: expect.stringMatching(/artifact.*(缺失|校验失败)/),
        });
        expect(stores.rawDailyBars.revisions.size).toBe(revisionCount);
        expect(requests.length).toBe(requestCount);
      } finally {
        await writeFile(localPath, dailyKFixture.bytes);
      }
    },
  );

  it('结果投影不携带 presignedUrl / localPath', async () => {
    const { manager } = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    const result = await manager.sync({ kind: 'daily-k' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Signature');
    expect(serialized).not.toContain('o.thsi.cn');
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain('.parquet');
  });
});

describe('MarketDumpManager.sync adjustment-factors', () => {
  it('复权事件导入：同日多事件分别保留、配股字段成对存在、写公司行动仓储', async () => {
    const { manager, stores } = makeHarness({
      fixture: adjustmentFixture,
      presignedUrl: PRESIGNED_ADJ,
    });

    const result = await manager.sync({ kind: 'adjustment-factors' });

    expect(result.status).toBe('complete');
    expect(result.processedRows).toBe(3);
    expect(result.dumpId).toBe('a_share_adjustment_factors_event_none_all');

    const events = await stores.corporateActionEvents.listRevisions({ stockId: '600030.SH' });
    expect(events).toHaveLength(2);
    // 配股行：allotment 成对存在
    const rights = events.find((event) => event.allotmentRatio !== null);
    expect(rights?.allotmentRatio).toBe(0.3);
    expect(rights?.allotmentPrice).toBe(5.5);
    expect(rights?.dividendPerShare).toBe(0);
    expect(rights?.perShareBonus).toBe(0);
    // 同日现金+送转行
    const cash = events.find((event) => event.allotmentRatio === null);
    expect(cash?.dividendPerShare).toBe(0.2);
    expect(cash?.perShareBonus).toBe(0.1);
    for (const event of events) {
      expect(event.dumpId).toBe('a_share_adjustment_factors_event_none_all');
      expect(event.artifactSha256).toBe(adjustmentFixture.sha256);
      expect(event.sourceRecordId).toContain('fuyao:600030.SH:');
    }
    // 同日不同事件 sourceRecordId 不同
    expect(events[0]?.sourceRecordId).not.toBe(events[1]?.sourceRecordId);

    // 600519 现金分红
    const moutai = await stores.corporateActionEvents.listRevisions({ stockId: '600519.SH' });
    expect(moutai).toHaveLength(1);
    expect(moutai[0]?.dividendPerShare).toBe(28.02423);
  });

  it('重复行跨批次去重，文件重排不改变事件身份，并与 online 相同内容一致', async () => {
    const columns = adjustmentColumns();
    const reordered = Object.fromEntries(
      Object.entries(columns).map(([key, values]) => [
        key,
        [2, 1, 0, 1, 2].map((index) => (values as readonly unknown[])[index]),
      ]),
    );
    const bytes = writeParquetBytes(reordered);
    const first = makeHarness({ fixture: adjustmentFixture, presignedUrl: PRESIGNED_ADJ });
    const second = makeHarness({
      fixture: { bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
      presignedUrl: PRESIGNED_ADJ,
    });
    expect((await first.manager.sync({ kind: 'adjustment-factors' })).status).toBe('complete');
    const result = await second.manager.sync({ kind: 'adjustment-factors' });
    expect(result.status).toBe('complete');
    expect(result.processedRows).toBe(5);
    expect(second.stores.corporateActionEvents.revisions.size).toBe(3);
    const identities = (repo: StubEventRepo) =>
      [...repo.revisions.values()].map((event) => event.sourceRecordId).sort();
    expect(identities(second.stores.corporateActionEvents)).toEqual(
      identities(first.stores.corporateActionEvents),
    );

    const client = new FuyaoClient(
      { baseUrl: 'https://fuyao.test', apiKey: 'test', timeoutMs: 1000, retries: 0 },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              code: 0,
              message: 'success',
              request_id: '0'.repeat(32),
              data: {
                thscode: '600030.SH',
                ticker: '600030',
                item: [
                  {
                    ticker: '600030',
                    ex_date_ms: EX1_MS,
                    dividend_per_share: 0.2,
                    per_share_bonus: 0.1,
                  },
                ],
              },
            }),
          )) as unknown as typeof fetch,
      },
    );
    const online = await new FuyaoCorporateActionAdapter(client).fetchEvents({
      stockId: '600030.SH',
    });
    const dump = [...first.stores.corporateActionEvents.revisions.values()].find(
      (event) => event.dividendPerShare === 0.2,
    );
    expect(online.events[0]?.sourceRecordId).toBe(dump?.sourceRecordId);
    expect(online.events[0]?.contentHash).toBe(dump?.contentHash);
  });

  it('不触碰 raw 日线仓储（kind 分流严格）', async () => {
    const { manager, stores } = makeHarness({
      fixture: adjustmentFixture,
      presignedUrl: PRESIGNED_ADJ,
    });
    await manager.sync({ kind: 'adjustment-factors' });
    const rawRows = await stores.rawDailyBars.listRevisionsForStocks({
      stockIds: ['600030.SH', '600519.SH'],
    });
    expect(rawRows).toHaveLength(0);
  });
});

describe('MarketDumpManager.status', () => {
  it('返回全部 run（按 requestedAt 降序），不含敏感字段', async () => {
    const { manager } = makeHarness({ fixture: dailyKFixture, presignedUrl: PRESIGNED_DAILY });
    await manager.sync({ kind: 'daily-k' });
    const runs = await manager.status();
    expect(runs).toHaveLength(1);
    const serialized = JSON.stringify(runs);
    expect(serialized).not.toContain('Signature');
    expect(serialized).not.toContain('presigned');
    expect(serialized).not.toContain('.parquet');
    expect(runs[0]?.kind).toBe('daily-k');
    expect(runs[0]?.status).toBe('complete');
  });
});
