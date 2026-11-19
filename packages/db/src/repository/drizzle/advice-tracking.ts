import {
  type AdviceFeedback,
  type AdviceFeedbackQuery,
  type AdviceSettlement,
  type AdviceSettlementQuery,
  type AdviceTrackingRepository,
  money,
} from '@luoome/core';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { adviceFeedbacks, adviceSettlements, type Schema } from '../../schema/index.js';

type FeedbackRow = typeof adviceFeedbacks.$inferSelect;
type SettlementRow = typeof adviceSettlements.$inferSelect;

const toFeedback = (row: FeedbackRow): AdviceFeedback => ({
  adviceId: row.adviceId,
  action: row.action,
  ...(row.fillPrice === null ? {} : { fillPrice: money(row.fillPrice) }),
  recordedAt: row.recordedAt,
});

const toSettlement = (row: SettlementRow): AdviceSettlement => ({
  adviceId: row.adviceId,
  horizonDays: row.horizonDays as 1 | 3 | 5,
  assumedEntryPrice: money(row.assumedEntryPrice),
  exitPrice: money(row.exitPrice),
  returnPct: row.returnPct,
  benchmarkReturnPct: row.benchmarkReturnPct,
  excessPct: row.excessPct,
  hit: row.hit,
  evaluatedAt: row.evaluatedAt,
  ...(row.note === null ? {} : { note: row.note }),
});

export class DrizzleAdviceTrackingRepository implements AdviceTrackingRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async recordFeedback(feedback: AdviceFeedback): Promise<void> {
    const row = {
      adviceId: feedback.adviceId,
      action: feedback.action,
      fillPrice: feedback.fillPrice ?? null,
      recordedAt: feedback.recordedAt,
    };
    this.db
      .insert(adviceFeedbacks)
      .values(row)
      .onConflictDoUpdate({ target: adviceFeedbacks.adviceId, set: row })
      .run();
  }

  async findFeedback(adviceId: string): Promise<AdviceFeedback | null> {
    const row = this.db
      .select()
      .from(adviceFeedbacks)
      .where(eq(adviceFeedbacks.adviceId, adviceId))
      .get();
    return row === undefined ? null : toFeedback(row);
  }

  async listFeedbacks(filter: AdviceFeedbackQuery = {}): Promise<AdviceFeedback[]> {
    const conditions = [
      filter.adviceId === undefined ? undefined : eq(adviceFeedbacks.adviceId, filter.adviceId),
      filter.since === undefined ? undefined : gte(adviceFeedbacks.recordedAt, filter.since),
      filter.until === undefined ? undefined : lte(adviceFeedbacks.recordedAt, filter.until),
    ].filter((condition) => condition !== undefined);
    const base = this.db
      .select()
      .from(adviceFeedbacks)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(adviceFeedbacks.recordedAt), desc(adviceFeedbacks.adviceId));
    const rows = filter.limit === undefined ? base.all() : base.limit(filter.limit).all();
    return rows.map(toFeedback);
  }

  async saveSettlement(settlement: AdviceSettlement): Promise<void> {
    const row = {
      adviceId: settlement.adviceId,
      horizonDays: settlement.horizonDays,
      assumedEntryPrice: settlement.assumedEntryPrice,
      exitPrice: settlement.exitPrice,
      returnPct: settlement.returnPct,
      benchmarkReturnPct: settlement.benchmarkReturnPct,
      excessPct: settlement.excessPct,
      hit: settlement.hit,
      evaluatedAt: settlement.evaluatedAt,
      note: settlement.note ?? null,
    };
    this.db
      .insert(adviceSettlements)
      .values(row)
      .onConflictDoUpdate({
        target: [adviceSettlements.adviceId, adviceSettlements.horizonDays],
        set: row,
      })
      .run();
  }

  async listSettlements(filter: AdviceSettlementQuery = {}): Promise<AdviceSettlement[]> {
    const conditions = [
      filter.adviceId === undefined ? undefined : eq(adviceSettlements.adviceId, filter.adviceId),
      filter.horizonDays === undefined
        ? undefined
        : eq(adviceSettlements.horizonDays, filter.horizonDays),
      filter.since === undefined ? undefined : gte(adviceSettlements.evaluatedAt, filter.since),
      filter.until === undefined ? undefined : lte(adviceSettlements.evaluatedAt, filter.until),
    ].filter((condition) => condition !== undefined);
    const base = this.db
      .select()
      .from(adviceSettlements)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(adviceSettlements.evaluatedAt), desc(adviceSettlements.adviceId));
    const rows = filter.limit === undefined ? base.all() : base.limit(filter.limit).all();
    return rows.map(toSettlement);
  }

  async removeForAdvice(adviceId: string): Promise<void> {
    this.db.delete(adviceFeedbacks).where(eq(adviceFeedbacks.adviceId, adviceId)).run();
    this.db.delete(adviceSettlements).where(eq(adviceSettlements.adviceId, adviceId)).run();
  }
}
