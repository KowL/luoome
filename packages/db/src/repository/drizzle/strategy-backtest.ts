import {
  InvariantError,
  type StrategyBacktestRepository,
  type StrictBacktestMarketFact,
  StrictBacktestMarketFactSchema,
  type StrictBacktestRun,
  StrictBacktestRunSchema,
} from '@luoome/core';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  strategyBacktestMarketFacts,
  strategyBacktestRuns,
} from '../../schema/index.js';

type RunRow = typeof strategyBacktestRuns.$inferSelect;

const toRun = (row: RunRow): StrictBacktestRun =>
  StrictBacktestRunSchema.parse({
    id: row.id,
    status: row.status,
    resultAvailability: row.resultAvailability,
    spec: row.spec,
    specHash: row.specHash,
    inputFingerprint: row.inputFingerprint,
    evaluator: row.evaluator,
    gateAudit: row.gateAudit,
    ...(row.metrics === null ? {} : { metrics: row.metrics }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.createdAt,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
  });

const immutableIdentity = (run: StrictBacktestRun): string =>
  JSON.stringify({
    id: run.id,
    specHash: run.specHash,
    inputFingerprint: run.inputFingerprint,
    evaluator: run.evaluator,
  });

const allowedTransition = (
  from: StrictBacktestRun['status'],
  to: StrictBacktestRun['status'],
): boolean =>
  from === to ||
  (from === 'queued' && (to === 'running' || to === 'complete' || to === 'failed')) ||
  (from === 'running' && (to === 'complete' || to === 'failed'));

export class DrizzleStrategyBacktestRepository implements StrategyBacktestRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveRun(run: StrictBacktestRun): Promise<void> {
    const parsed = StrictBacktestRunSchema.parse(run);
    this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(strategyBacktestRuns)
        .where(eq(strategyBacktestRuns.id, parsed.id))
        .get();
      if (row !== undefined) {
        const existing = toRun(row);
        if (immutableIdentity(existing) !== immutableIdentity(parsed)) {
          throw new InvariantError('strict backtest immutable identity 不能修改');
        }
        if (!allowedTransition(existing.status, parsed.status)) {
          throw new InvariantError(
            `strict backtest 非法状态迁移: ${existing.status}->${parsed.status}`,
          );
        }
      }
      tx.insert(strategyBacktestRuns)
        .values({
          id: parsed.id,
          strategyId: parsed.spec.strategyId,
          strategyVersionId: parsed.spec.strategyVersionId,
          evaluationSessionId: parsed.spec.evaluationSessionId,
          status: parsed.status,
          resultAvailability: parsed.resultAvailability,
          spec: parsed.spec,
          specHash: parsed.specHash,
          inputFingerprint: parsed.inputFingerprint,
          evaluator: parsed.evaluator,
          gateAudit: parsed.gateAudit,
          metrics: parsed.metrics ?? null,
          error: parsed.error ?? null,
          createdAt: parsed.createdAt,
          startedAt: parsed.startedAt ?? null,
          finishedAt: parsed.finishedAt ?? null,
        })
        .onConflictDoUpdate({
          target: strategyBacktestRuns.id,
          set: {
            status: parsed.status,
            resultAvailability: parsed.resultAvailability,
            gateAudit: parsed.gateAudit,
            metrics: parsed.metrics ?? null,
            error: parsed.error ?? null,
            startedAt: parsed.startedAt ?? null,
            finishedAt: parsed.finishedAt ?? null,
          },
        })
        .run();
    });
  }

  async findRunById(id: string): Promise<StrictBacktestRun | null> {
    const row = this.db
      .select()
      .from(strategyBacktestRuns)
      .where(eq(strategyBacktestRuns.id, id))
      .get();
    return row === undefined ? null : toRun(row);
  }

  async listRuns(input?: {
    readonly strategyId?: string;
    readonly limit?: number;
  }): Promise<readonly StrictBacktestRun[]> {
    const query = this.db.select().from(strategyBacktestRuns);
    return (
      input?.strategyId === undefined
        ? query.orderBy(desc(strategyBacktestRuns.createdAt), desc(strategyBacktestRuns.id))
        : query
            .where(eq(strategyBacktestRuns.strategyId, input.strategyId))
            .orderBy(desc(strategyBacktestRuns.createdAt), desc(strategyBacktestRuns.id))
    )
      .limit(input?.limit ?? 50)
      .all()
      .map(toRun);
  }

  async saveMarketFacts(facts: readonly StrictBacktestMarketFact[]): Promise<void> {
    if (facts.length === 0) return;
    const parsed = facts.map((fact) => StrictBacktestMarketFactSchema.parse(fact));
    this.db
      .insert(strategyBacktestMarketFacts)
      .values(
        parsed.map((fact) => ({
          stockId: fact.stockId,
          date: fact.date,
          recordedAt: fact.recordedAt,
          contentHash: fact.contentHash,
          fact,
        })),
      )
      .onConflictDoNothing()
      .run();
  }

  async listMarketFacts(input: {
    readonly stockIds: readonly string[];
    readonly from: Date;
    readonly to: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly StrictBacktestMarketFact[]> {
    if (input.stockIds.length === 0) return [];
    const conditions = [
      inArray(strategyBacktestMarketFacts.stockId, [...input.stockIds]),
      gte(strategyBacktestMarketFacts.date, input.from),
      lte(strategyBacktestMarketFacts.date, input.to),
    ];
    if (input.recordedAt !== undefined) {
      conditions.push(lte(strategyBacktestMarketFacts.recordedAt, input.recordedAt));
    }
    return this.db
      .select()
      .from(strategyBacktestMarketFacts)
      .where(and(...conditions))
      .orderBy(
        strategyBacktestMarketFacts.date,
        strategyBacktestMarketFacts.stockId,
        strategyBacktestMarketFacts.recordedAt,
        strategyBacktestMarketFacts.contentHash,
      )
      .all()
      .map((row) => StrictBacktestMarketFactSchema.parse(row.fact));
  }
}
