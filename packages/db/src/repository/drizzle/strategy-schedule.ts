import {
  assertStrategyScheduleInvariants,
  InvariantError,
  type StrategySchedule,
  type StrategyScheduleRepository,
} from '@luoome/core';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, strategySchedules } from '../../schema/index.js';

type Row = typeof strategySchedules.$inferSelect;

const toSchedule = (row: Row): StrategySchedule => ({
  id: row.id,
  strategyId: row.strategyId,
  cron: row.cron,
  timezone: row.timezone,
  enabled: row.enabled,
  ...(row.nextRunAt === null ? {} : { nextRunAt: row.nextRunAt }),
  ...(row.lastRunId === null ? {} : { lastRunId: row.lastRunId }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const changedRows = (result: unknown): number =>
  typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { readonly changes: unknown }).changes)
    : 0;

export class DrizzleStrategyScheduleRepository implements StrategyScheduleRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(schedule: StrategySchedule): Promise<void> {
    assertStrategyScheduleInvariants(schedule);
    this.db
      .insert(strategySchedules)
      .values({
        ...schedule,
        nextRunAt: schedule.nextRunAt ?? null,
        lastRunId: schedule.lastRunId ?? null,
        leaseOwner: null,
        leaseUntil: null,
      })
      .onConflictDoUpdate({
        target: strategySchedules.id,
        set: {
          cron: schedule.cron,
          timezone: schedule.timezone,
          enabled: schedule.enabled,
          nextRunAt: schedule.nextRunAt ?? null,
          lastRunId: schedule.lastRunId ?? null,
          updatedAt: schedule.updatedAt,
          leaseOwner: null,
          leaseUntil: null,
        },
      })
      .run();
  }

  async findById(id: string): Promise<StrategySchedule | null> {
    const row = this.db.select().from(strategySchedules).where(eq(strategySchedules.id, id)).get();
    return row === undefined ? null : toSchedule(row);
  }

  async findByStrategyId(strategyId: string): Promise<StrategySchedule | null> {
    const row = this.db
      .select()
      .from(strategySchedules)
      .where(eq(strategySchedules.strategyId, strategyId))
      .get();
    return row === undefined ? null : toSchedule(row);
  }

  async list(input: { readonly enabledOnly?: boolean } = {}): Promise<readonly StrategySchedule[]> {
    return this.db
      .select()
      .from(strategySchedules)
      .where(input.enabledOnly ? eq(strategySchedules.enabled, true) : undefined)
      .orderBy(asc(strategySchedules.strategyId))
      .all()
      .map(toSchedule);
  }

  async claimDue(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategySchedule[]> {
    return this.db.transaction((tx) => {
      const candidates = tx
        .select()
        .from(strategySchedules)
        .where(
          and(
            eq(strategySchedules.enabled, true),
            lte(strategySchedules.nextRunAt, input.now),
            or(isNull(strategySchedules.leaseUntil), lte(strategySchedules.leaseUntil, input.now)),
          ),
        )
        .orderBy(asc(strategySchedules.nextRunAt), asc(strategySchedules.id))
        .limit(input.limit)
        .all();
      const claimed: StrategySchedule[] = [];
      for (const candidate of candidates) {
        const result = tx.run(sql`
          UPDATE strategy_schedules
          SET lease_owner = ${input.owner}, lease_until = ${input.leaseUntil.getTime()}
          WHERE id = ${candidate.id}
            AND enabled = 1
            AND next_run_at <= ${input.now.getTime()}
            AND (lease_until IS NULL OR lease_until <= ${input.now.getTime()})
        `);
        if (changedRows(result) === 1) claimed.push(toSchedule(candidate));
      }
      return claimed;
    });
  }

  async finishClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly nextRunAt: Date;
    readonly updatedAt: Date;
    readonly lastRunId?: string;
  }): Promise<void> {
    const result =
      input.lastRunId === undefined
        ? this.db.run(sql`
          UPDATE strategy_schedules
          SET next_run_at = ${input.nextRunAt.getTime()}, updated_at = ${input.updatedAt.getTime()},
              lease_owner = NULL, lease_until = NULL
          WHERE id = ${input.id} AND lease_owner = ${input.owner}
        `)
        : this.db.run(sql`
          UPDATE strategy_schedules
          SET next_run_at = ${input.nextRunAt.getTime()}, updated_at = ${input.updatedAt.getTime()},
              last_run_id = ${input.lastRunId}, lease_owner = NULL, lease_until = NULL
          WHERE id = ${input.id} AND lease_owner = ${input.owner}
        `);
    if (changedRows(result) !== 1) {
      throw new InvariantError('StrategySchedule lease owner 不匹配');
    }
  }
}
