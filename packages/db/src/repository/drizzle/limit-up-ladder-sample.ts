import {
  assertLimitUpLadderSampleInvariants,
  type LimitUpLadderSample,
  type LimitUpLadderSamplePublishResult,
  type LimitUpLadderSampleRepository,
  LimitUpLadderSampleSchema,
  type LimitUpLadderSource,
  ladderOfSample,
} from '@luoome/core';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { limitUpLadderSamples, type Schema } from '../../schema/index.js';

type SampleRow = typeof limitUpLadderSamples.$inferSelect;

const toSample = (row: SampleRow): LimitUpLadderSample => {
  const parsed = LimitUpLadderSampleSchema.parse({
    id: row.id,
    tradingDate: row.tradingDate,
    sampledAt: row.sampledAt,
    source: row.source,
    total: row.total,
    maxLevel: row.maxLevel,
    levels: row.levels,
    warnings: row.warnings,
    asOf: row.asOf,
  });
  assertLimitUpLadderSampleInvariants(parsed);
  return parsed;
};

export class DrizzleLimitUpLadderSampleRepository implements LimitUpLadderSampleRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(sample: LimitUpLadderSample): Promise<LimitUpLadderSamplePublishResult> {
    const parsed = LimitUpLadderSampleSchema.parse(sample);
    assertLimitUpLadderSampleInvariants(parsed);
    ladderOfSample(parsed);
    const inserted = this.db
      .insert(limitUpLadderSamples)
      .values({
        id: parsed.id,
        tradingDate: parsed.tradingDate,
        source: parsed.source,
        sampledAt: parsed.sampledAt,
        total: parsed.total,
        maxLevel: parsed.maxLevel,
        levels: parsed.levels,
        warnings: parsed.warnings,
        asOf: parsed.asOf,
      })
      .onConflictDoNothing({ target: limitUpLadderSamples.id })
      .returning({ id: limitUpLadderSamples.id })
      .all();
    const saved = await this.findById(parsed.id);
    if (saved === null) {
      throw new Error('limit up ladder sample save did not produce a row');
    }
    return { created: inserted.length === 1, sample: saved };
  }

  async findById(id: string): Promise<LimitUpLadderSample | null> {
    const row = this.db
      .select()
      .from(limitUpLadderSamples)
      .where(eq(limitUpLadderSamples.id, id))
      .get();
    return row === undefined ? null : toSample(row);
  }

  async findAtOrBefore(input: {
    readonly tradingDate: string;
    readonly source: LimitUpLadderSource;
    readonly sampledAt: Date;
  }): Promise<LimitUpLadderSample | null> {
    const row = this.db
      .select()
      .from(limitUpLadderSamples)
      .where(
        and(
          eq(limitUpLadderSamples.tradingDate, input.tradingDate),
          eq(limitUpLadderSamples.source, input.source),
          lte(limitUpLadderSamples.sampledAt, input.sampledAt),
        ),
      )
      .orderBy(desc(limitUpLadderSamples.sampledAt), desc(limitUpLadderSamples.id))
      .get();
    return row === undefined ? null : toSample(row);
  }

  async listByTradingDate(input: {
    readonly tradingDate: string;
    readonly source: LimitUpLadderSource;
  }): Promise<LimitUpLadderSample[]> {
    return this.db
      .select()
      .from(limitUpLadderSamples)
      .where(
        and(
          eq(limitUpLadderSamples.tradingDate, input.tradingDate),
          eq(limitUpLadderSamples.source, input.source),
        ),
      )
      .orderBy(asc(limitUpLadderSamples.sampledAt), asc(limitUpLadderSamples.id))
      .all()
      .map(toSample);
  }
}
