import type { CorporateActionEventRevision } from '../entity/corporate-action-event.js';
import type { MarketDumpRun } from '../entity/market-dump.js';
import type { RawDailyBarRevision } from '../entity/raw-daily-bar.js';

/**
 * Market dump 事实链的仓储端口（设计 §5.4 / §6.1）。
 *
 * 独立文件而非 repository/index.ts 的成员：Phase 2 交付期 RepositoryRegistry
 * 接线由集成方统一完成，本文件先固定接口契约。实现必须同时提供 Drizzle/SQLite
 * 与 in-memory 版本，并保持排序与幂等语义一致。
 */

/**
 * dump 运行审计仓储。
 *
 * - saveStarted 创建 running 行；同一 runId 重复创建视为幂等重放（内容一致）或拒绝；
 * - advanceCheckpoint 只在 running 上推进 nextRowOffset/processedRows/minDate/maxDate，
 *   并冻结 recordedAt（首次推进时写入，之后沿用）；
 * - finish 一次性进入 complete/failed 终态；终态后不再接受任何写入。
 */
export interface MarketDumpRunRepository {
  saveStarted(run: MarketDumpRun): Promise<void>;
  findById(runId: string): Promise<MarketDumpRun | null>;
  /** 同 kind 最近运行（按 requestedAt 降序，其次 runId），供 status tool 与恢复发现。 */
  listRecent(input: {
    readonly kind?: MarketDumpRun['kind'];
    readonly limit?: number;
  }): Promise<readonly MarketDumpRun[]>;
  /** 查找处于 running 且匹配 (kind, dumpId, artifactSha256) 的可恢复 run。 */
  findResumable(input: {
    readonly kind: MarketDumpRun['kind'];
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<MarketDumpRun | null>;
  advanceCheckpoint(input: {
    readonly runId: string;
    readonly recordedAt: Date;
    readonly nextRowOffset: number;
    readonly processedRows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }): Promise<void>;
  markDownloaded(input: {
    readonly runId: string;
    readonly artifactSha256: string;
    readonly artifactBytes: number;
    readonly downloadedAt: Date;
  }): Promise<void>;
  finish(input: {
    readonly runId: string;
    readonly status: 'complete' | 'failed';
    readonly finishedAt: Date;
    readonly errorKind?: string;
    readonly errorMessage?: string;
  }): Promise<void>;
}

/**
 * 原始日线 revision 仓储（append-only）。
 *
 * saveMany 幂等：完全相同的 (stockId, date, recordedAt, contentHash) 重放不重复插入；
 * 同 (stockId, date, recordedAt) 不同 contentHash 的新行必须保留（不覆盖旧行）。
 */
export interface RawDailyBarRepository {
  saveMany(revisions: readonly RawDailyBarRevision[]): Promise<void>;
  listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    /** PIT cutoff：只返回 recordedAt <= cutoff 的 revision。 */
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]>;
  listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]>;
  /** 审计用：某 artifact 已落库的行数与日期范围。 */
  summarizeArtifact(input: { readonly dumpId: string; readonly artifactSha256: string }): Promise<{
    readonly rows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }>;
}

/**
 * 原始公司行动事件仓储（append-only）。
 *
 * saveMany 幂等：相同 (stockId, exDate, sourceRecordId, recordedAt, contentHash) 重放不重复插入；
 * 同日不同事件（不同 sourceRecordId/contentHash）分别保留。
 */
export interface CorporateActionEventRepository {
  saveMany(revisions: readonly CorporateActionEventRevision[]): Promise<void>;
  listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]>;
  listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]>;
  summarizeArtifact(input: { readonly dumpId: string; readonly artifactSha256: string }): Promise<{
    readonly rows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }>;
}
