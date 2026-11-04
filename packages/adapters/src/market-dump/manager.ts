import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { MarketDumpRun } from '@luoome/core';
import { corporateActionEventContent } from '@luoome/core';

import { SourceExecutionError, sourceErrorKindOf } from '../source-error.js';
import { downloadToFile, probeRemoteSize } from './downloader.js';
import type { DumpAdjustmentFactorRow, DumpDailyKRow } from './parquet.js';
import { iterateAdjustmentFactorRows, iterateDailyKRows } from './parquet.js';
import type {
  DumpArtifactRef,
  DumpDownloadTicket,
  MarketDumpManagerLike,
  MarketDumpManagerOptions,
  MarketDumpStores,
  MarketDumpSyncInput,
  MarketDumpSyncResult,
} from './types.js';

/**
 * MarketDumpManager（设计 §5：dump → artifact → 分批导入 → checkpoint 恢复）。
 *
 * 关键语义：
 * - recordedAt：写入任何 revision 前以原 offset 持久化冻结，恢复沿用；全部 revision
 *   共享同一 PIT 记录时间，后到的全量 dump 不会变成过去 cutoff 已可见的数据；
 * - 幂等：revision 主键 (stockId, date, recordedAt, contentHash) 保证同 recordedAt
 *   重放相同行不重复插入；进程在「写 revision」与「推进 checkpoint」之间退出时，
 *   下一执行以相同 recordedAt 重放相同行；
 * - 恢复：只有相同 (kind, dumpId, artifactSha256) 的 running run 可续跑；
 *   新文件（hash 变化）必须开新 run，不复用旧 checkpoint；
 * - append-only：同主键不同内容形成新 revision，不覆盖旧行；
 * - 安全：presignedUrl 只在下载内存中使用；错误消息经脱敏（不含 URL / 本地路径）；
 * - 隔离：raw 日 K 只写 RawDailyBarRepository，不写 daily_bars/daily_bar_revisions；
 *   公司行动只写 CorporateActionEventRepository，不触碰账户账本。
 */

const DEFAULT_BATCH_SIZE = 1000;

// 全市场 dump 含北交所；保留显式交易所，不能复用仅支持沪深在线行情的归一化器。
const normalizeDumpStockId = (thscode: string): string => {
  const stockId = thscode.trim().toUpperCase();
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(stockId)) {
    throw new SourceExecutionError('invalid_payload', 'market-dump: 股票身份格式不符');
  }
  return stockId;
};

/** 行内容 → 全量内容 hash（SHA-256；审计 / 幂等识别，不冒充上游 revision）。 */
const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex');

