import {
  type CorporateActionEventRepository,
  type CorporateActionEventRevision,
  CorporateActionEventRevisionSchema,
} from '@luoome/core';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import { type Schema, schema } from '../../schema/index.js';

/**
 * corporate_action_event_revisions：append-only 市场级原始公司行动事件（设计 §6.1）。
 *
 * 主键 (stock_id, ex_date, source_record_id, recorded_at, content_hash)：
 * - 同日多事件：不同 source_record_id / content_hash 的行并存保留；
 * - 同一 run 重放（五元组完全一致）幂等忽略；
 * - 与账户级 portfolio_corporate_actions 无任何外键或触发关系。
 *
 * 表定义在共享 schema/index.ts；DDL 由 migrations.ts 的 ensureSchema 幂等建立。
 */
const corporateActionEventRevisions = schema.corporateActionEventRevisions;

type EventRow = typeof corporateActionEventRevisions.$inferSelect;

const toRevision = (row: EventRow): CorporateActionEventRevision =>
  CorporateActionEventRevisionSchema.parse({
    stockId: row.stockId,
    exDate: row.exDate,
    dividendPerShare: row.dividendPerShare,
    perShareBonus: row.perShareBonus,
    allotmentRatio: row.allotmentRatio,
    allotmentPrice: row.allotmentPrice,
    currency: row.currency,
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    dumpId: row.dumpId,
    artifactSha256: row.artifactSha256,
    recordedAt: row.recordedAt,
    contentHash: row.contentHash,
  });

const byStockDate = (left: EventRow, right: EventRow): number =>
  left.stockId.localeCompare(right.stockId) ||
  left.exDate.getTime() - right.exDate.getTime() ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.sourceRecordId.localeCompare(right.sourceRecordId) ||
  left.contentHash.localeCompare(right.contentHash);

const byDate = (left: EventRow, right: EventRow): number =>
  left.exDate.getTime() - right.exDate.getTime() ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.sourceRecordId.localeCompare(right.sourceRecordId) ||
  left.contentHash.localeCompare(right.contentHash);

const STOCK_ID_CHUNK = 500;

export class DrizzleCorporateActionEventRepository implements CorporateActionEventRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async saveMany(revisions: readonly CorporateActionEventRevision[]): Promise<void> {
    if (revisions.length === 0) return;
    const rows = revisions.map((input) => {
      const parsed = CorporateActionEventRevisionSchema.parse(input);
      return {
        stockId: parsed.stockId,
        exDate: parsed.exDate,
        sourceRecordId: parsed.sourceRecordId,
        recordedAt: parsed.recordedAt,
        contentHash: parsed.contentHash,
        dividendPerShare: parsed.dividendPerShare,
        perShareBonus: parsed.perShareBonus,
        allotmentRatio: parsed.allotmentRatio,
        allotmentPrice: parsed.allotmentPrice,
        currency: parsed.currency,
        source: parsed.source,
        dumpId: parsed.dumpId,
        artifactSha256: parsed.artifactSha256,
      };
    });
    this.db.insert(corporateActionEventRevisions).values(rows).onConflictDoNothing().run();
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly CorporateActionEventRevision[]> {
    const conditions = [eq(corporateActionEventRevisions.stockId, input.stockId)];
    if (input.from !== undefined) {
      conditions.push(gte(corporateActionEventRevisions.exDate, input.from));
    }
    if (input.to !== undefined)
      conditions.push(lte(corporateActionEventRevisions.exDate, input.to));
    if (input.recordedAt !== undefined) {
      conditions.push(lte(corporateActionEventRevisions.recordedAt, input.recordedAt));
    }
    return this.db
      .select()
      .from(corporateActionEventRevisions)
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
  }): Promise<readonly CorporateActionEventRevision[]> {
    if (input.stockIds.length === 0) return [];
    const rows: EventRow[] = [];
    for (let index = 0; index < input.stockIds.length; index += STOCK_ID_CHUNK) {
      const chunk = input.stockIds.slice(index, index + STOCK_ID_CHUNK);
      const conditions = [inArray(corporateActionEventRevisions.stockId, chunk)];
      if (input.from !== undefined) {
        conditions.push(gte(corporateActionEventRevisions.exDate, input.from));
      }
      if (input.to !== undefined) {
        conditions.push(lte(corporateActionEventRevisions.exDate, input.to));
      }
      if (input.recordedAt !== undefined) {
        conditions.push(lte(corporateActionEventRevisions.recordedAt, input.recordedAt));
      }
      rows.push(
        ...this.db
          .select()
          .from(corporateActionEventRevisions)
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
        minDate: sql<number | null>`min("ex_date")`,
        maxDate: sql<number | null>`max("ex_date")`,
      })
      .from(corporateActionEventRevisions)
      .where(
        and(
          eq(corporateActionEventRevisions.dumpId, input.dumpId),
          eq(corporateActionEventRevisions.artifactSha256, input.artifactSha256),
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
