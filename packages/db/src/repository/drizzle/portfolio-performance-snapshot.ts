import {
  type PortfolioPerformanceSnapshot,
  type PortfolioPerformanceSnapshotRepository,
  PortfolioPerformanceSnapshotSchema,
} from '@luoome/core';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { portfolioPerformanceSnapshots, type Schema } from '../../schema/index.js';

type SnapshotRow = typeof portfolioPerformanceSnapshots.$inferSelect;

const parse = (row: SnapshotRow): PortfolioPerformanceSnapshot =>
  PortfolioPerformanceSnapshotSchema.parse({
    id: row.id,
    accountId: row.accountId,
    from: row.from,
    to: row.to,
    currency: row.currency,
    inputFingerprint: row.inputFingerprint,
    calculatedAt: row.calculatedAt,
    ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
    performance: row.performance,
  });

export class DrizzlePortfolioPerformanceSnapshotRepository
  implements PortfolioPerformanceSnapshotRepository
{
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(snapshot: PortfolioPerformanceSnapshot): Promise<void> {
    const parsed = PortfolioPerformanceSnapshotSchema.parse(snapshot);
    this.db
      .insert(portfolioPerformanceSnapshots)
      .values({
        id: parsed.id,
        accountId: parsed.accountId,
        from: parsed.from,
        to: parsed.to,
        currency: parsed.currency,
        inputFingerprint: parsed.inputFingerprint,
        calculatedAt: parsed.calculatedAt,
        dataAsOf: parsed.dataAsOf ?? null,
        performance: parsed.performance,
      })
      .onConflictDoUpdate({
        target: portfolioPerformanceSnapshots.id,
        set: {
          accountId: parsed.accountId,
          from: parsed.from,
          to: parsed.to,
          currency: parsed.currency,
          inputFingerprint: parsed.inputFingerprint,
          calculatedAt: parsed.calculatedAt,
          dataAsOf: parsed.dataAsOf ?? null,
          performance: parsed.performance,
        },
      })
      .run();
  }

  async findById(id: string): Promise<PortfolioPerformanceSnapshot | null> {
    const row = this.db
      .select()
      .from(portfolioPerformanceSnapshots)
      .where(eq(portfolioPerformanceSnapshots.id, id))
      .get();
    return row === undefined ? null : parse(row);
  }

  async findByFingerprint(input: {
    readonly accountId: string;
    readonly from: Date;
    readonly to: Date;
    readonly inputFingerprint: string;
  }): Promise<PortfolioPerformanceSnapshot | null> {
    const row = this.db
      .select()
      .from(portfolioPerformanceSnapshots)
      .where(
        and(
          eq(portfolioPerformanceSnapshots.accountId, input.accountId),
          eq(portfolioPerformanceSnapshots.from, input.from),
          eq(portfolioPerformanceSnapshots.to, input.to),
          eq(portfolioPerformanceSnapshots.inputFingerprint, input.inputFingerprint),
        ),
      )
      .get();
    return row === undefined ? null : parse(row);
  }

  async listByAccount(
    accountId: string,
    limit = 50,
  ): Promise<readonly PortfolioPerformanceSnapshot[]> {
    return this.db
      .select()
      .from(portfolioPerformanceSnapshots)
      .where(eq(portfolioPerformanceSnapshots.accountId, accountId))
      .orderBy(
        desc(portfolioPerformanceSnapshots.calculatedAt),
        desc(portfolioPerformanceSnapshots.id),
      )
      .limit(Math.max(0, limit))
      .all()
      .map(parse);
  }

  async listByAccountAndRange(
    accountId: string,
    from: Date,
    to: Date,
    limit = 200,
  ): Promise<readonly PortfolioPerformanceSnapshot[]> {
    if (from > to) return [];
    return this.db
      .select()
      .from(portfolioPerformanceSnapshots)
      .where(
        and(
          eq(portfolioPerformanceSnapshots.accountId, accountId),
          lte(portfolioPerformanceSnapshots.from, to),
          gte(portfolioPerformanceSnapshots.to, from),
        ),
      )
      .orderBy(
        desc(portfolioPerformanceSnapshots.calculatedAt),
        desc(portfolioPerformanceSnapshots.id),
      )
      .limit(Math.max(0, limit))
      .all()
      .map(parse);
  }

  async remove(id: string): Promise<void> {
    this.db
      .delete(portfolioPerformanceSnapshots)
      .where(eq(portfolioPerformanceSnapshots.id, id))
      .run();
  }
}