/** date_ms（上海零点毫秒）→ 该交易日 UTC 00:00（与 DailyBar.date 同约定）。 */
const msToTradingDate = (ms: number): Date => {
  const shifted = new Date(ms + 8 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

const rawDailyBarContent = (row: DumpDailyKRow, stockId: string, date: Date): string =>
  JSON.stringify({
    stockId,
    dateMs: date.getTime(),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    turnover: row.turnover,
    source: 'fuyao',
  });

/** 脱敏：错误消息不得携带 presigned URL 或本地文件路径（host 白名单保留）。 */
const sanitizeErrorMessage = (message: string): string =>
  message
    .replace(/https?:\/\/[^\s"'`]+/gi, '[redacted-url]')
    .replace(/(?:X-api-key|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted-credential]')
    .replace(
      /\/(?:Users|home|private|tmp|var|opt|etc|Volumes|workspace)\/[^\s"'`)]+/gi,
      '[redacted-path]',
    )
    .replace(/[A-Za-z]:\\[^\s"'`)]+/g, '[redacted-path]')
    .slice(0, 2000);

interface BatchState {
  rows: (DumpDailyKRow | DumpAdjustmentFactorRow)[];
  minDate: Date | null;
  maxDate: Date | null;
}

export class MarketDumpManager implements MarketDumpManagerLike {
  readonly name = 'market-dump' as const;

  private readonly stores: MarketDumpStores;
  private readonly artifactDir: string;
  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly runIdGen: () => string;
  private readonly batchSize: number;
  private readonly fetchTicket: (kind: MarketDumpSyncInput['kind']) => Promise<DumpDownloadTicket>;

  constructor(
    options: MarketDumpManagerOptions & {
      readonly fetchTicket: (kind: MarketDumpSyncInput['kind']) => Promise<DumpDownloadTicket>;
    },
  ) {
    this.stores = options.stores;
    this.artifactDir = options.artifactDir;
    this.clock = options.clock;
    this.fetchImpl = options.fetchImpl;
    this.runIdGen = options.runIdGen ?? ((): string => randomUUID());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.fetchTicket = options.fetchTicket;
  }

  async status(): Promise<readonly MarketDumpRun[]> {
    return this.stores.runs.listRecent({});
  }

  async sync(input: MarketDumpSyncInput): Promise<MarketDumpSyncResult> {
    const requestedAt = this.clock();
    let ticket: DumpDownloadTicket | undefined;
    let resumedRun: MarketDumpRun | null;
    let artifact: DumpArtifactRef;
    try {
      resumedRun = await this.findResumeCandidate(input);
      ticket = await this.fetchTicket(input.kind);
      artifact = await this.ensureArtifact(ticket, resumedRun);
    } catch (error) {
      const runId = this.runIdGen();
      const errorKind = sourceErrorKindOf(error);
      const errorMessage = sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      // 尚未取得上游身份时显式标为 unresolved；不伪造文件身份或破坏已有恢复点。
      await this.stores.runs.saveStarted({
        runId,
        kind: input.kind,
        dumpId: ticket?.dumpId ?? `unresolved:${input.kind}:${runId}`,
        source: 'fuyao',
        artifactSha256: null,
        status: 'running',
        recordedAt: null,
        requestedAt,
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
      await this.stores.runs.finish({
        runId,
        status: 'failed',
        finishedAt: this.clock(),
        errorKind,
        errorMessage,
      });
      throw new SourceExecutionError(errorKind, errorMessage);
    }

    const run = await this.openRun(input, artifact, resumedRun, requestedAt);
    if (run.status !== 'running') {
      // 幂等重放：同 (kind, dumpId, artifactSha256) 已 complete 的 run 直接返回终态投影。
      return this.toResult(run, resumedRun !== null);
    }

    try {
      await this.importArtifact(run, artifact);
      const finishedAt = this.clock();
      await this.stores.runs.finish({ runId: run.runId, status: 'complete', finishedAt });
      const done = await this.requireRun(run.runId);
      return this.toResult(done, resumedRun !== null);
    } catch (error) {
      const finishedAt = this.clock();
      await this.stores.runs.finish({
        runId: run.runId,
        status: 'failed',
        finishedAt,
        errorKind: sourceErrorKindOf(error),
        errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      const failed = await this.requireRun(run.runId);
      return this.toResult(failed, resumedRun !== null);
    }
  }

  /** 恢复候选：显式 resumeRunId 优先；否则按 kind 找最新 running run（dumpId 待下载后核对）。 */
  private async findResumeCandidate(input: MarketDumpSyncInput): Promise<MarketDumpRun | null> {
    if (input.resumeRunId !== undefined) {
      const run = await this.stores.runs.findById(input.resumeRunId);
      if (run === null) {
        throw new SourceExecutionError(
          'invalid_payload',
          `market-dump sync: resumeRunId ${input.resumeRunId} 不存在`,
        );
      }
      if (run.status !== 'running') {
        throw new SourceExecutionError(
          'invalid_payload',
          `market-dump sync: run ${input.resumeRunId} 已进入终态 ${run.status}，不能恢复`,
        );
      }
      if (run.kind !== input.kind) {
        throw new SourceExecutionError(
          'invalid_payload',
          `market-dump sync: run ${input.resumeRunId} kind=${run.kind} 与请求 ${input.kind} 不符`,
        );
      }
      return run;
    }
    const recent = await this.stores.runs.listRecent({ kind: input.kind, limit: 20 });
    return recent.find((run) => run.status === 'running') ?? null;
  }

  /**
   * 内容寻址 artifact：相同 (dumpId, sha256) 复用本地完整文件；内容变化生成新身份，
   * 不覆盖旧文件。下载到 .tmp/ 后原子 rename 到 <dumpId>/<artifactSha256>.parquet。
   */
  private async ensureArtifact(
    ticket: DumpDownloadTicket,
    resumedRun: MarketDumpRun | null,
  ): Promise<DumpArtifactRef> {
    const download = async (): Promise<{ bytes: number; sha256: string }> => {
      const tmpDir = resolve(this.artifactDir, '.tmp');
      const tmpPath = resolve(tmpDir, `${ticket.dumpId}-${this.runIdGen()}.parquet`);
      if (dirname(tmpPath) !== tmpDir) {
        throw new SourceExecutionError('invalid_payload', 'market-dump artifact: 临时文件路径无效');
      }
      const result = await downloadToFile(ticket.presignedUrl, tmpPath, {
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
      // 内容寻址落盘：相同 (dumpId, sha256) 路径一致，POSIX rename 覆盖同内容文件即复用；
      // 内容变化 → 新 sha256 → 新文件名，不覆盖旧文件。
      const finalDir = join(this.artifactDir, ticket.dumpId);
      const finalPath = join(finalDir, `${result.sha256}.parquet`);
      try {
        await mkdir(finalDir, { recursive: true });
        await rename(tmpPath, finalPath);
      } catch {
        await rm(tmpPath, { force: true }).catch(() => {
          throw new SourceExecutionError('network', 'market-dump artifact: 临时文件清理失败');
        });
        throw new SourceExecutionError('network', 'market-dump artifact: 原子落盘失败');
      }
      return result;
    };

    // 恢复路径：run 已记录 artifactSha256（下载已完成），本地文件必须仍在（否则无法续跑）。
    if (
      resumedRun !== null &&
      resumedRun.artifactSha256 !== null &&
      resumedRun.dumpId === ticket.dumpId
    ) {
      const localPath = join(
        this.artifactDir,
        resumedRun.dumpId,
        `${resumedRun.artifactSha256}.parquet`,
      );
      const { bytes, sha256 } = await this.inspectArtifact(localPath, resumedRun.dumpId);
      if (
        sha256 !== resumedRun.artifactSha256 ||
        (resumedRun.artifactBytes !== null && bytes !== resumedRun.artifactBytes)
      ) {
        throw new SourceExecutionError(
          'invalid_payload',
          `market-dump sync: 本地 artifact 校验失败（dumpId=${resumedRun.dumpId}）`,
        );
      }
      return {
        dumpId: resumedRun.dumpId,
        sha256: resumedRun.artifactSha256,
        bytes,
        localPath,
      };
    }

    // 新 run：先 Range 探测大小（可选，仅记录），再流式下载 + 实测 sha256。
    let probedBytes: number | null = null;
    try {
      probedBytes = await probeRemoteSize(ticket.presignedUrl, {
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
    } catch {
      // 大小探测失败不阻断下载；artifactBytes 以实测为准。
      probedBytes = null;
    }
    const result = await download();
    return {
      dumpId: ticket.dumpId,
      sha256: result.sha256,
      bytes: result.bytes > 0 ? result.bytes : (probedBytes ?? result.bytes),
      localPath: join(this.artifactDir, ticket.dumpId, `${result.sha256}.parquet`),
    };
  }

  private async inspectArtifact(
    localPath: string,
    dumpId: string,
  ): Promise<{ bytes: number; sha256: string }> {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(localPath)) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    } catch {
      throw new SourceExecutionError(
        'invalid_payload',
        `market-dump sync: 本地 artifact 缺失或读取失败（dumpId=${dumpId}）`,
      );
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  /**
   * 打开本次 sync 的 run：恢复候选 hash 匹配则沿用；hash 不匹配（新文件）开新 run；
   * 无候选时新建。同 (kind, dumpId, artifactSha256) 已 complete 的 run 幂等返回。
   */
  private async openRun(
    input: MarketDumpSyncInput,
    artifact: DumpArtifactRef,
    resumedRun: MarketDumpRun | null,
    requestedAt: Date,
  ): Promise<MarketDumpRun> {
    if (resumedRun !== null) {
      if (resumedRun.artifactSha256 === artifact.sha256) {
        // 相同 artifact hash：沿用原 run 的 checkpoint 与冻结 recordedAt 续跑。
        if (resumedRun.downloadedAt === null) {
          await this.stores.runs.markDownloaded({
            runId: resumedRun.runId,
            artifactSha256: artifact.sha256,
            artifactBytes: artifact.bytes,
            downloadedAt: this.clock(),
          });
          return this.requireRun(resumedRun.runId);
        }
        return resumedRun;
      }
      if (resumedRun.artifactSha256 === null && resumedRun.dumpId === artifact.dumpId) {
        // 旧 run 在下载完成前中断（hash 未记录）：本次实测 hash 补记后继续沿用。
        await this.stores.runs.markDownloaded({
          runId: resumedRun.runId,
          artifactSha256: artifact.sha256,
          artifactBytes: artifact.bytes,
          downloadedAt: this.clock(),
        });
        return this.requireRun(resumedRun.runId);
      }
      // 内容变化 → 新身份：旧 running run 保持原状（可用旧 artifact 恢复），本次开新 run。
    }

    // 幂等：同内容已 complete 的 run 直接复用终态（不重复导入）。
    const completed = await this.stores.runs.listRecent({ kind: input.kind, limit: 50 });
    const sameArtifact = completed.find(
      (run) =>
        run.dumpId === artifact.dumpId &&
        run.artifactSha256 === artifact.sha256 &&
        run.status === 'complete',
    );
    if (sameArtifact !== undefined) return sameArtifact;

    const runId = this.runIdGen();
    await this.stores.runs.saveStarted({
      runId,
      kind: input.kind,
      dumpId: artifact.dumpId,
      source: 'fuyao',
      artifactSha256: null,
      status: 'running',
      recordedAt: null,
      requestedAt,
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
    await this.stores.runs.markDownloaded({
      runId,
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
      downloadedAt: this.clock(),
    });
    return this.requireRun(runId);
  }

  /** 分批导入：先持久化 recordedAt，再写 revision，成功后推进数据 checkpoint。 */
  private async importArtifact(run: MarketDumpRun, artifact: DumpArtifactRef): Promise<void> {
    const offset = run.nextRowOffset;
    const recordedAt = run.recordedAt ?? this.clock();
    if (run.recordedAt === null) {
      await this.stores.runs.advanceCheckpoint({
        runId: run.runId,
        recordedAt,
        nextRowOffset: run.nextRowOffset,
        processedRows: run.processedRows,
        minDate: run.minDate,
        maxDate: run.maxDate,
      });
    }
    const iterate =
      run.kind === 'adjustment-factors'
        ? iterateAdjustmentFactorRows(artifact.localPath, { offset })
        : iterateDailyKRows(artifact.localPath, { offset });

    let batch: BatchState = { rows: [], minDate: run.minDate, maxDate: run.maxDate };
    let processedRows = run.processedRows;
    let nextRowOffset = run.nextRowOffset;

    const flush = async (): Promise<void> => {
      if (batch.rows.length === 0) return;
      if (run.kind === 'adjustment-factors') {
        await this.saveAdjustmentBatch(batch.rows as DumpAdjustmentFactorRow[], run, recordedAt);
      } else {
        await this.saveDailyKBatch(batch.rows as DumpDailyKRow[], run, recordedAt);
      }
      processedRows += batch.rows.length;
      nextRowOffset = (batch.rows[batch.rows.length - 1]?.rowIndex ?? nextRowOffset - 1) + 1;
      await this.stores.runs.advanceCheckpoint({
        runId: run.runId,
        recordedAt,
        nextRowOffset,
        processedRows,
        minDate: batch.minDate,
        maxDate: batch.maxDate,
      });
      batch = { rows: [], minDate: batch.minDate, maxDate: batch.maxDate };
    };

    for await (const row of iterate) {
      const date = msToTradingDate(
        run.kind === 'adjustment-factors'
          ? (row as DumpAdjustmentFactorRow).exDateMs
          : (row as DumpDailyKRow).dateMs,
      );
      if (batch.minDate === null || date.getTime() < batch.minDate.getTime()) batch.minDate = date;
      if (batch.maxDate === null || date.getTime() > batch.maxDate.getTime()) batch.maxDate = date;
      batch.rows.push(row);
      if (batch.rows.length >= this.batchSize) await flush();
    }
    await flush();
  }

  private async saveDailyKBatch(
    rows: readonly DumpDailyKRow[],
    run: MarketDumpRun,
    recordedAt: Date,
  ): Promise<void> {
    await this.stores.rawDailyBars.saveMany(
      rows.map((row) => {
        const stockId = normalizeDumpStockId(row.thscode);
        const date = msToTradingDate(row.dateMs);
        return {
          stockId,
          date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          turnover: row.turnover,
          source: 'fuyao' as const,
          dumpId: run.dumpId,
          artifactSha256: run.artifactSha256 ?? '',
          recordedAt,
          contentHash: sha256Of(rawDailyBarContent(row, stockId, date)),
        };
      }),
    );
  }

  private async saveAdjustmentBatch(
    rows: readonly DumpAdjustmentFactorRow[],
    run: MarketDumpRun,
    recordedAt: Date,
  ): Promise<void> {
    await this.stores.corporateActionEvents.saveMany(
      rows.map((row) => {
        const stockId = normalizeDumpStockId(row.thscode);
        if (stockId.slice(0, 6) !== row.ticker) {
          throw new SourceExecutionError(
            'invalid_payload',
            'market-dump event: 股票身份字段不一致',
          );
        }
        const exDate = msToTradingDate(row.exDateMs);
        const contentInput = {
          stockId,
          exDate,
          dividendPerShare: row.dividendPerShare,
          perShareBonus: row.perShareBonus,
          allotmentRatio: row.allotmentRatio,
          allotmentPrice: row.allotmentPrice,
          currency: 'CNY' as const,
          source: 'fuyao' as const,
        };
        const contentHash = sha256Of(corporateActionEventContent(contentInput));
        return {
          ...contentInput,
          sourceRecordId: `fuyao:${stockId}:${exDate.getTime()}:${contentHash}`,
          dumpId: run.dumpId,
          artifactSha256: run.artifactSha256,
          recordedAt,
          contentHash,
        };
      }),
    );
  }

  private async requireRun(runId: string): Promise<MarketDumpRun> {
    const run = await this.stores.runs.findById(runId);
    if (run === null) {
      throw new SourceExecutionError('upstream_error', `market-dump sync: run ${runId} 丢失`);
    }
    return run;
  }

  /** 对外投影：绝不携带 presignedUrl / localPath。 */
  private toResult(run: MarketDumpRun, resumed: boolean): MarketDumpSyncResult {
    if (run.status === 'running') {
      throw new SourceExecutionError(
        'upstream_error',
        `market-dump sync: run ${run.runId} 仍处于 running，不能输出终态结果`,
      );
    }
    return {
      runId: run.runId,
      kind: run.kind,
      dumpId: run.dumpId,
      artifactSha256: run.artifactSha256 ?? '',
      status: run.status,
      resumed,
      processedRows: run.processedRows,
      nextRowOffset: run.nextRowOffset,
      minDate: run.minDate,
      maxDate: run.maxDate,
      recordedAt: run.recordedAt ?? run.requestedAt,
      startedAt: run.startedAt ?? run.requestedAt,
      finishedAt: run.finishedAt ?? run.requestedAt,
      errorKind: run.errorKind,
      errorMessage: run.errorMessage,
    };
  }
}
