import {
  type MarketDumpRun,
  type MarketDumpRunRepository,
  MarketDumpRunSchema,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import { type Schema, schema } from '../../schema/index.js';

/**
 * market_dump_runs：dump 同步运行审计（设计 §5.4）。
 * 表定义在共享 schema/index.ts；DDL 由 migrations.ts 的 ensureSchema 幂等建立。
 */
const marketDumpRuns = schema.marketDumpRuns;

type RunRow = typeof marketDumpRuns.$inferSelect;

const toRun = (row: RunRow): MarketDumpRun =>
  MarketDumpRunSchema.parse({
    runId: row.runId,
    kind: row.kind,
    dumpId: row.dumpId,
    source: row.source,
    artifactSha256: row.artifactSha256,
    status: row.status,
    recordedAt: row.recordedAt,
    requestedAt: row.requestedAt,
    downloadedAt: row.downloadedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    nextRowOffset: row.nextRowOffset,
    processedRows: row.processedRows,
    minDate: row.minDate,
    maxDate: row.maxDate,
    artifactBytes: row.artifactBytes,
    errorKind: row.errorKind,
    errorMessage: row.errorMessage,
  });

export class DrizzleMarketDumpRunRepository implements MarketDumpRunRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async saveStarted(run: MarketDumpRun): Promise<void> {
    const parsed = MarketDumpRunSchema.parse(run);
    if (parsed.status !== 'running') {
      throw new Error('market_dump_runs: saveStarted 只接受 running 状态');
    }
    const existing = this.db
      .select()
      .from(marketDumpRuns)
      .where(eq(marketDumpRuns.runId, parsed.runId))
      .get();
    if (existing !== undefined) {
      const current = toRun(existing);
      // 幂等重放：同 runId 同身份字段视为重复提交，直接返回。
      if (
        current.kind === parsed.kind &&
        current.dumpId === parsed.dumpId &&
        current.requestedAt.getTime() === parsed.requestedAt.getTime()
      ) {
        return;
      }
      throw new Error(`market_dump_runs: runId ${parsed.runId} 已存在且身份不一致`);
    }
    this.db
      .insert(marketDumpRuns)
      .values({
        runId: parsed.runId,
        kind: parsed.kind,
        dumpId: parsed.dumpId,
        source: parsed.source,
        artifactSha256: parsed.artifactSha256,
        status: parsed.status,
        recordedAt: parsed.recordedAt,
        requestedAt: parsed.requestedAt,
        downloadedAt: parsed.downloadedAt,
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        nextRowOffset: parsed.nextRowOffset,
        processedRows: parsed.processedRows,
        minDate: parsed.minDate,
        maxDate: parsed.maxDate,
        artifactBytes: parsed.artifactBytes,
        errorKind: parsed.errorKind,
        errorMessage: parsed.errorMessage,
      })
      .run();
  }

  async findById(runId: string): Promise<MarketDumpRun | null> {
    const row = this.db.select().from(marketDumpRuns).where(eq(marketDumpRuns.runId, runId)).get();
    return row === undefined ? null : toRun(row);
  }

  async listRecent(input: {
    readonly kind?: MarketDumpRun['kind'];
    readonly limit?: number;
  }): Promise<readonly MarketDumpRun[]> {
    const limit = input.limit ?? 20;
    const rows =
      input.kind === undefined
        ? this.db
            .select()
            .from(marketDumpRuns)
            .orderBy(desc(marketDumpRuns.requestedAt), desc(marketDumpRuns.runId))
            .limit(limit)
            .all()
        : this.db
            .select()
            .from(marketDumpRuns)
            .where(eq(marketDumpRuns.kind, input.kind))
            .orderBy(desc(marketDumpRuns.requestedAt), desc(marketDumpRuns.runId))
            .limit(limit)
            .all();
    return rows.map(toRun);
  }

  async findResumable(input: {
    readonly kind: MarketDumpRun['kind'];
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<MarketDumpRun | null> {
    const rows = this.db
      .select()
      .from(marketDumpRuns)
      .where(
        and(
          eq(marketDumpRuns.kind, input.kind),
          eq(marketDumpRuns.dumpId, input.dumpId),
          eq(marketDumpRuns.artifactSha256, input.artifactSha256),
          eq(marketDumpRuns.status, 'running'),
        ),
      )
      .orderBy(desc(marketDumpRuns.requestedAt), desc(marketDumpRuns.runId))
      .limit(1)
      .all();
    const row = rows[0];
    return row === undefined ? null : toRun(row);
  }

  async advanceCheckpoint(input: {
    readonly runId: string;
    readonly recordedAt: Date;
    readonly nextRowOffset: number;
    readonly processedRows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }): Promise<void> {
    const current = await this.requireRunning(input.runId);
    // recordedAt 首次推进时冻结，之后沿用（checkpoint 恢复保持同一 PIT 记录时间）。
    const recordedAt = current.recordedAt ?? input.recordedAt;
    const startedAt = current.startedAt ?? input.recordedAt;
    this.db
      .update(marketDumpRuns)
      .set({
        recordedAt,
        startedAt,
        nextRowOffset: input.nextRowOffset,
        processedRows: input.processedRows,
        minDate: input.minDate,
        maxDate: input.maxDate,
      })
      .where(eq(marketDumpRuns.runId, input.runId))
      .run();
  }

  async markDownloaded(input: {
    readonly runId: string;
    readonly artifactSha256: string;
    readonly artifactBytes: number;
    readonly downloadedAt: Date;
  }): Promise<void> {
    await this.requireRunning(input.runId);
    this.db
      .update(marketDumpRuns)
      .set({
        artifactSha256: input.artifactSha256,
        artifactBytes: input.artifactBytes,
        downloadedAt: input.downloadedAt,
      })
      .where(eq(marketDumpRuns.runId, input.runId))
      .run();
  }

  async finish(input: {
    readonly runId: string;
    readonly status: 'complete' | 'failed';
    readonly finishedAt: Date;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    const current = await this.requireRunning(input.runId);
    if (input.status === 'complete' && current.artifactSha256 === null) {
      throw new Error('market_dump_runs: complete 前必须先 markDownloaded');
    }
    if (input.status === 'failed' && input.errorKind === undefined) {
      throw new Error('market_dump_runs: failed 必须携带 errorKind');
    }
    this.db
      .update(marketDumpRuns)
      .set({
        status: input.status,
        finishedAt: input.finishedAt,
        errorKind: input.status === 'failed' ? (input.errorKind ?? null) : null,
        errorMessage: input.status === 'failed' ? (input.errorMessage ?? null) : null,
      })
      .where(eq(marketDumpRuns.runId, input.runId))
      .run();
  }

  private async requireRunning(runId: string): Promise<MarketDumpRun> {
    const current = await this.findById(runId);
    if (current === null) throw new Error(`market_dump_runs: run ${runId} 不存在`);
    if (current.status !== 'running') {
      throw new Error(`market_dump_runs: run ${runId} 已进入终态 ${current.status}`);
    }
    return current;
  }
}
