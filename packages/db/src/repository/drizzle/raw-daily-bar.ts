import {
  type RawDailyBarRepository,
  type RawDailyBarRevision,
  RawDailyBarRevisionSchema,
} from '@luoome/core';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import { type Schema, schema } from '../../schema/index.js';

/**
 * raw_daily_bar_revisions：append-only 原始（未复权）日线 revision（设计 §5.3）。
 *
 * 主键 (stock_id, date, recorded_at, content_hash)：
 * - 同一 run 重放（同 recordedAt 同 hash）幂等；
 * - 同 (stock_id, date, recorded_at) 不同 content_hash 必须并存（不回改、不覆盖）；
 * - 后续 dump 批次用新 recorded_at 形成新 revision。
 *
 * 表定义在共享 schema/index.ts；DDL 由 migrations.ts 的 ensureSchema 幂等建立。
 */
const rawDailyBarRevisions = schema.rawDailyBarRevisions;

type BarRow = typeof rawDailyBarRevisions.$inferSelect;

const toRevision = (row: BarRow): RawDailyBarRevision =>
  RawDailyBarRevisionSchema.parse({
    stockId: row.stockId,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    turnover: row.turnover,
    source: row.source,
    dumpId: row.dumpId,
    artifactSha256: row.artifactSha256,
    recordedAt: row.recordedAt,
    contentHash: row.contentHash,
  });

/** 与 daily_bar_revisions 相同的稳定排序（stockId, date, recordedAt, contentHash）。 */
const byStockDate = (left: BarRow, right: BarRow): number =>
  left.stockId.localeCompare(right.stockId) ||
  left.date.getTime() - right.date.getTime() ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.contentHash.localeCompare(right.contentHash);

const byDate = (left: BarRow, right: BarRow): number =>
  left.date.getTime() - right.date.getTime() ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.contentHash.localeCompare(right.contentHash);

/** SQLite 绑定参数上限保护：与 daily-bar.ts 的 listRevisionsForStocks 分块策略一致。 */
const STOCK_ID_CHUNK = 500;

export class DrizzleRawDailyBarRepository implements RawDailyBarRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async saveMany(revisions: readonly RawDailyBarRevision[]): Promise<void> {
    if (revisions.length === 0) return;
    const rows = revisions.map((input) => {
      const parsed = RawDailyBarRevisionSchema.parse(input);
      return {
        stockId: parsed.stockId,
        date: parsed.date,
        recordedAt: parsed.recordedAt,
        contentHash: parsed.contentHash,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
        turnover: parsed.turnover,
        source: parsed.source,
        dumpId: parsed.dumpId,
        artifactSha256: parsed.artifactSha256,
      };
    });
    // append-only + 幂等重放：主键冲突（完全相同的行）忽略；不同 contentHash 不冲突、并存。
    this.db.insert(rawDailyBarRevisions).values(rows).onConflictDoNothing().run();
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    const conditions = [eq(rawDailyBarRevisions.stockId, input.stockId)];
    if (input.from !== undefined) conditions.push(gte(rawDailyBarRevisions.date, input.from));
    if (input.to !== undefined) conditions.push(lte(rawDailyBarRevisions.date, input.to));
    if (input.recordedAt !== undefined) {
      conditions.push(lte(rawDailyBarRevisions.recordedAt, input.recordedAt));
    }
    return this.db
      .select()
      .from(rawDailyBarRevisions)
      .where(and(...conditions))
      .all()
      .sort(byDate)
      .map(toRevision);
  }

  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly RawDailyBarRevision[]> {
    if (input.stockIds.length === 0) return [];
    const rows: BarRow[] = [];
    for (let index = 0; index < input.stockIds.length; index += STOCK_ID_CHUNK) {
      const chunk = input.stockIds.slice(index, index + STOCK_ID_CHUNK);
      const conditions = [inArray(rawDailyBarRevisions.stockId, chunk)];
      if (input.from !== undefined) conditions.push(gte(rawDailyBarRevisions.date, input.from));
      if (input.to !== undefined) conditions.push(lte(rawDailyBarRevisions.date, input.to));
      if (input.recordedAt !== undefined) {
        conditions.push(lte(rawDailyBarRevisions.recordedAt, input.recordedAt));
      }
      rows.push(
        ...this.db
          .select()
          .from(rawDailyBarRevisions)
          .where(and(...conditions))
          .all(),
      );
    }
    return rows.sort(byStockDate).map(toRevision);
  }

  async summarizeArtifact(input: {
    readonly dumpId: string;
    readonly artifactSha256: string;
  }): Promise<{
    readonly rows: number;
    readonly minDate: Date | null;
    readonly maxDate: Date | null;
  }> {
    const result = this.db
      .select({
        rows: sql<number>`count(*)`,
        minDate: sql<number | null>`min("date")`,
        maxDate: sql<number | null>`max("date")`,
      })
      .from(rawDailyBarRevisions)
      .where(
        and(
          eq(rawDailyBarRevisions.dumpId, input.dumpId),
          eq(rawDailyBarRevisions.artifactSha256, input.artifactSha256),
        ),
      )
      .get();
    return {
      rows: Number(result?.rows ?? 0),
      minDate:
        result?.minDate === null || result?.minDate === undefined
          ? null
          : new Date(Number(result.minDate)),
      maxDate:
        result?.maxDate === null || result?.maxDate === undefined
          ? null
          : new Date(Number(result.maxDate)),
    };
  }
}
