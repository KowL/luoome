import {
  assertStrategyScheduleInvariants,
  InvariantError,
  StrategyRecommendationPolicySchema,
  StrategyRunAcceptancePolicySchema,
  type StrategySchedule,
  type StrategyScheduleClaim,
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
  ...(row.acceptancePolicy === null
    ? {}
    : { acceptancePolicy: StrategyRunAcceptancePolicySchema.parse(row.acceptancePolicy) }),
  ...(row.recommendationPolicy === null
    ? {}
    : { recommendationPolicy: StrategyRecommendationPolicySchema.parse(row.recommendationPolicy) }),
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
        acceptancePolicy: schedule.acceptancePolicy ?? null,
        recommendationPolicy: schedule.recommendationPolicy ?? null,
        lastRunId: schedule.lastRunId ?? null,
        leaseOwner: null,
        leaseUntil: null,
        leaseFence: 0,
        leaseHeartbeatAt: null,
      })
      .onConflictDoUpdate({
        target: strategySchedules.id,
        set: {
          cron: schedule.cron,
          timezone: schedule.timezone,
          enabled: schedule.enabled,
          nextRunAt: schedule.nextRunAt ?? null,
          acceptancePolicy: schedule.acceptancePolicy ?? null,
          recommendationPolicy: schedule.recommendationPolicy ?? null,
          lastRunId: schedule.lastRunId ?? null,
          updatedAt: schedule.updatedAt,
          leaseOwner: null,
          leaseUntil: null,
          leaseHeartbeatAt: null,
        },
      })
      .run();
  }

  async removeByStrategyId(strategyId: string): Promise<void> {
    this.db.delete(strategySchedules).where(eq(strategySchedules.strategyId, strategyId)).run();
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
          SET lease_owner = ${input.owner}, lease_until = ${input.leaseUntil.getTime()},
              lease_fence = lease_fence + 1, lease_heartbeat_at = ${input.now.getTime()}
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

  async claimDueWithFence(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategyScheduleClaim[]> {
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
      const claimed: StrategyScheduleClaim[] = [];
      for (const candidate of candidates) {
        const result = tx.run(sql`
          UPDATE strategy_schedules
          SET lease_owner = ${input.owner}, lease_until = ${input.leaseUntil.getTime()},
              lease_fence = lease_fence + 1, lease_heartbeat_at = ${input.now.getTime()}
          WHERE id = ${candidate.id}
            AND enabled = 1
            AND next_run_at <= ${input.now.getTime()}
            AND (lease_until IS NULL OR lease_until <= ${input.now.getTime()})
        `);
        if (changedRows(result) !== 1) continue;
        const row = tx
          .select()
          .from(strategySchedules)
          .where(eq(strategySchedules.id, candidate.id))
          .get();
        if (row === undefined) continue;
        claimed.push({
          schedule: toSchedule(row),
          token: {
            scheduleId: row.id,
            owner: input.owner,
            fence: row.leaseFence,
            leaseUntil: row.leaseUntil as Date,
          },
        });
      }
      return claimed;
    });
  }

  async claimByStrategyIdWithFence(input: {
    readonly strategyId: string;
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
  }): Promise<StrategyScheduleClaim | null> {
    return this.db.transaction((tx) => {
      const candidate = tx
        .select()
        .from(strategySchedules)
        .where(
          and(
            eq(strategySchedules.strategyId, input.strategyId),
            eq(strategySchedules.enabled, true),
            or(isNull(strategySchedules.leaseUntil), lte(strategySchedules.leaseUntil, input.now)),
          ),
        )
        .limit(1)
        .get();
      if (candidate === undefined) return null;
      const result = tx.run(sql`
        UPDATE strategy_schedules
        SET lease_owner = ${input.owner}, lease_until = ${input.leaseUntil.getTime()},
            lease_fence = lease_fence + 1, lease_heartbeat_at = ${input.now.getTime()}
        WHERE id = ${candidate.id}
          AND strategy_id = ${input.strategyId}
          AND enabled = 1
          AND (lease_until IS NULL OR lease_until <= ${input.now.getTime()})
      `);
      if (changedRows(result) !== 1) return null;
      const row = tx
        .select()
        .from(strategySchedules)
        .where(eq(strategySchedules.id, candidate.id))
        .get();
      if (row === undefined) return null;
      return {
        schedule: toSchedule(row),
        token: {
          scheduleId: row.id,
          owner: input.owner,
          fence: row.leaseFence,
          leaseUntil: row.leaseUntil as Date,
        },
      };
    });
  }

  async renewClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const result = this.db.run(sql`
      UPDATE strategy_schedules
      SET lease_until = ${input.leaseUntil.getTime()}
          , lease_heartbeat_at = ${input.now.getTime()}
      WHERE id = ${input.id}
        AND lease_owner = ${input.owner}
        AND lease_fence = ${input.fence}
        AND lease_until > ${input.now.getTime()}
    `);
    return changedRows(result) === 1;
  }

  async finishClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence?: number;
    readonly nextRunAt: Date;
    readonly updatedAt: Date;
    readonly lastRunId?: string;
  }): Promise<void> {
    const fenceCondition =
      input.fence === undefined ? sql`` : sql` AND lease_fence = ${input.fence}`;
    const result =
      input.lastRunId === undefined
        ? this.db.run(sql`
          UPDATE strategy_schedules
          SET next_run_at = ${input.nextRunAt.getTime()}, updated_at = ${input.updatedAt.getTime()},
              lease_owner = NULL, lease_until = NULL
          WHERE id = ${input.id} AND lease_owner = ${input.owner}
            AND lease_until > ${input.updatedAt.getTime()}
          ${fenceCondition}
        `)
        : this.db.run(sql`
          UPDATE strategy_schedules
          SET next_run_at = ${input.nextRunAt.getTime()}, updated_at = ${input.updatedAt.getTime()},
              last_run_id = ${input.lastRunId}, lease_owner = NULL, lease_until = NULL
          WHERE id = ${input.id} AND lease_owner = ${input.owner}
            AND lease_until > ${input.updatedAt.getTime()}
          ${fenceCondition}
        `);
    if (changedRows(result) !== 1) {
      throw new InvariantError('StrategySchedule lease owner 不匹配');
    }
  }
}
