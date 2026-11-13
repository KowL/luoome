import {
  type LimitUpBoardHistory,
  type LimitUpBoardHistoryRepository,
  LimitUpBoardHistorySchema,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { limitUpBoardHistory, type Schema } from '../../schema/index.js';

type Row = typeof limitUpBoardHistory.$inferSelect;

const toHistory = (row: Row): LimitUpBoardHistory =>
  LimitUpBoardHistorySchema.parse({
    tradeDate: row.tradeDate,
    source: row.source,
    coverage: 'CN_A_SHARES_SH_SZ',
    status: row.status,
    dataAsOf: row.dataAsOf,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    vintage: row.vintage,
    facts: row.facts,
    missingFields: row.missingFields,
    warnings: row.warnings,
    recordedAt: row.recordedAt,
  });

/** 炸板/断板历史事实；同一 (tradeDate, source) 可保留多次修订，读取取最新 recordedAt。 */
export class DrizzleLimitUpBoardHistoryRepository implements LimitUpBoardHistoryRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(history: LimitUpBoardHistory): Promise<void> {
    const parsed = LimitUpBoardHistorySchema.parse(history);
    this.db
      .insert(limitUpBoardHistory)
      .values({
        tradeDate: parsed.tradeDate,
        source: parsed.source,
        status: parsed.status,
        dataAsOf: parsed.dataAsOf,
        publishedAt: parsed.publishedAt,
        fetchedAt: parsed.fetchedAt,
        vintage: parsed.vintage,
        facts: parsed.facts,
        missingFields: parsed.missingFields,
        warnings: parsed.warnings,
        recordedAt: parsed.recordedAt,
      })
      .onConflictDoNothing()
      .run();
  }

  async findByDate(input: {
    readonly tradeDate: string;
    readonly source?: string;
  }): Promise<LimitUpBoardHistory | null> {
    const conditions = [eq(limitUpBoardHistory.tradeDate, input.tradeDate)];
    if (input.source !== undefined) {
      conditions.push(eq(limitUpBoardHistory.source, input.source));
    }
    const row = this.db
      .select()
      .from(limitUpBoardHistory)
      .where(and(...conditions))
      .orderBy(desc(limitUpBoardHistory.recordedAt), desc(limitUpBoardHistory.source))
      .limit(1)
      .get();
    return row === undefined ? null : toHistory(row);
  }
}
